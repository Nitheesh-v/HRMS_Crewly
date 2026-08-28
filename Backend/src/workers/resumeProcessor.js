// ============================================================
// 📄 PHASE 28.4 — RESUME PARSING WORKER ADAPTER
//
// Thin adapter between BullMQ and the EXISTING processing service:
//   validate job (name + strict payload) → processResumeJob (the
//   unchanged claim → extract → parse → persist pipeline).
//
// Semantics:
//   - Payload carries REFERENCES only; the service re-loads every
//     document under the job's companyId (a tenant mismatch simply
//     makes the atomic claim miss → NOT_PROCESSABLE, terminal no-op).
//   - Business outcome RETRY_PENDING = transient failure with
//     attempts left → throw so BullMQ backs off and retries.
//   - Business outcomes COMPLETED/REVIEW_REQUIRED/FAILED/UNSUPPORTED
//     are terminal for THIS job → return (no retry).
//   - Infra errors thrown by the service (Mongo) propagate → retry.
//
// Returns a small operational result only — never parsed content.
// ============================================================

import mongoose from 'mongoose';
import {
  JOB_NAMES,
  RESUME_JOB_OPTIONS,
} from '../config/queueConfig.js';
import { processResumeJob } from '../services/resumeProcessingService.js';

const RESUME_PAYLOAD_KEYS = new Set([
  'companyId',
  'candidateId',
  'resumeId',
  'parserVersion',
  'correlationId',
]);

// Strict payload validation: known keys only, valid ids, short
// version string. Unknown keys are rejected — defense against
// fat-fingered or malicious producers (and against PII/data
// smuggling into Redis).
export const validateResumeJobPayload = (data) => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, reason: 'payload must be a plain object' };
  }
  for (const key of Object.keys(data)) {
    if (!RESUME_PAYLOAD_KEYS.has(key)) {
      return { valid: false, reason: `unknown payload key: ${key}` };
    }
  }
  for (const key of ['companyId', 'candidateId', 'resumeId']) {
    if (!mongoose.isValidObjectId(data[key])) {
      return { valid: false, reason: `${key} must be a valid id` };
    }
  }
  if (
    typeof data.parserVersion !== 'string' ||
    data.parserVersion.length === 0 ||
    data.parserVersion.length > 64
  ) {
    return { valid: false, reason: 'parserVersion must be a short string' };
  }
  if (data.correlationId !== undefined && typeof data.correlationId !== 'string') {
    return { valid: false, reason: 'correlationId must be a string' };
  }
  return {
    valid: true,
    value: {
      companyId: String(data.companyId),
      candidateId: String(data.candidateId),
      resumeId: String(data.resumeId),
    },
  };
};

// `process` is a DI seam for hermetic tests; default is the real
// service entry.
export const resumeParseProcessor = async (job, { process = processResumeJob } = {}) => {
  const { valid, reason, value } = validateResumeJobPayload(job.data);
  if (!valid) {
    throw new Error(`RESUME_PARSE rejected: ${reason}`);
  }

  const finalAttempt = job.attemptsStarted >= RESUME_JOB_OPTIONS.attempts;
  const result = await process({
    ...value,
    finalAttempt,
  });

  if (result.status === 'RETRY_PENDING') {
    // Transient failure, attempts remaining — BullMQ retries with
    // exponential backoff (RESUME_JOB_OPTIONS). The Mongo state is
    // already RETRY_PENDING (lease released); recovery also covers
    // this job if the retry itself never runs.
    throw new Error(
      `RESUME_PARSE retryable failure (resume=${value.resumeId}, attempt=${job.attemptsStarted})`
    );
  }

  return {
    processed: Boolean(result.accepted),
    resumeId: value.resumeId,
    status: result.status || 'NOT_PROCESSABLE',
  };
};

export const registerResumeProcessors = ({ registerProcessor }) => {
  registerProcessor(JOB_NAMES.RESUME_PARSE, resumeParseProcessor);
};
