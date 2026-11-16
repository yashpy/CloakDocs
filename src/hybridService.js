/**
 * CloakDocs hybrid engine.
 *
 *  ┌────────────── browser (raw text never leaves this box) ──────────────┐
 *  │ rules engine  ─┐                                                      │
 *  │                ├─► entities ─► buildRedaction() ─► sanitized + map    │
 *  │ Gemini Nano  ──┘   (Firebase AI Logic, ONLY_ON_DEVICE)               │
 *  └───────────────────────────────┬──────────────────────────────────────┘
 *                                  │ sanitized text only, after the privacy gate
 *                                  ▼
 *      Firebase AI Logic  ── ONLY_IN_CLOUD ─────► Gemini (deep clause audit)
 *                         └─ PREFER_ON_DEVICE ──► Nano if ready, else Gemini
 *
 * Exports: PII redaction engine, token re-hydration, privacy gate, cloud clause
 * auditor, auto hybrid router and the live telemetry tracker used by the UI.
 */
import { getGenerativeModel, InferenceMode, InferenceSource, Schema } from 'firebase/ai';
import { ai, DEFAULT_HYBRID_CONFIG } from './firebase.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Constants                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export const TARGET = Object.freeze({
  ON_DEVICE: 'on_device',
  CLOUD: 'cloud',
  FALLBACK: 'fallback'
});

export const SEVERITY_ORDER = Object.freeze({ High: 0, Medium: 1, Low: 2 });

const ENTITY_TYPES = ['PERSON', 'SSN', 'EMAIL', 'PHONE', 'SALARY', 'ADDRESS', 'DOB', 'ACCOUNT'];

/** Lower number wins when the same string is reported under several types. */
const TYPE_PRIORITY = Object.freeze({
  SSN: 0,
  EMAIL: 1,
  PHONE: 2,
  ACCOUNT: 3,
  DOB: 4,
  SALARY: 5,
  ADDRESS: 6,
  PERSON: 7
});

const NANO_CHUNK_CHARS = 2400;
const NANO_MAX_CHUNKS = 24;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* ────────────────────────────────────────────────────────────────────────── */
/* Telemetry tracker (consumed by the header pill via useSyncExternalStore)   */
/* ────────────────────────────────────────────────────────────────────────── */

function createTelemetry() {
  let snapshot = Object.freeze({
    target: null,
    latencyMs: null,
    action: null,
    mode: null,
    detail: '',
    at: null,
    runs: []
  });
  const listeners = new Set();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** @param {{target:string, latencyMs:number, action:string, mode:string, detail?:string}} entry */
    record(entry) {
      const stamped = { detail: '', ...entry, at: Date.now() };
      snapshot = Object.freeze({ ...stamped, runs: [stamped, ...snapshot.runs].slice(0, 20) });
      listeners.forEach((listener) => listener());
    }
  };
}

export const telemetry = createTelemetry();

/* ────────────────────────────────────────────────────────────────────────── */
/* Errors                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export class PrivacyGateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrivacyGateError';
  }
}

export class HybridConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HybridConfigError';
  }
}

/** Turn SDK / network errors into one actionable sentence for the UI. */
export function friendlyError(error) {
  if (!error) return 'Unknown error.';
  if (error instanceof PrivacyGateError || error instanceof HybridConfigError) return error.message;
  const message = String(error.message || error);
  const code = String(error.code || '');

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'You are offline. Your document stays on this device; reconnect to run the cloud audit.';
  }
  if (/app.?check|appcheck/i.test(message) || /403|permission/i.test(message + code)) {
    return 'Firebase rejected the request (App Check / permissions). Register your App Check debug token and make sure Firebase AI Logic is enabled for this project.';
  }
  if (/api.?not.?enabled|not available in this environment|LanguageModel API/i.test(message + code)) {
    return 'Gemini Nano is not available in this browser (enable the Chrome flags in the README).';
  }
  if (/fetch|network|failed to fetch/i.test(message + code)) {
    return 'Network request failed. Check your connection and try again.';
  }
  if (/quota|429|resource.?exhausted/i.test(message + code)) {
    return 'Cloud quota reached. Try again in a minute.';
  }
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Rules-based PII detection (deterministic floor; works offline, no model)   */
/* ────────────────────────────────────────────────────────────────────────── */

const STRUCTURED = Object.freeze({
  EMAIL: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  SSN: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g,
  PHONE: /(?<![\w])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g,
  ACCOUNT: /(?<!\d)(?:\d{4}[ -]){3}\d{4}(?!\d)/g
});

const DOB_RX =
  /\b(?:DOB|D\.O\.B\.|Date of Birth|Birth ?date|Born)\s*[:-]?\s*((?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4})|(?:[A-Z][a-z]+\.? \d{1,2}, \d{4}))/g;

const ACCOUNT_LABEL_RX =
  /\b(?:Member ID|Subscriber ID|Policy (?:No\.?|Number|#)|Group (?:No\.?|Number)|Claim (?:No\.?|Number|#)|MRN|Medical Record (?:No\.?|Number)|Account (?:No\.?|Number|#)|Routing (?:No\.?|Number)|Passport (?:No\.?|Number)|Driver'?s License(?: (?:No\.?|Number|#))?)\s*[:#]?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/g;

const STREET_SUFFIX =
  '(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Parkway|Pkwy|Highway|Hwy|Terrace|Circle|Cir)';

const ADDRESS_RX = new RegExp(
  `\\b\\d{1,6}\\s+(?:[A-Z][\\w.'-]*\\s+){0,4}${STREET_SUFFIX}\\b\\.?` +
    `(?:,?\\s+(?:Suite|Ste\\.?|Apt\\.?|Unit|Floor|Fl\\.?|#)\\s*[\\w-]+)?` +
    `(?:,\\s*[A-Z][A-Za-z.\\s]{1,30}?,\\s*[A-Z]{2}\\s+\\d{5}(?:-\\d{4})?)?`,
  'g'
);

const MONEY_RX =
  /(?:USD\s?|US\$|\$)\s?\d+(?:,\d{3})*(?:\.\d{1,2})?(?:\s?[kK]\b)?(?:\s*(?:per|a|\/)\s*(?:year|yr|annum|month|hour|hr|week)\b)?/g;

/** Dollar amounts are only SALARY when the surrounding words talk about pay. */
const COMPENSATION_CONTEXT =
  /\b(?:salary|compensation|base pay|bonus|wages?|stipend|hourly rate|earnings|income|remuneration|severance)\b/i;

const NAME_WORD = "(?:O['’][A-Z][a-z]+|Mc[A-Z][a-z]+|[A-Z][a-z]+(?:-[A-Z][a-z]+)?)";
// Names never span lines: spaces/tabs only, so "Priya Raman" + newline + "Signature" is not one name.
const SP = '[ \\t]+';
const FULL_NAME = `${NAME_WORD}(?:${SP}[A-Z]\\.)?(?:${SP}${NAME_WORD}){1,2}`;

const PERSON_PATTERNS = [
  // Mr. / Dr. / Ms. Name
  new RegExp(`\\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\\.?${SP}(${NAME_WORD}(?:${SP}[A-Z]\\.)?(?:${SP}${NAME_WORD})?)`, 'g'),
  // Label: Full Name
  new RegExp(
    `\\b(?:Employee|Patient|Insured|Claimant|Member|Subscriber|Candidate|Applicant|Name|Executive|Physician|Provider|` +
      `Beneficiary|Contractor|Policyholder|Guarantor|Witness|Signed|Signature|Attn|Attention|By|Prepared by|` +
      `Emergency Contact|Referring Physician|Primary Care Physician|Print Name)[ \\t]*[:\\-][ \\t]*` +
      `(?:(?:Mr|Mrs|Ms|Dr)\\.?${SP})?(${FULL_NAME})`,
    'g'
  ),
  // /s/ Full Name
  new RegExp(`/s/[ \\t]*(${FULL_NAME})`, 'g'),
  // Full Name, an individual / residing at / a resident of
  new RegExp(`(${FULL_NAME}),?${SP}(?:an individual|residing at|a resident of|whose address)`, 'g'),
  // "and Full Name (the "Employee")"
  new RegExp(`\\band${SP}(${FULL_NAME})[ \\t]*\\((?:the${SP})?[“"]`, 'g')
];

const NAME_STOP_WORDS = new Set(
  (
    'inc llc ltd corp corporation company co team department agreement services service systems health healthcare ' +
    'legal support university hospital clinic bank insurance group holdings technologies solutions partners customer ' +
    'vendor employer employee party parties section article exhibit schedule effective date north south east west ' +
    'street avenue road medical center centre association foundation institute laboratories labs robotics cloud ' +
    'analytics plan policy benefits human resources payroll billing claims general counsel officer chief president ' +
    'manager director state county city united states america master subscription governing law'
  ).split(' ')
);

const COMMON_WORD_NAMES = new Set(
  ['will', 'may', 'mark', 'bill', 'grant', 'hope', 'rose', 'dawn', 'page', 'faith', 'joy', 'summer', 'art', 'sue', 'pat']
);

function looksLikePerson(name) {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return !words.some((word) => NAME_STOP_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, '')));
}

function nameWords(value) {
  return value
    .toLowerCase()
    .split(/[^a-z'’-]+/)
    .filter((word) => word.length > 1 && !['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof'].includes(word));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Run a global regex and return capture group `group` (or the full match) with offsets. */
function* matchAll(text, rx, group = 0) {
  const regex = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`);
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[0] === '') {
      regex.lastIndex += 1;
      continue;
    }
    const value = match[group];
    if (value) yield { value, index: match.index + match[0].indexOf(value) };
  }
}

/**
 * Deterministic detector: structured identifiers, labeled IDs, addresses,
 * compensation amounts and title/label-anchored person names.
 * @returns {{value:string,type:string,source:string}[]}
 */
export function detectWithRules(text) {
  const found = [];
  const push = (value, type) => found.push({ value: value.trim(), type, source: 'rules' });

  for (const [type, rx] of Object.entries(STRUCTURED)) {
    for (const { value } of matchAll(text, rx)) push(value, type);
  }
  for (const { value } of matchAll(text, DOB_RX, 1)) push(value, 'DOB');
  for (const { value } of matchAll(text, ACCOUNT_LABEL_RX, 1)) {
    if (value.length >= 5) push(value, 'ACCOUNT');
  }
  for (const { value } of matchAll(text, ADDRESS_RX)) push(value.replace(/[.,\s]+$/, ''), 'ADDRESS');

  for (const { value, index } of matchAll(text, MONEY_RX)) {
    const before = text.slice(Math.max(0, index - 90), index);
    const after = text.slice(index + value.length, index + value.length + 40);
    if (COMPENSATION_CONTEXT.test(`${before} ${after}`)) push(value, 'SALARY');
  }

  for (const pattern of PERSON_PATTERNS) {
    for (const { value } of matchAll(text, pattern, 1)) {
      if (looksLikePerson(value)) push(value, 'PERSON');
    }
  }

  return found;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Redaction builder, re-hydration and privacy gate                           */
/* ────────────────────────────────────────────────────────────────────────── */

function buildMatcher(values, flags = 'g') {
  const alternatives = [...new Set(values)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((value) => {
      const startsWord = /^[A-Za-z0-9]/.test(value);
      const endsWord = /[A-Za-z0-9]$/.test(value);
      return `${startsWord ? '(?<![A-Za-z0-9])' : ''}${escapeRegExp(value)}${endsWord ? '(?![A-Za-z0-9])' : ''}`;
    });
  return alternatives.length ? new RegExp(alternatives.join('|'), flags) : null;
}

/**
 * Convert raw detections into reversible tokens.
 *  - identical strings share a token
 *  - "Priya Raman", "Priya" and "Raman" collapse into one [PERSON_n]
 *  - PERSON tokens are always indexed; other types are indexed only when a type repeats
 */
export function buildRedaction(text, rawEntities) {
  const byValue = new Map();
  for (const entity of rawEntities) {
    const value = (entity.value || '').trim();
    if (value.length < 2 || !ENTITY_TYPES.includes(entity.type) || !text.includes(value)) continue;
    const existing = byValue.get(value);
    if (!existing || TYPE_PRIORITY[entity.type] < TYPE_PRIORITY[existing.type]) {
      byValue.set(value, { value, type: entity.type });
    }
  }

  // Expand each multi-word person into standalone first/last-name and UPPERCASE forms.
  for (const entity of [...byValue.values()].filter((e) => e.type === 'PERSON')) {
    const words = entity.value.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'’-]+$/.test(w) && w.length >= 3);
    if (words.length >= 2) {
      for (const word of words) {
        if (COMMON_WORD_NAMES.has(word.toLowerCase()) || NAME_STOP_WORDS.has(word.toLowerCase())) continue;
        if (!byValue.has(word) && text.includes(word)) byValue.set(word, { value: word, type: 'PERSON' });
      }
    }
    const upper = entity.value.toUpperCase();
    if (upper !== entity.value && text.includes(upper) && !byValue.has(upper)) {
      byValue.set(upper, { value: upper, type: 'PERSON' });
    }
  }

  // Group person surface forms under the longest name that contains them.
  const people = [...byValue.values()]
    .filter((e) => e.type === 'PERSON')
    .sort((a, b) => nameWords(b.value).length - nameWords(a.value).length || b.value.length - a.value.length);
  const leaders = [];
  const groupOf = new Map();
  for (const person of people) {
    const words = nameWords(person.value);
    const leader = leaders.find((l) => words.length > 0 && words.every((w) => l.words.has(w)));
    if (leader) {
      groupOf.set(person.value, leader.value);
    } else {
      leaders.push({ value: person.value, words: new Set(words) });
      groupOf.set(person.value, person.value);
    }
  }
  for (const entity of byValue.values()) {
    if (entity.type !== 'PERSON') groupOf.set(entity.value, entity.value);
  }

  const matcher = buildMatcher([...byValue.keys()]);
  if (!matcher) {
    return { sanitized: text, entities: [], counts: {}, total: 0, replacements: 0 };
  }

  // Pass 1: discover groups in order of first appearance.
  const groups = new Map();
  for (const match of text.matchAll(matcher)) {
    const surface = match[0];
    const key = groupOf.get(surface);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { type: byValue.get(surface).type, value: key, forms: new Set(), occurrences: 0 });
    }
    const group = groups.get(key);
    group.forms.add(surface);
    group.occurrences += 1;
  }

  const totals = {};
  for (const group of groups.values()) totals[group.type] = (totals[group.type] || 0) + 1;

  const seenPerType = {};
  const entities = [];
  const tokenBySurface = new Map();
  for (const group of groups.values()) {
    seenPerType[group.type] = (seenPerType[group.type] || 0) + 1;
    const indexed = group.type === 'PERSON' || totals[group.type] > 1;
    const token = indexed ? `[${group.type}_${seenPerType[group.type]}]` : `[${group.type}]`;
    entities.push({
      token,
      type: group.type,
      value: group.value,
      forms: [...group.forms],
      occurrences: group.occurrences
    });
    for (const form of group.forms) tokenBySurface.set(form, token);
  }

  // Pass 2: replace.
  let replacements = 0;
  const sanitized = text.replace(matcher, (surface) => {
    const token = tokenBySurface.get(surface);
    if (!token) return surface;
    replacements += 1;
    return token;
  });

  return { sanitized, entities, counts: totals, total: entities.length, replacements };
}

/** Replace tokens in any string (cloud output, summaries) with their original values. Browser-only. */
export function rehydrate(text, entities) {
  if (!text || !entities?.length) return text || '';
  const valueByToken = new Map(entities.map((entity) => [entity.token, entity.value]));
  return text.replace(/\[[A-Z]+(?:_\d+)?\]/g, (token) => valueByToken.get(token) ?? token);
}

/**
 * Last line of defense before ANY cloud-bound call. Throws if the outbound text
 * still contains a known original value or any structured identifier.
 */
export function assertSafeForCloud(sanitized, entities) {
  const leaks = new Set();

  const forms = (entities || []).flatMap((entity) => entity.forms.filter((form) => form.length >= 3));
  // Case-sensitive on purpose: redaction is case-sensitive too (plus an UPPERCASE variant per name),
  // so a lowercase common word that happens to equal a name is not a leak.
  const matcher = buildMatcher(forms, '');
  if (matcher && matcher.test(sanitized)) leaks.add('a previously detected value');

  for (const [type, rx] of Object.entries(STRUCTURED)) {
    if (new RegExp(rx.source, rx.flags.replace('g', '')).test(sanitized)) leaks.add(type);
  }

  if (leaks.size > 0) {
    throw new PrivacyGateError(
      `Privacy gate blocked the cloud call: sanitized text still contains ${[...leaks].join(', ')}. Re-run Local PII Redact.`
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Local clause triage (no model required)                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const CLAUSE_RULES = [
  { id: 'non-compete', label: 'Non-compete / restrictive covenant', severity: 'High', rx: /non[- ]?compet|not (?:to )?compete|restrictive covenant/i },
  { id: 'ip-assignment', label: 'Broad IP / invention assignment', severity: 'High', rx: /assign(?:s|ment)?[^.]{0,120}(?:inventions?|intellectual property|work product)|(?:inventions?|work product)[^.]{0,120}(?:whether or not|personal time|outside)/i },
  { id: 'indemnification', label: 'Indemnification', severity: 'High', rx: /indemnif/i },
  { id: 'liability-cap', label: 'Limitation of liability', severity: 'Medium', rx: /limitation of liability|aggregate liability|in no event shall|liability[^.]{0,60}(?:shall not exceed|limited to)/i },
  { id: 'auto-renew', label: 'Automatic renewal', severity: 'Medium', rx: /auto(?:matic(?:ally)?)?[- ]?renew|renews? automatically|successive (?:renewal )?terms?/i },
  { id: 'dispute', label: 'Arbitration / venue / waiver', severity: 'Medium', rx: /binding arbitration|waive[^.]{0,60}(?:jury|class action)|exclusive (?:jurisdiction|venue)/i },
  { id: 'unilateral', label: 'Unilateral changes / sole discretion', severity: 'Medium', rx: /sole discretion|unilateral|at any time without (?:prior )?notice|may (?:modify|amend|change|increase)[^.]{0,80}(?:at any time|upon)/i },
  { id: 'clawback', label: 'Repayment / clawback', severity: 'Medium', rx: /clawback|repay[^.]{0,60}(?:bonus|training|relocation)|reimburse[^.]{0,60}(?:bonus|training|relocation)/i },
  { id: 'data-sharing', label: 'Data sharing / secondary use', severity: 'Medium', rx: /share[^.]{0,80}(?:affiliates|third part(?:y|ies)|marketing)|de-?identified|aggregate(?:d)? data/i },
  { id: 'subrogation', label: 'Subrogation / third-party recovery', severity: 'Low', rx: /subrogat/i }
];

export function guessDocType(text) {
  if (/\b(?:employee|employment|non-?compete|at-will)\b/i.test(text)) return 'Employment agreement';
  if (/\b(?:patient|diagnos|claim|insured|member id|physician|hipaa)\b/i.test(text)) return 'Medical / insurance record';
  if (/\b(?:master services|saas|subscription|vendor|customer|service level)\b/i.test(text)) return 'Vendor / SaaS agreement';
  return 'General document';
}

/** Keyword triage over sanitized text. Always available, including with no model and no network. */
export function ruleTriage(sanitized) {
  const flags = [];
  for (const rule of CLAUSE_RULES) {
    const match = rule.rx.exec(sanitized);
    if (!match) continue;
    const start = Math.max(0, match.index - 60);
    const end = Math.min(sanitized.length, match.index + match[0].length + 90);
    flags.push({
      id: rule.id,
      label: rule.label,
      severity: rule.severity,
      excerpt: `${start > 0 ? '…' : ''}${sanitized.slice(start, end).replace(/\s+/g, ' ').trim()}${end < sanitized.length ? '…' : ''}`
    });
  }
  return flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Firebase AI Logic: model factory, device status                            */
/* ────────────────────────────────────────────────────────────────────────── */

const TEXT_IO = [{ type: 'text', languages: ['en'] }];

const NER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: ENTITY_TYPES }
        },
        required: ['text', 'type']
      }
    }
  },
  required: ['entities']
};

const AUDIT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    docType: { type: 'string' },
    riskScore: { type: 'integer' },
    complianceScore: { type: 'integer' },
    summary: { type: 'string' },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          clause: { type: 'string' },
          why: { type: 'string' },
          redline: { type: 'string' }
        },
        required: ['title', 'severity', 'clause', 'why', 'redline']
      }
    }
  },
  required: ['docType', 'riskScore', 'complianceScore', 'summary', 'risks']
};

const AUDIT_CLOUD_SCHEMA = Schema.object({
  properties: {
    docType: Schema.string(),
    riskScore: Schema.integer(),
    complianceScore: Schema.integer(),
    summary: Schema.string(),
    risks: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string(),
          severity: Schema.enumString({ enum: ['High', 'Medium', 'Low'] }),
          clause: Schema.string(),
          why: Schema.string(),
          redline: Schema.string()
        }
      })
    })
  }
});

const modelCache = new Map();

/**
 * One Firebase AI Logic hybrid model per (task, mode, cloud model).
 * `getGenerativeModel` receives HybridParams: the inference `mode`, plus separate
 * on-device and in-cloud configuration.
 */
function getHybridModel({ task, mode, config, structured = false }) {
  if (!ai) {
    throw new HybridConfigError(
      'Firebase AI Logic is not configured. Copy .env.example to .env and add your Firebase web config.'
    );
  }
  const cloudModel = config?.cloud_model || DEFAULT_HYBRID_CONFIG.cloud_model;
  const key = `${task}|${mode}|${cloudModel}`;
  if (modelCache.has(key)) return modelCache.get(key);

  const hybridParams = {
    mode,
    onDeviceParams: {
      createOptions: { expectedInputs: TEXT_IO, expectedOutputs: TEXT_IO },
      ...(structured && {
        promptOptions: { responseConstraint: task === 'ner' ? NER_JSON_SCHEMA : AUDIT_JSON_SCHEMA }
      })
    },
    inCloudParams: {
      model: cloudModel,
      generationConfig: {
        temperature: 0.2,
        ...(structured && task !== 'ner' && {
          responseMimeType: 'application/json',
          responseSchema: AUDIT_CLOUD_SCHEMA
        })
      }
    }
  };

  const model = getGenerativeModel(ai, hybridParams);
  modelCache.set(key, model);
  return model;
}

/** Chrome Prompt API availability: 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'no-api'. */
export async function getOnDeviceStatus() {
  const LanguageModel = globalThis.LanguageModel;
  if (!LanguageModel || typeof LanguageModel.availability !== 'function') return 'no-api';
  try {
    return await LanguageModel.availability({ expectedInputs: TEXT_IO, expectedOutputs: TEXT_IO });
  } catch {
    return 'unavailable';
  }
}

const deviceInit = new WeakMap();

/**
 * Initialize the on-device model for a hybrid model instance.
 * Awaits when the model is ready/downloading in the foreground; when
 * `waitForDownload` is false a pending download is kicked off and NOT awaited.
 * Must be triggered from a user gesture (button click) for first-time downloads.
 */
async function warmDeviceModel(model, { waitForDownload = false, onProgress } = {}) {
  const status = await getOnDeviceStatus();
  if (status === 'no-api' || status === 'unavailable') return status;

  if (!deviceInit.has(model) || status !== 'available') {
    const pending = model.initializeDeviceModel(onProgress);
    if (status === 'available' || waitForDownload) {
      await pending;
      deviceInit.set(model, true);
    } else {
      pending.then(() => deviceInit.set(model, true)).catch(() => {});
    }
  }
  return status;
}

/**
 * Explicit "Prepare Gemini Nano" action (header button): downloads the on-device
 * model with progress reporting. Resolves with the final status.
 */
export async function prepareOnDevice(config, onProgress) {
  const model = getHybridModel({ task: 'ner', mode: InferenceMode.ONLY_ON_DEVICE, config, structured: true });
  await warmDeviceModel(model, { waitForDownload: true, onProgress });
  return getOnDeviceStatus();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function chunkText(text, size) {
  const chunks = [];
  let current = '';
  for (const line of text.split(/(?<=\n)/)) {
    if (current.length + line.length <= size) {
      current += line;
      continue;
    }
    if (current) chunks.push(current);
    current = '';
    let rest = line;
    while (rest.length > size) {
      const cut = rest.lastIndexOf(' ', size);
      const at = cut > size * 0.5 ? cut : size;
      chunks.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    current = rest;
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseJsonLoose(raw) {
  let body = String(raw || '').trim();
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(body);
  } catch (firstError) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw firstError;
  }
}

const clampScore = (value, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
};

const normalizeSeverity = (value) => {
  const text = String(value || '').toLowerCase();
  if (text.startsWith('h') || text.startsWith('c')) return 'High';
  if (text.startsWith('l')) return 'Low';
  return 'Medium';
};

export function normalizeAudit(parsed) {
  const risks = (Array.isArray(parsed?.risks) ? parsed.risks : [])
    .map((risk) => ({
      title: String(risk?.title || 'Untitled risk').slice(0, 140),
      severity: normalizeSeverity(risk?.severity),
      clause: String(risk?.clause || '').slice(0, 400),
      why: String(risk?.why || '').slice(0, 500),
      redline: String(risk?.redline || '').slice(0, 900)
    }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, 3);

  return {
    docType: String(parsed?.docType || 'Document').slice(0, 80),
    riskScore: clampScore(parsed?.riskScore, 50),
    complianceScore: clampScore(parsed?.complianceScore, 50),
    summary: String(parsed?.summary || '').slice(0, 700),
    risks
  };
}

function inferenceTarget(source, fallbackWhenCloud = false) {
  if (source === InferenceSource.ON_DEVICE) return TARGET.ON_DEVICE;
  return fallbackWhenCloud ? TARGET.FALLBACK : TARGET.CLOUD;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Action 1: local PII redaction + triage (ONLY_ON_DEVICE, rules fallback)    */
/* ────────────────────────────────────────────────────────────────────────── */

function buildNerPrompt(chunk) {
  return (
    'You are an offline privacy filter. Find every piece of personally identifiable information in the DOCUMENT.\n' +
    `Allowed types: ${ENTITY_TYPES.join(', ')}.\n` +
    '- PERSON: names of individual people only (not companies, not job titles).\n' +
    '- ADDRESS: street addresses including suite, city, state and ZIP.\n' +
    '- SALARY: personal compensation amounts (salary, bonus, wages).\n' +
    '- DOB, SSN, EMAIL, PHONE, ACCOUNT (member, policy, claim, account or record numbers).\n' +
    'Copy each value EXACTLY as written in the document. Return JSON: {"entities":[{"text":"...","type":"..."}]}.\n\n' +
    `DOCUMENT:\n${chunk}`
  );
}

async function extractEntitiesOnDevice(text, config, onStatus) {
  const model = getHybridModel({ task: 'ner', mode: InferenceMode.ONLY_ON_DEVICE, config, structured: true });
  const status = await warmDeviceModel(model, { waitForDownload: false, onProgress: undefined });

  if (status !== 'available') {
    const reason =
      status === 'downloadable' || status === 'downloading'
        ? 'Gemini Nano is still downloading (use "Prepare Gemini Nano"); used the rules engine for now.'
        : 'Gemini Nano is not available in this browser; used the on-device rules engine.';
    const error = new HybridConfigError(reason);
    error.nanoStatus = status;
    throw error;
  }

  const chunks = chunkText(text, NANO_CHUNK_CHARS).slice(0, NANO_MAX_CHUNKS);
  const entities = [];

  for (let i = 0; i < chunks.length; i += 1) {
    onStatus?.(`Gemini Nano scanning section ${i + 1}/${chunks.length}…`);
    const result = await model.generateContent(buildNerPrompt(chunks[i]));

    // Hard guarantee: raw text must never be answered by the cloud.
    if (result.response.inferenceSource && result.response.inferenceSource !== InferenceSource.ON_DEVICE) {
      throw new PrivacyGateError('Blocked: the SDK attempted cloud inference for raw text.');
    }

    const parsed = parseJsonLoose(result.response.text());
    for (const item of Array.isArray(parsed?.entities) ? parsed.entities : []) {
      const value = String(item?.text || '').trim();
      const type = String(item?.type || '').toUpperCase();
      if (value.length < 2 || value.length > 120 || !ENTITY_TYPES.includes(type)) continue;
      if (!chunks[i].includes(value)) continue; // reject hallucinated strings
      if (type === 'PERSON' && !looksLikePerson(value)) continue;
      entities.push({ value, type, source: 'gemini-nano' });
    }
  }
  return entities;
}

async function summarizeOnDevice(sanitized, config) {
  const model = getHybridModel({ task: 'summary', mode: InferenceMode.ONLY_ON_DEVICE, config });
  await warmDeviceModel(model, { waitForDownload: false });
  const input = sanitized.slice(0, Math.max(1000, config.max_local_char_limit));
  const result = await model.generateContent(
    'Summarize this sanitized document in exactly 3 short bullet points: what it is, the key obligations or terms, ' +
      'and anything unusual. Keep tokens such as [PERSON_1] unchanged. Plain text only.\n\nDOCUMENT:\n' +
      input
  );
  if (result.response.inferenceSource && result.response.inferenceSource !== InferenceSource.ON_DEVICE) {
    throw new PrivacyGateError('Blocked: the SDK attempted cloud inference for the local summary.');
  }
  return result.response.text().trim();
}

/**
 * Action 1. Detects PII with the rules engine, adds Gemini Nano detections when
 * available (ONLY_ON_DEVICE, never cloud), then produces sanitized text, the
 * reversible token map, a local summary and a keyword triage.
 */
export async function localRedactAndTriage(text, { config, onStatus } = {}) {
  const cfg = config || DEFAULT_HYBRID_CONFIG;
  const started = now();

  onStatus?.('Rules engine scanning for identifiers…');
  const entities = detectWithRules(text);

  let engine = 'rules';
  let fallbackReason = null;

  if (ai) {
    try {
      const deviceEntities = await extractEntitiesOnDevice(text, cfg, onStatus);
      entities.push(...deviceEntities);
      engine = 'gemini-nano';
    } catch (error) {
      if (error instanceof PrivacyGateError) throw error;
      fallbackReason = error instanceof HybridConfigError ? error.message : `On-device model error: ${friendlyError(error)}`;
    }
  } else {
    fallbackReason = 'Firebase AI Logic is not configured; used the on-device rules engine.';
  }

  onStatus?.('Building reversible token map…');
  const redaction = buildRedaction(text, entities);

  let summary = '';
  let summaryEngine = null;
  if (engine === 'gemini-nano') {
    try {
      onStatus?.('Gemini Nano writing a local summary…');
      summary = await summarizeOnDevice(redaction.sanitized, cfg);
      summaryEngine = 'gemini-nano';
    } catch (error) {
      if (error instanceof PrivacyGateError) throw error;
      summary = '';
    }
  }

  const triage = ruleTriage(redaction.sanitized);
  const docType = guessDocType(redaction.sanitized);
  const latencyMs = Math.round(now() - started);
  const target = engine === 'gemini-nano' ? TARGET.ON_DEVICE : TARGET.FALLBACK;

  telemetry.record({
    target,
    latencyMs,
    action: 'Local PII Redact & Triage',
    mode: engine === 'gemini-nano' ? InferenceMode.ONLY_ON_DEVICE : 'rules_engine',
    detail:
      engine === 'gemini-nano'
        ? `${redaction.total} entities redacted by Gemini Nano + rules`
        : fallbackReason || 'Rules engine fallback'
  });

  return {
    sourceText: text,
    ...redaction,
    engine,
    fallbackReason,
    summary,
    summaryEngine,
    triage,
    docType,
    latencyMs,
    target,
    mode: engine === 'gemini-nano' ? InferenceMode.ONLY_ON_DEVICE : 'rules_engine'
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Action 2 & 3: sanitized-only audit                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function buildAuditPrompt(sanitized, { concise = false } = {}) {
  return (
    'You are a senior counsel reviewing a SANITIZED document. All personal data was replaced by tokens such as ' +
    '[PERSON_1], [SSN], [EMAIL], [SALARY]. Never guess the original values and keep tokens exactly as written.\n' +
    'Identify the TOP 3 legal or financial risks for the individual or organization that is asked to sign.\n' +
    'Return JSON with: docType; riskScore (0 = safe, 100 = severe); complianceScore (0-100, higher = better); ' +
    'summary (max 50 words); risks: exactly 3 items, each with title, severity (High, Medium or Low), ' +
    'clause (short verbatim quote, max 200 characters), why (max 40 words) and redline ' +
    '(a concrete replacement clause the signer could propose).\n' +
    (concise ? 'Be concise.\n' : '') +
    'This is analysis for triage, not legal advice.\n\nSANITIZED DOCUMENT:\n' +
    sanitized
  );
}

/**
 * Action 2. Sends ONLY the sanitized text to the cloud model (ONLY_IN_CLOUD).
 * @param {string} sanitized text produced by localRedactAndTriage
 * @param {object[]} entities the token map (used by the privacy gate, never sent)
 */
export async function cloudClauseAudit(sanitized, entities, { config } = {}) {
  const cfg = config || DEFAULT_HYBRID_CONFIG;
  if (!cfg.enable_cloud_deep_audit) {
    throw new HybridConfigError('Cloud deep audit is disabled by Remote Config (enable_cloud_deep_audit = false).');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new HybridConfigError(
      'You are offline. Local redaction still works; reconnect to run the cloud audit on the sanitized text.'
    );
  }
  assertSafeForCloud(sanitized, entities);

  const model = getHybridModel({ task: 'audit-cloud', mode: InferenceMode.ONLY_IN_CLOUD, config: cfg, structured: true });
  const started = now();
  const result = await model.generateContent(buildAuditPrompt(sanitized));
  const latencyMs = Math.round(now() - started);

  const audit = normalizeAudit(parseJsonLoose(result.response.text()));
  const target = inferenceTarget(result.response.inferenceSource);

  telemetry.record({
    target,
    latencyMs,
    action: 'Deep Cloud Clause Audit',
    mode: InferenceMode.ONLY_IN_CLOUD,
    detail: `${sanitized.length.toLocaleString()} sanitized chars sent to ${cfg.cloud_model}`
  });

  return {
    audit,
    latencyMs,
    target,
    mode: InferenceMode.ONLY_IN_CLOUD,
    model: cfg.cloud_model,
    charCount: sanitized.length,
    sentText: sanitized
  };
}

/**
 * Decide the Firebase AI Logic inference mode from document length and policy.
 * Pure function so the UI can preview the decision.
 */
export function planRoute(charCount, config) {
  const limit = config.max_local_char_limit;
  if (!config.enable_cloud_deep_audit) {
    return {
      mode: InferenceMode.ONLY_ON_DEVICE,
      truncate: charCount > limit,
      reason:
        charCount > limit
          ? `Cloud audit disabled by Remote Config; analyzing the first ${limit.toLocaleString()} chars on-device only.`
          : 'Cloud audit disabled by Remote Config; on-device only.'
    };
  }
  if (charCount > limit) {
    return {
      mode: InferenceMode.ONLY_IN_CLOUD,
      truncate: false,
      reason: `${charCount.toLocaleString()} chars exceeds the ${limit.toLocaleString()}-char local limit, so the sanitized text is routed to the cloud.`
    };
  }
  return {
    mode: InferenceMode.PREFER_ON_DEVICE,
    truncate: false,
    reason: `Within the ${limit.toLocaleString()}-char local limit: Gemini Nano is preferred and the SDK falls back to the cloud if it is unavailable.`
  };
}

/**
 * Action 3. One call site, automatic routing: PREFER_ON_DEVICE under the
 * Remote Config threshold, cloud above it. Only sanitized text is ever used.
 */
export async function autoHybridRoute(sanitized, entities, { config, onStatus } = {}) {
  const cfg = config || DEFAULT_HYBRID_CONFIG;
  assertSafeForCloud(sanitized, entities);

  const plan = planRoute(sanitized.length, cfg);
  const input = plan.truncate ? sanitized.slice(0, cfg.max_local_char_limit) : sanitized;
  const model = getHybridModel({ task: 'audit-auto', mode: plan.mode, config: cfg, structured: true });

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline && plan.mode === InferenceMode.ONLY_IN_CLOUD) {
    throw new HybridConfigError(
      'You are offline and this document is over the on-device limit, so it cannot be routed to the cloud. Shorten it or reconnect.'
    );
  }

  if (plan.mode !== InferenceMode.ONLY_IN_CLOUD) {
    onStatus?.('Checking Gemini Nano availability…');
    const status = await warmDeviceModel(model, { waitForDownload: false });
    if (offline && status !== 'available') {
      throw new HybridConfigError(
        'You are offline and Gemini Nano is not ready, so the hybrid route has nowhere to run. Use "Prepare Gemini Nano" while online.'
      );
    }
  }

  onStatus?.(`Routing with ${plan.mode}…`);
  const started = now();
  const result = await model.generateContent(buildAuditPrompt(input, { concise: true }));
  const latencyMs = Math.round(now() - started);

  const source = result.response.inferenceSource;
  const audit = normalizeAudit(parseJsonLoose(result.response.text()));
  // Any cloud answer from the auto router is a hybrid fallback (device not ready or over threshold).
  const target = inferenceTarget(source, true);

  telemetry.record({
    target,
    latencyMs,
    action: 'Auto Hybrid Route',
    mode: plan.mode,
    detail:
      source === InferenceSource.ON_DEVICE
        ? 'Answered on-device by Gemini Nano'
        : plan.mode === InferenceMode.ONLY_IN_CLOUD
          ? 'Over local threshold → cloud'
          : 'Gemini Nano unavailable → cloud fallback'
  });

  return {
    audit,
    latencyMs,
    target,
    mode: plan.mode,
    plan,
    inferenceSource: source || null,
    model: cfg.cloud_model,
    charCount: input.length,
    truncated: plan.truncate,
    sentText: source === InferenceSource.ON_DEVICE ? '' : input
  };
}
