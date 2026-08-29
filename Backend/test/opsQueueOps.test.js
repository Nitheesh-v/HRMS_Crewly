// ============================================================
// 🧪 PHASE 28.8 — OPS QUEUE OPERATIONS (HERMETIC)
//
// No live Redis, no Mongo. Fakes for queues/Redis/audit/models
// are injected through the ops service's `deps` seam.
//
// Covers:
//   - worker bootstrap export-link guard (regression: 28.6 bug)
//   - ops queue allowlist
//   - safe failure categories + backend retry policy
//   - safe job serializer (whitelist + redaction + entity refs)
//   - queue health severity calc (delayed never flagged)
//   - overview degraded shape (Redis down)
//   - failed list paging limits
//   - retry / remove / pause / batch policy (409/422/400 paths)
//   - reconciliation preview + bounded run
//   - cache ops (validation + invalidation)
//   - worker heartbeat (key format, stop, state calc)
//   - platform permission matrix (read vs manage)
// ============================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
process.env.REDIS_ENABLED ||= 'false';
process.env.JWT_SECRET ||= 'ops-hermetic-test-secret';

const {
  OPS_QUEUES,
  OPS_QUEUE_ALLOWLIST,
  getOpsQueue,
  getOpsThresholds,
  classifyOpsFailure,
  getRetryPolicy,
  SAFE_CATEGORIES,
  OPS_JOB_ID_PATTERN,
} = await import('../src/services/opsQueueRegistry.js');

const {
  redactSensitiveText,
  extractEntityRef,
  serializeJobForOps,
} = await import('../src/services/opsJobSerializer.js');

const {
  getOpsOverview,
  getFailedJobs,
  getJobDetail,
  retryJob,
  retryFailedJobs,
  removeJob,
  pauseQueue,
  resumeQueue,
  getReconcilePreview,
  runReconcile,
  getCacheStatus,
  invalidateCompanyAnalyticsCache,
  computeQueueHealth,
  getWorkerStates,
  humanAge,
  OpsError,
  OPS_FAILED_PAGE_MAX,
  RECONCILE_MAX_LIMIT,
  RECONCILE_AREAS,
} = await import('../src/services/opsQueueService.js');

const {
  startWorkerHeartbeat,
  classifyWorkerState,
  heartbeatKeyFor,
  workerMemberKey,
} = await import('../src/workers/workerHeartbeat.js');

const {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  superAdminSession,
} = await import('../src/middlewares/superAdminAuth.js');

const { protect } = await import('../src/middlewares/authMiddleware.js');
const jwt = (await import('jsonwebtoken')).default;
const { reconcileBackgroundWork } = await import(
  '../src/services/opsReconcileCoordinator.js'
);

const VALID_OID = '64a1b2c3d4e5f6a7b8c9d0e1';
const OTHER_OID = '64b2c3d4e5f6a7b8c9d0e2f3';

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

const makeFakeJob = (overrides = {}) => ({
  id: '123',
  name: 'email-pipeline-update',
  timestamp: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  failedAt: 1_700_000_060_000,
  attemptsMade: 1,
  opts: { maxAttempts: 3 },
  failedReason: 'connection lost',
  data: {
    deliveryId: OTHER_OID,
    companyId: VALID_OID,
    candidateName: 'Jane Doe',
    candidateEmail: 'jane@example.com',
    secretToken: 'abcdef1234567890abcdef1234567890abcdef12',
  },
  retryCalls: 0,
  removeCalls: 0,
  retry: async function () {
    this.retryCalls += 1;
  },
  remove: async function () {
    this.removeCalls += 1;
  },
  ...overrides,
});

const makeFakeQueue = ({
  counts = {},
  failedJobs = [],
  oldestWaiting = null,
  paused = false,
  jobState = 'failed',
} = {}) => {
  const calls = { getJobCounts: 0, getWaiting: 0, getJobs: 0, isPaused: 0 };
  return {
    calls,
    getJobCounts: async () => {
      calls.getJobCounts += 1;
      return counts;
    },
    getWaiting: async () => {
      calls.getWaiting += 1;
      return oldestWaiting ? [oldestWaiting] : [];
    },
    getJobs: async (_types, start, end) => {
      calls.getJobs += 1;
      return failedJobs.slice(start, end + 1);
    },
    getJob: async (id) =>
      failedJobs.find((j) => String(j.id) === String(id)) || null,
    getJobState: async () => jobState,
    isPaused: async () => {
      calls.isPaused += 1;
      return paused;
    },
    pause: async () => {},
    resume: async () => {},
  };
};

const makeFakeRedis = () => {
  const store = new Map();
  const members = new Set();
  const log = { set: [], del: [], sadd: [], srem: [] };
  return {
    store,
    members,
    log,
    set: async (key, value, ...args) => {
      log.set.push([key, value, args]);
      store.set(key, value);
      return 'OK';
    },
    get: async (key) => (store.has(key) ? store.get(key) : null),
    pttl: async (key) => (store.has(key) ? 30000 : -2),
    del: async (key) => {
      log.del.push(key);
      store.delete(key);
      return 1;
    },
    sadd: async (_key, member) => (members.has(member) ? 0 : (members.add(member), 1)),
    smembers: async () => [...members],
    scard: async () => members.size,
    srem: async (_key, member) => {
      log.srem.push(member);
      members.delete(member);
      return 1;
    },
  };
};

const makeFakeAudit = () => {
  const entries = [];
  return {
    entries,
    create: async (entry) => {
      entries.push(entry);
      return {};
    },
  };
};

const baseDeps = (overrides = {}) => ({
  getRedisStatus: () => ({ state: 'up', reason: '' }),
  getRedisClient: () => makeFakeRedis(),
  classifySafeReason: (e) => String(e?.message || 'error').slice(0, 80),
  ...overrides,
});

// ---------------------------------------------------------------
// Worker bootstrap export-link guard
// (regression for the 28.6 import bug that could not start the
// worker process at all — no test previously linked this file)
// ---------------------------------------------------------------

describe('worker bootstrap link guard', () => {
  test('every relative named import in workers/index.js is exported', () => {
    const here = new URL('../src/workers/index.js', import.meta.url);
    const src = readFileSync(here, 'utf8');
    const importRe = /import\s*\{([\s\S]+?)\}\s*from\s*['"]([^'"]+)['"]/g;
    let checked = 0;
    for (const match of src.matchAll(importRe)) {
      const spec = match[2];
      if (!spec.startsWith('.')) continue;
      const target = new URL(spec, here);
      const targetSrc = readFileSync(fileURLToPath(target), 'utf8');
      const names = match[1]
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/).pop().trim())
        .filter(Boolean);
      for (const name of names) {
        checked += 1;
        const exported = new RegExp(
          `export\\s+const\\s+${name}\\b|export\\s+function\\s+${name}\\b|export\\s+\\{[^}]*\\b${name}\\b`
        );
        assert.ok(
          exported.test(targetSrc),
          `workers/index.js imports "${name}" from ${spec} but it is not exported`
        );
      }
    }
    assert.ok(checked >= 10, `expected to check many imports, checked ${checked}`);
  });
});

// ---------------------------------------------------------------
// Ops queue registry
// ---------------------------------------------------------------

describe('ops queue registry', () => {
  test('allowlist contains exactly the 7 implemented queues', () => {
    const names = OPS_QUEUES.map((q) => q.name);
    assert.deepEqual(
      [...names].sort(),
      ['ats', 'bgv', 'documents', 'email', 'resume', 'scheduled', 'system'].sort()
    );
    assert.equal(OPS_QUEUE_ALLOWLIST.size, 7);
  });

  test('excludes the reserved-but-unimplemented analytics queue', () => {
    assert.equal(getOpsQueue('analytics'), null);
    assert.equal(OPS_QUEUE_ALLOWLIST.has('analytics'), false);
  });

  test('rejects arbitrary names', () => {
    for (const name of ['anything', 'crewly:prod', '../etc', '', 'system ']) {
      assert.equal(OPS_QUEUE_ALLOWLIST.has(name), false);
    }
  });

  test('thresholds clamp to sane bounds', () => {
    const t = getOpsThresholds({
      OPS_QUEUE_WAITING_WARN: 'not-a-number',
      OPS_QUEUE_WAITING_CRITICAL: '5', // below warn → clamped up
      OPS_OLDEST_WAITING_WARN_MS: '0',
      OPS_OLDEST_WAITING_CRITICAL_MS: '999999999999',
      OPS_FAILED_RECENT_MINUTES: '99999',
    });
    assert.equal(t.waitingWarn, 100); // fallback
    assert.equal(t.waitingCritical, 100); // clamped to >= warn
    assert.equal(t.oldestWaitingWarnMs, 1000); // min clamp
    assert.equal(t.oldestWaitingCriticalMs, 86400000); // max clamp
    assert.equal(t.failedRecentMinutes, 1440); // max clamp
    assert.ok(t.waitingCritical >= t.waitingWarn);
  });

  test('job id pattern allows safe ids only', () => {
    assert.ok(OPS_JOB_ID_PATTERN.test('123'));
    assert.ok(OPS_JOB_ID_PATTERN.test(`document-process-${VALID_OID}-3`));
    for (const bad of ['', 'abc def', 'a:b', '../x', 'x'.repeat(129)]) {
      assert.equal(OPS_JOB_ID_PATTERN.test(bad), false);
    }
  });
});

// ---------------------------------------------------------------
// Safe failure categories + retry policy
// ---------------------------------------------------------------

describe('safe failure categories', () => {
  test('classifies configuration failures', () => {
    assert.equal(
      classifyOpsFailure('No processor registered for job name "x".'),
      SAFE_CATEGORIES.CONFIGURATION
    );
  });

  test('classifies security rejections (non-retryable)', () => {
    assert.equal(
      classifyOpsFailure('Tenant mismatch: job company does not match'),
      SAFE_CATEGORIES.SECURITY_REJECTION
    );
    assert.equal(
      classifyOpsFailure('Expired token for delivery'),
      SAFE_CATEGORIES.SECURITY_REJECTION
    );
  });

  test('classifies malformed payloads (non-retryable)', () => {
    assert.equal(
      classifyOpsFailure('Malformed payload: missing required field deliveryId'),
      SAFE_CATEGORIES.MALFORMED_PAYLOAD
    );
  });

  test('classifies redis/transient failures (retryable)', () => {
    assert.equal(
      classifyOpsFailure('connect ECONNREFUSED 10.0.0.5:6379'),
      SAFE_CATEGORIES.REDIS_UNAVAILABLE
    );
    assert.equal(
      classifyOpsFailure('worker timeout while processing'),
      SAFE_CATEGORIES.PROCESSOR_ERROR
    );
  });

  test('empty reason → UNKNOWN; attempt cap → RETRIES_EXHAUSTED', () => {
    assert.equal(classifyOpsFailure(''), SAFE_CATEGORIES.UNKNOWN);
    assert.equal(
      classifyOpsFailure('some generic error', { attemptsMade: 3, maxAttempts: 3 }),
      SAFE_CATEGORIES.RETRIES_EXHAUSTED
    );
  });
});

describe('backend retry policy', () => {
  const base = { attemptsMade: 1, maxAttempts: 3 };

  test('non-retryable categories are rejected with a safe reason', () => {
    for (const category of [
      SAFE_CATEGORIES.MALFORMED_PAYLOAD,
      SAFE_CATEGORIES.SECURITY_REJECTION,
      SAFE_CATEGORIES.CONFIGURATION,
      SAFE_CATEGORIES.RETRIES_EXHAUSTED,
      SAFE_CATEGORIES.UNKNOWN,
    ]) {
      const policy = getRetryPolicy('email', 'email-x', category, base);
      assert.equal(policy.retryable, false, category);
      assert.ok(policy.reason.length > 10);
    }
  });

  test('transient categories are retryable', () => {
    assert.equal(
      getRetryPolicy('email', 'email-x', SAFE_CATEGORIES.REDIS_UNAVAILABLE, base).retryable,
      true
    );
    assert.equal(
      getRetryPolicy('email', 'email-x', SAFE_CATEGORIES.PROCESSOR_ERROR, base).retryable,
      true
    );
  });

  test('attempt cap blocks retry even for transient categories', () => {
    const policy = getRetryPolicy(
      'email',
      'email-x',
      SAFE_CATEGORIES.PROCESSOR_ERROR,
      { attemptsMade: 3, maxAttempts: 3 }
    );
    assert.equal(policy.retryable, false);
  });
});

// ---------------------------------------------------------------
// Safe job serializer
// ---------------------------------------------------------------

describe('safe job serializer', () => {
  test('redacts credential URLs, tokens, secrets, paths', () => {
    const url = redactSensitiveText('failed: redis://user:pass@host:6379/0');
    assert.ok(!url.includes('user:pass'));
    assert.ok(url.includes('<url>'));

    const jwt = redactSensitiveText(
      'bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'
    );
    assert.ok(jwt.includes('<token>'));
    assert.ok(!jwt.includes('eyJhbGci'));

    const bearer = redactSensitiveText('Authorization: Bearer abcdef1234567890');
    assert.ok(bearer.includes('Bearer <token>'));

    const pwd = redactSensitiveText('login failed password=SuperSecret123');
    assert.ok(pwd.includes('password=<redacted>'));
    assert.ok(!pwd.includes('SuperSecret123'));

    const winPath = redactSensitiveText('read C:\\Users\\dev\\file.txt');
    assert.ok(winPath.includes('<path>'));
    assert.ok(!winPath.includes('dev'));

    const longToken = redactSensitiveText(
      `x ${'a1b2c3d4e5f6'.repeat(5)}`
    );
    assert.ok(longToken.includes('<token>'));
  });

  test('truncates to 300 chars', () => {
    const out = redactSensitiveText('word '.repeat(200).trim());
    assert.ok(out.length <= 300);
  });

  test('extracts entity refs (type + id only) from deterministic ids', () => {
    assert.deepEqual(extractEntityRef(`document-process-${VALID_OID}-3`), {
      type: 'DocumentVersion',
      id: VALID_OID,
    });
    assert.deepEqual(extractEntityRef(`bgv-check-${VALID_OID}`), {
      type: 'BgvCase',
      id: VALID_OID,
    });
    assert.deepEqual(extractEntityRef(`bgv-poll-${VALID_OID}-2`), {
      type: 'BgvCase',
      id: VALID_OID,
    });
    assert.deepEqual(extractEntityRef(`resume-parse-${VALID_OID}-v2-1700000000000`), {
      type: 'CandidateResume',
      id: VALID_OID,
    });
    assert.deepEqual(extractEntityRef(`ats-process-${VALID_OID}-${OTHER_OID}-1700000000000`), {
      type: 'Candidate',
      id: VALID_OID,
    });
    assert.deepEqual(extractEntityRef(`email-${VALID_OID}`), {
      type: 'EmailDelivery',
      id: VALID_OID,
    });
    // Numeric/system ids → no ref.
    assert.equal(extractEntityRef('12345'), null);
    assert.equal(extractEntityRef('system-health-check'), null);
    // Prefix without a valid ObjectId → null (never guess).
    assert.equal(extractEntityRef('document-process-xyz'), null);
  });

  test('whitelist output: no PII, no raw data, safe category + policy', () => {
    const job = makeFakeJob({
      id: `email-${VALID_OID}`,
      failedReason: 'connect ECONNREFUSED 10.0.0.5:6379',
    });
    const out = serializeJobForOps(job, 'email', 'failed');
    const flat = JSON.stringify(out);
    assert.ok(!flat.includes('Jane Doe'));
    assert.ok(!flat.includes('jane@example.com'));
    assert.ok(!flat.includes('abcdef1234567890'));
    assert.equal(out.tenantRef, VALID_OID); // redacted company ref OK
    assert.deepEqual(out.correlationRef, { type: 'EmailDelivery', id: VALID_OID });
    assert.equal(out.safeFailureCategory, SAFE_CATEGORIES.REDIS_UNAVAILABLE);
    assert.equal(out.retryable, true);
    assert.equal(out.attemptsMade, 1);
    assert.equal(out.maxAttempts, 3);
    // No returnvalue / stack / data keys ever present.
    for (const key of ['returnvalue', 'stack', 'data']) {
      assert.equal(key in out, false);
    }
  });

  test('security rejection → not retryable with safe reason', () => {
    const job = makeFakeJob({
      id: `email-${VALID_OID}`,
      failedReason: 'Tenant mismatch: job company does not match',
    });
    const out = serializeJobForOps(job, 'email', 'failed');
    assert.equal(out.safeFailureCategory, SAFE_CATEGORIES.SECURITY_REJECTION);
    assert.equal(out.retryable, false);
    assert.ok(out.retryReason.length > 10);
  });
});

// ---------------------------------------------------------------
// Queue health severity
// ---------------------------------------------------------------

describe('queue health severity', () => {
  const thresholds = getOpsThresholds({});
  const healthy = {
    counts: { waiting: 0 },
    oldestWaitingMs: null,
    failedRecent: 0,
    paused: false,
    hasOnlineWorker: true,
    thresholds,
  };

  test('all clear → HEALTHY with no reasons', () => {
    const h = computeQueueHealth(healthy);
    assert.equal(h.status, 'HEALTHY');
    assert.equal(h.reasons.length, 0);
  });

  test('delayed jobs are NEVER an incident', () => {
    const h = computeQueueHealth({
      ...healthy,
      counts: { waiting: 0, delayed: 5000 },
    });
    assert.equal(h.status, 'HEALTHY');
    assert.ok(!h.reasons.some((r) => /delayed/i.test(r)));
  });

  test('waiting above warn → WARNING; above critical → CRITICAL', () => {
    assert.equal(
      computeQueueHealth({ ...healthy, counts: { waiting: thresholds.waitingWarn } }).status,
      'WARNING'
    );
    const critical = computeQueueHealth({
      ...healthy,
      counts: { waiting: thresholds.waitingCritical },
    });
    assert.equal(critical.status, 'CRITICAL');
    assert.ok(critical.reasons.some((r) => /jobs waiting/.test(r)));
  });

  test('oldest waiting age produces human reason (warn/critical)', () => {
    const warn = computeQueueHealth({
      ...healthy,
      oldestWaitingMs: thresholds.oldestWaitingWarnMs,
      counts: { waiting: 1 },
    });
    assert.equal(warn.status, 'WARNING');
    assert.ok(warn.reasons.some((r) => /Oldest waiting job is/.test(r)));

    const critical = computeQueueHealth({
      ...healthy,
      oldestWaitingMs: thresholds.oldestWaitingCriticalMs,
      counts: { waiting: 1 },
    });
    assert.equal(critical.status, 'CRITICAL');
  });

  test('failed recency, pause, and missing workers each warn', () => {
    const failed = computeQueueHealth({ ...healthy, failedRecent: 3 });
    assert.equal(failed.status, 'WARNING');
    assert.ok(failed.reasons.some((r) => /3 jobs failed in the last 15 minutes/.test(r)));

    const paused = computeQueueHealth({ ...healthy, paused: true });
    assert.ok(paused.reasons.some((r) => /paused/.test(r)));

    const noWorkers = computeQueueHealth({ ...healthy, hasOnlineWorker: false });
    assert.ok(noWorkers.reasons.some((r) => /No online workers/.test(r)));
  });

  test('severity precedence: CRITICAL wins over WARNING', () => {
    const h = computeQueueHealth({
      ...healthy,
      counts: { waiting: 1 },
      oldestWaitingMs: thresholds.oldestWaitingCriticalMs,
      paused: true,
    });
    assert.equal(h.status, 'CRITICAL');
    assert.ok(h.reasons.length >= 2);
  });

  test('humanAge renders human units', () => {
    assert.equal(humanAge(5000), 'a few seconds');
    assert.equal(humanAge(45000), '45 seconds');
    assert.equal(humanAge(12 * 60000), '12 minutes');
    assert.equal(humanAge(3 * 3600000), '3 hours');
    assert.equal(humanAge(2 * 86400000), '2 days');
  });
});

// ---------------------------------------------------------------
// Overview (degraded + happy)
// ---------------------------------------------------------------

describe('ops overview', () => {
  test('Redis down → safe degraded shape, no queue reads', async () => {
    const fakeQueue = makeFakeQueue({});
    const deps = baseDeps({
      getRedisStatus: () => ({ state: 'down', reason: 'connect ECONNREFUSED' }),
      getQueue: () => fakeQueue,
    });
    const out = await getOpsOverview(deps);
    assert.equal(out.redis.state, 'down');
    assert.equal(out.queues, 'unavailable');
    assert.equal(out.workers, 'unavailable');
    assert.equal(fakeQueue.calls.getJobCounts, 0); // never touched queues
  });

  test('Redis disabled → degraded shape too', async () => {
    const deps = baseDeps({
      getRedisStatus: () => ({ state: 'disabled', reason: '' }),
    });
    const out = await getOpsOverview(deps);
    assert.equal(out.redis.state, 'disabled');
    assert.equal(out.queues, 'unavailable');
  });

  test('happy path: workers + all 7 queues with counts', async () => {
    const redis = makeFakeRedis();
    // Seed one online worker heartbeat.
    const workerId = 'worker-11111111-2222-3333-4444-555555555555';
    redis.store.set(heartbeatKeyFor(workerId), JSON.stringify({ state: 'online', ts: Date.now() }));
    redis.members.add(workerId);

    const fakeQueue = makeFakeQueue({
      counts: { wait: 2, active: 1, delayed: 4, failed: 1, completed: 10, prioritized: 0 },
      failedJobs: [makeFakeJob({ id: '111', failedAt: Date.now() - 60000 })],
      oldestWaiting: { timestamp: Date.now() - 12 * 60000 },
    });
    const deps = baseDeps({
      getRedisClient: () => redis,
      getQueue: () => fakeQueue,
    });
    const out = await getOpsOverview(deps);
    assert.equal(out.redis.state, 'up');
    assert.equal(out.workers.online, 1);
    assert.equal(out.workers.workers[0].status, 'ONLINE');
    assert.equal(Array.isArray(out.queues), true);
    assert.equal(out.queues.length, 7);
    const first = out.queues[0];
    assert.equal(first.counts.waiting, 2);
    assert.equal(first.counts.active, 1);
    assert.equal(first.counts.delayed, 4);
    assert.equal(first.counts.failed, 1);
    assert.ok(first.oldestWaitingMs >= 11 * 60000);
    assert.equal(first.health.status, 'WARNING'); // oldest 12 min + recent fail
    assert.ok(first.health.reasons.some((r) => /Oldest waiting job is/.test(r)));
  });
});

// ---------------------------------------------------------------
// Worker states
// ---------------------------------------------------------------

describe('worker states', () => {
  test('ONLINE / SHUTTING_DOWN / OFFLINE from TTL + payload', async () => {
    const redis = makeFakeRedis();
    const online = 'worker-online';
    const shutting = 'worker-shutting';
    redis.store.set(heartbeatKeyFor(online), JSON.stringify({ state: 'online', ts: Date.now() }));
    redis.store.set(heartbeatKeyFor(shutting), JSON.stringify({ state: 'shutting_down', ts: Date.now() }));
    redis.members.add(online);
    redis.members.add(shutting);
    const dead = 'worker-dead'; // in member set but key expired
    redis.members.add(dead);

    const out = await getWorkerStates(redis);
    const byId = Object.fromEntries(out.workers.map((w) => [w.workerId, w.status]));
    assert.equal(byId[online], 'ONLINE');
    assert.equal(byId[shutting], 'SHUTTING_DOWN');
    assert.equal(byId[dead], 'OFFLINE');
    assert.equal(out.online, 1);
  });

  test('classifyWorkerState is pure', () => {
    assert.equal(classifyWorkerState(30000, 'online'), 'ONLINE');
    assert.equal(classifyWorkerState(30000, 'shutting_down'), 'SHUTTING_DOWN');
    assert.equal(classifyWorkerState(-2, 'online'), 'OFFLINE');
    assert.equal(classifyWorkerState(-1, 'online'), 'OFFLINE');
    assert.equal(classifyWorkerState(30000, 'garbage'), 'OFFLINE');
  });
});

// ---------------------------------------------------------------
// Failed jobs listing
// ---------------------------------------------------------------

describe('failed jobs listing', () => {
  const jobs = [0, 1, 2].map((i) => makeFakeJob({ id: String(i) }));
  test('limit clamps to hard max, page floors to 1', async () => {
    const fakeQueue = makeFakeQueue({ counts: { failed: 3 }, failedJobs: jobs });
    const deps = baseDeps({ getQueue: () => fakeQueue });
    const out = await getFailedJobs(
      { queueName: 'email', page: 0, limit: 1000000 },
      deps
    );
    assert.equal(out.meta.limit, OPS_FAILED_PAGE_MAX);
    assert.equal(out.meta.page, 1);
    assert.equal(out.meta.total, 3);
    assert.equal(out.rows.length, 3);
  });

  test('unknown queue → 404', async () => {
    const deps = baseDeps({ getQueue: () => makeFakeQueue({}) });
    await assert.rejects(
      getFailedJobs({ queueName: 'analytics' }, deps),
      (err) => err instanceof OpsError && err.status === 404
    );
  });

  test('job detail: 404 for unknown, serialized when present', async () => {
    const job = makeFakeJob({ id: '777' });
    const found = makeFakeQueue({ failedJobs: [job] });
    await assert.rejects(
      getJobDetail({ queueName: 'email', jobId: 'nope' }, baseDeps({ getQueue: () => found })),
      (err) => err instanceof OpsError && err.status === 404
    );
    const out = await getJobDetail(
      { queueName: 'email', jobId: '777' },
      baseDeps({ getQueue: () => found })
    );
    assert.equal(out.jobId, '777');
    assert.equal(out.state, 'failed');
  });

  test('job detail rejects unsafe job ids', async () => {
    await assert.rejects(
      getJobDetail(
        { queueName: 'email', jobId: 'a b:c' },
        baseDeps({ getQueue: () => makeFakeQueue({}) })
      ),
      (err) => err instanceof OpsError && err.status === 400
    );
  });
});

// ---------------------------------------------------------------
// Retry / remove / pause policy
// ---------------------------------------------------------------

describe('retry policy (service)', () => {
  test('retryable failed job → retried + audited (safe metadata only)', async () => {
    const job = makeFakeJob({ id: '900', failedReason: 'connect ECONNREFUSED 10.0.0.5:6379' });
    const audit = makeFakeAudit();
    const deps = baseDeps({
      getQueue: () => makeFakeQueue({ failedJobs: [job] }),
      AuditLog: audit,
    });
    const out = await retryJob(
      { queueName: 'email', jobId: '900', actor: { id: 'admin-1', role: 'SUPER_ADMIN' } },
      deps
    );
    assert.equal(out.ok, true);
    assert.equal(job.retryCalls, 1);
    const entry = audit.entries.find((e) => e.action === 'QUEUE_JOB_RETRIED');
    assert.ok(entry);
    assert.equal(entry.companyId, null); // platform scope
    assert.equal(entry.actorRole, 'SUPER_ADMIN');
    assert.ok(!JSON.stringify(entry.metadata).includes('ECONNREFUSED'));
  });

  test('non-retryable (security) → 422 with safe reason, NOT retried', async () => {
    const job = makeFakeJob({
      id: '901',
      failedReason: 'Tenant mismatch: job company does not match',
    });
    const deps = baseDeps({ getQueue: () => makeFakeQueue({ failedJobs: [job] }) });
    await assert.rejects(
      retryJob({ queueName: 'email', jobId: '901' }, deps),
      (err) =>
        err instanceof OpsError &&
        err.status === 422 &&
        err.details.retryable === false &&
        job.retryCalls === 0
    );
  });

  test('not-failed state → 409 (race-safe, no mutation)', async () => {
    const job = makeFakeJob({ id: '902', failedReason: 'boom' });
    const deps = baseDeps({
      getQueue: () => makeFakeQueue({ failedJobs: [job], jobState: 'active' }),
    });
    await assert.rejects(
      retryJob({ queueName: 'email', jobId: '902' }, deps),
      (err) => err instanceof OpsError && err.status === 409 && job.retryCalls === 0
    );
  });

  test('retry() throwing (state changed mid-flight) → 409', async () => {
    const job = makeFakeJob({
      id: '903',
      failedReason: 'connect ETIMEDOUT',
      retry: async () => {
        throw new Error('Job is not in failed or completed state');
      },
    });
    const deps = baseDeps({ getQueue: () => makeFakeQueue({ failedJobs: [job] }) });
    await assert.rejects(
      retryJob({ queueName: 'email', jobId: '903' }, deps),
      (err) => err instanceof OpsError && err.status === 409
    );
  });

  test('unknown job → 404', async () => {
    const deps = baseDeps({ getQueue: () => makeFakeQueue({}) });
    await assert.rejects(
      retryJob({ queueName: 'email', jobId: 'nope' }, deps),
      (err) => err instanceof OpsError && err.status === 404
    );
  });

  test('batch retry caps at 25 and reports per-job results', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => String(i));
    const deps = baseDeps({ getQueue: () => makeFakeQueue({}) });
    await assert.rejects(
      retryFailedJobs({ queueName: 'email', jobIds: ids }, deps),
      (err) => err instanceof OpsError && err.status === 400
    );

    const jobs = [
      makeFakeJob({ id: '100', failedReason: 'connect ECONNREFUSED' }),
      makeFakeJob({ id: '101', failedReason: 'Tenant mismatch' }),
    ];
    const deps2 = baseDeps({ getQueue: () => makeFakeQueue({ failedJobs: jobs }) });
    const out = await retryFailedJobs(
      { queueName: 'email', jobIds: ['100', '101'] },
      deps2
    );
    assert.equal(out.total, 2);
    assert.equal(out.retried, 1);
    const failed = out.results.find((r) => r.jobId === '101');
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 422);
  });
});

describe('remove policy (service)', () => {
  test('failed job → removed + audited', async () => {
    const job = makeFakeJob({ id: '950' });
    const audit = makeFakeAudit();
    const deps = baseDeps({
      getQueue: () => makeFakeQueue({ failedJobs: [job], jobState: 'failed' }),
      AuditLog: audit,
    });
    const out = await removeJob({ queueName: 'email', jobId: '950' }, deps);
    assert.equal(out.ok, true);
    assert.equal(job.removeCalls, 1);
    assert.ok(audit.entries.find((e) => e.action === 'QUEUE_JOB_REMOVED'));
  });

  test('completed job → removable', async () => {
    const job = makeFakeJob({ id: '951' });
    const deps = baseDeps({
      getQueue: () => makeFakeQueue({ failedJobs: [job], jobState: 'completed' }),
    });
    const out = await removeJob({ queueName: 'email', jobId: '951' }, deps);
    assert.equal(out.removedState, 'completed');
  });

  test('active job → 409, never removed', async () => {
    const job = makeFakeJob({ id: '952' });
    const deps = baseDeps({
      getQueue: () => makeFakeQueue({ failedJobs: [job], jobState: 'active' }),
    });
    await assert.rejects(
      removeJob({ queueName: 'email', jobId: '952' }, deps),
      (err) => err instanceof OpsError && err.status === 409 && job.removeCalls === 0
    );
  });

  test('remove() throwing (state changed) → 409', async () => {
    const job = makeFakeJob({
      id: '953',
      remove: async () => {
        throw new Error('Job is not in failed or completed state');
      },
    });
    const deps = baseDeps({
      getQueue: () => makeFakeQueue({ failedJobs: [job], jobState: 'failed' }),
    });
    await assert.rejects(
      removeJob({ queueName: 'email', jobId: '953' }, deps),
      (err) => err instanceof OpsError && err.status === 409
    );
  });
});

describe('pause / resume (service)', () => {
  test('pause calls queue.pause() and audits QUEUE_PAUSED', async () => {
    let paused = 0;
    const audit = makeFakeAudit();
    const deps = baseDeps({
      getQueue: () => ({ pause: async () => (paused += 1), resume: async () => {} }),
      AuditLog: audit,
    });
    const out = await pauseQueue({ queueName: 'email', actor: { role: 'SUPER_ADMIN' } }, deps);
    assert.equal(out.paused, true);
    assert.equal(paused, 1);
    assert.ok(audit.entries.find((e) => e.action === 'QUEUE_PAUSED'));
  });

  test('resume calls queue.resume() and audits QUEUE_RESUMED', async () => {
    let resumed = 0;
    const audit = makeFakeAudit();
    const deps = baseDeps({
      getQueue: () => ({ pause: async () => {}, resume: async () => (resumed += 1) }),
      AuditLog: audit,
    });
    const out = await resumeQueue({ queueName: 'email' }, deps);
    assert.equal(out.paused, false);
    assert.equal(resumed, 1);
    assert.ok(audit.entries.find((e) => e.action === 'QUEUE_RESUMED'));
  });

  test('Redis failure to pause → 502 safe error', async () => {
    const deps = baseDeps({
      getQueue: () => ({ pause: async () => { throw new Error('connect ECONNREFUSED'); } }),
    });
    await assert.rejects(
      pauseQueue({ queueName: 'email' }, deps),
      (err) => err instanceof OpsError && err.status === 502
    );
  });
});

// ---------------------------------------------------------------
// Reconciliation ops
// ---------------------------------------------------------------

describe('reconciliation ops', () => {
  test('preview returns per-area counts with maxRun', async () => {
    const deps = baseDeps({
      EmailDelivery: { countDocuments: async () => 3 },
      CandidateResume: { countDocuments: async () => 5 },
      loadInterviewsForReminderReconcile: async () => [1, 2],
      loadOffersForReconcile: async () => [3],
      loadDocumentVersionsForReconcile: async () => [4, 5, 6],
      loadCasesForBgvReconcile: async () => ({ missingSubmission: [7], duePolls: [8] }),
    });
    const out = await getReconcilePreview(deps);
    assert.equal(out.areas.length, 6);
    const byArea = Object.fromEntries(out.areas.map((a) => [a.area, a]));
    assert.equal(byArea.email.eligible, 3);
    assert.equal(byArea.resume.eligible, 5);
    assert.equal(byArea.ats.eligible, 5); // same model, flagged estimate
    assert.equal(byArea.ats.estimate, true);
    assert.equal(byArea.scheduled.eligible, 3);
    assert.equal(byArea.documents.eligible, 3);
    assert.equal(byArea.bgv.eligible, 2);
    assert.equal(byArea.email.maxRun, RECONCILE_MAX_LIMIT);
  });

  test('preview tolerates Mongo failure (null + unavailable)', async () => {
    const deps = baseDeps({
      EmailDelivery: { countDocuments: async () => { throw new Error('mongo down'); } },
      CandidateResume: { countDocuments: async () => { throw new Error('mongo down'); } },
      loadInterviewsForReminderReconcile: async () => { throw new Error('no'); },
      loadOffersForReconcile: async () => { throw new Error('no'); },
      loadDocumentVersionsForReconcile: async () => { throw new Error('no'); },
      loadCasesForBgvReconcile: async () => { throw new Error('no'); },
    });
    const out = await getReconcilePreview(deps);
    assert.equal(out.areas.length, 6);
    for (const area of out.areas) {
      assert.equal(area.eligible, null);
      assert.equal(area.unavailable, true);
    }
  });

  test('run clamps limit to 1..100 and calls the existing runner', async () => {
    let seen = null;
    const audit = makeFakeAudit();
    const deps = baseDeps({
      reconcileStuckEmailDeliveries: async (opts) => {
        seen = opts;
        return { scanned: 2, requeued: 1, results: [{ requeued: true }, { requeued: false }] };
      },
      AuditLog: audit,
    });
    const out = await runReconcile(
      { area: 'email', limit: 1000000, actor: { role: 'SUPER_ADMIN' } },
      deps
    );
    assert.equal(out.limit, RECONCILE_MAX_LIMIT);
    assert.equal(seen.limit, RECONCILE_MAX_LIMIT);
    assert.equal(out.checked, 2);
    assert.equal(out.requeued, 1);
    assert.equal(out.skipped, 1);
    assert.equal(out.failed, 1);
    const entry = audit.entries.find((e) => e.action === 'RECONCILIATION_TRIGGERED');
    assert.ok(entry);
    assert.deepEqual(entry.metadata, { area: 'email', limit: RECONCILE_MAX_LIMIT });
  });

  test('run clamps limit below 1 to 1', async () => {
    let seen = null;
    const deps = baseDeps({
      reconcileStuckEmailDeliveries: async (opts) => {
        seen = opts;
        return { scanned: 0, requeued: 0, results: [] };
      },
    });
    await runReconcile({ area: 'email', limit: -5 }, deps);
    assert.equal(seen.limit, 1);
  });

  test('unknown area → 400', async () => {
    await assert.rejects(
      runReconcile({ area: 'everything', limit: 10 }, baseDeps()),
      (err) => err instanceof OpsError && err.status === 400
    );
  });

  test('runner throwing → safe 502 (no raw error text)', async () => {
    const deps = baseDeps({
      runBgvReconcile: async () => {
        throw new Error('redis://user:pass@host down');
      },
    });
    await assert.rejects(
      runReconcile({ area: 'bgv', limit: 10 }, deps),
      (err) =>
        err instanceof OpsError &&
        err.status === 502 &&
        !err.message.includes('user:pass')
    );
  });

  test('scheduled/documents/bgv summary mapping', async () => {
    const deps = baseDeps({
      runScheduledReconcile: async () => ({
        interviews: { checked: 2, scheduled: 1, skipped: 1, errors: 0 },
        offers: { checked: 1, reminders: 1, expiries: 1, errors: 0 },
      }),
      runDocumentReconcile: async () => ({ checked: 3, scheduled: 2, skipped: 1, errors: 0 }),
      runBgvReconcile: async () => ({ checked: 2, queued: 1, pollsScheduled: 1, skipped: 0, errors: 0 }),
    });
    const s = await runReconcile({ area: 'scheduled', limit: 5 }, deps);
    assert.equal(s.checked, 3);
    assert.equal(s.requeued, 3); // 1 + 1 + 1
    const d = await runReconcile({ area: 'documents', limit: 5 }, deps);
    assert.equal(d.requeued, 2);
    const b = await runReconcile({ area: 'bgv', limit: 5 }, deps);
    assert.equal(b.requeued, 2); // queued + polls
  });

  test('area registry is stable and bounded', () => {
    assert.equal(Object.keys(RECONCILE_AREAS).length, 6);
    assert.equal(RECONCILE_MAX_LIMIT, 100);
  });
});

// ---------------------------------------------------------------
// Master reconciliation coordinator (28.9)
// ---------------------------------------------------------------

describe('master reconciliation coordinator', () => {
  const fakeRunners = (failAreas = {}) => {
    const calls = [];
    const make = (area) =>
      async (opts) => {
        calls.push({ area, limit: opts.limit });
        if (failAreas[area]) throw new Error(failAreas[area]);
        return { checked: 1, requeued: 1, skipped: 0, failed: 0 };
      };
    return {
      calls,
      reconcileStuckEmailDeliveries: make('email'),
      recoverPendingResumeProcessing: make('resume'),
      recoverPendingATSMatching: make('ats'),
      runScheduledReconcile: make('scheduled'),
      runDocumentReconcile: make('documents'),
      runBgvReconcile: make('bgv'),
    };
  };

  test('dryRun returns preview counts only (no runners called)', async () => {
    const runners = fakeRunners();
    const deps = baseDeps({
      EmailDelivery: { countDocuments: async () => 2 },
      CandidateResume: { countDocuments: async () => 3 },
      loadInterviewsForReminderReconcile: async () => [],
      loadOffersForReconcile: async () => [],
      loadDocumentVersionsForReconcile: async () => [],
      loadCasesForBgvReconcile: async () => ({ missingSubmission: [], duePolls: [] }),
      ...runners,
    });
    const out = await reconcileBackgroundWork(
      { domains: ['email', 'resume'], dryRun: true, limit: 50 },
      deps
    );
    assert.equal(out.dryRun, true);
    assert.equal(out.domains.length, 2);
    assert.equal(out.domains[0].area, 'email');
    assert.equal(out.domains[0].eligible, 2);
    assert.equal(runners.calls.length, 0, 'no runner may run in dryRun');
  });

  test("'all' runs all 6 existing runners sequentially, limit clamped", async () => {
    const runners = fakeRunners();
    const out = await reconcileBackgroundWork(
      { domains: 'all', limit: 1000000 },
      baseDeps(runners)
    );
    assert.equal(out.dryRun, false);
    assert.equal(out.limit, RECONCILE_MAX_LIMIT);
    assert.equal(out.domains.length, 6);
    assert.equal(out.ok, true);
    const areas = out.domains.map((d) => d.area);
    assert.deepEqual(areas, Object.keys(RECONCILE_AREAS));
    for (const call of runners.calls) {
      assert.equal(call.limit, RECONCILE_MAX_LIMIT);
    }
  });

  test('per-domain failure is isolated; remaining domains still run', async () => {
    const runners = fakeRunners({ documents: 'mongo down' });
    const out = await reconcileBackgroundWork(
      { domains: 'all', limit: 10 },
      baseDeps(runners)
    );
    assert.equal(out.ok, false);
    const docs = out.domains.find((d) => d.area === 'documents');
    assert.ok(docs.error, 'failed domain reported with a safe message');
    assert.ok(!docs.error.includes('mongo down'), 'no raw error text leaks');
    const email = out.domains.find((d) => d.area === 'email');
    assert.equal(email.requeued, 1, 'other domains still ran');
  });

  test('unknown domain → 400; empty domains → 400', async () => {
    await assert.rejects(
      reconcileBackgroundWork({ domains: ['everything'] }, baseDeps()),
      (err) => err instanceof OpsError && err.status === 400
    );
    await assert.rejects(
      reconcileBackgroundWork({ domains: [] }, baseDeps()),
      (err) => err instanceof OpsError && err.status === 400
    );
  });

  test('duplicate domains are deduped; limit floors to 1', async () => {
    const runners = fakeRunners();
    const out = await reconcileBackgroundWork(
      { domains: ['email', 'email', 'ats'], limit: -99 },
      baseDeps(runners)
    );
    assert.equal(out.domains.length, 2);
    assert.equal(runners.calls.length, 2);
    assert.ok(runners.calls.every((c) => c.limit === 1));
  });
});

// ---------------------------------------------------------------
// Cache ops
// ---------------------------------------------------------------

describe('cache ops', () => {
  test('status shape (enabled + ttl + stats)', async () => {
    const deps = baseDeps({
      getCacheTtlSeconds: () => 60,
      getCacheStats: () => ({ hits: 5, misses: 2, invalidations: 1 }),
    });
    const out = await getCacheStatus(deps);
    assert.equal(out.feature, 'recruitment-analytics');
    assert.equal(out.enabled, true);
    assert.equal(out.ttlSeconds, 60);
    assert.equal(out.redis, 'up');
    assert.equal(out.stats.hits, 5);
  });

  test('ttl 0 → disabled', async () => {
    const deps = baseDeps({
      getCacheTtlSeconds: () => 0,
      getCacheStats: () => ({}),
    });
    const out = await getCacheStatus(deps);
    assert.equal(out.enabled, false);
  });

  test('invalid company id → 400', async () => {
    await assert.rejects(
      invalidateCompanyAnalyticsCache({ companyId: 'not-an-id' }, baseDeps()),
      (err) => err instanceof OpsError && err.status === 400
    );
    await assert.rejects(
      invalidateCompanyAnalyticsCache({ companyId: '' }, baseDeps()),
      (err) => err instanceof OpsError && err.status === 400
    );
  });

  test('valid id → bump + audit CACHE_INVALIDATED', async () => {
    let bumped = null;
    const audit = makeFakeAudit();
    const deps = baseDeps({
      bumpRecruitmentAnalyticsGeneration: async (id) => {
        bumped = id;
        return true;
      },
      AuditLog: audit,
    });
    const out = await invalidateCompanyAnalyticsCache(
      { companyId: VALID_OID, actor: { role: 'SUPER_ADMIN' } },
      deps
    );
    assert.equal(out.ok, true);
    assert.equal(bumped, VALID_OID);
    const entry = audit.entries.find((e) => e.action === 'CACHE_INVALIDATED');
    assert.ok(entry);
    assert.equal(entry.metadata.companyId, VALID_OID);
  });
});

// ---------------------------------------------------------------
// Worker heartbeat
// ---------------------------------------------------------------

describe('worker heartbeat', () => {
  test('writes ephemeral key + member set, worker-uuid format', async () => {
    const redis = makeFakeRedis();
    const hb = startWorkerHeartbeat(redis, {
      OPS_WORKER_HEARTBEAT_INTERVAL_MS: '100000',
      OPS_WORKER_HEARTBEAT_TTL_SECONDS: '60',
    });
    assert.match(hb.workerId, /^worker-[0-9a-f-]{36}$/);
    // Allow the immediate first beat (async) to settle.
    await new Promise((r) => setTimeout(r, 25));
    const key = heartbeatKeyFor(hb.workerId);
    assert.ok(redis.store.has(key), 'heartbeat key written');
    const [setValue, , args] = redis.log.set[0];
    assert.equal(setValue, key);
    assert.deepEqual(args, ['EX', 60]);
    assert.ok(redis.members.has(hb.workerId), 'member set populated');
    assert.ok(!JSON.stringify(redis.log.set).includes('localhost'));
    await hb.stop();
  });

  test('stop clears the key and member; single timer', async () => {
    const redis = makeFakeRedis();
    const hb = startWorkerHeartbeat(redis, { OPS_WORKER_HEARTBEAT_INTERVAL_MS: '100000' });
    await new Promise((r) => setTimeout(r, 25));
    const before = redis.log.set.length;
    assert.ok(before >= 1);
    await hb.stop();
    assert.ok(redis.log.del.includes(heartbeatKeyFor(hb.workerId)));
    assert.ok(redis.log.srem.includes(hb.workerId));
    // No further beats after stop.
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(redis.log.set.length, before);
  });

  test('heartbeat failure never throws (best-effort)', async () => {
    const broken = {
      set: async () => { throw new Error('ECONNREFUSED'); },
      sadd: async () => { throw new Error('ECONNREFUSED'); },
      del: async () => { throw new Error('ECONNREFUSED'); },
      srem: async () => { throw new Error('ECONNREFUSED'); },
    };
    const hb = startWorkerHeartbeat(broken, { OPS_WORKER_HEARTBEAT_INTERVAL_MS: '100000' });
    await new Promise((r) => setTimeout(r, 25));
    await assert.doesNotReject(() => hb.stop());
  });

  test('key + member key shapes are env-scoped, no hostnames', () => {
    const key = heartbeatKeyFor('worker-abc');
    assert.match(key, /^crewly:ops:worker:[a-z0-9_-]+:worker-abc$/);
    assert.match(workerMemberKey(), /^crewly:ops:workers:[a-z0-9_-]+$/);
    assert.ok(!/hostname|localhost|127\.0\.0\.1/.test(key));
  });
});

// ---------------------------------------------------------------
// Platform permission matrix
// ---------------------------------------------------------------

describe('platform permissions', () => {
  const has = (role, permission) =>
    (PLATFORM_PERMISSIONS[role] || []).includes('*') ||
    (PLATFORM_PERMISSIONS[role] || []).includes(permission);

  test('SUPER_ADMIN can read and manage', () => {
    assert.ok(has('SUPER_ADMIN', 'operations:read'));
    assert.ok(has('SUPER_ADMIN', 'operations:manage'));
  });

  test('PLATFORM_ADMIN can read but NOT manage', () => {
    assert.ok(has('PLATFORM_ADMIN', 'operations:read'));
    assert.equal(has('PLATFORM_ADMIN', 'operations:manage'), false);
  });

  test('SUPPORT / BILLING admins have no ops access', () => {
    assert.equal(has('SUPPORT_ADMIN', 'operations:read'), false);
    assert.equal(has('BILLING_ADMIN', 'operations:read'), false);
    assert.equal(has('BILLING_ADMIN', 'operations:manage'), false);
  });

  test('tenant roles are not platform roles at all', () => {
    for (const role of ['EMPLOYEE', 'HR_MANAGER', 'MANAGER', 'ADMIN']) {
      assert.equal(PLATFORM_PERMISSIONS[role], undefined);
    }
  });

  test('superAdminSession rejects tenant roles BEFORE any DB access (403)', async () => {
    const mkRes = () => {
      const res = {
        statusCode: null,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          return this;
        },
      };
      return res;
    };

    for (const role of ['EMPLOYEE', 'HR_MANAGER', 'ADMIN', 'MANAGER']) {
      const req = {
        user: { _id: '50e', role, name: 'Tenant' },
        headers: { authorization: 'Bearer not-a-platform-token' },
      };
      const res = mkRes();
      await superAdminSession(req, res, () => {
        throw new Error('next() must not be called for tenant roles');
      });
      assert.equal(res.statusCode, 403, `role ${role} must be denied`);
      assert.match(res.body.message, /Platform administrator/i);
    }

    // A platform role passes the role gate (then needs a valid
    // AdminSession — proven in the live ladder). No 403 here.
    const req = {
      user: { _id: '50e', role: 'SUPER_ADMIN', name: 'Platform' },
      headers: { authorization: 'Bearer whatever' },
    };
    const res = mkRes();
    let nextCalled = false;
    // No AdminSession in Mongo here; the lookup will 401, but the
    // role gate itself must have PASSED (no 403).
    await superAdminSession(req, res, () => (nextCalled = true));
    assert.equal(res.statusCode !== 403, true);
    assert.equal(nextCalled, false); // invalid token → not next()
  });

  test('validly-signed CUSTOMER token + tenant role → 403 before any DB access', async () => {
    // The platform chain is protect (JWT + user) THEN
    // superAdminSession (role gate + AdminSession). A customer
    // JWT is cryptographically valid — the DENIAL must come from
    // the platform role gate, before AdminSession/Mongo is touched.
    const token = jwt.sign(
      { sub: '50e34f0a0a0a0a0a0a0a0a01', name: 'Tenant User' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    for (const role of ['EMPLOYEE', 'HR_MANAGER', 'ADMIN']) {
      const req = {
        user: { _id: '50e34f0a0a0a0a0a0a0a0a01', role, name: 'Tenant User' },
        headers: { authorization: `Bearer ${token}` },
      };
      const res = {
        statusCode: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          return this;
        },
      };
      const startedAt = Date.now();
      await superAdminSession(req, res, () => {
        throw new Error('next() must not be called for a tenant user');
      });
      // Role gate returns immediately — no Mongo buffering/timeout.
      assert.ok(Date.now() - startedAt < 2000, 'must not touch the DB');
      assert.equal(res.statusCode, 403, `role ${role} with a valid token`);
    }
  });

  test('protect: anonymous → 401; malformed token → 401 (no DB access)', async () => {
    const mkReqResNext = (authorization) => {
      const req = {
        headers: authorization ? { authorization } : {},
        body: {},
        ip: '127.0.0.1',
        method: 'GET',
        originalUrl: '/api/super-admin/operations/queues',
      };
      const res = {
        statusCode: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          return this;
        },
      };
      let captured = null;
      const next = (error) => (captured = error);
      return { req, res, next, getCaptured: () => captured };
    };

    // Anonymous: no token at all.
    const anon = mkReqResNext(undefined);
    await protect(anon.req, anon.res, anon.next);
    assert.ok(anon.getCaptured(), 'error forwarded');
    assert.equal(anon.getCaptured().statusCode, 401);

    // Malformed token: fails jwt.verify BEFORE any user lookup.
    const bad = mkReqResNext('Bearer not.a.jwt');
    await protect(bad.req, bad.res, bad.next);
    assert.ok(bad.getCaptured(), 'error forwarded');
    assert.equal(bad.getCaptured().statusCode, 401);
  });
});
