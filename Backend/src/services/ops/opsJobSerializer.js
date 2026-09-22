// ============================================================
// 🛡️ PHASE 28.8 — SAFE JOB SERIALIZER (ops views)
//
// Turns a BullMQ Job into a small, safe, metadata-only view for
// the Super Admin ops UI. RULES (enforced here, not by caller
// discipline):
//
//   - Whitelist ONLY: jobId, name, queue, state, timestamps,
//     attempts, safe failure category, sanitized message,
//     correlation reference (type + id), redacted tenant ref.
//   - NEVER: job.data (except data.companyId, read for a redacted
//     tenant reference only), job.returnvalue, raw stack traces,
//     raw failedReason verbatim (sanitized + truncated to 300).
//   - Sanitization: credential URLs, JWT/Bearer/long tokens,
//     SMTP URLs, key=value secrets, absolute file paths.
//   - Correlation refs are entity TYPE + ObjectId only — no
//     candidate names, emails, document content, BGV evidence.
//
// Pure (no Redis/Mongo) — fully hermetic.
// ============================================================

import {
  classifyOpsFailure,
  getRetryPolicy,
} from './opsQueueRegistry.js';

const MAX_MESSAGE_CHARS = 300;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

/**
 * Redact credential-like material from an error message.
 * Returns a short, human-safe string. Pure — exported for tests.
 */
export const redactSensitiveText = (text) => {
  let out = String(text || '');
  // 1) Credential URLs (scheme://user:pass@host …) and bare
  //    scheme://token-style URLs → neutral placeholder.
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<url>');
  // 2) Bearer tokens first (covers "Authorization: Bearer x").
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <token>');
  // 3) JWTs (three dotted base64 segments).
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[^\s"'<>]{8,}/g, '<token>');
  // 4) key=value / key: secret pairs for common secret names
  //    (skipped when the value is the already-redacted "Bearer").
  out = out.replace(
    /\b(user|pass|password|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)\b(\s*[:=]\s*)(?!Bearer\b)([^\s"'<>]{4,})/gi,
    '$1$2<redacted>'
  );
  // 4) Long opaque tokens (≥40 chars of token-ish charset).
  out = out.replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, '<token>');
  // 5) Absolute filesystem paths (Windows + POSIX).
  out = out.replace(
    /(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var|etc|opt|root)[\\/])[^\s:"'<>){},]{2,}/g,
    '<path>'
  );
  // 6) Collapse whitespace + hard cap.
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > MAX_MESSAGE_CHARS) {
    out = `${out.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
  }
  return out;
};

// Deterministic job-id prefixes (28.2–28.6 scheme) → entity type.
// Longest prefixes first; only a VALID ObjectId segment is ever
// surfaced (first ObjectId segment after the prefix = entity id).
const ENTITY_PREFIXES = Object.freeze([
  ['document-process', 'DocumentVersion'],
  ['document-security', 'DocumentVersion'],
  ['bgv-result', 'BgvCase'],
  ['bgv-poll', 'BgvCase'],
  ['bgv-check', 'BgvCase'],
  ['bgv-reminder', 'BgvCase'],
  ['resume-parse', 'CandidateResume'],
  // ats-process-<candidateId>-<parseResultId>-<epoch>
  ['ats-process', 'Candidate'],
  ['interview-reminder', 'Interview'],
  ['offer-expiry-reminder', 'Offer'],
  ['offer-expire', 'Offer'],
  ['preonboarding-reminder', 'PreOnboarding'],
  // email job ids are "email-<deliveryId>" (buildEmailJobId).
  ['email', 'EmailDelivery'],
]);

/**
 * Extract a safe correlation reference (entity type + id only)
 * from a deterministic job id. Returns null for ids without a
 * recognizable, verifiable entity reference. Pure.
 */
export const extractEntityRef = (jobId) => {
  const id = String(jobId || '');
  for (const [prefix, type] of ENTITY_PREFIXES) {
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length).replace(/^-/, '');
    const segments = rest.split('-');
    for (const segment of segments) {
      if (OBJECT_ID.test(segment)) {
        return { type, id: segment };
      }
    }
    return null; // prefix matched but no verifiable id inside
  }
  return null;
};

/**
 * Build the safe ops view of one job.
 *
 * @param {object} job   BullMQ Job (or a plain object with the
 *                       same fields — hermetic tests).
 * @param {string} queueName allowed queue name
 * @param {string} state   current job state ('failed', 'completed', …)
 */
export const serializeJobForOps = (job, queueName, state = 'failed') => {
  if (!job) return null;

  const attemptsMade = Number(job.attemptsMade ?? 0) || 0;
  const maxAttempts = Number(job.opts?.maxAttempts ?? 0) || 0;
  const rawReason = String(job.failedReason || '');
  const category = classifyOpsFailure(rawReason, { attemptsMade, maxAttempts });
  const policy = getRetryPolicy(queueName, String(job.name || ''), category, {
    attemptsMade,
    maxAttempts,
  });

  // The ONLY data field ever touched: companyId, for a redacted
  // tenant reference. Invalid/absent → null.
  const rawCompanyId = job.data?.companyId;
  const tenantRef =
    typeof rawCompanyId === 'string' && OBJECT_ID.test(rawCompanyId)
      ? rawCompanyId
      : null;

  return {
    jobId: String(job.id ?? ''),
    name: String(job.name || 'unknown'),
    queue: queueName,
    state,
    createdAt: job.createdAt || job.timestamp || null,
    failedAt: job.failedAt || null,
    attemptsMade,
    maxAttempts,
    safeFailureCategory: category,
    message: redactSensitiveText(rawReason),
    correlationRef: extractEntityRef(job.id),
    tenantRef,
    retryable: policy.retryable,
    retryReason: policy.reason,
  };
};
