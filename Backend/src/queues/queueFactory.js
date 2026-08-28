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

// Single controlled producer path: applies Crewly's default job
// options, then caller overrides. Payload must contain references
// only (never secrets/PII/binary) — enforced by convention + tests.
export const enqueueJob = async (queueName, jobName, data, options = {}) => {
  const queue = getQueue(queueName);
  const jobOptions = {
    ...getDefaultJobOptions(),
    ...options,
  };
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
