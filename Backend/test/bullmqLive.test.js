// ============================================================
// Phase 28.2 — BullMQ LIVE integration test (OPT-IN)
//
//   npm run test:bullmq:live
//
// Run explicitly — the normal suite (npm run test:bullmq) is
// hermetic and never touches Redis. This test uses the real
// REDIS_URL from Backend/.env but is ISOLATED from it:
//
//   - prefix: crewly:test:live-<random> (never crewly:development)
//   - in-process Queue + Worker (no dependency on the dev worker)
//   - cleanup: queue.obliterate() scoped to THIS queue only
//
// ABSOLUTELY NO FLUSHALL / FLUSHDB — only this test queue's own
// keys are removed.
//
// Proves against the live managed Redis:
//   1. SYSTEM_HEALTH_CHECK round-trip (Queue → Redis → Worker)
//   2. Retry + backoff (controlled fail-once processor)
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: resolve(backendDir, '.env') });

// Isolate this run: unique prefix, set BEFORE queue/worker creation.
const livePrefix = `crewly:test:live-${randomUUID().slice(0, 8)}`;
process.env.BULLMQ_PREFIX = livePrefix;
process.env.NODE_ENV = 'test';

const { getRedisConfig, createRedisOptions } = await import('../src/config/redis.js');
const { QUEUE_NAMES, JOB_NAMES } = await import('../src/config/queueConfig.js');
const { getQueue, enqueueJob, closeAllQueues } = await import('../src/queues/queueFactory.js');
const { dispatchJob } = await import('../src/workers/registry.js');

const { Worker } = await import('bullmq');

const config = getRedisConfig();
const RUN = config.enabled && config.hasUrl;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitForJob = async (queue, jobId, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        // Re-fetch after the terminal state: hash read and state
        // read are separate commands; the atomic completion script
        // may have landed between them (stale returnvalue).
        const fresh = await queue.getJob(jobId);
        return fresh ?? job;
      }
    }
    await sleep(250);
  }
  return null;
};

let worker;
let workerConnection;
let queue;

if (!RUN) {
  // Explicitly-run opt-in test must FAIL loudly when Redis is not
  // configured (a silent skip would hide the misconfiguration).
  test('live Redis is configured (REDIS_ENABLED + REDIS_URL)', () => {
    assert.fail(
      'Redis is not configured (REDIS_ENABLED/REDIS_URL in Backend/.env). ' +
        'This opt-in test requires a reachable Redis — configure it and re-run: npm run test:bullmq:live'
    );
  });
} else {
  test.before(async () => {
    queue = getQueue(QUEUE_NAMES.SYSTEM);
    workerConnection = new Redis(String(process.env.REDIS_URL).trim(), {
      ...createRedisOptions('bullmq-worker'),
      connectionName: 'crewly-worker-test-live',
    });
    worker = new Worker(QUEUE_NAMES.SYSTEM, dispatchJob, {
      connection: workerConnection,
      prefix: livePrefix,
      concurrency: 1,
    });
    await worker.waitUntilReady();
  });

  test.after(async () => {
    try {
      if (worker) await worker.close();
    } catch {
      /* ignore */
    }
    // Scoped cleanup: ONLY this test queue's keys (prefix includes a
    // unique random suffix). Never FLUSHALL/FLUSHDB.
    try {
      if (queue) await queue.obliterate({ force: true });
    } catch {
      /* queue already closed */
    }
    await closeAllQueues();
    try {
      workerConnection?.disconnect();
    } catch {
      /* ignore */
    }
  });

  test('live: SYSTEM_HEALTH_CHECK round-trip completes (Queue → Redis → Worker)', async () => {
    const job = await enqueueJob(QUEUE_NAMES.SYSTEM, JOB_NAMES.SYSTEM_HEALTH_CHECK, {
      requestedAt: new Date().toISOString(),
      correlationId: randomUUID(),
    });
    const done = await waitForJob(queue, job.id);
    assert.ok(done, 'job should complete within 30s');
    const state = await done.getState();
    assert.equal(state, 'completed');
    assert.equal(done.returnvalue.ok, true);
    assert.equal(done.returnvalue.worker, 'system');
    assert.equal(done.returnvalue.correlationId, job.data.correlationId);
  });

  test('live: retry + backoff — controlled fail-once job completes on attempt 2', async () => {
    const job = await enqueueJob(
      QUEUE_NAMES.SYSTEM,
      JOB_NAMES.SYSTEM_RETRY_TEST,
      { requestedAt: new Date().toISOString(), correlationId: randomUUID() },
      { attempts: 2, backoff: { type: 'exponential', delay: 500 } }
    );
    const done = await waitForJob(queue, job.id);
    assert.ok(done, 'job should complete within 30s');
    const state = await done.getState();
    assert.equal(state, 'completed');
    assert.equal(done.attemptsMade, 1, 'exactly one controlled failure');
    assert.equal(done.attemptsStarted, 2, 'second attempt ran');
    assert.equal(done.returnvalue.ok, true);
  });
}
