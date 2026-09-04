// ============================================================
// PHASE 30.1.2 — LIVE REDIS VERIFICATION (OPT-IN)
//
//   npm run test:redis:live
//
// Run explicitly. The normal suite (npm run test:redis) is hermetic
// and NEVER touches Redis, so it cannot prove the 28.7 caching
// abstraction really works. This file does — against the real
// REDIS_URL from Backend/.env, using the production modules
// unmodified:
//
//   src/config/redis.js            (28.1 foundation + health mapping)
//   src/services/redisCacheService.js  (28.7 fail-open cache)
//   src/services/analyticsCacheInvalidation.js (generation bumps)
//
// ISOLATION (this is a shared instance, so it behaves):
//   - cache keys use freshly generated random 24-hex companyIds, so
//     no real tenant's key namespace can be touched
//   - raw probe keys live under crewly:test:live-<random>:
//   - NO queue namespace is used (that is test:bullmq:live's job)
//   - cleanup deletes EVERY key this file created and asserts none
//     remain — no FLUSHALL / FLUSHDB / KEYS / SCAN, ever
//
// If Redis is not configured the run FAILS LOUDLY (a silent skip
// would hide a misconfiguration, which is the whole point here).
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: resolve(backendDir, '.env') });

// Nothing here depends on NODE_ENV-driven queue prefixes, but pinning
// it keeps log output identical on any machine.
process.env.NODE_ENV = 'test';

const {
  initializeRedis,
  getRedisClient,
  getRedisHealth,
  pingRedis,
  closeRedis,
  getRedisConfig,
} = await import('../src/config/redis.js');
const {
  buildTenantCacheKey,
  getCache,
  getCacheRaw,
  setCache,
  deleteCache,
  getOrSetCache,
  incrementWithTtl,
  getCacheStats,
  MAX_CACHE_VALUE_BYTES,
  _resetCacheForTests,
} = await import('../src/services/redisCacheService.js');
const {
  recruitmentAnalyticsGenerationKey,
  bumpRecruitmentAnalyticsGeneration,
} = await import('../src/services/analyticsCacheInvalidation.js');

const config = getRedisConfig();
const RUN = config.enabled && config.hasUrl;

// Every key this file writes is tracked and removed in after().
const createdKeys = new Set();
const track = (key) => {
  createdKeys.add(key);
  return key;
};

// Random-but-valid tenant id: satisfies the 24-hex shape the key
// builder requires and can never collide with a real company.
const fakeCompanyId = () => randomBytes(12).toString('hex');

const cacheKey = ({ companyId, namespace, segments = [] }) =>
  track(
    buildTenantCacheKey({
      companyId,
      namespace,
      version: 1,
      segments: [randomUUID().slice(0, 8), ...segments],
    })
  );

// Managed/shared Redis hosts must not be paused by this suite - see the
// op-budget test for the reason. Hostname shape only; nothing is printed.
const MANAGED_HOST =
  /(^|\.)(redis\.io|redislabs\.com|rlrcp\.com|upstash\.io|upstash\.com|cache\.amazonaws\.com|redis\.cache\.windows\.net|database\.windows\.net)$/i;
const isManagedEndpoint = (url) => {
  try {
    const host = new URL(String(url || '').trim()).hostname.toLowerCase();
    return MANAGED_HOST.test(host) || /^redis-\d+\.c/i.test(host);
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

if (!RUN) {
  test('live Redis is configured (REDIS_ENABLED + REDIS_URL)', () => {
    assert.fail(
      'Redis is not configured (REDIS_ENABLED/REDIS_URL in Backend/.env). ' +
        'This opt-in test requires a reachable Redis. Run `npm run redis:doctor` ' +
        'for the full diagnosis, configure it, then re-run: npm run test:redis:live'
    );
  });
} else {
  // Always the CURRENT infrastructure client: one test deliberately
  // closes the connection, so a captured reference could go stale.
  const redis = () => getRedisClient();

  test.before(async () => {
    // Uses the production connection path, not a bespoke client.
    await initializeRedis();
    _resetCacheForTests();
  });

  test.after(async () => {
    try {
      const instance = redis();
      for (const key of createdKeys) {
        await instance?.del(key).catch(() => {});
      }
    } finally {
      await closeRedis().catch(() => {});
    }
  });

  // --- 28.1 foundation against the live server -------------------

  test('foundation: initializeRedis reaches READY and health maps to "up"', async () => {
    // DB Logic - live connection + internal ping helper.
    assert.equal(getRedisHealth().status, 'up', `expected health up, got ${JSON.stringify(getRedisHealth())}`);
    assert.equal(await pingRedis(), true, 'pingRedis() should answer PONG');
    assert.ok(redis(), 'a live client must be exposed to the cache layer');
  });

  test('foundation: the endpoint is a writable, scripting-capable standalone', async () => {
    // DB Logic - server introspection (BullMQ + cache requirements).
    const server = new Map(
      String(await redis().info('server'))
        .split('\r\n')
        .filter((line) => line.includes(':'))
        .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)])
    );
    const replication = String(await redis().info('replication'));
    assert.ok(Number(server.get('redis_version').split('.')[0]) >= 6, `Redis ${server.get('redis_version')} is older than the 6.2 baseline Crewly is validated on`);
    assert.equal(server.get('redis_mode'), 'standalone', 'Crewly targets a standalone/primary endpoint');
    assert.ok(!/role:(slave|replica)/.test(replication), 'REDIS_URL points at a read-only replica — writes would fail');
    // BullMQ runs entirely on Lua; the cache relies on plain SET/GET.
    assert.equal(Number(await redis().eval('return 1', 0)), 1, 'EVAL (Lua) must be available for the queues');
  });

  // --- 28.7 cache abstraction: keys, round trip, TTL -------------

  test('cache: tenant keys are isolated by companyId and never collide', async () => {
    const companyA = fakeCompanyId();
    const companyB = fakeCompanyId();
    const keyA = cacheKey({ companyId: companyA, namespace: 'bgvops' });
    const keyB = cacheKey({ companyId: companyB, namespace: 'bgvops' });
    assert.ok(keyA.includes(companyA) && keyA !== keyB, 'key must embed its own tenant only');
    // DB Logic - write under A, read under B.
    assert.equal(await setCache(keyA, { secret: 'A-only' }, 60), true);
    assert.deepEqual(await getCache(keyA), { secret: 'A-only' });
    assert.equal(await getCache(keyB), null, 'a second tenant must never read another tenant entry');
  });

  test('cache: invalid tenant ids are rejected by the key builder (no unscoped keys)', () => {
    assert.equal(buildTenantCacheKey({ companyId: 'not-an-objectid', namespace: 'bgvops', version: 1 }), null);
    assert.equal(buildTenantCacheKey({ companyId: '', namespace: 'bgvops', version: 1 }), null);
    assert.equal(buildTenantCacheKey({ companyId: fakeCompanyId(), namespace: 'bad namespace!', version: 1 }), null);
    assert.equal(buildTenantCacheKey({ companyId: fakeCompanyId(), namespace: 'bgvops', version: 0 }), null);
  });

  test('cache: JSON types survive the round trip', async () => {
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'analytics' });
    const value = { counts: { open: 3, overdue: 0 }, flag: true, list: ['EDUCATION', 'COURT_RECORD'], ratio: 0.5 };
    // DB Logic - SET with TTL then GET.
    assert.equal(await setCache(key, value, 60), true);
    assert.deepEqual(await getCache(key), value);
  });

  test('cache: TTL expiry really removes the entry', async () => {
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'ttl' });
    // DB Logic - 1s TTL, read inside and after the window.
    assert.equal(await setCache(key, { short: true }, 1), true);
    assert.deepEqual(await getCache(key), { short: true });
    const ttl = await redis().ttl(key);
    assert.ok(ttl > 0 && ttl <= 2, `expected a live TTL, got ${ttl}`);
    await sleep(1300);
    assert.equal(await getCache(key), null, 'expired entry must read as a miss');
    assert.equal(await redis().exists(key), 0);
  });

  test('cache: a corrupt entry self-heals — exact key deleted, treated as miss', async () => {
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'corrupt' });
    // DB Logic - plant a non-JSON value the way a truncated write would.
    await redis().set(key, '{not json');
    assert.equal(await getCache(key), null, 'corrupt payload must degrade to a miss');
    assert.equal(await redis().exists(key), 0, 'corrupt key must be removed (exact key only)');
  });

  test('cache: oversized values are never cached, and the source result still answers', async () => {
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'oversize' });
    const big = { blob: 'x'.repeat(MAX_CACHE_VALUE_BYTES) };
    // DB Logic - write must be skipped entirely.
    assert.equal(await setCache(key, big, 60), false, 'oversized value must not be stored');
    assert.equal(await redis().exists(key), 0, 'no key may exist after a skipped write');
    // The read-through wrapper still returns the loader value.
    const result = await getOrSetCache(key, { ttlSeconds: 60, version: 1, loader: async () => big });
    assert.equal(result.cache, 'MISS');
    assert.equal(result.value.blob.length, MAX_CACHE_VALUE_BYTES);
  });

  // --- 28.7 read-through behaviour --------------------------------

  test('cache: getOrSetCache serves MISS then HIT from the live cache', async () => {
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'stats' });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return { total: 7 };
    };
    const before = getCacheStats();
    // DB Logic - first call hits Mongo (the loader), second is served by Redis.
    const first = await getOrSetCache(key, { ttlSeconds: 60, version: 1, loader });
    assert.equal(first.cache, 'MISS');
    assert.deepEqual(first.value, { total: 7 });
    const second = await getOrSetCache(key, { ttlSeconds: 60, version: 1, loader });
    assert.equal(second.cache, 'HIT', 'second read must come from Redis');
    assert.deepEqual(second.value, { total: 7 });
    assert.equal(loads, 1, 'the loader must run once');
    const after = getCacheStats();
    assert.equal(after.hits - before.hits, 1);
    assert.equal(after.misses - before.misses, 1);
    assert.equal(after.writes - before.writes, 1);
  });

  test('cache: concurrent callers share ONE loader run (single-flight)', async () => {
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'flight' });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await sleep(150); // keep the window open for all six callers
      return { expensive: true };
    };
    // DB Logic - six simultaneous reads must produce one loader call.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => getOrSetCache(key, { ttlSeconds: 60, version: 1, loader }))
    );
    assert.equal(loads, 1, `single-flight failed: loader ran ${loads} times`);
    results.forEach((entry) => assert.deepEqual(entry.value, { expensive: true }));
    // By design the followers receive the LEADER's outcome object, so
    // every caller reports the same marker (no duplicate misses).
    assert.equal(new Set(results.map((entry) => entry.cache)).size, 1, 'shared flight must report one outcome');
    // DB Logic - after the flight settles, the stored value serves HITs.
    const later = await getOrSetCache(key, { ttlSeconds: 60, version: 1, loader });
    assert.equal(later.cache, 'HIT');
    assert.equal(loads, 1, 'a cached entry must not re-run the loader');
  });

  test('cache: an old envelope version is never served (generation semantics)', async () => {
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'version' });
    // DB Logic - store a generation-1 envelope, then ask for generation 2.
    assert.equal(await setCache(key, { v: 1, at: Date.now(), payload: { stale: true } }, 60), true);
    let loads = 0;
    const fresh = await getOrSetCache(key, {
      ttlSeconds: 60,
      version: 2,
      loader: async () => {
        loads += 1;
        return { stale: false };
      },
    });
    assert.equal(fresh.cache, 'MISS', 'a stale generation must be reloaded');
    assert.deepEqual(fresh.value, { stale: false });
    assert.equal(loads, 1);
    const again = await getOrSetCache(key, { ttlSeconds: 60, version: 2, loader: async () => ({ wrong: true }) });
    assert.deepEqual(again.value, { stale: false }, 'the new generation is now cached');
  });

  test('cache: generation invalidation bumps the counter and keeps its TTL', async () => {
    const companyId = fakeCompanyId();
    const generationKey = track(recruitmentAnalyticsGenerationKey(companyId));
    // DB Logic - two mutations = two bumps.
    assert.equal(await bumpRecruitmentAnalyticsGeneration(companyId), true);
    assert.equal(await getCacheRaw(generationKey), '1');
    assert.equal(await bumpRecruitmentAnalyticsGeneration(companyId), true);
    assert.equal(await getCacheRaw(generationKey), '2');
    const ttl = await redis().ttl(generationKey);
    assert.ok(ttl > 23 * 3600, `generation counter must keep its ~24h TTL (got ${ttl}s)`);
    // Invalid tenant ids must be refused, never turned into a wild INCR.
    assert.equal(await bumpRecruitmentAnalyticsGeneration('nope'), false);
    assert.equal(await incrementWithTtl(null, 60), null, 'no key, no command');
  });

  // The one test that is NOT zero-impact: CLIENT PAUSE stalls the
  // server for ~300ms (every client, briefly). Skip it on a shared or
  // production-ish endpoint with REDIS_LIVE_SKIP_PAUSE=1.
  test('cache: a stalling Redis is cut off by the op budget — the caller never waits', async () => {
    // CLIENT PAUSE freezes the WHOLE instance for ~300ms, so it is refused
    // on managed/shared endpoints unless explicitly allowed - a cloud Redis
    // is usually serving the rest of the tenant base too.
    if (process.env.REDIS_LIVE_SKIP_PAUSE === '1') {
      console.log('    note: REDIS_LIVE_SKIP_PAUSE=1 — op-budget test skipped');
      return;
    }
    if (isManagedEndpoint(process.env.REDIS_URL) && process.env.REDIS_LIVE_ALLOW_PAUSE !== '1') {
      console.log(
        '    note: managed endpoint — op-budget test skipped (it pauses the whole ' +
          'instance). Run it anyway with REDIS_LIVE_ALLOW_PAUSE=1.'
      );
      return;
    }
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'budget' });
    const previousBudget = process.env.REDIS_CACHE_OP_TIMEOUT_MS;
    process.env.REDIS_CACHE_OP_TIMEOUT_MS = '100';
    try {
      // DB Logic - warm the entry, then freeze the server past the budget.
      assert.equal(await setCache(key, { warm: true }, 60), true);
      await redis().client('PAUSE', '300', 'ALL');
      const startedAt = Date.now();
      const result = await getOrSetCache(key, {
        ttlSeconds: 60,
        version: 1,
        loader: async () => ({ servedBy: 'source' }),
      });
      const elapsed = Date.now() - startedAt;
      assert.deepEqual(result.value, { servedBy: 'source' }, 'the caller must still get an answer while Redis stalls');
      assert.equal(result.cache, 'MISS', 'a timed-out GET is treated as a miss');
      assert.ok(elapsed < 280, `cache ops must abandon at the budget, not after the stall (${elapsed}ms)`);
    } catch (error) {
      // Providers may block CLIENT PAUSE — that is a capability gap,
      // not a caching defect, so report it instead of failing.
      assert.match(String(error?.message || ''), /pause/i, `unexpected failure: ${error?.message}`);
      console.log('    note: CLIENT PAUSE is not permitted here — op-budget assertion skipped');
    } finally {
      if (previousBudget === undefined) delete process.env.REDIS_CACHE_OP_TIMEOUT_MS;
      else process.env.REDIS_CACHE_OP_TIMEOUT_MS = previousBudget;
      await redis().client('UNPAUSE').catch(() => {});
    }
  });

  // --- fail-open when Redis disappears (the degraded-mode promise) -

  test('fail-open: with Redis closed, cache reads/writes no-op and the source answers', async () => {
    // DB Logic - deliberately close the 28.1 client (simulates a crash
    // or a provider outage while the API is serving traffic).
    await closeRedis();
    assert.notEqual(getRedisHealth().status, 'up', 'health must stop reporting up');
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'down' });
    assert.equal(await getCache(key), null, 'GET while down must be a miss');
    assert.equal(await setCache(key, { any: 1 }, 60), false, 'SET while down must report not-stored');
    assert.equal(await deleteCache(key), false);
    assert.equal(await incrementWithTtl(key, 60), null);
    let loads = 0;
    const result = await getOrSetCache(key, {
      ttlSeconds: 60,
      version: 1,
      loader: async () => {
        loads += 1;
        return { served: 'from source' };
      },
    });
    assert.deepEqual(result.value, { served: 'from source' }, 'a dead cache must never break a read');
    assert.equal(result.cache, 'MISS');
    assert.equal(loads, 1);
  });

  test('recovery: the API reconnects and the cache serves again once Redis is back', async () => {
    // DB Logic - reconnect through the same idempotent entry point.
    await initializeRedis();
    assert.equal(getRedisHealth().status, 'up', 'background recovery must restore health');
    const key = cacheKey({ companyId: fakeCompanyId(), namespace: 'recover' });
    assert.equal(await setCache(key, { back: true }, 60), true);
    assert.deepEqual(await getCache(key), { back: true });
  });

  // --- housekeeping ------------------------------------------------

  test('cleanup: every key this file created is deleted (no residue on a shared instance)', async () => {
    // DB Logic - exact-key DEL + EXISTS only, never KEYS/SCAN/FLUSHDB.
    for (const key of createdKeys) {
      await redis().del(key);
    }
    const live = [];
    for (const key of createdKeys) {
      if ((await redis().exists(key)) === 1) live.push(key);
    }
    assert.ok(createdKeys.size >= 8, 'the suite is expected to have exercised several keys');
    assert.deepEqual(live, [], `residual keys left behind: ${live.join(', ')}`);
  });
}
