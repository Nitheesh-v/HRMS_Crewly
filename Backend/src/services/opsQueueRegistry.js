// ============================================================
// 📋 PHASE 28.8 — OPS QUEUE REGISTRY (allowlist + policy)
//
// The single source of truth for what the Super Admin
// "Background Operations" tooling may touch:
//
//   - OPS_QUEUES: ONLY queues that actually exist (a worker is
//     registered and producers enqueue into them). The reserved
//     but unimplemented "analytics" name is deliberately
//     excluded, as is any arbitrary string.
//   - OPS thresholds: env-configurable severity cutoffs with
//     sane clamped defaults (documented in .env.example).
//   - Safe failure categories + the BACKEND-AUTHORITATIVE retry
//     policy. The UI can never override it (no force /
//     skipValidation flags anywhere in the API surface).
//
// This module is pure (no Redis, no Mongo) — fully hermetic.
// ============================================================

import {
  QUEUE_NAMES,
  JOB_NAMES,
  PROCESSING_JOB_NAMES,
  SCHEDULED_JOB_NAMES,
  DOCUMENT_JOB_NAMES,
  BGV_JOB_NAMES,
  PAYROLL_JOB_NAMES,
} from '../config/queueConfig.js';

const SYSTEM_JOB_NAMES = Object.freeze([
  JOB_NAMES.SYSTEM_HEALTH_CHECK,
  JOB_NAMES.SYSTEM_RETRY_TEST,
]);

// Email job names = every JOB_NAMES entry with the email- prefix
// (mirrors the EMAIL_JOB_NAMES derivation in queueConfig, kept
// local so this module stays import-light for hermetic tests).
const EMAIL_JOB_NAMES = Object.freeze(
  Object.values(JOB_NAMES).filter((name) =>
    String(name).startsWith('email-')
  )
);

const RESUME_JOB_NAMES = Object.freeze([JOB_NAMES.RESUME_PARSE]);
const ATS_JOB_NAMES = Object.freeze([JOB_NAMES.ATS_PROCESS]);

export const OPS_QUEUES = Object.freeze([
  {
    name: QUEUE_NAMES.SYSTEM,
    purpose: 'Infrastructure jobs (health checks, retry proofs)',
    jobNames: SYSTEM_JOB_NAMES,
  },
  {
    name: QUEUE_NAMES.EMAIL,
    purpose: 'Security-scoped email delivery',
    jobNames: EMAIL_JOB_NAMES,
  },
  {
    name: QUEUE_NAMES.RESUME,
    purpose: 'Resume parsing (CPU-bound, single-flight default)',
    jobNames: RESUME_JOB_NAMES,
  },
  {
    name: QUEUE_NAMES.ATS,
    purpose: 'ATS candidate matching',
    jobNames: ATS_JOB_NAMES,
  },
  {
    name: QUEUE_NAMES.SCHEDULED,
    purpose: 'One-time delayed jobs (reminders, offer expiry)',
    jobNames: SCHEDULED_JOB_NAMES,
  },
  {
    name: QUEUE_NAMES.DOCUMENTS,
    purpose: 'Stored document processing (security scan + parse)',
    jobNames: DOCUMENT_JOB_NAMES,
  },
  {
    name: QUEUE_NAMES.BGV,
    purpose: 'Background verification (provider check/poll/result)',
    jobNames: BGV_JOB_NAMES,
  },
  {
    name: QUEUE_NAMES.PAYROLL,
    purpose: 'Payroll calculation runs (29.6 — progress-tracked)',
    jobNames: PAYROLL_JOB_NAMES,
  },
]);

export const OPS_QUEUE_ALLOWLIST = new Set(
  OPS_QUEUES.map((queue) => queue.name)
);

export const isOpsQueue = (name) => OPS_QUEUE_ALLOWLIST.has(name);

export const getOpsQueue = (name) =>
  OPS_QUEUES.find((queue) => queue.name === name) || null;

// Retention as configured for every queue in 28.2
// (queueConfig.js) — surfaced so the UI can explain why the
// failed list is bounded.
export const OPS_RETENTION = Object.freeze({
  completed: 100,
  failed: 500,
});

// -----------------------------------------------------------
// Severity thresholds (env-configurable, clamped to sane bounds)
// -----------------------------------------------------------

const clampInt = (value, fallback, min, max) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const getOpsThresholds = (source = process.env) => {
  const waitingWarn = clampInt(source.OPS_QUEUE_WAITING_WARN, 100, 1, 1000000);
  const waitingCritical = clampInt(
    source.OPS_QUEUE_WAITING_CRITICAL, 1000, waitingWarn, 10000000
  );
  const oldestWaitingWarnMs = clampInt(
    source.OPS_OLDEST_WAITING_WARN_MS, 5 * 60 * 1000, 1000, 86400000
  );
  const oldestWaitingCriticalMs = clampInt(
    source.OPS_OLDEST_WAITING_CRITICAL_MS,
    30 * 60 * 1000,
    oldestWaitingWarnMs,
    86400000
  );
  const failedRecentMinutes = clampInt(
    source.OPS_FAILED_RECENT_MINUTES, 15, 1, 1440
  );
  return Object.freeze({
    waitingWarn,
    waitingCritical,
    oldestWaitingWarnMs,
    oldestWaitingCriticalMs,
    failedRecentMinutes,
  });
};

// -----------------------------------------------------------
// Safe failure categories (ops mapping — normalizes the coarse
// worker classifier into a small, UI-safe vocabulary).
// -----------------------------------------------------------

export const SAFE_CATEGORIES = Object.freeze({
  REDIS_UNAVAILABLE: 'REDIS_UNAVAILABLE',
  PROCESSOR_ERROR: 'PROCESSOR_ERROR',
  MALFORMED_PAYLOAD: 'MALFORMED_PAYLOAD',
  SECURITY_REJECTION: 'SECURITY_REJECTION',
  CONFIGURATION: 'CONFIGURATION',
  RETRIES_EXHAUSTED: 'RETRIES_EXHAUSTED',
  UNKNOWN: 'UNKNOWN',
});

const PATTERN_RULES = Object.freeze([
  // Order matters: the most specific (and most security-relevant)
  // signals are classified first.
  [/no processor registered/i, SAFE_CATEGORIES.CONFIGURATION],
  [
    /retries? (have )?exhausted|attempts exhausted|RETRIES_EXHAUSTED/i,
    SAFE_CATEGORIES.RETRIES_EXHAUSTED,
  ],
  [
    /tenant mismatch|company (id )?mismatch|forbidden|denied|unauthorized|permission|expired (token|session|link)/i,
    SAFE_CATEGORIES.SECURITY_REJECTION,
  ],
  [
    /malformed|invalid (payload|body|json)|missing (required )?field|unexpected field|payload validation/i,
    SAFE_CATEGORIES.MALFORMED_PAYLOAD,
  ],
  [
    /redis|ioredis|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|EPIPE|socket hang up|read ECONNRESET|connection (closed|lost|refused)/i,
    SAFE_CATEGORIES.REDIS_UNAVAILABLE,
  ],
]);

/**
 * Map a raw failedReason string (never shown verbatim anywhere)
 * to a safe ops category. Pure — exported for tests.
 */
export const classifyOpsFailure = (
  failedReason,
  { attemptsMade = 0, maxAttempts = 0 } = {}
) => {
  const text = String(failedReason || '');
  if (!text.trim()) return SAFE_CATEGORIES.UNKNOWN;
  for (const [pattern, category] of PATTERN_RULES) {
    if (pattern.test(text)) return category;
  }
  if (maxAttempts > 0 && attemptsMade >= maxAttempts) {
    return SAFE_CATEGORIES.RETRIES_EXHAUSTED;
  }
  return SAFE_CATEGORIES.PROCESSOR_ERROR;
};

// -----------------------------------------------------------
// Backend-authoritative retry policy.
// -----------------------------------------------------------

const NON_RETRYABLE_REASONS = Object.freeze({
  [SAFE_CATEGORIES.MALFORMED_PAYLOAD]:
    'Payload is invalid — retrying will fail the same way. Fix the source record instead.',
  [SAFE_CATEGORIES.SECURITY_REJECTION]:
    'Rejected for a security or tenant reason — retrying is not safe.',
  [SAFE_CATEGORIES.CONFIGURATION]:
    'No processor is registered for this job type. Fix the deployment, not the job.',
  [SAFE_CATEGORIES.RETRIES_EXHAUSTED]:
    'The job already used all of its allowed attempts.',
  [SAFE_CATEGORIES.UNKNOWN]:
    'The failure is unclassified — inspect it before retrying.',
});

/**
 * Decide (server-side, always) whether a failed job may be
 * retried. There is no override: callers cannot force a retry.
 * Pure — exported for tests.
 */
export const getRetryPolicy = (
  _queueName,
  _jobName,
  category,
  { attemptsMade = 0, maxAttempts = 0 } = {}
) => {
  if (maxAttempts > 0 && attemptsMade >= maxAttempts) {
    return {
      retryable: false,
      reason: 'The job already used all of its allowed attempts.',
      category,
    };
  }
  const reason = NON_RETRYABLE_REASONS[category];
  if (reason) {
    return { retryable: false, reason, category };
  }
  return {
    retryable: true,
    reason: 'Transient failure — safe to retry.',
    category,
  };
};

// Job-id charset accepted by the API (BullMQ ids here are
// numeric or our colon-free deterministic slugs).
export const OPS_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
