// ============================================================
// 🛰️ PHASE 28.8 — OPS QUEUE OPERATIONS LIVE LADDER (OPT-IN)
//
//   npm run test:ops:live
//
// Same isolation rules as test/bullmqLive.test.js:
//   - real REDIS_URL from Backend/.env
//   - unique prefix crewly:test:live-<random> (never crewly:development)
//   - in-process Queue + Worker
//   - scoped cleanup: queue.obliterate() on THIS run's queues only
//   - ABSOLUTELY NO FLUSHALL / FLUSHDB
//
// Proves, against live Redis (+ Mongo for the reconcile step):
//   1. Worker heartbeat → ONLINE visible, stop → OFFLINE while
//      queues remain visible (mandatory worker-down test)
//   2. Controlled FAILED job → ops retry → COMPLETED
//   3. Non-retryable (tenant mismatch) FAILED job → 422, NOT retried
//   4. removeJob on FAILED job → removed; ACTIVE jobs never removable
//      (policy asserted hermetically + state re-check here)
//   5. Reconciliation idempotency: 1 stuck email delivery →
//      requeued 1 → second run creates NO duplicate job
//   6. Ops overview reflects live queue counts
//
// Requires Mongo (MONGO_URI) for the reconcile step; fails loudly
// if Redis or Mongo is missing (opt-in = explicit run).
// ============================================================

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
// Phase 30.1.2 fix: these suites used to build the .env path by hand as
// resolve(testDir, '..', '..') + '.env', which resolves to the REPO ROOT
// (<repo>/.env) instead of Backend/.env. dotenv then silently found
// nothing, and every opt-in live test reported "Redis is not configured"
// even with a correct Backend/.env (seen on Windows: "injected env (0) from
// ..\.env"). The canonical loader is the one place that knows the real
// path, so it is imported instead - same behaviour as src/server.js.
import '../src/config/loadEnv.js';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';


// Isolate this run BEFORE any queue/worker creation.
const livePrefix = `crewly:test:live-${randomUUID().slice(0, 8)}`;
process.env.BULLMQ_PREFIX = livePrefix;
process.env.NODE_ENV = 'test';

const { getRedisConfig, createRedisOptions } = await import('../src/config/redis.js');
const { QUEUE_NAMES } = await import('../src/config/queueConfig.js');
const { getQueue, enqueueJob, closeAllQueues } = await import('../src/queues/queueFactory.js');
const { registerProcessor, dispatchJob } = await import('../src/workers/registry.js');
// UnrecoverableError means 'fail this attempt now, do not burn the retry
// budget'. Throwing it is the version-safe way to produce a controlled
// FAILED job: calling job.moveToFailed() from inside the processor was the
// old trick, but BullMQ >= 6 then loses the job lock, re-delays the job and
// re-runs the processor until maxAttempts is exhausted (verified on a live
// Redis 7.2.5 with bullmq 6.3.1). That destroys both the attemptsMade and
// the 'ran exactly once' premises this ladder asserts.
const { Worker, UnrecoverableError } = await import('bullmq');

const {
  startWorkerHeartbeat,
  heartbeatKeyFor,
} = await import('../src/workers/workerHeartbeat.js');
const { OPS_QUEUES } = await import('../src/services/opsQueueRegistry.js');
const {
  getOpsOverview,
  getWorkerStates,
  retryJob,
  removeJob,
  runReconcile,
  OpsError,
} = await import('../src/services/opsQueueService.js');

const config = getRedisConfig();
const HAS_REDIS = config.enabled && config.hasUrl;
const HAS_MONGO = Boolean(process.env.MONGO_URI);

const sleep = (ms) => new Promise((r) => setTimeout(r), ms);

// Bounded poll for eventually-consistent live reads (heartbeat key,
// queue counts). A live suite must never depend on a hardcoded sleep:
// on a loaded machine one round trip can take longer than any fixed
// wait, and a flaky test is worse than no test.
const pollUntil = async (read, isSettled, { attempts = 20, delayMs = 150 } = {}) => {
  let value = await read();
  for (let i = 0; i < attempts && !isSettled(value); i += 1) {
    await sleep(delayMs);
    value = await read();
  }
  return value;
};

const waitForState = async (queue, jobId, states, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (states.includes(state)) return job;
    }
    await sleep(250);
  }
  return null;
};

if (!HAS_REDIS) {
  test('live Redis is configured (REDIS_ENABLED + REDIS_URL)', () => {
    assert.fail(
      'Redis is not configured. This opt-in ladder requires a reachable Redis — ' +
        'check Backend/.env and re-run: npm run test:ops:live'
    );
  });
} else {
  const systemQueue = getQueue(QUEUE_NAMES.SYSTEM);
  const emailQueue = getQueue(QUEUE_NAMES.EMAIL);

  let worker;
  let workerConnection;

// Reads the ops overview through the same deps the API injects, but
// bounded-retried: getOpsOverview is fail-safe by design (a slow queue
// read returns queues: 'unavailable' instead of throwing), so a live
// assertion must wait for the real snapshot instead of racing it.
const readOverview = (predicate) =>
  pollUntil(
    () =>
      getOpsOverview({
        getQueue,
        getRedisClient: () => workerConnection,
        getRedisStatus: () => ({ state: 'up', reason: '' }),
        classifySafeReason: (e) => String(e?.message || 'error').slice(0, 80),
      }),
    (overview) => Array.isArray(overview?.queues) && (predicate ? predicate(overview) : true),
    { attempts: 20, delayMs: 250 }
  );
  let heartbeat;
  let createdDeliveryId = null;

  // Controlled demo processors (in-process registry only).
  let transientCalls = 0;
  registerProcessor('ops-live-transient-fail', async () => {
    transientCalls += 1;
    if (transientCalls === 1) {
      // One controlled failure that looks like a transient Redis blip
      // (the ops classifier maps it to REDIS_UNAVAILABLE = retryable).
      throw new UnrecoverableError('connect ECONNREFUSED 10.0.0.5:6379');
    }
    return { ok: true, calls: transientCalls };
  });
  registerProcessor('ops-live-security-fail', async () => {
    // Tenant mismatch fails the job and is never retryable.
    throw new UnrecoverableError('Tenant mismatch: job company does not match');
  });

  test.before(async () => {
    workerConnection = new Redis(String(process.env.REDIS_URL).trim(), {
      ...createRedisOptions('bullmq-worker'),
      connectionName: 'crewly-worker-ops-live',
    });
    worker = new Worker(QUEUE_NAMES.SYSTEM, dispatchJob, {
      connection: workerConnection,
      prefix: livePrefix,
      concurrency: 1,
    });
    await worker.waitUntilReady();
  });

  test.after(async () => {
    if (heartbeat) await heartbeat.stop().catch(() => {});
    try {
      if (worker) await worker.close();
    } catch {
      /* ignore */
    }
    if (workerConnection) {
      try {
        workerConnection.disconnect();
      } catch {
        /* ignore */
      }
    }
    // Scoped cleanup: ONLY this run's queues (unique prefix).
    for (const queue of [systemQueue, emailQueue]) {
      try {
        await queue.obliterate({ force: true });
      } catch {
        /* queue already closed */
      }
    }
    await closeAllQueues();
    // Mongo cleanup for the reconcile fixture (if we created one).
    if (createdDeliveryId && HAS_MONGO) {
      try {
        const mongoose = (await import('mongoose')).default;
        const EmailDelivery = (await import('../src/models/EmailDelivery.js')).default;
        await EmailDelivery.deleteOne({ _id: createdDeliveryId });
        await mongoose.connection.close();
      } catch {
        /* fixture cleanup is best-effort */
      }
    }
  });

  test('heartbeat: worker ONLINE visible, stop → OFFLINE while queues stay visible', async () => {
    heartbeat = startWorkerHeartbeat(workerConnection, {
      OPS_WORKER_HEARTBEAT_INTERVAL_MS: '10000',
      OPS_WORKER_HEARTBEAT_TTL_SECONDS: '60',
    });
    // First beat lands asynchronously; wait for it to be observable.
    const states = await pollUntil(
      () => getWorkerStates(workerConnection),
      (snapshot) => snapshot.online >= 1
    );
    assert.equal(states.online, 1, 'one online worker expected');
    assert.equal(states.workers[0].status, 'ONLINE');
    assert.match(states.workers[0].workerId, /^worker-[0-9a-f-]{36}$/);

    // Crash simulation: key disappears but the member lingers.
    const deadId = `worker-${randomUUID()}`;
    await workerConnection.sadd('crewly:ops:workers:' + livePrefix.replace('crewly:', ''), deadId);
    const states2 = await pollUntil(
      () => getWorkerStates(workerConnection),
      (snapshot) => snapshot.workers.some((w) => w.workerId === deadId)
    );
    const dead = states2.workers.find((w) => w.workerId === deadId);
    assert.ok(dead, 'lingering member listed');
    assert.equal(dead.status, 'OFFLINE', 'expired key = OFFLINE');

    // Graceful stop → OFFLINE exactly (key deleted), queues visible.
    await heartbeat.stop();
    heartbeat = null;
    const states3 = await pollUntil(
      () => getWorkerStates(workerConnection),
      (snapshot) => snapshot.online === 0
    );
    assert.equal(states3.online, 0, 'worker gone after graceful stop');

    const overview = await readOverview((snapshot) => snapshot.workers.online === 0);
    assert.equal(overview.workers.online, 0, 'worker down is visible');
    assert.ok(Array.isArray(overview.queues), 'queues remain visible while worker is down');
    // Derived from the allowlist, never a literal: Phase 29.6 added the
    // payroll queue and this line went stale unnoticed. Only a LIVE run can
    // catch that, which is exactly what this suite is for.
    assert.equal(
      overview.queues.length,
      OPS_QUEUES.length,
      'every implemented queue stays visible in ops'
    );
  });

  test('controlled failed job → ops retry → COMPLETED (real queue + worker)', async () => {
    const jobId = `ops-live-retry-${randomUUID()}`;
    await enqueueJob(
      QUEUE_NAMES.SYSTEM,
      'ops-live-transient-fail',
      { requestedAt: new Date().toISOString(), correlationId: randomUUID() },
      { jobId }
    );
    const failed = await waitForState(systemQueue, jobId, ['failed']);
    assert.ok(failed, 'job should reach FAILED after the controlled failure');

    // Ops retry goes through the real service (allowlist + policy +
    // BullMQ job.retry on the SAME job).
    const result = await retryJob({
      queueName: QUEUE_NAMES.SYSTEM,
      jobId,
      // A 24-hex id, because AuditLog.actor is an ObjectId ref: a fake string
      // like 'live-test' makes the (fail-open) audit write throw a CastError,
      // which used to print a misleading connection_error line.
      actor: {
        id: '64a1b2c3d4e5f6a7b8c9d0e1',
        role: 'SUPER_ADMIN',
        method: 'POST',
        path: '/live',
      },
    });
    assert.equal(result.ok, true);
    // A count here used to be `=== 1` ("the retry has not re-run it yet"). That
    // is racy by construction: the worker lives in this same process, and the
    // fail-open audit write inside retryJob can now cost up to its 1 s deadline
    // (or, with no MongoDB, exactly that), during which the retried job is
    // already picked up and finished. The deterministic statement is the end
    // state asserted below: exactly two executions, one failure then one
    // success, and nothing else re-ran the job.
    assert.ok(transientCalls >= 1, 'the failing attempt ran');

    const completed = await waitForState(systemQueue, jobId, ['completed']);
    assert.ok(completed, 'job should complete after the ops retry');
    assert.equal(transientCalls, 2);
  });

  test('non-retryable (tenant mismatch) FAILED job → 422, NOT retried', async () => {
    const jobId = `ops-live-nr-${randomUUID()}`;
    let calls = 0;
    const name = `ops-live-nr-${randomUUID().slice(0, 8)}`;
    registerProcessor(name, async () => {
      calls += 1;
      throw new UnrecoverableError('Tenant mismatch: job company does not match');
    });
    await enqueueJob(
      QUEUE_NAMES.SYSTEM,
      name,
      { requestedAt: new Date().toISOString(), correlationId: randomUUID() },
      { jobId }
    );
    const failed = await waitForState(systemQueue, jobId, ['failed']);
    assert.ok(failed, 'job should fail with a security rejection');
    assert.equal(calls, 1);

    await assert.rejects(
      retryJob({ queueName: QUEUE_NAMES.SYSTEM, jobId }),
      (err) =>
        err instanceof OpsError &&
        err.status === 422 &&
        err.details.retryable === false &&
        err.details.safeFailureCategory === 'SECURITY_REJECTION'
    );
    await sleep(500);
    assert.equal(calls, 1, 'the job must NOT have been retried');

    // Then remove it (FAILED is a removable state) — cleanup + proof.
    const removed = await removeJob({ queueName: QUEUE_NAMES.SYSTEM, jobId });
    assert.equal(removed.ok, true);
    assert.equal(removed.removedState, 'failed');
    assert.equal(await systemQueue.getJob(jobId), undefined);
  });

  test('overview reflects live counts (system queue not empty mid-run)', async () => {
    const jobId = `ops-live-count-${randomUUID()}`;
    await enqueueJob(
      QUEUE_NAMES.SYSTEM,
      'ops-live-security-fail',
      { requestedAt: new Date().toISOString(), correlationId: randomUUID() },
      { jobId }
    );
    const failedJob = await waitForState(systemQueue, jobId, ['failed']);
    assert.ok(failedJob, 'the controlled security job must reach FAILED');

    const overview = await readOverview((snapshot) => {
      const entry = snapshot.queues.find((q) => q.name === QUEUE_NAMES.SYSTEM);
      return (entry?.counts?.failed ?? 0) >= 1;
    });
    const system = overview.queues.find((q) => q.name === QUEUE_NAMES.SYSTEM);
    assert.ok(system.counts.failed >= 1, 'system queue shows the failed job');
    assert.ok(system.health.status === 'WARNING' || system.health.status === 'CRITICAL');
    await removeJob({ queueName: QUEUE_NAMES.SYSTEM, jobId });
  });

  test('reconciliation idempotency: 1 stuck delivery → requeued 1 → second run no duplicate', async () => {
    assert.ok(
      HAS_MONGO,
      'MONGO_URI required for the reconciliation step — set it in Backend/.env'
    );
    const mongoose = (await import('mongoose')).default;
    if (mongoose.connection.readyState !== 1) {
      try {
        await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      } catch {
        assert.fail(
          'MONGO_URI is set but MongoDB is unreachable - the reconciliation ' +
            'step needs a live MongoDB. Run the first four steps alone with: ' +
            'node --test --test-name-pattern "heartbeat|retry|tenant|overview" test/opsQueueOpsLive.test.js'
        );
      }
    }
    const EmailDelivery = (await import('../src/models/EmailDelivery.js')).default;

    // Fixture: one stuck PENDING delivery (older than the 60s window).
    const doc = await EmailDelivery.create({
      companyId: new mongoose.Types.ObjectId(),
      jobName: 'email-pipeline-update',
      eventType: 'PIPELINE_UPDATE',
      eventKey: `ops-live-reconcile-${randomUUID()}`,
      entityType: 'CANDIDATE',
      entityId: new mongoose.Types.ObjectId(),
      recipientType: 'CANDIDATE',
      payload: { deliveryId: 'ops-live', companyId: 'ops-live' },
      status: 'PENDING',
      createdAt: new Date(Date.now() - 120000),
    });
    createdDeliveryId = doc._id;
    const expectedJobId = `email-${doc._id}`;

    // Run 1: requeues exactly 1.
    const run1 = await runReconcile({ area: 'email', limit: 100 });
    assert.ok(run1.requeued >= 1, 'first run should requeue the stuck delivery');
    await sleep(300);
    const jobsAfter1 = (await emailQueue.getJobs(['waiting', 'active', 'delayed', 'failed'])) || [];
    assert.equal(
      jobsAfter1.filter((j) => j.id === expectedJobId).length,
      1,
      'exactly one job for the delivery'
    );

    // Run 2: idempotent — NO duplicate job appears.
    const run2 = await runReconcile({ area: 'email', limit: 100 });
    assert.ok(run2.checked >= 1);
    await sleep(300);
    const jobsAfter2 = (await emailQueue.getJobs(['waiting', 'active', 'delayed', 'failed'])) || [];
    assert.equal(
      jobsAfter2.filter((j) => j.id === expectedJobId).length,
      1,
      'second run must NOT create a duplicate job (deterministic job id)'
    );
  });
}
