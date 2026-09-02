// ============================================================
// ⚙️ PHASE 28.2/28.3 — CREWLY WORKER PROCESS
//
//   npm run worker:dev   (nodemon)
//   npm run worker       (plain node)
//
// One process runs all seven BullMQ workers:
//   - system queue    (28.2 infrastructure jobs)
//   - email queue     (28.3 email delivery jobs)
//   - resume queue    (28.4 resume parsing jobs)
//   - ats queue       (28.4 ATS matching jobs)
//   - scheduled queue (28.5/28.6 delayed jobs: interview +
//     pre-onboarding + BGV reminders, offer expiry)
//   - documents queue (28.6 stored document processing)
//   - bgv queue       (28.6 background verification execution)
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

import '../config/loadEnv.js'; // FIRST — .env must load before env-snapshotting imports
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
  parseResumeWorkerConcurrency,
  parseATSWorkerConcurrency,
  parseScheduledWorkerConcurrency,
  parseDocumentWorkerConcurrency,
  parsePayrollWorkerConcurrency,
  parseBgvWorkerConcurrency,
  redactConnectionSecrets,
  EMAIL_JOB_NAMES,
} from '../config/queueConfig.js';
import { closeAllQueues } from '../queues/queueFactory.js';
import { dispatchJob, classifyJobFailure, registerProcessor, jobRegistry } from './registry.js';
import { registerEmailProcessors } from './emailProcessor.js';
import { registerResumeProcessors } from './resumeProcessor.js';
import { registerATSProcessors } from './atsProcessor.js';
import { registerScheduledProcessors } from './scheduledProcessor.js';
import { registerDocumentProcessors } from './documentProcessor.js';
import { registerBgvProcessors } from './bgvProcessor.js';
import { registerPayrollProcessors } from './payrollProcessor.js';
import { markEmailDelivery } from '../services/emailDeliveryService.js';
import {
  recoverPendingResumeProcessing,
} from '../services/resumeProcessingDispatcher.js';
import { recoverPendingATSMatching } from '../services/atsDispatcher.js';
import { runScheduledReconcile } from '../services/scheduledJobScheduler.js';
import { runDocumentReconcile } from '../services/documentProcessingDispatcher.js';
import { runBgvReconcile } from '../services/bgvQueueDispatcher.js';
import { startWorkerHeartbeat } from './workerHeartbeat.js';

const SHUTDOWN_HARD_STOP_MS = 10000;

// Safe error text: redact anything that could carry credentials.
const safeErrorText = (error) =>
  redactConnectionSecrets(`${error?.message || 'unknown error'}`).slice(0, 200);

// 28.9 error-storm protection (§76): sustained Redis/provider
// failures emit repeated 'error' events. Log the FIRST one, then
// at most one summary line per 30s (with a suppressed count) so
// the logs stay readable without hiding the problem.
const ERROR_LOG_INTERVAL_MS = 30000;

// One set of safe event handlers per worker (queue label included).
// Never logs full job.data — email payloads contain ids only, but
// the rule is uniform for all future jobs.
const attachEventHandlers = (worker, label) => {
  const errState = { last: 0, suppressed: 0 };
  worker.on('ready', () => {
    errState.last = 0;
    errState.suppressed = 0;
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
    // 28.4 processing jobs need no extra bookkeeping on exhaustion:
    // the resume business state is already terminal (FAILED via the
    // final-attempt path) or RETRY_PENDING, and the ATS intent
    // (missing result / recalculationPending) stays in Mongo —
    // startup recovery / processing:reconcile re-derives it with a
    // slot-prepared job id. Mongo is the audit of record.
    // 28.5 scheduled jobs are the same shape: the Mongo scheduling
    // intent (reminderDispatch PENDING/FAILED, terms.expiryDate)
    // survives exhaustion and startup reconcile / scheduled:reconcile
    // re-derives the job with a slot-prepared deterministic id.
  });

  worker.on('stalled', (jobId) => {
    logger.warn(`[Worker] stalled job detected (id=${jobId}) — BullMQ will re-queue it`);
  });

  worker.on('error', (error) => {
    // Connection-level error; ioredis retries internally with its
    // default bounded strategy. Log safely, never crash on it —
    // throttled to avoid a log storm on a sustained outage.
    const now = Date.now();
    if (now - errState.last < ERROR_LOG_INTERVAL_MS) {
      errState.suppressed += 1;
      return;
    }
    errState.last = now;
    const suppressed = errState.suppressed;
    errState.suppressed = 0;
    logger.warn(
      `[Worker] ${label} error (${classifySafeReason(error)}): ${safeErrorText(error)}` +
        (suppressed ? ` (+${suppressed} similar errors suppressed in the last 30s)` : '')
    );
  });

  worker.on('closing', () => {
    logger.info(`[Worker] ${label} closing (stopping acceptance, finishing active jobs)`);
  });
};

const startWorker = async () => {
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

  // --- Fail fast: email + processing jobs reload + persist via
  // --- MongoDB (28.2 system jobs don't; 28.3 email and 28.4
  // resume/ATS jobs do — a worker without Mongo cannot process
  // those queues).
  if (!process.env.MONGO_URI) {
    logger.error(
      '[Worker] MONGO_URI is empty — email and processing jobs require MongoDB. ' +
        'Set MONGO_URI privately in Backend/.env.'
    );
    process.exit(1);
  }
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: config.connectTimeoutMs,
    });
    logger.info(
      '[Worker] MongoDB connected (email + processing jobs can persist state)'
    );
  } catch (error) {
    logger.error(
      `[Worker] MongoDB connection failed (${safeErrorText(error)}) — ` +
        'email and processing jobs cannot run. Check MONGO_URI; the API is unaffected.'
    );
    process.exit(1);
  }

  const prefix = getQueuePrefix();
  const concurrency = parseWorkerConcurrency();
  const emailConcurrency = parseEmailWorkerConcurrency();
  const resumeConcurrency = parseResumeWorkerConcurrency();
  const atsConcurrency = parseATSWorkerConcurrency();
  const scheduledConcurrency = parseScheduledWorkerConcurrency();
  const documentConcurrency = parseDocumentWorkerConcurrency();
  const bgvConcurrency = parseBgvWorkerConcurrency();
  const payrollConcurrency = parsePayrollWorkerConcurrency();

  logger.info(
    `[Worker] Starting workers (prefix=${prefix}, system concurrency=${concurrency}, ` +
      `email concurrency=${emailConcurrency}, resume concurrency=${resumeConcurrency}, ` +
      `ats concurrency=${atsConcurrency}, scheduled concurrency=${scheduledConcurrency}, ` +
      `documents concurrency=${documentConcurrency}, bgv concurrency=${bgvConcurrency}, ` +
      `payroll concurrency=${payrollConcurrency})`
  );

  // Register the 28.3 email + 28.4 processing + 28.5 scheduled +
  // 28.6 document/BGV processors in the shared registry.
  registerEmailProcessors({ registerProcessor });
  registerResumeProcessors({ registerProcessor });
  registerATSProcessors({ registerProcessor });
  registerScheduledProcessors({ registerProcessor });
  registerDocumentProcessors({ registerProcessor });
  registerBgvProcessors({ registerProcessor });
  // 29.6 → 29.9 payroll processors: run, review export, bank file,
  // payslip generation, payslip ZIP and payslip email. Registered here
  // because the payroll queue needs a real consumer — without this the
  // API silently fell back to its inline path for every one of them.
  registerPayrollProcessors({ registerProcessor });

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

    // 28.4 processing queues. Resume is CPU-bound (PDF/DOCX
    // extraction) so it defaults to single-flight; ATS is light.
    const resumeConnection = createWorkerConnection('crewly-worker-resume');
    connections.push(resumeConnection);
    const resumeWorker = new Worker(QUEUE_NAMES.RESUME, dispatchJob, {
      connection: resumeConnection,
      prefix,
      concurrency: resumeConcurrency,
    });
    workers.push(resumeWorker);
    attachEventHandlers(resumeWorker, 'resume worker');

    const atsConnection = createWorkerConnection('crewly-worker-ats');
    connections.push(atsConnection);
    const atsWorker = new Worker(QUEUE_NAMES.ATS, dispatchJob, {
      connection: atsConnection,
      prefix,
      concurrency: atsConcurrency,
    });
    workers.push(atsWorker);
    attachEventHandlers(atsWorker, 'ats worker');

    // 28.5 scheduled queue: delayed one-time jobs (interview
    // reminders, offer expiry reminders, offer expiry).
    const scheduledConnection = createWorkerConnection('crewly-worker-scheduled');
    connections.push(scheduledConnection);
    const scheduledWorker = new Worker(QUEUE_NAMES.SCHEDULED, dispatchJob, {
      connection: scheduledConnection,
      prefix,
      concurrency: scheduledConcurrency,
    });
    workers.push(scheduledWorker);
    attachEventHandlers(scheduledWorker, 'scheduled worker');

    // 28.6 documents queue: stored document processing (CPU + IO).
    const documentConnection = createWorkerConnection('crewly-worker-documents');
    connections.push(documentConnection);
    const documentWorker = new Worker(QUEUE_NAMES.DOCUMENTS, dispatchJob, {
      connection: documentConnection,
      prefix,
      concurrency: documentConcurrency,
    });
    workers.push(documentWorker);
    attachEventHandlers(documentWorker, 'documents worker');

    // 28.6 BGV queue: provider registration + polling (IO-bound,
    // modest default — external providers must not be hammered).
    const bgvConnection = createWorkerConnection('crewly-worker-bgv');
    connections.push(bgvConnection);
    const bgvWorker = new Worker(QUEUE_NAMES.BGV, dispatchJob, {
      connection: bgvConnection,
      prefix,
      concurrency: bgvConcurrency,
    });
    workers.push(bgvWorker);
    attachEventHandlers(bgvWorker, 'bgv worker');

    // 29.6+ payroll queue: payroll runs, review exports, bank transfer
    // files and payslip jobs. PDF rendering is CPU-bound, so it keeps a
    // modest concurrency of its own.
    const payrollConnection = createWorkerConnection('crewly-worker-payroll');
    connections.push(payrollConnection);
    const payrollWorker = new Worker(QUEUE_NAMES.PAYROLL, dispatchJob, {
      connection: payrollConnection,
      prefix,
      concurrency: payrollConcurrency,
    });
    workers.push(payrollWorker);
    attachEventHandlers(payrollWorker, 'payroll worker');
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

  // --- Readiness gate: ALL workers must see Redis or fail fast ------
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

  // --- 29.12 §20 re-arm scheduled payroll reports --------------------
  // BullMQ's delayed jobs survive a Redis restart, but a schedule whose delay
  // already elapsed while no worker was running does NOT come back by itself.
  // The schedule's nextRunAt lives in MongoDB precisely for this: on startup
  // we sweep anything that is due, run it, and re-arm it. Best-effort — a
  // failure here logs and moves on rather than taking the worker down.
  try {
    const { default: analyticsService } = await import('../services/payroll/analyticsService.js');
    const due = await analyticsService.runDueSchedules();
    if (Array.isArray(due) && due.length) {
      const failed = due.filter((entry) => entry && entry.ok === false).length;
      logger.info(`[Worker] Scheduled payroll reports caught up (due=${due.length}, failed=${failed})`);
    }
  } catch (error) {
    logger.warn(`[Worker] Scheduled report sweep skipped: ${error?.message || error}`);
  }

  // --- 28.8 ops heartbeat ------------------------------------------
  // One ephemeral Redis key tells the Super Admin "Background
  // Operations" page this worker process is alive (ONLINE /
  // SHUTTING_DOWN / OFFLINE). Best-effort: a heartbeat blip never
  // affects job processing. Uses the system worker's own
  // connection (worker-owned, closed below on shutdown).
  let heartbeat = null;
  try {
    heartbeat = startWorkerHeartbeat(connections[0]);
    logger.info(
      `[Worker] Ops heartbeat started (id=${heartbeat.workerId})`
    );
  } catch (error) {
    logger.warn(
      `[Worker] Ops heartbeat unavailable (${safeErrorText(error)}) — ` +
        'workers will show OFFLINE in the ops UI'
    );
    heartbeat = null;
  }

  // --- 28.4 startup recovery ------------------------------------------
  // Mongo is the source of truth for processing intent. Re-derive any
  // stuck resume/ATS work (expired leases, COMPLETED parse with no
  // ATS result, pending recalculations) and re-enqueue it before the
  // queues start serving. Idempotent (deterministic job ids + slot
  // prep + dedupe); a failure here is NOT fatal — the same recovery
  // runs on the next startup and via `npm run processing:reconcile`.
  try {
    const [resumeRecovery, atsRecovery] = await Promise.all([
      recoverPendingResumeProcessing(),
      recoverPendingATSMatching(),
    ]);
    logger.info(
      `[Worker] Startup recovery: resume queued=${resumeRecovery.queued}/${resumeRecovery.pending}, ` +
        `ats queued=${atsRecovery.queued}/${atsRecovery.pending}`
    );
  } catch (error) {
    logger.warn(
      `[Worker] Startup recovery failed — processing jobs stay recoverable via ` +
        `npm run processing:reconcile (${safeErrorText(error)})`
    );
  }

  // --- 28.5 scheduled reconciliation --------------------------------
  // Delayed jobs persist in Redis across restarts, so startup only
  // re-derives anything the queue lost (queue.add failure, prefix
  // change, Redis incident). Bounded + idempotent; non-fatal.
  try {
    const scheduled = await runScheduledReconcile();
    logger.info(
      `[Worker] Scheduled reconcile: interviews ` +
        `queued=${scheduled.interviews.scheduled}/${scheduled.interviews.checked}, ` +
        `offer reminders=${scheduled.offers.reminders}, expiries=${scheduled.offers.expiries}`
    );
  } catch (error) {
    logger.warn(
      `[Worker] Scheduled reconcile failed — jobs stay recoverable via ` +
        `npm run scheduled:reconcile (${safeErrorText(error)})`
    );
  }

  // --- 28.6 document + BGV startup reconciliation ------------------
  // Same shape as the 28.4/28.5 blocks: Mongo intent survives any
  // Redis loss; deterministic job ids make re-derivation idempotent.
  try {
    const [documents, bgv] = await Promise.all([
      runDocumentReconcile(),
      runBgvReconcile(),
    ]);
    logger.info(
      `[Worker] 28.6 reconcile: documents queued=${documents.scheduled}/${documents.checked}, ` +
        `bgv cases queued=${bgv.queued}/${bgv.checked}, polls scheduled=${bgv.pollsScheduled}`
    );
  } catch (error) {
    logger.warn(
      `[Worker] 28.6 reconcile failed — jobs stay recoverable via ` +
        `npm run queue:reconcile (${safeErrorText(error)})`
    );
  }

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

    // Tell the ops UI we are on purpose (brief SHUTTING_DOWN
    // window; the key expires on its own if we never get here).
    if (heartbeat) {
      void heartbeat.markShuttingDown().catch(() => {});
    }

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
      // Clear the ops heartbeat BEFORE closing connections (its
      // key would expire anyway — this just makes OFFLINE exact).
      if (heartbeat) {
        await heartbeat.stop().catch(() => {});
      }
      // Startup recovery (28.4) opens producer-side queues in this
      // process — close them too (BullMQ leaves the ioredis
      // instances to us, then we disconnect).
      await closeAllQueues().catch(() => {});
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
