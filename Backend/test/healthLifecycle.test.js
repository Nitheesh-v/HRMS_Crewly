// ============================================================
//  PHASE 32.2 — HEALTH, READINESS & GRACEFUL LIFECYCLE (HERMETIC).
//
//  No MongoDB, no Redis, no network, no real process exit. The REAL
//  shipped lifecycle state machine, health controllers, drain gate
//  collaborator logic, graceful-shutdown sequence and worker
//  heartbeat run against injected fakes:
//    · mongoose readyState  → closure
//    · getRedisHealth       → closure
//    · http server          → event-emitter-style fake (close +
//                             closeIdleConnections recording)
//    · process.exit         → recording stub
//    · ioredis connection   → command-recording fake
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const lifecycle = await import('../src/config/lifecycle.js');
const healthModule = await import('../src/controllers/healthController.js');
const shutdownModule = await import('../src/utils/gracefulShutdown.js');
const heartbeatModule = await import('../src/workers/workerHeartbeat.js');

const { LIFECYCLE_STATES } = lifecycle;

const MONGO_UP = 1;
const MONGO_DOWN = 0;

const redisUp = { status: 'up' };
const redisDown = { status: 'down', reason: 'unavailable' };
const redisDisabled = { status: 'disabled' };

const freshController = () =>
  healthModule.createHealthController();

const mockRes = () => {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      if (this.statusCode === null) this.statusCode = 200; // express default

      this.body = body;
      return this;
    },
  };
  return res;
};

// ═════════════════════════════════════════════════════════════
//  Lifecycle state machine
// ═════════════════════════════════════════════════════════════

test('lifecycle: STARTING → READY → DRAINING → STOPPED, forward-only and idempotent', () => {
  lifecycle._resetLifecycleForTests();

  assert.equal(lifecycle.getLifecycleState(), LIFECYCLE_STATES.STARTING);
  assert.equal(lifecycle.isReadyToServe(), false);
  assert.equal(lifecycle.isDraining(), false);

  assert.equal(lifecycle.markReady(), true);
  assert.equal(lifecycle.isReadyToServe(), true);

  // Repeated markReady is a no-op.
  assert.equal(lifecycle.markReady(), false);
  assert.equal(lifecycle.getLifecycleState(), LIFECYCLE_STATES.READY);

  assert.equal(lifecycle.beginDrain('SIGTERM'), true);
  assert.equal(lifecycle.isReadyToServe(), false);
  assert.equal(lifecycle.isDraining(), true);
  assert.equal(lifecycle.getDrainReason(), 'SIGTERM');

  // Readiness can NEVER resurrect after drain begins.
  assert.equal(lifecycle.markReady(), false);
  assert.equal(lifecycle.getLifecycleState(), LIFECYCLE_STATES.DRAINING);

  // Repeated drain is a no-op and keeps the FIRST reason.
  assert.equal(lifecycle.beginDrain('SIGINT'), false);
  assert.equal(lifecycle.getDrainReason(), 'SIGTERM');

  assert.equal(lifecycle.markStopped(), true);
  assert.equal(lifecycle.isDraining(), true);
});

// ═════════════════════════════════════════════════════════════
//  Liveness
// ═════════════════════════════════════════════════════════════

test('liveness: 200 even with Mongo down and Redis down — never fails on recoverable dependencies', () => {
  lifecycle._resetLifecycleForTests();
  const controller = freshController();

  const withInjected = healthModule.createHealthController({
    mongooseState: () => MONGO_DOWN,
    redisHealth: () => redisDown,
  });

  const res = withInjected.liveness({}, mockRes());

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.success, true);
});

test('liveness body: no connection strings, hosts, database names or topology', () => {
  const controller = healthModule.createHealthController({
    mongooseState: () => MONGO_UP,
    redisHealth: () => redisUp,
  });

  const raw = JSON.stringify(
    controller.liveness({}, mockRes()).body,
  ).toLowerCase();

  for (const word of ['mongodb://', 'redis://', 'mongo_uri', 'redis_url', 'password', 'secret', 'uri', 'host']) {
    assert.ok(!raw.includes(word), `liveness must not contain "${word}"`);
  }
});

// ═════════════════════════════════════════════════════════════
//  Readiness matrix
// ═════════════════════════════════════════════════════════════

test('readiness: STARTING (before listen) → 503 startup_in_progress even with Mongo up', () => {
  lifecycle._resetLifecycleForTests();
  assert.equal(lifecycle.getLifecycleState(), LIFECYCLE_STATES.STARTING);

  const controller = healthModule.createHealthController({
    mongooseState: () => MONGO_UP,
    redisHealth: () => redisUp,
  });

  const res = controller.readiness({}, mockRes());

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'unready');
  assert.equal(res.body.reason, 'startup_in_progress');
});

test('readiness: READY + Mongo up → 200 ready', () => {
  lifecycle._resetLifecycleForTests();
  lifecycle.markReady();

  const controller = healthModule.createHealthController({
    mongooseState: () => MONGO_UP,
    redisHealth: () => redisUp,
  });

  const res = controller.readiness({}, mockRes());

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ready');
  assert.deepEqual(res.body.dependencies, { database: 'up', cache: 'up' });
});

test('readiness: Redis DISABLED is intentional configuration — still 200 ready, cache label reported', () => {
  lifecycle._resetLifecycleForTests();
  lifecycle.markReady();

  const controller = healthModule.createHealthController({
    mongooseState: () => MONGO_UP,
    redisHealth: () => redisDisabled,
  });

  const res = controller.readiness({}, mockRes());

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dependencies.cache, 'disabled');
});

test('readiness: Redis DEGRADED (enabled but down) — still 200 ready (fail-open architecture)', () => {
  lifecycle._resetLifecycleForTests();
  lifecycle.markReady();

  const controller = healthModule.createHealthController({
    mongooseState: () => MONGO_UP,
    redisHealth: () => redisDown,
  });

  const res = controller.readiness({}, mockRes());

  assert.equal(res.statusCode, 200, 'Redis degradation must NOT unready the API');
  assert.equal(res.body.dependencies.cache, 'down');
});

test('readiness: Mongo unavailable → 503 database_unavailable (authoritative state unreachable)', () => {
  lifecycle._resetLifecycleForTests();
  lifecycle.markReady();

  const controller = healthModule.createHealthController({
    mongooseState: () => MONGO_DOWN,
    redisHealth: () => redisUp,
  });

  const res = controller.readiness({}, mockRes());

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.reason, 'database_unavailable');
  assert.equal(res.body.dependencies.database, 'down');
});

test('readiness: DRAINING → 503 even with Mongo up (load balancer must stop routing)', () => {
  lifecycle._resetLifecycleForTests();
  lifecycle.markReady();
  lifecycle.beginDrain('SIGTERM');

  const controller = healthModule.createHealthController({
    mongooseState: () => MONGO_UP,
    redisHealth: () => redisUp,
  });

  const res = controller.readiness({}, mockRes());

  assert.equal(res.statusCode, 503);
  assert.match(res.body.reason, /^draining:SIGTERM$/);
});

// ═════════════════════════════════════════════════════════════
//  Legacy /api/health — shape preserved, status code honest
// ═════════════════════════════════════════════════════════════

test('legacy health: Phase 28 contract preserved — ALWAYS 200, body status field is the signal', () => {
  const okController = healthModule.createHealthController({
    mongooseState: () => MONGO_UP,
    redisHealth: () => redisUp,
  });

  const ok = okController.legacyHealth({}, mockRes());
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.status, 'ok');
  assert.equal(ok.body.services.mongodb, 'up');

  const degraded = healthModule.createHealthController({
    mongooseState: () => MONGO_UP,
    redisHealth: () => redisDown,
  }).legacyHealth({}, mockRes());

  assert.equal(degraded.statusCode, 200);
  assert.equal(degraded.body.status, 'degraded');
  assert.equal(degraded.body.services.redis, 'down');

  // Phase 28 pinned contract: the combined probe never changes its
  // status CODE (redisFoundation suite pins this). Infrastructure
  // routing uses /api/health/ready instead.
  const unhealthy = healthModule.createHealthController({
    mongooseState: () => MONGO_DOWN,
    redisHealth: () => redisUp,
  }).legacyHealth({}, mockRes());

  assert.equal(unhealthy.statusCode, 200);
  assert.equal(unhealthy.body.status, 'unhealthy');
});

test('health bodies never contain URIs, hosts or credentials', () => {
  lifecycle._resetLifecycleForTests();
  lifecycle.markReady();

  const controller = healthModule.createHealthController({
    mongooseState: () => MONGO_UP,
    redisHealth: () => ({ status: 'down', reason: 'unavailable' }),
  });

  const raw = JSON.stringify([
    controller.liveness({}, mockRes()).body,
    controller.readiness({}, mockRes()).body,
    controller.legacyHealth({}, mockRes()).body,
  ]);

  for (const word of ['mongodb://', 'redis://', 'mongoose', 'connectionstring', 'jwt', 'smpt', 'smtp', 'password', '@']) {
    assert.ok(!raw.toLowerCase().includes(word), `health payloads must not contain "${word}"`);
  }
});

// ═════════════════════════════════════════════════════════════
//  Graceful shutdown sequence
// ═════════════════════════════════════════════════════════════

const fakeServer = () => {
  const calls = [];

  return {
    calls,

    close(callback) {
      calls.push('close');

      callback();
    },

    closeIdleConnections() {
      calls.push('closeIdleConnections');
    },
  };
};

test('shutdown: drain flag first, then close server + closeIdleConnections + owned resources, exit 0', async () => {
  lifecycle._resetLifecycleForTests();
  lifecycle.markReady();

  const order = [];

  const server = fakeServer();

  const exits = [];

  const shutdown = shutdownModule.createGracefulShutdown({
    server,

    closeQueues: async () => order.push('queues'),

    closeRedis: async () => order.push('redis'),

    disconnectMongo: async () => order.push('mongo'),

    timeoutMs: 5000,

    exit: (code) => {
      order.push(`exit:${code}`);

      exits.push(code);
    },

    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  await shutdown('SIGTERM');

  assert.equal(lifecycle.isDraining(), true, 'readiness/gate must flip before anything closes');
  assert.deepEqual(order, ['queues', 'redis', 'mongo', 'exit:0']);
  assert.deepEqual(server.calls, ['close', 'closeIdleConnections']);
  assert.equal(lifecycle.getLifecycleState(), LIFECYCLE_STATES.STOPPED);
});

test('shutdown: idempotent — second signal does not re-run cleanup', async () => {
  lifecycle._resetLifecycleForTests();

  let queueCloses = 0;

  const shutdown = shutdownModule.createGracefulShutdown({
    server: fakeServer(),

    closeQueues: async () => {
      queueCloses += 1;
    },

    closeRedis: async () => {},

    disconnectMongo: async () => {},

    timeoutMs: 5000,

    exit: () => {},

    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  await shutdown('SIGTERM');
  await shutdown('SIGTERM');

  assert.equal(queueCloses, 1);
});

test('shutdown: bounded — a hanging server close triggers the forced exit within the timeout', async () => {
  lifecycle._resetLifecycleForTests();

  const hangingServer = {
    close() {
      // Never calls back — simulates a stuck keep-alive socket.
    },
    closeIdleConnections() {},
  };

  let exitCode = null;

  const shutdown = shutdownModule.createGracefulShutdown({
    server: hangingServer,

    closeQueues: async () => {},

    closeRedis: async () => {},

    disconnectMongo: async () => {},

    timeoutMs: 30,

    exit: (code) => {
      exitCode = code;
    },

    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const shutdownPromise = shutdown('SIGTERM');

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(exitCode, 1, 'hard stop must force exit(1) when close hangs');

  // The runner eventually settles regardless (hard stop unrefs — the
  // awaiting test just guards against a hanging test process).
  const settleRace = await Promise.race([
    shutdownPromise.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('timeout-guard'), 500)),
  ]);

  assert.equal(settleRace, 'timeout-guard', 'runner stays pending on hang — bounded exit is the safety net');
});

test('shutdown timeout parser: strict, clamped, safe default', () => {
  const parse = shutdownModule.parseShutdownTimeoutMs;

  assert.equal(parse({}), 10000);
  assert.equal(parse({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: '15000' }), 15000);
  assert.equal(parse({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: 'abc' }), 10000);
  assert.equal(parse({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: '-5' }), 10000);
  assert.equal(parse({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: '5' }), 1000, 'clamped to minimum');
  assert.equal(parse({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: '999999' }), 60000, 'clamped to maximum');
});

// ═════════════════════════════════════════════════════════════
//  Worker heartbeat truthfulness (worker health semantics)
// ═════════════════════════════════════════════════════════════

const fakeRedis = () => {
  const store = new Map();
  const members = new Set();

  return {
    store,

    async set(key, value) {
      store.set(key, value);

      return 'OK';
    },

    async sadd(key, member) {
      const fresh = !members.has(member);

      members.add(member);

      return fresh ? 1 : 0;
    },

    async srem(key, member) {
      members.delete(member);

      return 1;
    },

    async scard() {
      return members.size;
    },

    async del(key) {
      store.delete(key);

      return 1;
    },
  };
};

test('worker heartbeat: starts ONLINE, transitions to SHUTTING_DOWN on shutdown, stop clears exactly', async () => {
  const connection = fakeRedis();

  const heartbeat = heartbeatModule.startWorkerHeartbeat(connection, {
    OPS_WORKER_HEARTBEAT_INTERVAL_MS: '999999', // no timer beats during the test
  });

  // startWorkerHeartbeat fires one immediate beat — the key now holds
  // ONLINE state (with a TTL set by the real command args).
  const onlineKey = [...connection.store.keys()].find((key) =>
    key.includes(heartbeat.workerId),
  );

  assert.ok(onlineKey, 'heartbeat key present after first beat');
  assert.equal(JSON.parse(connection.store.get(onlineKey)).state, 'online');

  // The exact call the worker shutdown path makes first:
  await heartbeat.markShuttingDown();

  const payload = JSON.parse(connection.store.get(onlineKey));

  assert.equal(payload.state, 'shutting_down');

  await heartbeat.stop();

  assert.equal(
    connection.store.has(onlineKey),
    false,
    'stop() clears the key so OFFLINE is exact'
  );
});

test('worker health classification (ops truth): online / shutting_down / OFFLINE-by-expiry', () => {
  const { classifyWorkerState } = heartbeatModule;

  assert.equal(classifyWorkerState(30000, 'online'), 'ONLINE');
  assert.equal(classifyWorkerState(4000, 'shutting_down'), 'SHUTTING_DOWN');
  assert.equal(classifyWorkerState(-2, ''), 'OFFLINE', 'key missing/expired = OFFLINE');
  assert.equal(classifyWorkerState(-1, 'online'), 'OFFLINE', 'no-expiry anomaly treated as OFFLINE, never healthy');
  assert.equal(classifyWorkerState(5000, 'unexpected'), 'OFFLINE');
});
