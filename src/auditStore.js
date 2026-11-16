/**
 * Firestore audit history (per anonymous UID).
 *
 * Only sanitized telemetry is stored: execution target, latency, scores, entity
 * COUNTS and token-only summaries. Raw document text and the token → value map
 * stay in browser memory. firestore.rules rejects any other field.
 */
import {
  addDoc,
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  writeBatch
} from 'firebase/firestore';
import { db } from './firebase.js';

const auditsCollection = (uid) => collection(db, 'users', uid, 'audits');

/**
 * Build a Firestore-safe record. Never accepts raw text: callers pass derived,
 * already-sanitized values only.
 */
export function buildAuditRecord({ kind, action, target, mode, engine, latencyMs, charCount, redaction, audit, online }) {
  const record = {
    kind,
    action,
    target,
    mode: String(mode || 'unknown'),
    latencyMs: Math.max(0, Math.round(latencyMs || 0)),
    charCount: Math.max(0, Math.round(charCount || 0)),
    online: Boolean(online)
  };

  if (engine) record.engine = engine;

  if (redaction) {
    record.entityCounts = { ...redaction.counts };
    record.entityTotal = redaction.total;
    record.docType = redaction.docType;
    if (redaction.summary) record.summary = redaction.summary.slice(0, 500);
  }

  if (audit) {
    record.riskScore = audit.riskScore;
    record.complianceScore = audit.complianceScore;
    record.docType = audit.docType;
    record.topRisks = audit.risks.map((risk) => `${risk.severity}: ${risk.title}`.slice(0, 160));
    if (audit.summary) record.summary = audit.summary.slice(0, 500);
  }

  return record;
}

/** Fire-and-forget friendly: resolves when the server acks, queues offline otherwise. */
export function saveAudit(uid, record) {
  if (!db || !uid) return Promise.resolve(null);
  return addDoc(auditsCollection(uid), { ...record, createdAt: serverTimestamp() });
}

/** Real-time listener for the most recent audits. Returns an unsubscribe function. */
export function subscribeAudits(uid, onData, onError) {
  if (!db || !uid) return () => {};
  const recent = query(auditsCollection(uid), orderBy('createdAt', 'desc'), limit(15));
  return onSnapshot(
    recent,
    { includeMetadataChanges: true },
    (snapshot) => {
      onData(
        snapshot.docs.map((doc) => ({
          id: doc.id,
          pending: doc.metadata.hasPendingWrites,
          ...doc.data({ serverTimestamps: 'estimate' })
        })),
        snapshot.metadata.fromCache
      );
    },
    (error) => onError?.(error)
  );
}

/** Delete the caller's history (privacy control). */
export async function clearAudits(uid) {
  if (!db || !uid) return 0;
  const snapshot = await getDocs(query(auditsCollection(uid), limit(200)));
  if (snapshot.empty) return 0;
  const batch = writeBatch(db);
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  return snapshot.size;
}
