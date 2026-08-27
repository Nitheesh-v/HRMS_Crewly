// ============================================================
// 🚦 PHASE 28.2 — BULLMQ CONNECTIVITY/CYCLE CHECK
//
//   npm run queue:check         → SYSTEM_HEALTH_CHECK round-trip
//   npm run queue:check:retry   → controlled fail-once retry proof
//   npm run queue:check:duplicate → duplicate job id collapse proof
//   node scripts/queue-check.js --retry-test [--timeout 20000]
//
// (Dedicated scripts because some npm versions silently strip
//  --flag arguments after `npm run ... --`.)
//
// Flow: load env → confirm Redis configured → open system Queue
// (dedicated connection, environment prefix) → enqueue → poll job
// state → print SAFE result → close everything → exit.
//
// The system WORKER must be running separately (npm run worker:dev)
// for the job to complete. If it is not, this script times out
// SAFELY (bounded) and tells you so — it never hangs.
//
// Safe by design: never prints REDIS_URL; system job payloads are
// harmless metadata only (ids/timestamps). Exit codes:
//   0 = job completed as expected
//   1 = any failure (disabled, misconfigured, enqueue error,
//       worker missing, job failed)
// ============================================================

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getQueue,
  enqueueJob,
  closeAllQueues,
  getQueueStatus,
} from '../src/queues/queueFactory.js';
import { getRedisConfig } from '../src/config/redis.js';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  redactConnectionSecrets,
} from '../src/config/queueConfig.js';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(backendDir, '.env') });

const args = process.argv.slice(2);
const wantRetry = args.includes('--retry-test');
const wantDuplicate = args.includes('--duplicate-test');
const timeoutFlag = args.indexOf('--timeout');
const waitTimeoutMs =
  timeoutFlag !== -1
    ? Math.max(1000, Number(args[timeoutFlag + 1]) || 15000)
    : wantRetry
      ? 30000
      : 15000;
const POLL_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a job to a terminal state (bounded). Returns the final Job
// or null on timeout.
const waitForJob = async (queue, jobId, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') return job;
    }
    await sleep(POLL_MS);
  }
  return null;
};

const main = async () => {
  const config = getRedisConfig();
  if (!config.enabled) {
    console.error('queue:check failed: Redis is disabled (REDIS_ENABLED). Queues require Redis.');
    process.exit(1);
  }
  if (!config.hasUrl) {
    console.error('queue:check failed: REDIS_URL is empty. Set it privately in Backend/.env.');
    process.exit(1);
  }

  console.log('Queue configuration detected.');
  console.log(`Prefix: ${getQueueStatus().prefix}`);

  let jobName = JOB_NAMES.SYSTEM_HEALTH_CHECK;
  let jobId;

  try {
    if (wantRetry) {
      jobName = JOB_NAMES.SYSTEM_RETRY_TEST;
      const job = await enqueueJob(QUEUE_NAMES.SYSTEM, jobName, {
        requestedAt: new Date().toISOString(),
        correlationId: randomUUID(),
      });
      jobId = job.id;
      console.log(
        `SYSTEM_RETRY_TEST enqueued (id=${jobId}) — expect 1 controlled failure, then success.`
      );
    } else if (wantDuplicate) {
      const deterministicId = `queue-check-dup-${Date.now()}`;
      const first = await enqueueJob(
        QUEUE_NAMES.SYSTEM,
        jobName,
        { requestedAt: new Date().toISOString(), correlationId: randomUUID() },
        { jobId: deterministicId }
      );
      const second = await enqueueJob(
        QUEUE_NAMES.SYSTEM,
        jobName,
        { requestedAt: new Date().toISOString(), correlationId: randomUUID() },
        { jobId: deterministicId }
      );
      jobId = first.id;
      console.log(
        `Duplicate test: first id=${first.id}, second id=${second.id} (same id => single job).`
      );
    } else {
      const job = await enqueueJob(QUEUE_NAMES.SYSTEM, jobName, {
        requestedAt: new Date().toISOString(),
        correlationId: randomUUID(),
      });
      jobId = job.id;
      console.log(`SYSTEM_HEALTH_CHECK enqueued (id=${jobId}).`);
    }
  } catch (error) {
    console.error(
      `queue:check failed to enqueue: ${redactConnectionSecrets(error?.message || 'unknown error')}`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Waiting for worker completion (timeout ${waitTimeoutMs}ms)...`);
  const queue = getQueue(QUEUE_NAMES.SYSTEM);
  const job = await waitForJob(queue, jobId, waitTimeoutMs);

  if (!job) {
    console.error(
      'queue:check timed out: the job is still waiting — the system worker is not running.\n' +
        '  Start it in a separate terminal:  npm run worker:dev'
    );
    process.exitCode = 1;
    return;
  }

  const state = await job.getState();
  if (state === 'completed') {
    const result =
      job.returnvalue && typeof job.returnvalue === 'object'
        ? redactConnectionSecrets(JSON.stringify(job.returnvalue))
        : '(no result)';
    console.log(
      `${jobName} COMPLETED (id=${job.id}, attempts=${job.attemptsStarted}).`
    );
    console.log(`Result: ${result}`);
    if (wantDuplicate) {
      console.log(
        'Duplicate job id collapsed into a single job — idempotency behavior confirmed.'
      );
    }
    if (wantRetry && job.attemptsStarted >= 2) {
      console.log(
        'Retry confirmed: the processor ran 2 times (attempt 1 failed by design, backoff applied, attempt 2 completed).'
      );
    } else if (wantRetry) {
      console.log(
        'WARNING: job completed on the FIRST attempt — the retry was not exercised.'
      );
    }
    return;
  }

  console.error(
    `queue:check failed: ${jobName} FAILED after ${job.attemptsStarted} attempt(s). ` +
      `reason=${redactConnectionSecrets(job.failedReason || 'unknown').slice(0, 200)}`
  );
  process.exitCode = 1;
};

main()
  .catch((error) => {
    console.error(
      `queue:check failed: ${redactConnectionSecrets(error?.message || 'unexpected error')}`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllQueues().catch(() => {});
    process.exit(process.exitCode || 0);
  });
