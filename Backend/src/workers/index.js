// ============================================================
// ⚙️ PHASE 28.2/28.3 — CREWLY WORKER PROCESS
//
//   npm run worker:dev   (nodemon)
//   npm run worker       (plain node)
//
// One process runs both BullMQ workers:
//   - system queue (28.2 infrastructure jobs)
//   - email queue  (28.3 email delivery jobs)
//
// Architecture: the Express API and this Worker process are
// separate by design. The API serves HTTP; workers process
// background jobs. They scale independently, and a worker crash
// never takes down the API.
//
// UNLIKE the API (28.1 degraded mode), a WORKER REQUIRES Redis AND
// MongoDB (email jobs reload state and persist delivery results):
// if either is disabled/misconfigured/unreachable at startup, this
// process fails fast with a safe error (no credentials logged).
//
// CONNECTION OWNERSHIP (verified in BullMQ 6.3.1 source):
//   - One dedicated ioredis instance per worker (bullmq-worker
//     options: maxRetriesPerRequest null).
//   - BullMQ uses each as the worker's main connection (shared —
//     BullMQ will NOT close it) and auto-duplicates it for the
//     blocking connection (BullMQ closes the duplicate).
//   - We close our instances explicitly after worker.close().
//
// SHUTDOWN (SIGINT/SIGTERM): stop accepting work, let active jobs
// finish (bounded 10s hard stop), close connections, exit.
// ============================================================

import dotenv from 'dotenv';
import Redis from 'ioredis';
import { Worker } from 'bullmq';
import mongoose from 'mongoose';
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
  parseEmailWorkerConcurrency,
  redactConnectionSecrets,
  EMAIL_JOB_NAMES,
} from '../config/queueConfig.js';
import { dispatchJob, classifyJobFailure, registerProcessor, jobRegistry } from './registry.js';
import { registerEmailProcessors } from './emailProcessor.js';
import { markEmailDelivery } from '../services/emailDeliveryService.js';

const SHUTDOWN_HARD_STOP_MS = 10000;

// Safe error text: redact anything that could carry credentials.
const safeErrorText = (error) =>
  redactConnectionSecrets(`${error?.message || 'unknown error'}`).slice(0, 200);

// One set of safe event handlers per worker (queue label included).
// Never logs full job.data — email payloads contain ids only, but
// the rule is uniform for all future jobs.
const attachEventHandlers = (worker, label) => {
  worker.on('ready', () => {
    logger.info(
      `[Worker] ${label} ready (queue=${worker.name}, concurrency=${worker.concurrency})`
    );
  });

  worker.on('active', (job) => {
    logger.info(`[Worker] active: ${job.name} (id=${job.id}, attempt=${job.attemptsStarted})`);
  });

  worker.on('completed', (job) => {
    logger.info(`[Worker] completed: ${job.name} (id=${job.id}, attempts=${job.attemptsStarted})`);
  });

  worker.on('failed', (job, error) => {
    logger.warn(
      `[Worker] failed: ${job?.name || 'unknown'} (id=${job?.id || 'n/a'}, ` +
        `attempt=${job?.attemptsStarted || 'n/a'}, reason=${classifyJobFailure(error)}, ` +
        `detail=${safeErrorText(error)})`
    );
    // When an email job exhausts its retries, persist the terminal
    // state on the delivery record (Mongo is the audit of record).
    if (job && EMAIL_JOB_NAMES.includes(job.name)) {
      markEmailDelivery(job.data?.deliveryId, job.data?.companyId, {
        status: 'FAILED',
        lastFailureCategory: 'RETRIES_EXHAUSTED',
      }).catch(() => {});
    }
  });

  worker.on('stalled', (jobId) => {
    logger.warn(`[Worker] stalled job detected (id=${jobId}) — BullMQ will re-queue it`);
  });

  worker.on('error', (error) => {
    // Connection-level error; ioredis retries internally with its
    // default bounded strategy. Log safely, never crash on it.
    logger.warn(`[Worker] ${label} error (${classifySafeReason(error)}): ${safeErrorText(error)}`);
  });

  worker.on('closing', () => {
    logger.info(`[Worker] ${label} closing (stopping acceptance, finishing active jobs)`);
  });
};

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

  // --- Fail fast: email jobs reload + persist via MongoDB -----------
  // (The 28.2 system jobs don't need Mongo; the 28.3 email jobs do —
  // a worker without Mongo cannot process the email queue.)
  if (!process.env.MONGO_URI) {
    logger.error(
      '[Worker] MONGO_URI is empty — email jobs require MongoDB. ' +
        'Set MONGO_URI privately in Backend/.env.'
    );
    process.exit(1);
  }
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: config.connectTimeoutMs,
    });
    logger.info('[Worker] MongoDB connected (email jobs can persist state)');
  } catch (error) {
    logger.error(
      `[Worker] MongoDB connection failed (${safeErrorText(error)}) — ` +
        'email jobs cannot run. Check MONGO_URI; the API is unaffected.'
    );
    process.exit(1);
  }

  const prefix = getQueuePrefix();
  const concurrency = parseWorkerConcurrency();
  const emailConcurrency = parseEmailWorkerConcurrency();

  logger.info(
    `[Worker] Starting workers (prefix=${prefix}, system concurrency=${concurrency}, email concurrency=${emailConcurrency})`
  );

  // Register the 28.3 email processors in the shared registry.
  registerEmailProcessors({ registerProcessor });

  // One dedicated connection per worker (never the API's client).
  const createWorkerConnection = (connectionName) =>
    new Redis(String(process.env.REDIS_URL).trim(), {
      ...createRedisOptions('bullmq-worker'),
      connectionName,
    });

  const connections = [];
  const workers = [];

  try {
    const systemConnection = createWorkerConnection('crewly-worker-system');
    connections.push(systemConnection);
    const systemWorker = new Worker(QUEUE_NAMES.SYSTEM, dispatchJob, {
      connection: systemConnection,
      prefix,
      concurrency,
    });
    workers.push(systemWorker);
    attachEventHandlers(systemWorker, 'system worker');

    const emailConnection = createWorkerConnection('crewly-worker-email');
    connections.push(emailConnection);
    const emailWorker = new Worker(QUEUE_NAMES.EMAIL, dispatchJob, {
      connection: emailConnection,
      prefix,
      concurrency: emailConcurrency,
    });
    workers.push(emailWorker);
    attachEventHandlers(emailWorker, 'email worker');
  } catch (error) {
    logger.error(`[Worker] Startup failed: ${safeErrorText(error)}`);
    for (const connection of connections) {
      try {
        connection.disconnect();
      } catch {
        /* ignore */
      }
    }
    process.exit(1);
  }

  // --- Readiness gate: BOTH workers must see Redis or fail fast -----
  const ready = await Promise.race([
    Promise.all(
      workers.map((w) =>
        w
          .waitUntilReady()
          .then(() => true)
          .catch(() => false)
      )
    ).then((results) => results.every(Boolean)),
    new Promise((resolve) => setTimeout(() => resolve(false), config.connectTimeoutMs)),
  ]);

  if (!ready) {
    logger.error(
      `[Worker] Redis unavailable within ${config.connectTimeoutMs}ms — workers cannot start. ` +
        'Check REDIS_URL privately; the API is unaffected.'
    );
    await Promise.allSettled(workers.map((w) => w.close().catch(() => {})));
    for (const connection of connections) {
      try {
        connection.disconnect();
      } catch {
        /* ignore */
      }
    }
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  }

  const registrySize = jobRegistry.size;
  logger.info(`[Worker] Workers online (prefix=${prefix}, registered jobs=${registrySize})`);

  // --- Graceful shutdown (this process's own handlers) ---------------
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      // Second signal: stop waiting, exit immediately (user pressed
      // Ctrl+C again). Standard force-quit behavior.
      logger.error('[Worker] Second signal received — forcing immediate exit.');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info(`[Worker] ${signal} received — shutting down gracefully...`);

    const hardStop = setTimeout(() => {
      logger.error('[Worker] Graceful shutdown timed out after 10s — forcing exit.');
      process.exit(1);
    }, SHUTDOWN_HARD_STOP_MS);
    hardStop.unref();

    Promise.allSettled(
      workers.map((w) =>
        w.close().catch((error) => logger.warn(`[Worker] close() error: ${safeErrorText(error)}`))
      )
    ).finally(async () => {
      for (const connection of connections) {
        try {
          connection.disconnect();
        } catch {
          /* ignore */
        }
      }
      await mongoose.connection.close().catch(() => {});
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
