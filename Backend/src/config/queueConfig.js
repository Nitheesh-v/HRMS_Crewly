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
  // Phase 29.6 — payroll calculation engine (thousands of employees:
  // this is the workload that genuinely needs a background queue).
  PAYROLL: 'payroll',
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
  // 28.5: offer reminder (candidate nudge, non-sensitive — the
  // token-bearing offer-SEND email stays synchronous by 28.3 policy).
  EMAIL_OFFER_REMINDER: 'email-offer-reminder',
  // 28.6: pre-onboarding candidate reminder (non-sensitive nudge —
  // the token-bearing invite email stays synchronous by 28.3 policy)
  // and BGV HR reminder (reference-based, no candidate PII in payload).
  EMAIL_PREONBOARDING_REMINDER: 'email-preonboarding-reminder',
  EMAIL_BGV_REMINDER: 'email-bgv-reminder',
  // 29.6: payroll calculation run (background, progress-tracked).
  PAYROLL_RUN: 'payroll-run',
  // 29.7: payroll review export generation (same queue, own job name).
  PAYROLL_EXPORT: 'payroll-export',
  PAYROLL_PAYMENT_FILE: 'payroll-payment-file',
  // 29.9: payslip generation, bulk ZIP download and bulk email. Same queue,
  // own job names — the worker rebuilds everything from Mongo, so the payload
  // carries references only.
  PAYSLIP_GENERATE: 'payslip-generate',
  PAYSLIP_ZIP: 'payslip-zip',
  PAYSLIP_EMAIL: 'payslip-email',
  // 29.10: statutory compliance — monthly report generation, large/annual
  // export files and filing reminders. Same queue, own job names; the worker
  // rebuilds every figure from the 29.6 snapshots, so the payload carries
  // references only.
  STATUTORY_GENERATE: 'statutory-generate',
  STATUTORY_EXPORT: 'statutory-export',
  COMPLIANCE_REMINDER: 'compliance-reminder',
  // 29.11: final settlement — the F&F statement PDF and the bulk settlement
  // register. Same queue, own job names; the worker rebuilds from MongoDB, so
  // the payload carries references only.
  FNF_STATEMENT: 'fnf-statement',
  FNF_REGISTER: 'fnf-register',
  // 29.12: payroll analytics — large report exports, scheduled reports and
  // the executive dashboard refresh. Same queue, own job names; the worker
  // rebuilds every figure from the 29.6 snapshots, so the payload carries
  // references only.
  ANALYTICS_EXPORT: 'analytics-export',
  ANALYTICS_SCHEDULE: 'analytics-schedule',
  ANALYTICS_REFRESH: 'analytics-refresh',
  // 28.4: processing jobs (resume parsing + ATS matching). One job name
  // per stage — reprocess/recovery reuse the same job with a fresh
  // deterministic job id (version-aware), not extra job names.
  RESUME_PARSE: 'resume-parse',
  ATS_PROCESS: 'ats-process',
  // 28.5: scheduled (delayed) jobs — one-time future execution via
  // native BullMQ delay (no QueueScheduler).
  INTERVIEW_REMINDER: 'interview-reminder',
  OFFER_EXPIRY_REMINDER: 'offer-expiry-reminder',
  OFFER_EXPIRE: 'offer-expire',
  // 28.6: document security/processing + BGV provider jobs.
  DOCUMENT_PROCESS: 'document-process',
  BGV_PROCESS_CHECK: 'bgv-process-check',
  BGV_PROVIDER_POLL: 'bgv-provider-poll',
  BGV_PROCESS_RESULT: 'bgv-process-result',
  // 28.6: scheduled reminders (SCHEDULED queue, 28.5 architecture).
  PREONBOARDING_REMINDER: 'preonboarding-reminder',
  BGV_REMINDER: 'bgv-reminder',
};

export const EMAIL_JOB_NAMES = Object.values(JOB_NAMES).filter((name) =>
  name.startsWith('email-')
);

// 28.4 processing job names (resume queue + ats queue).
export const PROCESSING_JOB_NAMES = Object.freeze([
  JOB_NAMES.RESUME_PARSE,
  JOB_NAMES.ATS_PROCESS,
]);

// 28.5 scheduled job names (scheduled queue — delayed one-time jobs).
export const SCHEDULED_JOB_NAMES = Object.freeze([
  JOB_NAMES.INTERVIEW_REMINDER,
  JOB_NAMES.OFFER_EXPIRY_REMINDER,
  JOB_NAMES.OFFER_EXPIRE,
  // 28.6: pre-onboarding + BGV reminders ride the same architecture.
  JOB_NAMES.PREONBOARDING_REMINDER,
  JOB_NAMES.BGV_REMINDER,
]);

// 29.6 payroll job names (the payroll queue).
export const PAYROLL_JOB_NAMES = Object.freeze([
  JOB_NAMES.PAYROLL_RUN,
  JOB_NAMES.PAYROLL_EXPORT,
  JOB_NAMES.PAYROLL_PAYMENT_FILE,
  // 29.9 payslips
  JOB_NAMES.PAYSLIP_GENERATE,
  JOB_NAMES.PAYSLIP_ZIP,
  JOB_NAMES.PAYSLIP_EMAIL,
  // 29.10 statutory compliance
  JOB_NAMES.STATUTORY_GENERATE,
  JOB_NAMES.STATUTORY_EXPORT,
  JOB_NAMES.COMPLIANCE_REMINDER,
  // 29.11 final settlement
  JOB_NAMES.FNF_STATEMENT,
  JOB_NAMES.FNF_REGISTER,
  // 29.12 payroll analytics
  JOB_NAMES.ANALYTICS_EXPORT,
  JOB_NAMES.ANALYTICS_SCHEDULE,
  JOB_NAMES.ANALYTICS_REFRESH,
]);

// 28.6 document + BGV job names (their own reserved queues).
export const DOCUMENT_JOB_NAMES = Object.freeze([JOB_NAMES.DOCUMENT_PROCESS]);
export const BGV_JOB_NAMES = Object.freeze([
  JOB_NAMES.BGV_PROCESS_CHECK,
  JOB_NAMES.BGV_PROVIDER_POLL,
  JOB_NAMES.BGV_PROCESS_RESULT,
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

// 28.5 scheduled retry policy. Scheduled jobs are light (validate +
// dispatch an email intent / one atomic transition); attempts cover
// transient Mongo/Redis blips only. Stale/terminal business states
// complete as SKIPPED inside the processor and never consume these.
export const SCHEDULED_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

// 29.6 payroll jobs: a run is long (hundreds to thousands of
// employees) and must not be duplicated. ONE attempt (a partial run
// is recoverable by re-running; duplicate runs would double-write
// snapshots), no automatic retry, and the job id is deterministic per
// run so BullMQ itself de-duplicates (28.4 discipline).
export const PAYROLL_JOB_OPTIONS = Object.freeze({
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

export const getPayrollJobOptions = () => ({
  attempts: PAYROLL_JOB_OPTIONS.attempts,
  removeOnComplete: { ...PAYROLL_JOB_OPTIONS.removeOnComplete },
  removeOnFail: { ...PAYROLL_JOB_OPTIONS.removeOnFail },
});

export const getScheduledJobOptions = () => ({
  attempts: SCHEDULED_JOB_OPTIONS.attempts,
  backoff: { ...SCHEDULED_JOB_OPTIONS.backoff },
  removeOnComplete: { ...SCHEDULED_JOB_OPTIONS.removeOnComplete },
  removeOnFail: { ...SCHEDULED_JOB_OPTIONS.removeOnFail },
});

// 28.6 document jobs: bounded retries for transient storage/scanner
// blips. Permanent categories (unsupported file, corrupt file,
// integrity mismatch, security rejection) complete as
// PROCESSING_FAILED inside the processor and never consume these.
export const DOCUMENT_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
});

export const getDocumentJobOptions = () => ({
  attempts: DOCUMENT_JOB_OPTIONS.attempts,
  backoff: { ...DOCUMENT_JOB_OPTIONS.backoff },
  removeOnComplete: { ...DOCUMENT_JOB_OPTIONS.removeOnComplete },
  removeOnFail: { ...DOCUMENT_JOB_OPTIONS.removeOnFail },
});

// 28.6 BGV jobs: conservative (future external vendors rate-limit).
export const BGV_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 3000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
});

export const getBgvJobOptions = () => ({
  attempts: BGV_JOB_OPTIONS.attempts,
  backoff: { ...BGV_JOB_OPTIONS.backoff },
  removeOnComplete: { ...BGV_JOB_OPTIONS.removeOnComplete },
  removeOnFail: { ...BGV_JOB_OPTIONS.removeOnFail },
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

// 28.5 scheduled worker: jobs are light (validation + email-intent
// dispatch / one atomic transition) — moderate default, bounded.
export const DEFAULT_SCHEDULED_WORKER_CONCURRENCY = 4;
const MAX_SCHEDULED_WORKER_CONCURRENCY = 10;

export const parseScheduledWorkerConcurrency = (source = process.env) => {
  const parsed = Number(source.SCHEDULED_WORKER_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SCHEDULED_WORKER_CONCURRENCY;
  return Math.min(
    MAX_SCHEDULED_WORKER_CONCURRENCY,
    Math.max(MIN_PROCESSING_WORKER_CONCURRENCY, Math.trunc(parsed))
  );
};

// 28.5 offer reminder offset: one candidate nudge at
// expiry − offset. If the offer is sent inside that window, NO
// reminder is scheduled (the send email is the notice). Default 48h,
// clamped 1–168h. Interview reminders use the existing
// reminderDispatchAfter policy (24h → 1h → immediate), not this var.
export const DEFAULT_OFFER_REMINDER_OFFSET_HOURS = 48;
const MIN_OFFER_REMINDER_OFFSET_HOURS = 1;
const MAX_OFFER_REMINDER_OFFSET_HOURS = 168;

export const getOfferReminderOffsetMs = (source = process.env) => {
  const parsed = Number(source.OFFER_REMINDER_OFFSET_HOURS);
  const hours = Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : DEFAULT_OFFER_REMINDER_OFFSET_HOURS;
  return Math.min(
    MAX_OFFER_REMINDER_OFFSET_HOURS,
    Math.max(MIN_OFFER_REMINDER_OFFSET_HOURS, hours)
  ) * 60 * 60 * 1000;
};

// 28.6 document worker: file fetch + integrity + security checks
// consume memory/CPU — keep the default modest.
export const DEFAULT_DOCUMENT_WORKER_CONCURRENCY = 2;
const MAX_DOCUMENT_WORKER_CONCURRENCY = 8;

export const parseDocumentWorkerConcurrency = (source = process.env) => {
  const parsed = Number(source.DOCUMENT_WORKER_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DOCUMENT_WORKER_CONCURRENCY;
  return Math.min(
    MAX_DOCUMENT_WORKER_CONCURRENCY,
    Math.max(MIN_PROCESSING_WORKER_CONCURRENCY, Math.trunc(parsed))
  );
};

// 28.6 BGV worker: conservative default; future per-vendor rate
// limits may require tuning (no tenant throttling yet).
export const DEFAULT_BGV_WORKER_CONCURRENCY = 2;
const MAX_BGV_WORKER_CONCURRENCY = 8;

// 29.6 payroll worker: payroll calculation is CPU-light but
// Mongo-heavy; a low default keeps one run from starving the API's
// own queries. One run at a time per worker slot by design.
export const DEFAULT_PAYROLL_WORKER_CONCURRENCY = 2;
const MAX_PAYROLL_WORKER_CONCURRENCY = 8;

export const parsePayrollWorkerConcurrency = (source = process.env) => {
  const raw = source?.PAYROLL_WORKER_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAYROLL_WORKER_CONCURRENCY;
  return Math.min(
    MAX_PAYROLL_WORKER_CONCURRENCY,
    Math.max(1, Math.trunc(parsed)),
  );
};

export const parseBgvWorkerConcurrency = (source = process.env) => {
  const parsed = Number(source.BGV_WORKER_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BGV_WORKER_CONCURRENCY;
  return Math.min(
    MAX_BGV_WORKER_CONCURRENCY,
    Math.max(MIN_PROCESSING_WORKER_CONCURRENCY, Math.trunc(parsed))
  );
};

// 28.6 centralized reminder policy (env-overridable, clamped).
// ONE reminder per state per version — no repeated spam; idempotent
// eventKeys make even a double-fire a single email.
const clampedHours = (value, def, min, max) => {
  const parsed = Number(value);
  const hours = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : def;
  return Math.min(max, Math.max(min, hours));
};

export const getPreOnboardingReminderPolicy = (source = process.env) => {
  const H = 60 * 60 * 1000;
  const D = 24 * H;
  return Object.freeze({
    // Mandatory docs still pending after the pre-onboarding start.
    documentsPendingOffsetMs: clampedHours(source.PREONBOARDING_DOCS_REMINDER_HOURS, 72, 12, 336) * H,
    // After a HR rejection → resubmission reminder to the candidate.
    resubmissionOffsetMs: clampedHours(source.PREONBOARDING_RESUBMISSION_REMINDER_HOURS, 48, 6, 336) * H,
    // Joining-date reminder (days before joining, clamped 1-14).
    joiningDaysBefore: (() => {
      const parsed = Number(source.PREONBOARDING_JOINING_REMINDER_DAYS_BEFORE);
      const days = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 3;
      return Math.min(14, Math.max(1, days));
    })() * D,
  });
};

export const getBgvReminderPolicy = (source = process.env) => {
  const H = 60 * 60 * 1000;
  return Object.freeze({
    // Case awaiting the candidate's consent/information.
    candidateInfoOffsetMs: clampedHours(source.BGV_CANDIDATE_REMINDER_HOURS, 48, 12, 336) * H,
    // Case awaiting the assigned verifier.
    verifierOffsetMs: clampedHours(source.BGV_VERIFIER_REMINDER_HOURS, 72, 12, 336) * H,
  });
};

// 28.6 BGV provider polling ladder (external providers only).
// Bounded, monotonically increasing; the window caps total polling.
export const BGV_POLL_BACKOFF_MS = Object.freeze([
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
]);
export const BGV_POLL_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const nextBgvPollDelayMs = (pollAttempt) => {
  const index = Math.max(0, Math.trunc(pollAttempt)) - 1;
  const ladder = BGV_POLL_BACKOFF_MS;
  return ladder[Math.min(ladder.length - 1, Math.max(0, index))];
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
