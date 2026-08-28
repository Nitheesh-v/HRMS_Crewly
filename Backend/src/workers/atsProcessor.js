// ============================================================
// ️ PHASE 28.4 — ATS MATCHING WORKER ADAPTER
//
// Thin adapter between BullMQ and the EXISTING deterministic ATS
// engine: validate job (name + strict payload) → processATSMatch
// (unchanged tenant-scoped loads, fingerprint skip, upsert,
// ATS_SCREENING transition, history + audit).
//
// Semantics:
//   - Payload carries REFERENCES only; the service re-loads every
//     document under the job's companyId and verifies the candidate
//     ↔ job ↔ resume ↔ parseResult relationship (a tenant mismatch
//     simply misses → terminal safe no-op, NO retry — a mismatch
//     can never resolve by retrying).
//   - Business outcomes (MATCH_INPUTS_NOT_AVAILABLE,
//     UNCHANGED_INPUTS skip, processed) → return, job is terminal.
//   - Infra errors (Mongo) propagate → BullMQ retries per
//     ATS_JOB_OPTIONS.
//
// Returns a small operational result only — never candidate/job
// content or the score breakdown.
// ============================================================

import mongoose from 'mongoose';
import { JOB_NAMES } from '../config/queueConfig.js';
import { processATSMatch } from '../services/atsMatchingService.js';

const ATS_PAYLOAD_KEYS = new Set([
  'companyId',
  'candidateId',
  'jobId',
  'resumeId',
  'parseResultId',
  'engineVersion',
  'trigger',
  'actorId',
  'correlationId',
]);
const ATS_TRIGGERS = new Set(['RESUME_PARSED', 'STARTUP_RECOVERY', 'MANUAL_REPROCESS']);

// Strict payload validation: known keys only, valid ids, known
// trigger, short version strings. Unknown keys are rejected.
export const validateATSJobPayload = (data) => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, reason: 'payload must be a plain object' };
  }
  for (const key of Object.keys(data)) {
    if (!ATS_PAYLOAD_KEYS.has(key)) {
      return { valid: false, reason: `unknown payload key: ${key}` };
    }
  }
  for (const key of ['companyId', 'candidateId', 'jobId', 'resumeId', 'parseResultId']) {
    if (!mongoose.isValidObjectId(data[key])) {
      return { valid: false, reason: `${key} must be a valid id` };
    }
  }
  if (
    typeof data.engineVersion !== 'string' ||
    data.engineVersion.length === 0 ||
    data.engineVersion.length > 64
  ) {
    return { valid: false, reason: 'engineVersion must be a short string' };
  }
  if (!ATS_TRIGGERS.has(data.trigger)) {
    return { valid: false, reason: 'trigger must be a known ATS trigger' };
  }
  if (
    data.actorId !== undefined &&
    data.actorId !== null &&
    !mongoose.isValidObjectId(data.actorId)
  ) {
    return { valid: false, reason: 'actorId must be a valid id when present' };
  }
  if (data.correlationId !== undefined && typeof data.correlationId !== 'string') {
    return { valid: false, reason: 'correlationId must be a string' };
  }
  return {
    valid: true,
    value: {
      companyId: String(data.companyId),
      candidateId: String(data.candidateId),
      jobId: String(data.jobId),
      resumeId: String(data.resumeId),
      parseResultId: String(data.parseResultId),
      trigger: data.trigger,
      actorId: data.actorId ? String(data.actorId) : null,
    },
  };
};

// `process` is a DI seam for hermetic tests; default is the real
// service entry.
export const atsProcessProcessor = async (job, { process = processATSMatch } = {}) => {
  const { valid, reason, value } = validateATSJobPayload(job.data);
  if (!valid) {
    throw new Error(`ATS_PROCESS rejected: ${reason}`);
  }

  const result = await process(value);

  // Business no-ops are terminal by design: a tenant/relationship
  // mismatch or missing input will not resolve on retry, so the job
  // completes (Mongo intent stays the recovery source of truth).
  return {
    processed: Boolean(result.accepted),
    candidateId: value.candidateId,
    action: result.action || (result.skipped ? 'SKIPPED' : 'NOOP'),
    reason: result.reason || null,
  };
};

export const registerATSProcessors = ({ registerProcessor }) => {
  registerProcessor(JOB_NAMES.ATS_PROCESS, atsProcessProcessor);
};
