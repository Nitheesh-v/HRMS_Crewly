// ============================================================
// ⚙️ PHASE 28.2 — CREWLY SYSTEM WORKER (separate process)
//
//   npm run worker:dev   (nodemon)
//   npm run worker       (plain node)
//
// Architecture: the Express API and this Worker are separate
// processes by design. The API serves HTTP; the Worker processes
// background jobs. They scale independently, and a Worker crash
// never takes down the API.
//
// UNLIKE the API (28.1 degraded mode), a WORKER REQUIRES Redis:
// if Redis is disabled/misconfigured/unreachable at startup, this
// process fails fast with a safe error (no credentials logged).
//
// CONNECTION OWNERSHIP (verified in BullMQ 6.3.1 source):
//   - This process creates ONE dedicated ioredis instance
//     (bullmq-worker options: maxRetriesPerRequest null).
//   - BullMQ uses it as the worker's main connection (shared —
//     BullMQ will NOT close it) and auto-duplicates it for the
//     dedicated blocking connection (BullMQ closes the duplicate).
//   - We close our instance explicitly after worker.close().
//
// SHUTDOWN (SIGINT/SIGTERM): stop accepting work, let active jobs
// finish (bounded 10s hard stop), close connections, exit.
// ============================================================

import dotenv from 'dotenv';
import Redis from 'ioredis';
import { Worker } from 'bullmq';
import logger from '../config/logger.js';
import {
  getRedisConfig,
  createRedisOptions,
  classifySafeReason,
} from '../config/redis.js';
import {
  QUEUE_NAMES,
  getQueuePrefix,
  parseWorkerConcurrency,
  redactConnectionSecrets,
} from '../config/queueConfig.js';
import { dispatchJob } from './registry.js';

const SHUTDOWN_HARD_STOP_MS = 10000;

// Safe error text: redact anything that could carry credentials.
const safeErrorText = (error) =>
  redactConnectionSecrets(`${error?.message || 'unknown error'}`.slice(0, 200));

const startWorker = async () => {
  dotenv.config();

  // --- Fail fast: a worker cannot exist without Redis ---------------
  const config = getRedisConfig();
  if (!config.enabled) {
    logger.error(
      '[Worker] REDIS_ENABLED is false — the worker requires Redis. ' +
        'Enable REDIS_ENABLED=true in Backend/.env (API may still run without Redis).'
    );
    process.exit(1);
  }
  if (!config.hasUrl) {
    logger.error(
      '[Worker] REDIS_URL is empty — the worker requires Redis. ' +
        'Set REDIS_URL privately in Backend/.env.'
    );
    process.exit(1);
  }

  const prefix = getQueuePrefix();
  const concurrency = parseWorkerConcurrency();

  logger.info(
    `[Worker] Starting system worker (prefix=${prefix}, concurrency=${concurrency})`
  );

  // Dedicated worker connection (never the API's general client).
  const connection = new Redis(String(process.env.REDIS_URL).trim(), {
    ...createRedisOptions('bullmq-worker'),
    connectionName: `crewly-worker-system`,
  });

  let worker;
  try {
    worker = new Worker(QUEUE_NAMES.SYSTEM, dispatchJob, {
      connection,
      prefix,
      concurrency,
    });
  } catch (error) {
    logger.error(`[Worker] Startup failed: ${safeErrorText(error)}`);
    try {
      connection.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }

  // --- Safe event logging (never logs full job.data) ----------------
  worker.on('ready', () => {
    logger.info(
      `[Worker] System worker ready (queue=${QUEUE_NAMES.SYSTEM}, prefix=${prefix}, concurrency=${concurrency})`
    );
  });

  worker.on('active', (job) => {
    logger.info(
      `[Worker] active: ${job.name} (id=${job.id}, attempt=${job.attemptsStarted})`
    );
  });

  worker.on('completed', (job) => {
    logger.info(
      `[Worker] completed: ${job.name} (id=${job.id}, attempts=${job.attemptsStarted})`
    );
  });

  worker.on('failed', (job, error) => {
    logger.warn(
      `[Worker] failed: ${job?.name || 'unknown'} (id=${job?.id || 'n/a'}, ` +
        `attempt=${job?.attemptsStarted || 'n/a'}, reason=${classifySafeReason(error)}, ` +
        `detail=${safeErrorText(error)})`
    );
  });

  worker.on('stalled', (jobId) => {
    logger.warn(`[Worker] stalled job detected (id=${jobId}) — BullMQ will re-queue it`);
  });

  worker.on('error', (error) => {
    // Connection-level error; ioredis retries internally with its
    // default bounded strategy. Log safely, never crash on it.
    logger.warn(
      `[Worker] worker error (${classifySafeReason(error)}): ${safeErrorText(error)}`
    );
  });

  worker.on('closing', () => {
    logger.info('[Worker] Closing (stopping acceptance, finishing active jobs)');
  });

  // --- Readiness gate: worker must see Redis or fail fast -----------
  const ready = await Promise.race([
    worker
      .waitUntilReady()
      .then(() => true)
      .catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), config.connectTimeoutMs)),
  ]);

  if (!ready) {
    logger.error(
      `[Worker] Redis unavailable within ${config.connectTimeoutMs}ms — worker cannot start. ` +
        'Check REDIS_URL privately; the API is unaffected.'
    );
    await worker.close().catch(() => {});
    try {
      connection.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }

  // --- Graceful shutdown (this process's own handlers) ---------------
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[Worker] ${signal} received — shutting down gracefully...`);

    const hardStop = setTimeout(() => {
      logger.error('[Worker] Graceful shutdown timed out after 10s — forcing exit.');
      process.exit(1);
    }, SHUTDOWN_HARD_STOP_MS);
    hardStop.unref();

    worker
      .close()
      .catch((error) => logger.warn(`[Worker] close() error: ${safeErrorText(error)}`))
      .finally(async () => {
        try {
          connection.disconnect();
        } catch {
          /* ignore */
        }
        clearTimeout(hardStop);
        logger.info('[Worker] Connections closed. Bye.');
        process.exit(0);
      });
  };

  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => shutdown(signal));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(`[Worker] Unhandled rejection: ${safeErrorText(reason)}`);
    process.exit(1);
  });
};

startWorker().catch((error) => {
  logger.error(`[Worker] Startup failed: ${safeErrorText(error)}`);
  process.exit(1);
});
