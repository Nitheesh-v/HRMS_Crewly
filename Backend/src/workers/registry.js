// ============================================================
// ⚙️ PHASE 28.2 — WORKER JOB REGISTRY + SYSTEM PROCESSORS
//
// Simple registry/dispatch pattern: job name → processor.
// New workload phases (28.3 email, 28.4 resume/ATS, …) register
// their processors here instead of growing a switch file.
//
// PROCESSOR RULES (all phases):
//   - Pure ESM arrow functions, input is the BullMQ Job object.
//   - Validate job.name and payload shape — never trust job.data
//     just because it came from Redis.
//   - Payloads carry REFERENCES only (ids, timestamps,
//     correlation ids) — never secrets/PII/binary.
//   - Re-validate MongoDB state before acting (future workers).
//   - Throw to signal failure (BullMQ records retries); never
//     swallow errors and return success.
//   - Return a small operational result, not business objects.
//   - MUST be idempotent: BullMQ delivery is at-least-once.
// ============================================================

import { JOB_NAMES } from '../config/queueConfig.js';

// Strict payload validator for infrastructure system jobs.
// Known keys only; unknown keys are rejected (defense against
// fat-fingered or malicious producers).
export const validateSystemJobPayload = (data) => {
  if (data === undefined || data === null) return { valid: true, value: {} };
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, reason: 'payload must be a plain object' };
  }
  const known = new Set(['requestedAt', 'correlationId']);
  for (const key of Object.keys(data)) {
    if (!known.has(key)) {
      return { valid: false, reason: `unknown payload key: ${key}` };
    }
  }
  for (const key of ['requestedAt', 'correlationId']) {
    if (data[key] !== undefined && typeof data[key] !== 'string') {
      return { valid: false, reason: `${key} must be a string` };
    }
  }
  return { valid: true, value: data };
};

// SYSTEM_HEALTH_CHECK — proves Queue → Redis → Worker.
// Harmless by construction: no DB writes, no side effects.
export const systemHealthProcessor = async (job) => {
  const { valid, reason, value } = validateSystemJobPayload(job.data);
  if (!valid) {
    throw new Error(`SYSTEM_HEALTH_CHECK rejected: ${reason}`);
  }
  return {
    ok: true,
    processedAt: new Date().toISOString(),
    worker: 'system',
    correlationId: value.correlationId ?? null,
  };
};

// SYSTEM_RETRY_TEST — controlled retry verification.
// Fails on attempt 1 ONLY, succeeds on later attempts. Used by
// queue:check --retry-test and the opt-in live test. Not a
// permanently failing processor: it always converges.
export const systemRetryTestProcessor = async (job) => {
  const { valid, reason } = validateSystemJobPayload(job.data);
  if (!valid) {
    throw new Error(`SYSTEM_RETRY_TEST rejected: ${reason}`);
  }
  if (job.attemptsStarted === 1) {
    throw new Error('controlled retry-test failure (attempt 1)');
  }
  return {
    ok: true,
    processedAt: new Date().toISOString(),
    worker: 'system',
    attemptsStarted: job.attemptsStarted,
  };
};

// name → processor registry (28.2: infrastructure jobs only).
export const jobRegistry = new Map([
  [JOB_NAMES.SYSTEM_HEALTH_CHECK, systemHealthProcessor],
  [JOB_NAMES.SYSTEM_RETRY_TEST, systemRetryTestProcessor],
]);

export const registerProcessor = (jobName, processor) => {
  if (typeof jobName !== 'string' || jobName.length === 0) {
    throw new Error('registerProcessor: job name must be a non-empty string');
  }
  if (typeof processor !== 'function') {
    throw new Error('registerProcessor: processor must be a function');
  }
  jobRegistry.set(jobName, processor);
};

// Single dispatch entry used by the Worker. Unknown job names are a
// configuration fault — fail loudly (the job will retry/fail per
// its options) rather than silently no-op.
export const dispatchJob = async (job) => {
  const processor = jobRegistry.get(job.name);
  if (!processor) {
    throw new Error(
      `No processor registered for job name "${job.name}" (worker prefix may be mismatched).`
    );
  }
  return processor(job);
};
