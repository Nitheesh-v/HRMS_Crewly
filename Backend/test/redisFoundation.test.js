// ============================================================
// Phase 28.1 — Redis Foundation tests (hermetic)
//
// No live Redis and no MongoDB are required. Connection-failure
// cases use a deliberately unreachable LOCAL address
// (127.0.0.1:1) with a dummy credential that is asserted to
// never leak into status output.
//
// Live connectivity against the managed Redis Cloud is verified
// with: npm run redis:check
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';

const {
  parseRedisEnabled,
  getRedisConfig,
  createRedisOptions,
  classifySafeReason,
  initializeRedis,
  getRedisClient,
  getRedisStatus,
  getRedisHealth,
  pingRedis,
  closeRedis,
  _resetRedisForTests,
} = await import('../src/config/redis.js');

// --- REDIS_ENABLED parsing -------------------------------------

test('parseRedisEnabled accepts true/1/yes/on case-insensitively', () => {
  for (const value of ['true', '1', 'yes', 'on', 'TRUE', 'True', ' 1 ']) {
    assert.equal(parseRedisEnabled(value), true, `expected enabled for ${value}`);
  }
});

test('parseRedisEnabled treats false/0/no/off/empty as disabled', () => {
  for (const value of ['false', '0', 'no', 'off', '', undefined, null]) {
    assert.equal(parseRedisEnabled(value), false, `expected disabled for ${String(value)}`);
  }
});

test('parseRedisEnabled falls back to disabled on invalid values', () => {
  assert.equal(parseRedisEnabled('banana'), false);
  assert.equal(parseRedisEnabled('truee'), false);
});

// --- Config parsing ----------------------------------------------

test('getRedisConfig clamps REDIS_CONNECT_TIMEOUT_MS safely', () => {
  assert.equal(getRedisConfig({ REDIS_ENABLED: 'false' }).connectTimeoutMs, 10000);
  assert.equal(
    getRedisConfig({ REDIS_ENABLED: 'true', REDIS_CONNECT_TIMEOUT_MS: '500' }).connectTimeoutMs,
    1000
  );
  assert.equal(
    getRedisConfig({ REDIS_ENABLED: 'true', REDIS_CONNECT_TIMEOUT_MS: '999999' }).connectTimeoutMs,
    60000
  );
  assert.equal(
    getRedisConfig({ REDIS_ENABLED: 'true', REDIS_CONNECT_TIMEOUT_MS: 'garbage' }).connectTimeoutMs,
    10000
  );
  assert.equal(
    getRedisConfig({ REDIS_ENABLED: 'true', REDIS_CONNECT_TIMEOUT_MS: '5000' }).connectTimeoutMs,
    5000
  );
});

test('getRedisConfig reports URL presence without exposing the URL', () => {
  const config = getRedisConfig({
    REDIS_ENABLED: 'true',
    REDIS_URL: 'redis://user:pass@localhost:6379/0',
  });
  assert.equal(config.hasUrl, true);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'url'), false);
});

// --- Connection option factory (28.2 compatibility) ---------------

test('createRedisOptions: general client is fail-fast, BullMQ purposes use null retries', () => {
  const general = createRedisOptions('general');
  assert.equal(general.maxRetriesPerRequest, 2);
  assert.equal(general.enableOfflineQueue, false);
  assert.equal(typeof general.retryStrategy, 'function');

  const producer = createRedisOptions('bullmq-producer');
  const worker = createRedisOptions('bullmq-worker');
  assert.equal(producer.maxRetriesPerRequest, null);
  assert.equal(worker.maxRetriesPerRequest, null);
});

// --- Safe error classification ------------------------------------

test('classifySafeReason maps auth/socket errors to safe labels', () => {
  assert.equal(classifySafeReason(new Error('NOAUTH Authentication required.')), 'auth_failed');
  assert.equal(
    classifySafeReason(Object.assign(new Error('err'), { code: 'ERRNOAUTH' })),
    'auth_failed'
  );
  assert.equal(
    classifySafeReason(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    'connection_refused'
  );
  assert.equal(
    classifySafeReason(Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })),
    'dns_resolution_failed'
  );
  assert.equal(
    classifySafeReason(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })),
    'timeout'
  );
  assert.equal(classifySafeReason(new Error('weird failure')), 'connection_error');
});

// --- Disabled mode --------------------------------------------------

test('disabled mode: no client, safe health, idempotent init and close', async () => {
  _resetRedisForTests();

  const first = await initializeRedis({ REDIS_ENABLED: 'false' });
  const second = await initializeRedis({ REDIS_ENABLED: 'false' });
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(getRedisClient(), null);
  assert.deepEqual(getRedisHealth(), { status: 'disabled' });
  assert.equal(await pingRedis(), false);

  await closeRedis();
  await closeRedis(); // idempotent
  assert.deepEqual(getRedisHealth(), { status: 'disabled' });
});

// --- Misconfigured mode ---------------------------------------------

test('misconfigured mode: enabled without URL is down, no client, no crash', async () => {
  _resetRedisForTests();

  const result = await initializeRedis({ REDIS_ENABLED: 'true', REDIS_URL: '' });
  assert.equal(result, null);
  assert.equal(getRedisClient(), null);
  assert.equal(getRedisHealth().status, 'down');
  assert.equal(getRedisHealth().reason, 'misconfigured');

  await closeRedis();
});

// --- Unavailable mode (real client, unreachable local address) --------

test('unavailable Redis: startup degrades safely and never leaks secrets', async () => {
  _resetRedisForTests();

  const env = {
    REDIS_ENABLED: 'true',
    REDIS_URL: 'redis://user:supersecret@127.0.0.1:1/0',
    REDIS_CONNECT_TIMEOUT_MS: '1500',
  };

  const instance = await initializeRedis(env);
  assert.ok(instance, 'client instance exists for background retry');

  const health = getRedisHealth();
  assert.notEqual(health.status, 'up', 'must never report up when unreachable');

  const serialized = JSON.stringify({ ...getRedisStatus(), ...health });
  assert.ok(!serialized.includes('supersecret'), 'status must not leak credentials');
  assert.ok(!serialized.includes('127.0.0.1:1'), 'status must not leak endpoint');

  await closeRedis();
  assert.equal(getRedisStatus().state, 'CLOSED');
});

test('initializeRedis is idempotent while connecting', async () => {
  _resetRedisForTests();

  const env = {
    REDIS_ENABLED: 'true',
    REDIS_URL: 'redis://127.0.0.1:1/0',
    REDIS_CONNECT_TIMEOUT_MS: '1500',
  };

  const [a, b] = await Promise.all([initializeRedis(env), initializeRedis(env)]);
  assert.equal(a, b, 'second call must reuse the same client');

  await closeRedis();
});

// --- Health endpoint wiring (real HTTP, no DB connection) -----------

test('GET /api/health reports services safely with redis disabled', async () => {
  _resetRedisForTests();

  // Required before importing the route tree (env.js validates at import).
  // No real connection is made: connectDB is only called by server.js.
  process.env.MONGO_URI ||= 'mongodb://127.0.0.1:1/crewly_test';
  process.env.JWT_SECRET ||= 'test-jwt-secret-health';

  // Mount the real route tree on a bare express app. The full app.js is
  // intentionally NOT imported here: its morgan request logger starts a
  // periodic timer on the first logged request that would keep this
  // hermetic process alive. Health wiring is identical either way.
  //
  // Also: meetingController.js starts a 60s reminder scheduler at module
  // scope (pre-existing production behavior, fine in the server). While
  // the route tree is imported, auto-unref any setInterval it creates so
  // this hermetic process can exit. Test-only; production untouched.
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => originalSetInterval(...args).unref();

  let server;
  try {
    const [{ default: express }, routerModule] = await Promise.all([
      import('express'),
      import('../src/routes/index.js'),
    ]);
    const app = express();
    app.use('/api', routerModule.default);

    server = app.listen(0);
    await new Promise((resolveListen) => server.once('listening', resolveListen));

    const port = server.address().port;
    // Connection: close — keeps the hermetic test from leaving a
    // keep-alive socket that blocks process exit.
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { connection: 'close' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.status, 'unhealthy', 'no DB in this hermetic test');
    assert.equal(body.services.mongodb, 'down');
    assert.equal(body.services.redis, 'disabled');
    assert.equal(body.services.redisReason, undefined);

    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('redis://'), 'must not leak connection URLs');
    assert.ok(!serialized.includes('REDIS_URL'), 'must not leak env variable names');
  } finally {
    if (server) {
      server.close();
      server.closeAllConnections?.();
    }
    globalThis.setInterval = originalSetInterval;
  }
});
