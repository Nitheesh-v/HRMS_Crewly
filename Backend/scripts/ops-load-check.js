// ============================================================
// 📈 PHASE 28.9 — CONTROLLED LOAD / BACKPRESSURE CHECK (OPT-IN)
//
//   node scripts/ops-load-check.js [--jobs 100] [--concurrency 4] [--timeout 120000]
//
// A LIGHTWEIGHT, developer-controlled load check (not a production
// benchmark — do NOT treat free-tier Redis results as production
// capacity):
//
//   1. Isolated prefix crewly:test:load-<random> (never dev data)
//   2. Enqueues N SAFE SYSTEM_HEALTH_CHECK jobs (ids only — no
//      PII, no DB writes in the processor)
//   3. Runs an in-process system worker with bounded concurrency
//   4. Measures: drain time, failed count, peak backlog,
//      approximate process RSS before/after
//   5. Scoped cleanup: obliterate THIS queue only — never
//      FLUSHALL / FLUSHDB
//
// Exit codes: 0 = all jobs completed, 1 = any failure/misconfig.
// Safe by design: never prints REDIS_URL; payloads are harmless
// metadata; bounded by --timeout.
// ============================================================

import '../src/config/loadEnv.js'; // FIRST — before env-snapshotting imports
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 ? Number(args[i + 1]) || fallback : fallback;
};
const JOBS = Math.min(1000, Math.max(10, flag('--jobs', 100)));
const CONCURRENCY = Math.min(16, Math.max(1, flag('--concurrency', 4)));
const TIMEOUT_MS = Math.min(600000, Math.max(10000, flag('--timeout', 120000)));

const { getRedisConfig } = await import('../src/config/redis.js');
const { getQueuePrefix } = await import('../src/config/queueConfig.js');

const config = getRedisConfig();
if (!config.enabled || !config.hasUrl) {
  console.error(
    '✗ Redis is not configured (REDIS_ENABLED/REDIS_URL in Backend/.env). ' +
      'This opt-in check requires a reachable Redis.'
  );
  process.exit(1);
}

// Isolate BEFORE any queue/worker creation.
const loadPrefix = `crewly:test:load-${randomUUID().slice(0, 8)}`;
process.env.BULLMQ_PREFIX = loadPrefix;
process.env.NODE_ENV = 'test';

console.log(`📈 Load check: ${JOBS} safe jobs, concurrency ${CONCURRENCY}, isolated prefix ${loadPrefix}`);

const Redis = (await import('ioredis')).default;
const { Worker } = await import('bullmq');
const { createRedisOptions } = await import('../src/config/redis.js');
const { QUEUE_NAMES } = await import('../src/config/queueConfig.js');
const { getQueue, enqueueJob, closeAllQueues } = await import('../src/queues/queueFactory.js');
const { dispatchJob } = await import('../src/workers/registry.js');

const startedAt = Date.now();
const rssBefore = process.memoryUsage().rss;
const queue = getQueue(QUEUE_NAMES.SYSTEM);
const connection = new Redis(String(process.env.REDIS_URL).trim(), {
  ...createRedisOptions('bullmq-worker'),
  connectionName: 'crewly-load-check-worker',
});

let worker;
try {
  // Enqueue the full batch FIRST (backpressure: the backlog builds
  // while the worker drains it).
  const ids = [];
  for (let i = 0; i < JOBS; i += 1) {
    const job = await enqueueJob(
      QUEUE_NAMES.SYSTEM,
      'system-health-check',
      { requestedAt: new Date().toISOString(), correlationId: randomUUID() }
    );
    ids.push(String(job.id));
  }
  console.log(`✓ Enqueued ${JOBS} jobs`);

  let completed = 0;
  let failed = 0;
  let peakBacklog = 0;
  const sampler = setInterval(async () => {
    try {
      const counts = await queue.getJobCounts();
      peakBacklog = Math.max(peakBacklog, (counts.wait || 0) + (counts.prioritized || 0));
    } catch {
      /* sampling is best-effort */
    }
  }, 250);
  sampler.unref();

  worker = new Worker(QUEUE_NAMES.SYSTEM, dispatchJob, {
    connection,
    prefix: loadPrefix,
    concurrency: CONCURRENCY,
  });
  worker.on('completed', () => (completed += 1));
  worker.on('failed', () => (failed += 1));
  await worker.waitUntilReady();

  // Bounded drain wait.
  const deadline = Date.now() + TIMEOUT_MS;
  let done = false;
  while (Date.now() < deadline) {
    const counts = await queue.getJobCounts();
    const remaining =
      (counts.wait || 0) +
      (counts.prioritized || 0) +
      (counts.active || 0) +
      (counts.delayed || 0);
    if (remaining === 0 && completed + failed >= JOBS) {
      done = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  clearInterval(sampler);

  const drainMs = Date.now() - startedAt;
  const rssAfter = process.memoryUsage().rss;
  const rssDeltaKb = Math.round((rssAfter - rssBefore) / 1024);

  console.log('──────────────────────────────────────────────');
  console.log(`  Completed : ${completed}/${JOBS}`);
  console.log(`  Failed    : ${failed}`);
  console.log(`  Drain time: ${drainMs}ms (${(drainMs / JOBS).toFixed(1)}ms/job avg)`);
  console.log(`  Peak backlog: ${peakBacklog} waiting`);
  console.log(`  RSS before/after: ${Math.round(rssBefore / 1024 / 1024)}MB → ${Math.round(rssAfter / 1024 / 1024)}MB (Δ ${rssDeltaKb}KB — one measurement, NOT a leak claim)`);
  console.log('──────────────────────────────────────────────');
  console.log('Note: development managed-Redis results are NOT a production capacity benchmark.');

  if (!done) {
    console.error('✗ Load check timed out before the backlog drained');
    process.exitCode = 1;
  } else if (failed > 0 || completed + failed < JOBS) {
    console.error(`✗ Load check finished with ${failed} failed jobs`);
    process.exitCode = 1;
  } else {
    console.log('✓ Load check passed — backlog drained, no failures');
  }
} catch (error) {
  console.error(`✗ Load check failed: ${String(error?.message || 'unknown error').slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  try {
    if (worker) await worker.close();
  } catch {
    /* ignore */
  }
  try {
    connection.disconnect();
  } catch {
    /* ignore */
  }
  // Scoped cleanup: ONLY this isolated prefix's queue.
  try {
    await queue.obliterate({ force: true });
  } catch {
    /* already closed */
  }
  await closeAllQueues().catch(() => {});
  console.log(`Cleanup complete (prefix ${loadPrefix} removed). Bye.`);
}
