import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  appCheckMode,
  auth,
  DEFAULT_HYBRID_CONFIG,
  ensureAnonymousAuth,
  initError,
  isFirebaseConfigured,
  loadHybridConfig,
  missingConfigKeys
} from './firebase.js';
import {
  TARGET,
  autoHybridRoute,
  cloudClauseAudit,
  friendlyError,
  getOnDeviceStatus,
  localRedactAndTriage,
  planRoute,
  prepareOnDevice,
  rehydrate,
  telemetry
} from './hybridService.js';
import { buildAuditRecord, clearAudits, saveAudit, subscribeAudits } from './auditStore.js';
import { SAMPLE_DOCS } from './samples.js';

const REPO_URL = 'https://github.com/yashpy/CloakDocs';

/* ───────────────────────────── style lookups ───────────────────────────── */
/* Tailwind needs literal class names, so every variant is spelled out here. */

const TARGET_STYLES = {
  [TARGET.ON_DEVICE]: {
    label: 'ON-DEVICE (Gemini Nano 4)',
    pill: 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300',
    dot: 'bg-emerald-400'
  },
  [TARGET.CLOUD]: {
    label: 'CLOUD (Firebase AI Logic)',
    pill: 'border-sky-400/50 bg-sky-400/10 text-sky-300',
    dot: 'bg-sky-400'
  },
  [TARGET.FALLBACK]: {
    label: 'HYBRID FALLBACK',
    pill: 'border-amber-400/50 bg-amber-400/10 text-amber-300',
    dot: 'bg-amber-400'
  }
};

const TYPE_STYLES = {
  PERSON: 'bg-violet-500/20 text-violet-200 ring-violet-400/40',
  SSN: 'bg-rose-500/20 text-rose-200 ring-rose-400/40',
  EMAIL: 'bg-sky-500/20 text-sky-200 ring-sky-400/40',
  PHONE: 'bg-cyan-500/20 text-cyan-200 ring-cyan-400/40',
  SALARY: 'bg-amber-500/20 text-amber-200 ring-amber-400/40',
  ADDRESS: 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40',
  DOB: 'bg-pink-500/20 text-pink-200 ring-pink-400/40',
  ACCOUNT: 'bg-orange-500/20 text-orange-200 ring-orange-400/40'
};

const SEVERITY_STYLES = {
  High: 'border-rose-400/50 bg-rose-500/15 text-rose-300',
  Medium: 'border-amber-400/50 bg-amber-500/15 text-amber-300',
  Low: 'border-sky-400/50 bg-sky-500/15 text-sky-300'
};

const DEVICE_STATUS = {
  available: { label: 'Gemini Nano ready', tone: 'border-emerald-400/40 text-emerald-300' },
  downloadable: { label: 'Gemini Nano: download needed', tone: 'border-amber-400/40 text-amber-300' },
  downloading: { label: 'Gemini Nano: downloading…', tone: 'border-amber-400/40 text-amber-300' },
  unavailable: { label: 'Gemini Nano unavailable', tone: 'border-rose-400/40 text-rose-300' },
  'no-api': { label: 'Prompt API not found', tone: 'border-rose-400/40 text-rose-300' },
  checking: { label: 'Checking Gemini Nano…', tone: 'border-slate-500/40 text-slate-400' }
};

const APP_CHECK_LABEL = {
  debug: 'App Check: debug token',
  'recaptcha-v3': 'App Check: reCAPTCHA v3',
  'recaptcha-enterprise': 'App Check: reCAPTCHA Enterprise',
  disabled: 'App Check: not configured'
};

/* ───────────────────────────── small hooks ───────────────────────────── */

function useOnline() {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener('online', notify);
      window.addEventListener('offline', notify);
      return () => {
        window.removeEventListener('online', notify);
        window.removeEventListener('offline', notify);
      };
    },
    () => navigator.onLine,
    () => true
  );
}

/* ───────────────────────────── icons ───────────────────────────── */

function Icon({ name, className = 'h-4 w-4' }) {
  const paths = {
    shield: 'M12 3 4 6v6c0 4.4 3.1 8.3 8 9 4.9-.7 8-4.6 8-9V6l-8-3Z',
    chip: 'M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm3 5h4v4h-4z',
    cloud: 'M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 8.5a4.75 4.75 0 0 1 .5 9.5H7Z',
    route: 'M6 4v5a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v5M6 4 3 7m3-3 3 3m9 13-3-3m3 3 3-3',
    history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    close: 'M6 6l12 12M18 6 6 18',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    arrow: 'M5 12h14m-5-5 5 5-5 5',
    clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

/* ───────────────────────────── presentational pieces ───────────────────────────── */

function TelemetryPill({ snapshot, online, busy }) {
  const style = snapshot.target ? TARGET_STYLES[snapshot.target] : null;

  return (
    <div
      className="flex flex-wrap items-stretch gap-2"
      role="status"
      aria-live="polite"
      aria-label="Live hybrid inference telemetry"
      data-testid="telemetry-pill"
    >
      <div
        className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold tracking-wide ${
          busy ? 'border-slate-400/40 bg-slate-400/10 text-slate-200' : style ? style.pill : 'border-slate-600/60 bg-slate-700/20 text-slate-400'
        }`}
        title={snapshot.detail || 'Run an action to see where inference executed'}
      >
        <span
          className={`h-2 w-2 rounded-full ${busy ? 'pulse-dot bg-slate-300' : style ? `${style.dot} pulse-dot` : 'bg-slate-500'}`}
        />
        <span>{busy ? 'RUNNING…' : style ? style.label : 'IDLE: run an action'}</span>
      </div>

      <div
        className="flex items-center gap-1.5 rounded-full border border-slate-600/60 bg-slate-800/60 px-3.5 py-1.5 font-mono text-xs text-slate-200"
        title="Round-trip inference latency of the last run"
      >
        <Icon name="clock" className="h-3.5 w-3.5 text-slate-500" />
        <span data-testid="latency">{snapshot.latencyMs == null ? '— ms' : `${snapshot.latencyMs.toLocaleString()} ms`}</span>
      </div>

      <div
        className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${
          online ? 'border-emerald-400/40 bg-emerald-400/5 text-emerald-300' : 'border-rose-400/50 bg-rose-400/10 text-rose-300'
        }`}
        data-testid="connectivity"
      >
        <span className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-rose-400 pulse-dot'}`} />
        {online ? 'Online' : 'Offline'}
      </div>
    </div>
  );
}

function Chip({ children, tone = 'border-slate-600/50 text-slate-300', title }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border bg-slate-900/40 px-2 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {children}
    </span>
  );
}

function Card({ step, title, subtitle, right, children, className = '' }) {
  return (
    <section className={`card p-4 sm:p-5 ${className}`}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            {step && (
              <span className="grid h-5 w-5 place-items-center rounded-md bg-slate-700/70 text-[11px] text-slate-200">{step}</span>
            )}
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

function FlowStrip({ hasText, redaction, audit, busy }) {
  const steps = [
    { id: 'raw', label: 'Raw text', note: 'stays in browser', done: hasText },
    { id: 'redact', label: 'Redact', note: redaction ? (redaction.engine === 'gemini-nano' ? 'Gemini Nano' : 'rules engine') : 'on-device', done: Boolean(redaction), active: busy === 'redact' },
    { id: 'sanitized', label: 'Sanitized', note: 'tokens only', done: Boolean(redaction) },
    { id: 'infer', label: 'Infer', note: audit ? (audit.target === TARGET.ON_DEVICE ? 'on-device' : 'cloud') : 'cloud / device', done: Boolean(audit), active: busy === 'cloud' || busy === 'auto' },
    { id: 'rehydrate', label: 'Re-hydrate', note: 'local only', done: Boolean(audit) }
  ];

  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-xs" aria-label="Privacy data flow">
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-center gap-1">
          <span
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 ${
              step.active
                ? 'border-sky-400/60 bg-sky-400/10 text-sky-200'
                : step.done
                  ? 'border-emerald-400/40 bg-emerald-400/5 text-emerald-200'
                  : 'border-slate-700 bg-slate-900/40 text-slate-500'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${step.active ? 'pulse-dot bg-sky-300' : step.done ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            <span className="font-semibold">{step.label}</span>
            <span className="hidden text-[10px] opacity-70 sm:inline">{step.note}</span>
          </span>
          {index < steps.length - 1 && <Icon name="arrow" className="h-3.5 w-3.5 text-slate-600" />}
        </li>
      ))}
    </ol>
  );
}

function HighlightedText({ text, entities }) {
  const known = useMemo(() => new Map(entities.map((entity) => [entity.token, entity])), [entities]);
  const parts = useMemo(() => text.split(/(\[[A-Z]+(?:_\d+)?\])/g), [text]);

  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-slate-300">
      {parts.map((part, index) => {
        const entity = known.get(part);
        if (!entity) return <span key={index}>{part}</span>;
        return (
          <mark key={index} className={`rounded px-1 py-px font-semibold ring-1 ${TYPE_STYLES[entity.type]}`} title={entity.type}>
            {part}
          </mark>
        );
      })}
    </pre>
  );
}

function ScoreBar({ label, value, invert = false }) {
  const bad = invert ? value < 40 : value >= 60;
  const mid = invert ? value < 70 : value >= 35;
  const color = bad ? 'bg-rose-400' : mid ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div className="min-w-[8rem] flex-1">
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-sm font-semibold text-white">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-700/70">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          setCopied(false);
        }
      }}
      className="focus-ring inline-flex items-center gap-1 rounded-md border border-slate-600/60 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700/50"
    >
      <Icon name="copy" className="h-3 w-3" />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function TextBlock({ label, value, mono = false, tone = 'text-slate-300' }) {
  if (!value) return null;
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <p className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed ${mono ? 'font-mono text-[12.5px]' : ''} ${tone}`}>{value}</p>
    </div>
  );
}

function RiskCard({ risk, index, view, entities }) {
  const hydrate = (value) => rehydrate(value, entities);
  const renderField = (label, value, props = {}) => {
    if (view === 'compare') {
      return (
        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-lg border border-sky-400/20 bg-sky-400/5 p-2.5">
            <TextBlock label={`${label} · cloud saw`} value={value} {...props} />
          </div>
          <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-2.5">
            <TextBlock label={`${label} · re-hydrated locally`} value={hydrate(value)} {...props} />
          </div>
        </div>
      );
    }
    return <TextBlock label={label} value={view === 'rehydrated' ? hydrate(value) : value} {...props} />;
  };

  const redlineText = view === 'rehydrated' ? hydrate(risk.redline) : risk.redline;

  return (
    <article className="fade-up rounded-xl border border-slate-700/70 bg-slate-900/50 p-3.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-slate-700 text-[11px] font-bold text-slate-200">{index + 1}</span>
        <h3 className="text-sm font-semibold text-white">{risk.title}</h3>
        <span className={`ml-auto rounded-full border px-2 py-0.5 text-[11px] font-bold ${SEVERITY_STYLES[risk.severity]}`}>{risk.severity}</span>
      </div>
      <div className="space-y-2.5">
        {renderField('Clause', risk.clause, { mono: true, tone: 'text-slate-400' })}
        {renderField('Why it matters', risk.why)}
        <div>
          {renderField('Suggested redline', risk.redline, { tone: 'text-emerald-200' })}
          {risk.redline && (
            <div className="mt-1.5">
              <CopyButton text={redlineText} />
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function AuditPanel({ run, view, setView }) {
  const { audit, entities } = run;
  const answeredOnDevice = run.target === TARGET.ON_DEVICE;

  const headline =
    run.kind === 'cloud'
      ? 'Deep Cloud Clause Audit'
      : answeredOnDevice
        ? 'Auto Hybrid Route · answered on-device'
        : 'Auto Hybrid Route · fell back to cloud';

  return (
    <Card
      step="3"
      title={headline}
      subtitle={
        run.kind === 'cloud'
          ? `Mode ${run.mode} · model ${run.model}`
          : `Mode ${run.mode} · ${run.plan.reason}`
      }
      right={
        <div className="inline-flex rounded-lg border border-slate-600/60 bg-slate-900/60 p-0.5 text-[11px]" role="tablist" aria-label="Result view">
          {[
            ['sanitized', 'Sanitized'],
            ['rehydrated', 'Re-hydrated'],
            ['compare', 'Side by side']
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={`focus-ring rounded-md px-2.5 py-1 font-medium ${view === id ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap gap-4 rounded-xl border border-slate-700/60 bg-slate-900/40 p-3">
        <ScoreBar label="Risk score (lower is safer)" value={audit.riskScore} />
        <ScoreBar label="Compliance score" value={audit.complianceScore} invert />
      </div>

      {audit.summary && (
        <p className="mb-3 text-[13px] leading-relaxed text-slate-300">
          <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{audit.docType}</span>
          {view === 'rehydrated' ? rehydrate(audit.summary, entities) : audit.summary}
        </p>
      )}

      {audit.risks.length === 0 ? (
        <p className="rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-sm text-slate-400">The model returned no risks for this text.</p>
      ) : (
        <div className="space-y-3">
          {audit.risks.map((risk, index) => (
            <RiskCard key={`${risk.title}-${index}`} risk={risk} index={index} view={view} entities={entities} />
          ))}
        </div>
      )}

      <details className="mt-3 rounded-lg border border-slate-700/70 bg-slate-950/50 p-3 text-xs text-slate-400">
        <summary className="cursor-pointer select-none font-semibold text-slate-300">
          <Icon name="lock" className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
          Network payload inspector: {run.sentText ? `${run.sentText.length.toLocaleString()} sanitized characters left this device` : 'nothing left this device'}
        </summary>
        {run.sentText ? (
          <div className="mt-2 max-h-56 overflow-auto rounded-md bg-slate-900/80 p-2.5">
            <HighlightedText text={run.sentText} entities={entities} />
          </div>
        ) : (
          <p className="mt-2">Gemini Nano answered locally. No document content was sent to any server.</p>
        )}
      </details>
    </Card>
  );
}

function HistoryDrawer({ open, onClose, items, error, onClear, uid, fromCache }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Audit history">
      <button type="button" className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="Close history" />
      <aside className="slide-in relative flex h-full w-full max-w-md flex-col border-l border-slate-700 bg-slate-950 shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Sanitized audit history</h2>
            <p className="text-[11px] text-slate-500">
              Firestore · users/{uid ? `${uid.slice(0, 6)}…` : '—'}/audits {fromCache ? '· from local cache' : '· live'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className="flex-1 space-y-2.5 overflow-y-auto p-4">
          {error && <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">{error}</p>}
          {!error && items.length === 0 && (
            <p className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
              No runs yet. Run an action and it will appear here in real time. Only sanitized metadata is stored: never your raw text.
            </p>
          )}
          {items.map((item) => {
            const style = TARGET_STYLES[item.target] || TARGET_STYLES[TARGET.FALLBACK];
            const when = item.createdAt?.toDate ? item.createdAt.toDate() : null;
            return (
              <article key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${style.pill}`}>{style.label}</span>
                  <span className="font-mono text-xs text-slate-300">{item.latencyMs} ms</span>
                  {!item.online && <Chip tone="border-rose-400/40 text-rose-300">offline run</Chip>}
                  {item.pending && <Chip tone="border-amber-400/40 text-amber-300">syncing…</Chip>}
                  <span className="ml-auto text-[11px] text-slate-500">{when ? when.toLocaleTimeString() : ''}</span>
                </div>
                <p className="text-sm font-medium text-white">{item.action}</p>
                <p className="text-xs text-slate-400">
                  {item.docType || 'Document'} · {Number(item.charCount || 0).toLocaleString()} chars · mode {item.mode}
                  {typeof item.entityTotal === 'number' ? ` · ${item.entityTotal} entities redacted` : ''}
                </p>
                {typeof item.riskScore === 'number' && (
                  <p className="mt-1 text-xs text-slate-300">
                    Risk <b className="font-mono">{item.riskScore}</b> · Compliance <b className="font-mono">{item.complianceScore}</b>
                  </p>
                )}
                {Array.isArray(item.topRisks) && item.topRisks.length > 0 && (
                  <ul className="mt-1.5 list-inside list-disc text-xs text-slate-400">
                    {item.topRisks.map((risk) => (
                      <li key={risk}>{risk}</li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>

        <footer className="flex items-center justify-between border-t border-slate-800 px-4 py-3">
          <span className="text-[11px] text-slate-500">Showing the 15 most recent runs</span>
          <button
            type="button"
            onClick={onClear}
            disabled={items.length === 0}
            className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-rose-500/40 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
          >
            <Icon name="trash" className="h-3.5 w-3.5" /> Clear history
          </button>
        </footer>
      </aside>
    </div>
  );
}

/* ───────────────────────────── main app ───────────────────────────── */

export default function App() {
  const online = useOnline();
  const snapshot = useSyncExternalStore(telemetry.subscribe, telemetry.getSnapshot, telemetry.getSnapshot);

  const [text, setText] = useState('');
  const [activePreset, setActivePreset] = useState(null);
  const [redaction, setRedaction] = useState(null);
  const [audit, setAudit] = useState(null);
  const [view, setView] = useState('sanitized');
  const [showOriginals, setShowOriginals] = useState(false);

  const [busy, setBusy] = useState(null);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');

  const [config, setConfig] = useState({ ...DEFAULT_HYBRID_CONFIG });
  const [configSource, setConfigSource] = useState('default');
  const [uid, setUid] = useState(null);
  const [authState, setAuthState] = useState(isFirebaseConfigured ? 'signing-in' : 'off');
  const [deviceStatus, setDeviceStatus] = useState('checking');
  const [prep, setPrep] = useState({ active: false, progress: null });

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [historyFromCache, setHistoryFromCache] = useState(false);

  const busyRef = useRef(null);

  /* boot: anonymous auth + Remote Config + device status */
  useEffect(() => {
    let alive = true;
    (async () => {
      const [user, remote] = await Promise.all([ensureAnonymousAuth(), loadHybridConfig()]);
      if (!alive) return;
      setConfig(remote.config);
      setConfigSource(remote.source);
      setUid(user?.uid ?? null);
      setAuthState(user ? 'ready' : isFirebaseConfigured ? 'pending' : 'off');
    })();
    getOnDeviceStatus().then((status) => alive && setDeviceStatus(status));
    return () => {
      alive = false;
    };
  }, []);

  /* retry anonymous sign-in when connectivity returns */
  useEffect(() => {
    if (!online || uid || !isFirebaseConfigured) return;
    ensureAnonymousAuth().then((user) => {
      if (user) {
        setUid(user.uid);
        setAuthState('ready');
      }
    });
  }, [online, uid]);

  /* real-time Firestore history */
  useEffect(() => {
    if (!uid) return undefined;
    setHistoryError('');
    return subscribeAudits(
      uid,
      (items, fromCache) => {
        setHistory(items);
        setHistoryFromCache(fromCache);
      },
      (err) => setHistoryError(`History unavailable: ${err?.code || err?.message || 'unknown error'}`)
    );
  }, [uid]);

  const refreshDevice = useCallback(() => {
    getOnDeviceStatus().then(setDeviceStatus);
  }, []);

  const persist = useCallback(
    (record) => {
      if (!uid) return;
      saveAudit(uid, record).catch((err) => console.warn('[CloakDocs] Could not save audit history:', err?.code || err));
    },
    [uid]
  );

  const redactionFresh = redaction && redaction.sourceText === text;
  const cloudAllowed = config.enable_cloud_deep_audit;
  const charCount = text.length;
  const limit = config.max_local_char_limit;
  const overLimit = charCount > limit;
  const routePreview = useMemo(
    () => planRoute(redactionFresh ? redaction.sanitized.length : charCount, config),
    [redactionFresh, redaction, charCount, config]
  );

  /* ───── actions ───── */

  const runRedact = useCallback(async () => {
    const result = await localRedactAndTriage(text, { config, onStatus: setStatusText });
    setRedaction(result);
    setAudit(null);
    persist(
      buildAuditRecord({
        kind: 'redact',
        action: 'Local PII Redact & Triage',
        target: result.target,
        mode: result.mode,
        engine: result.engine,
        latencyMs: result.latencyMs,
        charCount: result.sourceText.length,
        redaction: result,
        online: navigator.onLine
      })
    );
    return result;
  }, [text, config, persist]);

  const guarded = useCallback(
    async (kind, work) => {
      if (busyRef.current) return;
      if (!text.trim()) {
        setError('Paste a document or load a sample first.');
        return;
      }
      busyRef.current = kind;
      setBusy(kind);
      setError('');
      setStatusText('');
      try {
        await work();
      } catch (err) {
        console.error('[CloakDocs]', err);
        setError(friendlyError(err));
      } finally {
        busyRef.current = null;
        setBusy(null);
        setStatusText('');
        refreshDevice();
      }
    },
    [text, refreshDevice]
  );

  const onRedact = () => guarded('redact', runRedact);

  const onCloudAudit = () =>
    guarded('cloud', async () => {
      const red = redactionFresh ? redaction : await runRedact();
      setStatusText('Sending sanitized text to the cloud…');
      const result = await cloudClauseAudit(red.sanitized, red.entities, { config });
      setAudit({ kind: 'cloud', ...result, entities: red.entities });
      setView('sanitized');
      persist(
        buildAuditRecord({
          kind: 'cloud',
          action: 'Deep Cloud Clause Audit',
          target: result.target,
          mode: result.mode,
          latencyMs: result.latencyMs,
          charCount: result.charCount,
          audit: result.audit,
          online: navigator.onLine
        })
      );
    });

  const onAutoRoute = () =>
    guarded('auto', async () => {
      const red = redactionFresh ? redaction : await runRedact();
      const result = await autoHybridRoute(red.sanitized, red.entities, { config, onStatus: setStatusText });
      setAudit({ kind: 'auto', ...result, entities: red.entities });
      setView('sanitized');
      persist(
        buildAuditRecord({
          kind: 'auto',
          action: 'Auto Hybrid Route',
          target: result.target,
          mode: result.mode,
          latencyMs: result.latencyMs,
          charCount: result.charCount,
          audit: result.audit,
          online: navigator.onLine
        })
      );
    });

  const onPrepare = async () => {
    setError('');
    setPrep({ active: true, progress: 0 });
    try {
      await prepareOnDevice(config, (progress) => setPrep({ active: true, progress }));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setPrep({ active: false, progress: null });
      refreshDevice();
    }
  };

  const loadPreset = (doc) => {
    if (busyRef.current) return;
    setText(doc.text);
    setActivePreset(doc.id);
    setRedaction(null);
    setAudit(null);
    setError('');
  };

  const onClearHistory = async () => {
    try {
      await clearAudits(uid);
    } catch (err) {
      setHistoryError(`Could not clear history: ${err?.code || err?.message}`);
    }
  };

  const deviceChip = DEVICE_STATUS[deviceStatus] || DEVICE_STATUS.unavailable;
  const needsPrepare = deviceStatus === 'downloadable' || deviceStatus === 'downloading';
  const authLabel =
    authState === 'ready' ? `Anonymous · ${uid.slice(0, 6)}` : authState === 'signing-in' ? 'Signing in…' : authState === 'pending' ? 'Auth pending (offline?)' : 'Auth: off';

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-3 pb-10 sm:px-5">
      {/* ───── header ───── */}
      <header className="sticky top-0 z-40 -mx-3 border-b border-slate-800/80 bg-slate-950/85 px-3 py-3 backdrop-blur sm:-mx-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-sky-400 text-slate-950">
              <Icon name="shield" className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold leading-tight tracking-tight text-white">
                CloakDocs <span className="font-normal text-slate-400">· privacy-first hybrid AI workspace</span>
              </h1>
              <p className="text-[11px] text-slate-500">Redact on-device with Gemini Nano. Send only sanitized text to the cloud. Firebase AI Logic hybrid inference.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <TelemetryPill snapshot={snapshot} online={online} busy={busy} />
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="focus-ring inline-flex items-center gap-2 rounded-lg border border-slate-600/60 bg-slate-800/60 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700/60"
            >
              <Icon name="history" /> History
              {history.length > 0 && <span className="rounded bg-slate-600 px-1.5 text-[10px] font-bold">{history.length}</span>}
            </button>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Chip tone={deviceChip.tone} title="Chrome Prompt API availability reported by the browser">
            <Icon name="chip" className="h-3 w-3" /> {deviceChip.label}
          </Chip>
          {needsPrepare && (
            <button
              type="button"
              onClick={onPrepare}
              disabled={prep.active}
              className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-amber-400/50 bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-400/20 disabled:opacity-70"
            >
              {prep.active ? `Downloading… ${Math.round((prep.progress || 0) * 100)}%` : 'Prepare Gemini Nano'}
            </button>
          )}
          <Chip title={`Remote Config source: ${configSource}`}>
            <Icon name="route" className="h-3 w-3" /> max_local_char_limit {limit.toLocaleString()} · cloud audit {cloudAllowed ? 'on' : 'off'} · RC {configSource}
          </Chip>
          <Chip tone={appCheckMode === 'disabled' ? 'border-amber-400/40 text-amber-300' : 'border-slate-600/50 text-slate-300'}>
            <Icon name="lock" className="h-3 w-3" /> {APP_CHECK_LABEL[appCheckMode]}
          </Chip>
          <Chip title={auth?.currentUser?.uid || ''}>{authLabel}</Chip>
        </div>
      </header>

      {/* ───── banners ───── */}
      {!isFirebaseConfigured && (
        <div className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3.5 text-sm text-amber-100" role="alert">
          <b>Firebase is not configured.</b> Copy <code className="rounded bg-black/30 px-1">.env.example</code> to{' '}
          <code className="rounded bg-black/30 px-1">.env</code> and set: {missingConfigKeys.join(', ')}. Local rules-based redaction works now; Gemini Nano,
          cloud audit, history and Remote Config need Firebase.
        </div>
      )}
      {initError && (
        <div className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/10 p-3.5 text-sm text-rose-100" role="alert">
          Firebase failed to initialize: {String(initError.message || initError)}
        </div>
      )}
      {!online && (
        <div className="mt-4 rounded-xl border border-rose-400/30 bg-rose-400/5 p-3 text-sm text-rose-200">
          You are offline. <b>Local PII Redact &amp; Triage</b> still runs on-device. Cloud audits resume when you reconnect.
        </div>
      )}

      <div className="mt-4">
        <FlowStrip hasText={text.trim().length > 0} redaction={redactionFresh ? redaction : null} audit={audit} busy={busy} />
      </div>

      {/* ───── workspace ───── */}
      <main className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* left: input + actions */}
        <div className="space-y-4">
          <Card step="1" title="Document" subtitle="Raw text never leaves this tab. Paste your own or load a realistic sample.">
            <div className="mb-3 grid gap-2 sm:grid-cols-3">
              {SAMPLE_DOCS.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => loadPreset(doc)}
                  disabled={Boolean(busy)}
                  data-testid={`preset-${doc.id}`}
                  className={`focus-ring rounded-xl border p-2.5 text-left transition disabled:opacity-50 ${
                    activePreset === doc.id
                      ? 'border-emerald-400/60 bg-emerald-400/10'
                      : 'border-slate-700 bg-slate-900/50 hover:border-slate-500 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="text-[13px] font-semibold text-white">{doc.label}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-slate-400">{doc.badge}</div>
                </button>
              ))}
            </div>

            <label htmlFor="doc-input" className="sr-only">
              Document text
            </label>
            <textarea
              id="doc-input"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setActivePreset(null);
              }}
              placeholder="Paste a contract, resume, medical or financial document here…"
              spellCheck={false}
              className="focus-ring h-72 w-full resize-y rounded-xl border border-slate-700 bg-slate-950/70 p-3 font-mono text-[12.5px] leading-relaxed text-slate-200 placeholder:text-slate-600"
            />

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
              <span className="font-mono text-slate-300" data-testid="char-count">
                {charCount.toLocaleString()} chars
              </span>
              <div className="flex min-w-[10rem] flex-1 items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700/70" title="Characters vs Remote Config max_local_char_limit">
                  <div
                    className={`h-full rounded-full transition-all ${overLimit ? 'bg-amber-400' : 'bg-emerald-400'}`}
                    style={{ width: `${Math.min(100, (charCount / limit) * 100)}%` }}
                  />
                </div>
                <span className={overLimit ? 'text-amber-300' : 'text-slate-500'}>
                  {overLimit ? 'over local limit → cloud route' : 'within local limit'} · {limit.toLocaleString()}
                </span>
              </div>
              {text && (
                <button
                  type="button"
                  className="focus-ring text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
                  onClick={() => {
                    setText('');
                    setActivePreset(null);
                    setRedaction(null);
                    setAudit(null);
                    setError('');
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </Card>

          <Card step="2" title="Hybrid actions" subtitle="One Firebase AI Logic SDK, three inference modes.">
            <div className="grid gap-2.5">
              <ActionButton
                onClick={onRedact}
                loading={busy === 'redact'}
                disabled={Boolean(busy)}
                tone="emerald"
                icon="chip"
                title="Local PII Redact & Triage"
                note="On-device · works offline · ONLY_ON_DEVICE (rules-engine fallback, never cloud)"
                testId="action-redact"
              />
              <ActionButton
                onClick={onCloudAudit}
                loading={busy === 'cloud'}
                disabled={Boolean(busy) || !cloudAllowed || !online}
                tone="sky"
                icon="cloud"
                title="Deep Cloud Clause Audit (sanitized only)"
                note={
                  !cloudAllowed
                    ? 'Disabled by Remote Config: enable_cloud_deep_audit = false'
                    : !online
                      ? 'Offline: reconnect to send the sanitized text'
                      : 'Top 3 risks, severity, redlines · ONLY_IN_CLOUD'
                }
                testId="action-cloud"
              />
              <ActionButton
                onClick={onAutoRoute}
                loading={busy === 'auto'}
                disabled={Boolean(busy)}
                tone="amber"
                icon="route"
                title="Auto Hybrid Route (smart threshold)"
                note={`PREFER_ON_DEVICE · now would use ${routePreview.mode}`}
                testId="action-auto"
              />
            </div>

            <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
              <b className="text-slate-400">Route preview:</b> {routePreview.reason}
            </p>

            <div className="mt-2 min-h-[1.25rem] text-xs" aria-live="polite">
              {busy && statusText && <span className="text-sky-300">{statusText}</span>}
              {error && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2.5 text-rose-200" role="alert" data-testid="error">
                  {error}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* right: results */}
        <div className="space-y-4">
          {!redaction && !audit && (
            <Card title="Results" subtitle="Sanitized text, entity map and risk analysis appear here.">
              <div className="grid place-items-center rounded-xl border border-dashed border-slate-700 px-6 py-14 text-center">
                <Icon name="shield" className="mb-3 h-8 w-8 text-slate-600" />
                <p className="max-w-sm text-sm text-slate-400">
                  Load a sample and run <b className="text-emerald-300">Local PII Redact &amp; Triage</b>. Try toggling DevTools → Network → Offline first to
                  watch it keep working on-device.
                </p>
              </div>
            </Card>
          )}

          {redaction && (
            <Card
              step="R"
              title="Local redaction result"
              subtitle={
                redaction.engine === 'gemini-nano'
                  ? 'Gemini Nano + rules engine · executed on this device'
                  : `Rules engine fallback · ${redaction.fallbackReason || 'Gemini Nano not used'}`
              }
              right={
                <div className="flex flex-wrap gap-1.5">
                  {!redactionFresh && <Chip tone="border-amber-400/40 text-amber-300">text edited since: re-run</Chip>}
                  <Chip tone={TARGET_STYLES[redaction.target].pill}>{redaction.latencyMs} ms</Chip>
                  <Chip>{redaction.total} entities · {redaction.replacements} replacements</Chip>
                </div>
              }
            >
              <div className="mb-3 flex flex-wrap gap-1.5">
                {Object.entries(redaction.counts).map(([type, count]) => (
                  <span key={type} className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ${TYPE_STYLES[type]}`}>
                    {type} × {count}
                  </span>
                ))}
                {redaction.total === 0 && <span className="text-xs text-slate-500">No PII detected.</span>}
              </div>

              <div className="mb-3 rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {redaction.summary ? 'Local summary · Gemini Nano' : 'Local triage · rules engine'} · {redaction.docType}
                </div>
                {redaction.summary ? (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300">{redaction.summary}</p>
                ) : redaction.triage.length === 0 ? (
                  <p className="text-[13px] text-slate-400">No risky clause keywords detected.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {redaction.triage.map((flag) => (
                      <li key={flag.id} className="flex items-start gap-2 text-[13px]">
                        <span className={`mt-0.5 rounded-full border px-1.5 py-px text-[10px] font-bold ${SEVERITY_STYLES[flag.severity]}`}>{flag.severity}</span>
                        <span className="text-slate-300">
                          <b className="text-white">{flag.label}</b>
                          <span className="block text-xs text-slate-500">{flag.excerpt}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-300">Sanitized text (the only thing that may leave your device)</h3>
                <CopyButton text={redaction.sanitized} />
              </div>
              <div className="max-h-72 overflow-auto rounded-xl border border-slate-700 bg-slate-950/70 p-3">
                <HighlightedText text={redaction.sanitized} entities={redaction.entities} />
              </div>

              {redaction.entities.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-slate-300">Reversible token map (browser memory only)</h3>
                    <button
                      type="button"
                      onClick={() => setShowOriginals((value) => !value)}
                      className="focus-ring inline-flex items-center gap-1 rounded-md border border-slate-600/60 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700/50"
                    >
                      <Icon name="eye" className="h-3 w-3" /> {showOriginals ? 'Hide originals' : 'Reveal originals'}
                    </button>
                  </div>
                  <div className="max-h-52 overflow-auto rounded-xl border border-slate-700">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 bg-slate-900 text-slate-400">
                        <tr>
                          <th className="px-2.5 py-1.5 font-medium">Token</th>
                          <th className="px-2.5 py-1.5 font-medium">Original</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">×</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {redaction.entities.map((entity) => (
                          <tr key={entity.token}>
                            <td className="px-2.5 py-1.5">
                              <span className={`rounded px-1.5 py-px font-mono font-semibold ring-1 ${TYPE_STYLES[entity.type]}`}>{entity.token}</span>
                            </td>
                            <td className="max-w-[16rem] truncate px-2.5 py-1.5 font-mono text-slate-300" title={showOriginals ? entity.forms.join(' | ') : ''}>
                              {showOriginals ? entity.forms.join(' | ') : '•'.repeat(Math.min(14, Math.max(6, entity.value.length)))}
                            </td>
                            <td className="px-2.5 py-1.5 text-right text-slate-500">{entity.occurrences}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>
          )}

          {audit && <AuditPanel run={audit} view={view} setView={setView} />}
        </div>
      </main>

      <footer className="mt-8 border-t border-slate-800 pt-4 text-[11px] leading-relaxed text-slate-500">
        <p>
          CloakDocs is an open-source demo (Apache-2.0) built for #BuildHybridAI 2026 on Firebase AI Logic hybrid inference. Output is triage assistance, not
          legal or medical advice. Source:{' '}
          <a className="text-sky-400 hover:underline" href={REPO_URL} target="_blank" rel="noreferrer">
            github.com/yashpy/CloakDocs
          </a>
          .
        </p>
      </footer>

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        items={history}
        error={historyError}
        onClear={onClearHistory}
        uid={uid}
        fromCache={historyFromCache}
      />
    </div>
  );
}

/* ───────────────────────────── action button ───────────────────────────── */

const ACTION_TONES = {
  emerald: 'border-emerald-400/40 bg-emerald-400/10 hover:bg-emerald-400/20 text-emerald-100',
  sky: 'border-sky-400/40 bg-sky-400/10 hover:bg-sky-400/20 text-sky-100',
  amber: 'border-amber-400/40 bg-amber-400/10 hover:bg-amber-400/20 text-amber-100'
};

function ActionButton({ onClick, loading, disabled, tone, icon, title, note, testId }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`focus-ring flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${ACTION_TONES[tone]}`}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-black/25">
        {loading ? <span className="spinner" /> : <Icon name={icon} className="h-5 w-5" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="block text-[11px] leading-snug opacity-80">{note}</span>
      </span>
    </button>
  );
}
