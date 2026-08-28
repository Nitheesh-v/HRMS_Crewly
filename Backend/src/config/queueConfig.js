// ============================================================
// 🚦 PHASE 28.2 — BULLMQ QUEUE/WORKER CONFIGURATION
//
// Central, pure, testable configuration for Crewly's BullMQ
// foundation. Reads process.env at CALL time (never at import)
// so tests and scripts can override safely.
//
// Environment isolation:
//   Queue keys are namespaced as  <prefix>:<queue>:<type>
//   (e.g. crewly:development:system:wait). The prefix defaults
//   to crewly:<NODE_ENV> so development/staging/production can
//   never share a queue namespace on the same Redis instance.
//   Tenant IDs are NEVER part of the prefix — they belong in
//   individual job payloads as trusted references later.
// ============================================================

// Reserved queue names (28.2 instantiates SYSTEM only).
export const QUEUE_NAMES = {
  SYSTEM: 'system',
  EMAIL: 'email',
  RESUME: 'resume',
  ATS: 'ats',
  SCHEDULED: 'scheduled',
  DOCUMENTS: 'documents',
  BGV: 'bgv',
  ANALYTICS: 'analytics',
};

// Centralized job names (28.2: infrastructure jobs; 28.3: email jobs).
// Email jobs are domain-oriented; there is deliberately NO
// SEND_ARBITRARY_EMAIL job — only trusted business services dispatch.
export const JOB_NAMES = {
  SYSTEM_HEALTH_CHECK: 'system-health-check',
  SYSTEM_RETRY_TEST: 'system-retry-test',
  EMAIL_APPLICATION_RECEIVED: 'email-application-received',
  EMAIL_PIPELINE_UPDATE: 'email-pipeline-update',
  EMAIL_INTERVIEW_CANDIDATE: 'email-interview-candidate',
  EMAIL_INTERVIEW_INTERVIEWER: 'email-interview-interviewer',
  EMAIL_OFFER_DECISION: 'email-offer-decision',
  EMAIL_OFFER_WITHDRAWN: 'email-offer-withdrawn',
  EMAIL_PREONBOARDING_DOC_DECISION: 'email-preonboarding-doc-decision',
  // 28.4: processing jobs (resume parsing + ATS matching). One job name
  // per stage — reprocess/recovery reuse the same job with a fresh
  // deterministic job id (version-aware), not extra job names.
  RESUME_PARSE: 'resume-parse',
  ATS_PROCESS: 'ats-process',
};

export const EMAIL_JOB_NAMES = Object.values(JOB_NAMES).filter((name) =>
  name.startsWith('email-')
);

// 28.4 processing job names (resume queue + ats queue).
export const PROCESSING_JOB_NAMES = Object.freeze([
  JOB_NAMES.RESUME_PARSE,
  JOB_NAMES.ATS_PROCESS,
]);

// --- Defaults ------------------------------------------------------

export const DEFAULT_WORKER_CONCURRENCY = 2;
const MIN_WORKER_CONCURRENCY = 1;
const MAX_WORKER_CONCURRENCY = 50;

// Safe, bounded job defaults:
//  - 3 attempts with exponential backoff starting at 1s
//  - retain the 100 most recent completed jobs for diagnostics
//  - retain more (500) failed jobs for troubleshooting
// Business history stays in MongoDB/Audit — never in queue retention.
export const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

export const getDefaultJobOptions = () => ({
  attempts: DEFAULT_JOB_OPTIONS.attempts,
  backoff: { ...DEFAULT_JOB_OPTIONS.backoff },
  removeOnComplete: { ...DEFAULT_JOB_OPTIONS.removeOnComplete },
  removeOnFail: { ...DEFAULT_JOB_OPTIONS.removeOnFail },
});

// Email-specific retry policy (28.3): SMTP failures are usually
// transient; 5 attempts with 2s exponential backoff (~30s total)
// balances prompt retry against provider load. Non-retryable
// failures (auth, invalid recipient, config) fail fast inside the
// processor and never consume these attempts.
export const EMAIL_JOB_OPTIONS = Object.freeze({
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

export const getEmailJobOptions = () => ({
  attempts: EMAIL_JOB_OPTIONS.attempts,
  backoff: { ...EMAIL_JOB_OPTIONS.backoff },
  removeOnComplete: { ...EMAIL_JOB_OPTIONS.removeOnComplete },
  removeOnFail: { ...EMAIL_JOB_OPTIONS.removeOnFail },
});

// 28.4 processing retry policy. Resume parsing: 3 attempts, 2s
// exponential backoff — enough for transient storage/Mongo blips,
// while permanent content errors (corrupt PDF, password protected)
// fail fast inside the processor and never consume these attempts.
// Business attempt accounting (CandidateResume.parsingAttempts, max 8)
// is separate and persists across reconciliations.
export const RESUME_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

// ATS scoring is deterministic and local — attempts only cover
// transient Mongo/infrastructure failures.
export const ATS_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

export const getResumeJobOptions = () => ({
  attempts: RESUME_JOB_OPTIONS.attempts,
  backoff: { ...RESUME_JOB_OPTIONS.backoff },
  removeOnComplete: { ...RESUME_JOB_OPTIONS.removeOnComplete },
  removeOnFail: { ...RESUME_JOB_OPTIONS.removeOnFail },
});

export const getATSJobOptions = () => ({
  attempts: ATS_JOB_OPTIONS.attempts,
  backoff: { ...ATS_JOB_OPTIONS.backoff },
  removeOnComplete: { ...ATS_JOB_OPTIONS.removeOnComplete },
  removeOnFail: { ...ATS_JOB_OPTIONS.removeOnFail },
});

// --- Prefix / environment isolation --------------------------------

const sanitizeSegment = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

// Queue key prefix. BULLMQ_PREFIX (sanitized) wins when provided and
// valid; otherwise crewly:<NODE_ENV> (unknown env values are safe —
// they are sanitized, never a crash).
export const getQueuePrefix = (source = process.env) => {
  const override = sanitizeSegment(source.BULLMQ_PREFIX);
  if (override) return override;
  const nodeEnv = sanitizeSegment(source.NODE_ENV) || 'development';
  return `crewly:${nodeEnv}`;
};

// --- Worker concurrency --------------------------------------------

export const parseWorkerConcurrency = (source = process.env) => {
  const parsed = Number(source.WORKER_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WORKER_CONCURRENCY;
  return Math.min(
    MAX_WORKER_CONCURRENCY,
    Math.max(MIN_WORKER_CONCURRENCY, Math.trunc(parsed))
  );
};

// Email worker: lower ceiling than the system worker on purpose.
// SMTP providers rate-limit sending; email is externally bounded
// (future CPU-bound workers like resume parsing get their own vars).
export const DEFAULT_EMAIL_WORKER_CONCURRENCY = 2;
const MIN_EMAIL_WORKER_CONCURRENCY = 1;
const MAX_EMAIL_WORKER_CONCURRENCY = 10;

export const parseEmailWorkerConcurrency = (source = process.env) => {
  const parsed = Number(source.EMAIL_WORKER_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EMAIL_WORKER_CONCURRENCY;
  return Math.min(
    MAX_EMAIL_WORKER_CONCURRENCY,
    Math.max(MIN_EMAIL_WORKER_CONCURRENCY, Math.trunc(parsed))
  );
};

// 28.4 processing workers. Resume parsing is CPU-bound (PDF/DOCX
// extraction + parser) — default 1 so a single large file cannot
// starve the process or other tenants' jobs. ATS scoring is light
// and deterministic — default 2.
export const DEFAULT_RESUME_WORKER_CONCURRENCY = 1;
export const DEFAULT_ATS_WORKER_CONCURRENCY = 2;
const MIN_PROCESSING_WORKER_CONCURRENCY = 1;
const MAX_RESUME_WORKER_CONCURRENCY = 4;
const MAX_ATS_WORKER_CONCURRENCY = 10;

export const parseResumeWorkerConcurrency = (source = process.env) => {
  const parsed = Number(source.RESUME_WORKER_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESUME_WORKER_CONCURRENCY;
  return Math.min(
    MAX_RESUME_WORKER_CONCURRENCY,
    Math.max(MIN_PROCESSING_WORKER_CONCURRENCY, Math.trunc(parsed))
  );
};

export const parseATSWorkerConcurrency = (source = process.env) => {
  const parsed = Number(source.ATS_WORKER_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ATS_WORKER_CONCURRENCY;
  return Math.min(
    MAX_ATS_WORKER_CONCURRENCY,
    Math.max(MIN_PROCESSING_WORKER_CONCURRENCY, Math.trunc(parsed))
  );
};

// --- Job ID / idempotency convention --------------------------------

// Deterministic job IDs let duplicate dispatches collapse:
//   buildJobId('resume-parse', resumeId, parserVersion)
//   buildJobId('offer-expiry', offerId, expiryTimestamp)
// Rules: colon-joined, non-empty parts, no spaces or control
// characters, bounded length. Never put secrets/tokens/PII in IDs.
const JOB_ID_MAX_LENGTH = 128;

const hasUnsafeCharacters = (value) => {
  if (/\s/.test(value)) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

// NOTE: the ':' join is valid for Mongo keys (e.g. eventKey) but
// BullMQ REJECTS custom job ids containing ':' ("Custom Id cannot
// contain :"). When passing the result to Queue.add as jobId, use a
// single hyphen-joined part instead (see buildEmailJobId in
// services/emailDeliveryService.js).
export const buildJobId = (...parts) => {
  const values = parts.map((part) => String(part ?? ''));
  for (const value of values) {
    if (value.length === 0) {
      throw new Error('buildJobId: job id parts must be non-empty');
    }
    if (hasUnsafeCharacters(value)) {
      throw new Error('buildJobId: job id parts must not contain spaces or control characters');
    }
  }
  const id = values.join(':');
  if (id.length > JOB_ID_MAX_LENGTH) {
    throw new Error(`buildJobId: job id exceeds ${JOB_ID_MAX_LENGTH} characters`);
  }
  return id;
};

// --- Safe log redaction ---------------------------------------------

// Redacts URL userinfo (user:password@) from any text before it is
// logged. Defense in depth: BullMQ/ioredis errors normally do not
// embed credentials, but this guarantees it for 28.2+.
export const redactConnectionSecrets = (text) =>
  String(text ?? '').replace(/(:\/\/)[^\s/?#]+@/g, '$1***@');

// --- Queue name guard -------------------------------------------------

export const isKnownQueueName = (name) =>
  Object.values(QUEUE_NAMES).includes(name);

// Safe, secret-free configuration summary (for logs / future 28.8 ops).
export const getQueueConfigSummary = (source = process.env) => ({
  prefix: getQueuePrefix(source),
  concurrency: parseWorkerConcurrency(source),
  jobDefaults: getDefaultJobOptions(),
});
