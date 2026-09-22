// ============================================================
// 🚦 PHASE 28.2 — BULLMQ QUEUE FACTORY (producer side)
//
// One controlled entry point for creating/enqueuing on Crewly
// queues. Controllers/services must NOT instantiate BullMQ
// Queue objects on their own.
//
// CONNECTION OWNERSHIP (verified against BullMQ 6.3.1 source):
//   - Each Queue gets its OWN ioredis instance created here from
//     REDIS_URL + createRedisOptions('bullmq-producer') — never
//     the shared Phase 28.1 general client.
//   - BullMQ treats a passed ioredis instance as "shared": it does
//     NOT close it. So this module closes the instances it created
//     in closeAllQueues() after queue.close().
//   - BullMQ's ESM build cannot require('ioredis') for options-only
//     connections — passing a constructed instance is required.
// ============================================================

import Redis from 'ioredis';
import { Queue } from 'bullmq';
import logger from '../config/logger.js';
import {
  getRedisConfig,
  createRedisOptions,
} from '../config/redis.js';
import {
  getDefaultJobOptions,
  getQueuePrefix,
  isKnownQueueName,
} from '../config/queueConfig.js';
import { getCurrentRequestId, isValidRequestId } from '../infrastructure/observability/requestContext.js';

const queues = new Map(); // name -> { queue, connection }
let closing = false;

// Create (or reuse) the Queue for a reserved queue name.
export const getQueue = (name) => {
  if (!isKnownQueueName(name)) {
    throw new Error(`Unknown queue name: ${name}. Use QUEUE_NAMES from config/queueConfig.js.`);
  }

  if (queues.has(name)) return queues.get(name).queue;

  const config = getRedisConfig();
  if (!config.enabled || !config.hasUrl) {
    throw new Error(
      'BullMQ queue requested but Redis is not configured ' +
        '(REDIS_ENABLED/REDIS_URL). The API itself runs without Redis; queues require it.'
    );
  }

  // Dedicated producer connection for THIS queue.
  const connection = new Redis(String(process.env.REDIS_URL).trim(), {
    ...createRedisOptions('bullmq-producer'),
  });

  const queue = new Queue(name, {
    connection,
    prefix: getQueuePrefix(),
  });

  queues.set(name, { queue, connection });
  logger.info(`[Queue] ${name} opened (prefix=${getQueuePrefix()})`);
  return queue;
};

// ── Phase 32.7 §45 — producer-boundary payload defense-in-depth ──
// Processors keep their per-job allowlist validators (email
// EMAIL_JOB_KEYS, strict system validator, per-domain payload
// validators) — that is the second wall. This is the FIRST wall at
// the ONE producer entry: references-only payloads are Crewly law,
// so a bounded denylist of dangerous key names is rejected here,
// before anything reaches Redis. Conservative by design: exact
// word-ish matches against keys that no legitimate Crewly payload
// uses (verified against all dispatchers); values are NEVER logged.
const FORBIDDEN_PAYLOAD_KEY_PATTERN =
  /(password|passwd|secret|token|jwt|credential|pin|otp|base64|binary|buffer|pdf|attachment|latitude|longitude|gps|coordinates|bankaccount|accountnumber|ifsc|salaryrow|resumetext|filecontent|documentcontent)/i;

export const findForbiddenPayloadKey = (value, prefix = '') => {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = findForbiddenPayloadKey(entry, prefix);

      if (hit) return hit;
    }

    return null;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (FORBIDDEN_PAYLOAD_KEY_PATTERN.test(key)) return path;

      const hit = findForbiddenPayloadKey(nested, path);

      if (hit) return hit;
    }

    return null;
  }

  return null; // primitives carry no key names
};

export const assertReferencesOnlyPayload = (queueName, jobName, data) => {
  const forbiddenKey = findForbiddenPayloadKey(data);

  if (forbiddenKey) {
    throw new Error(
      `[Queue] payload rejected (references-only law): key "${forbiddenKey}" ` +
        `is forbidden for ${jobName} on queue ${queueName}. ` +
        'Job payloads carry references only — never secrets, tokens, PII, or binaries.'
    );
  }
};

// Single controlled producer path: applies Crewly's default job
// options, then caller overrides. Payload must contain references
// only (never secrets/PII/binary) — enforced HERE at the dispatch
// boundary (32.7) + per-processor validators (second wall) + tests.
export const enqueueJob = async (queueName, jobName, data, options = {}) => {
  assertReferencesOnlyPayload(queueName, jobName, data ?? {});

  const queue = getQueue(queueName);
  const jobOptions = {
    ...getDefaultJobOptions(),
    ...options,
  };

  // Phase 32.12 — diagnostics correlation: the HTTP request ID rides as
  // BullMQ opts metadata (NOT payload — the references-only payload law
  // and every per-queue validator are untouched; idempotency jobId is
  // untouched). Workers do not inherit HTTP async context (ALS), so the
  // stamp here is the ONLY bridge. Bounded/validated: only a strict
  // [A-Za-z0-9_-]{8,64} value is ever attached — no PII, no tokens.
  if (jobOptions.correlationId === undefined) {
    const requestId = getCurrentRequestId();
    if (isValidRequestId(requestId)) jobOptions.correlationId = requestId;
  }
  const job = await queue.add(jobName, data ?? {}, jobOptions);
  logger.info(
    `[Queue] ${jobName} enqueued (queue=${queueName}, id=${job.id ?? 'auto'}, ` +
      `jobId=${jobOptions.jobId || 'n/a'})`
  );
  return job;
};

// Reconciliation helper (28.3/28.4): BullMQ never re-creates a used
// jobId — queue.add with an existing id returns the EXISTING job
// regardless of state (including FAILED, which persists in the
// failed set). Before re-adding a deterministic job id, clear the
// slot only when the previous job is FAILED (a dead job). Live jobs
// (waiting/active/delayed/completed) are left untouched so
// reconciliation stays idempotent. Returns the previous state or
// 'absent' / 'failed-removed'.
export const prepareJobSlot = async (queue, jobId) => {
  const existing = await queue.getJob(jobId);
  if (!existing) return 'absent';
  const state = await existing.getState();
  if (state === 'failed') {
    await existing.remove().catch(() => {});
    return 'failed-removed';
  }
  return state;
};

// Close every queue this process opened: BullMQ backend first, then
// the ioredis instances we created (BullMQ leaves those to us).
export const closeAllQueues = async () => {
  if (closing) return;
  closing = true;
  for (const [name, entry] of queues) {
    try {
      await entry.queue.close();
    } catch {
      /* already closing */
    }
    try {
      entry.connection.disconnect();
    } catch {
      /* already closed */
    }
    logger.info(`[Queue] ${name} closed`);
  }
  queues.clear();
};

// Safe status (no connection details, no credentials).
export const getQueueStatus = () => ({
  queues: Object.fromEntries(
    [...queues.entries()].map(([name, entry]) => [
      name,
      entry.queue.closing ? 'closing' : 'open',
    ])
  ),
  prefix: getQueuePrefix(),
});
