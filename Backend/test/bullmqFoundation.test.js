// ============================================================
// Phase 28.2 — BullMQ foundation tests (hermetic)
//
// No live Redis and no MongoDB required. These verify config,
// conventions, payload validation, registry dispatch, and safe
// failure modes only. The live Queue→Worker round-trip is the
// separate OPT-IN test:  npm run test:bullmq:live
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';

const {
  QUEUE_NAMES,
  JOB_NAMES,
  getQueuePrefix,
  parseWorkerConcurrency,
  getDefaultJobOptions,
  buildJobId,
  redactConnectionSecrets,
  isKnownQueueName,
  getQueueConfigSummary,
  validateSystemJobPayload,
  systemHealthProcessor,
  systemRetryTestProcessor,
  dispatchJob,
  registerProcessor,
  jobRegistry,
  classifyJobFailure,
} = await import('../src/config/queueConfig.js').then(async (qc) => {
  const reg = await import('../src/workers/registry.js');
  return { ...qc, ...reg };
});

const { getQueue } = await import('../src/queues/queueFactory.js');

// --- Queue / job name constants ------------------------------------

test('queue and job name constants are centralized', () => {
  assert.equal(QUEUE_NAMES.SYSTEM, 'system');
  for (const reserved of ['email', 'resume', 'ats', 'scheduled', 'documents', 'bgv', 'analytics']) {
    assert.ok(Object.values(QUEUE_NAMES).includes(reserved), `reserved queue ${reserved}`);
  }
  assert.equal(JOB_NAMES.SYSTEM_HEALTH_CHECK, 'system-health-check');
  assert.equal(JOB_NAMES.SYSTEM_RETRY_TEST, 'system-retry-test');
  assert.equal(isKnownQueueName('system'), true);
  assert.equal(isKnownQueueName('nope'), false);
});

// --- Prefix / environment isolation ---------------------------------

test('getQueuePrefix derives crewly:<NODE_ENV> by default', () => {
  assert.equal(getQueuePrefix({ NODE_ENV: 'development' }), 'crewly:development');
  assert.equal(getQueuePrefix({ NODE_ENV: 'test' }), 'crewly:test');
  assert.equal(getQueuePrefix({ NODE_ENV: 'production' }), 'crewly:production');
  assert.equal(getQueuePrefix({ NODE_ENV: 'staging' }), 'crewly:staging');
});

test('getQueuePrefix sanitizes odd env values and honors BULLMQ_PREFIX', () => {
  assert.equal(getQueuePrefix({ NODE_ENV: 'My Env!' }), 'crewly:my-env');
  assert.equal(getQueuePrefix({}), 'crewly:development');
  // Clean override is used as-is (sanitized).
  assert.equal(
    getQueuePrefix({ NODE_ENV: 'production', BULLMQ_PREFIX: 'crewly:staging' }),
    'crewly:staging'
  );
  // Messy override is sanitized safely (lowercase, safe chars only).
  assert.equal(
    getQueuePrefix({ NODE_ENV: 'production', BULLMQ_PREFIX: 'Crewly: Prod ' }),
    'crewly:-prod'
  );
  // Invalid override (empty/whitespace) falls back to derived prefix.
  assert.equal(getQueuePrefix({ NODE_ENV: 'test', BULLMQ_PREFIX: '   ' }), 'crewly:test');
});

// --- Worker concurrency ----------------------------------------------

test('parseWorkerConcurrency clamps and falls back safely', () => {
  assert.equal(parseWorkerConcurrency({}), 2);
  assert.equal(parseWorkerConcurrency({ WORKER_CONCURRENCY: '7' }), 7);
  // Zero/negative/invalid values fall back to the safe default (2).
  assert.equal(parseWorkerConcurrency({ WORKER_CONCURRENCY: '0' }), 2);
  assert.equal(parseWorkerConcurrency({ WORKER_CONCURRENCY: '-4' }), 2);
  assert.equal(parseWorkerConcurrency({ WORKER_CONCURRENCY: '999' }), 50);
  assert.equal(parseWorkerConcurrency({ WORKER_CONCURRENCY: 'garbage' }), 2);
  assert.equal(parseWorkerConcurrency({ WORKER_CONCURRENCY: '2.9' }), 2);
});

// --- Default job options ----------------------------------------------

test('default job options are safe and bounded', () => {
  const options = getDefaultJobOptions();
  assert.equal(options.attempts, 3);
  assert.deepEqual(options.backoff, { type: 'exponential', delay: 1000 });
  assert.deepEqual(options.removeOnComplete, { count: 100 });
  assert.deepEqual(options.removeOnFail, { count: 500 });

  // Mutating one copy must not leak into the next call.
  options.backoff.delay = 99999;
  options.removeOnComplete.count = 1;
  assert.deepEqual(getDefaultJobOptions().backoff, { type: 'exponential', delay: 1000 });
  assert.deepEqual(getDefaultJobOptions().removeOnComplete, { count: 100 });
});

// --- Job ID convention --------------------------------------------------

test('buildJobId joins parts and rejects unsafe input', () => {
  assert.equal(buildJobId('resume-parse', 'res_123', 'v1'), 'resume-parse:res_123:v1');
  assert.throws(() => buildJobId('resume-parse', '', 'v1'));
  assert.throws(() => buildJobId('resume-parse', 'has space', 'v1'));
  assert.throws(() => buildJobId('resume-parse', 'bad\ttab', 'v1'));
  assert.throws(() => buildJobId('x'.repeat(200)));
});

// --- Secret redaction ----------------------------------------------------

test('redactConnectionSecrets hides URL userinfo, leaves other text alone', () => {
  assert.equal(
    redactConnectionSecrets('connect redis://user:pass@host:6379 failed'),
    'connect redis://***@host:6379 failed'
  );
  assert.equal(
    redactConnectionSecrets('rediss://a:b@h:1/0 ok'),
    'rediss://***@h:1/0 ok'
  );
  assert.equal(
    redactConnectionSecrets('mongodb+srv://u:p@cluster.example.net/db'),
    'mongodb+srv://***@cluster.example.net/db'
  );
  assert.equal(redactConnectionSecrets('no url here'), 'no url here');
});

// --- System job payload validation ---------------------------------------

test('validateSystemJobPayload enforces known keys and string types', () => {
  assert.equal(validateSystemJobPayload(undefined).valid, true);
  assert.equal(validateSystemJobPayload({}).valid, true);
  assert.equal(
    validateSystemJobPayload({ correlationId: 'abc', requestedAt: '2026-01-01T00:00:00Z' }).valid,
    true
  );
  assert.equal(validateSystemJobPayload({ password: 'x' }).valid, false);
  assert.equal(validateSystemJobPayload({ correlationId: 42 }).valid, false);
  assert.equal(validateSystemJobPayload(['array']).valid, false);
});

// --- Processors (fake BullMQ Job objects — no Redis involved) --------------

const fakeJob = (name, data, attemptsStarted = 1) => ({
  name,
  data,
  id: 'test-id',
  attemptsStarted,
});

test('systemHealthProcessor returns a safe operational result', async () => {
  const result = await systemHealthProcessor(
    fakeJob(JOB_NAMES.SYSTEM_HEALTH_CHECK, { correlationId: 'corr-1' })
  );
  assert.equal(result.ok, true);
  assert.equal(result.worker, 'system');
  assert.equal(result.correlationId, 'corr-1');
  assert.ok(typeof result.processedAt === 'string');

  await assert.rejects(
    () => systemHealthProcessor(fakeJob(JOB_NAMES.SYSTEM_HEALTH_CHECK, { secret: 'x' }))
  );
});

test('systemRetryTestProcessor fails only on the first attempt', async () => {
  await assert.rejects(
    () => systemRetryTestProcessor(fakeJob(JOB_NAMES.SYSTEM_RETRY_TEST, {}, 1)),
    /attempt 1/
  );
  const result = await systemRetryTestProcessor(fakeJob(JOB_NAMES.SYSTEM_RETRY_TEST, {}, 2));
  assert.equal(result.ok, true);
  assert.equal(result.attemptsStarted, 2);
});

// --- Registry dispatch -------------------------------------------------------

test('dispatchJob routes known names and rejects unknown names safely', async () => {
  const result = await dispatchJob(
    fakeJob(JOB_NAMES.SYSTEM_HEALTH_CHECK, { correlationId: 'c-9' })
  );
  assert.equal(result.correlationId, 'c-9');

  await assert.rejects(
    () => dispatchJob(fakeJob('unknown-job-name', {})),
    /No processor registered/
  );
});

test('registerProcessor validates its arguments', () => {
  assert.throws(() => registerProcessor('', () => {}));
  assert.throws(() => registerProcessor('x', 'not-a-function'));
  const before = jobRegistry.size;
  registerProcessor('temp-test-job', async () => ({ ok: true }));
  assert.ok(jobRegistry.has('temp-test-job'));
  jobRegistry.delete('temp-test-job');
  assert.equal(jobRegistry.size, before);
});

// --- Safe job-failure classification -------------------------------------

class FakeRedisError extends Error {}

test('classifyJobFailure separates processor errors from connection errors', () => {
  assert.equal(classifyJobFailure(new Error('controlled retry-test failure (attempt 1)')), 'processor_error');
  assert.equal(classifyJobFailure(null), 'unknown');
  assert.equal(classifyJobFailure(undefined), 'unknown');

  const refused = new Error('connect ECONNREFUSED');
  refused.code = 'ECONNREFUSED';
  assert.equal(classifyJobFailure(refused), 'connection_refused');

  const dns = new Error('getaddrinfo ENOTFOUND host');
  dns.code = 'ENOTFOUND';
  assert.equal(classifyJobFailure(dns), 'dns_resolution_failed');

  const redisErr = new FakeRedisError('read timeout');
  assert.equal(classifyJobFailure(redisErr), 'connection_error');
});

// --- Queue factory guards (no Redis required for these paths) ---------------

test('getQueue rejects unknown queue names', () => {
  assert.throws(() => getQueue('totally-unknown'), /Unknown queue name/);
});

test('getQueue fails safely (no crash) when Redis is not configured', () => {
  // Deterministic without Redis: force the disabled/misconfigured paths
  // through the real config reader by clearing the env in a sandbox copy.
  const savedEnabled = process.env.REDIS_ENABLED;
  const savedUrl = process.env.REDIS_URL;
  try {
    process.env.REDIS_ENABLED = 'false';
    assert.throws(() => getQueue(QUEUE_NAMES.SYSTEM), /Redis is not configured/);

    process.env.REDIS_ENABLED = 'true';
    delete process.env.REDIS_URL;
    assert.throws(() => getQueue(QUEUE_NAMES.SYSTEM), /Redis is not configured/);
  } finally {
    if (savedEnabled === undefined) delete process.env.REDIS_ENABLED;
    else process.env.REDIS_ENABLED = savedEnabled;
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
  }
});

// --- Safe config summary -------------------------------------------------------

test('queue config summary contains no connection secrets', () => {
  const savedUrl = process.env.REDIS_URL;
  try {
    process.env.REDIS_URL = 'rediss://user:hunter2@secret-host.example:1234/0';
    const summary = JSON.stringify(getQueueConfigSummary());
    assert.ok(!summary.includes('hunter2'), 'summary must not contain the password');
    assert.ok(!summary.includes('secret-host'), 'summary must not contain the host');
  } finally {
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
  }
});
