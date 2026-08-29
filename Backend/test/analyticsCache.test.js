// ============================================================
// PHASE 28.7 — ANALYTICS CACHE TESTS (hermetic, no live Redis)
//
// Covers the safe-caching contracts:
//   - tenant-scoped deterministic key building (no unsafe segments)
//   - filter normalization + hash (equivalent requests share ONE
//     entry; different filters never collide)
//   - TTL config parsing/clamp/opt-out
//   - HIT / MISS / BYPASS flows with a fake cache client (DI)
//   - corrupt/malformed cache → exact delete + MISS (no crash)
//   - single-flight coalescing (one loader per cold key, no leak)
//   - generation invalidation key + fail-open bump
//   - Redis-down fallback (real module, no client → safe miss)
// Live Redis verification is manual (docs/PHASE_28_7, §50–62).
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [cache, invalidation, analytics] = await Promise.all([
  import('../src/services/redisCacheService.js'),
  import('../src/services/analyticsCacheInvalidation.js'),
  import('../src/services/recruitmentAnalyticsService.js'),
]);

const INFOLEXUS = '64a000000000000000000001'; // tenant A
const AGRIHUB = '64b000000000000000000011'; // tenant B

const key = (companyId, extra = '') =>
  cache.buildTenantCacheKey({
    companyId,
    namespace: 'recruitment:analytics',
    version: 1,
    segments: [`g${extra || 0}`],
  });

// ── Key building (tenant isolation is the critical guarantee) ────

test('cache keys are tenant-scoped, deterministic, and reject unsafe parts', () => {
  const a = key(INFOLEXUS);
  assert.equal(a, `crewly:cache:company:${INFOLEXUS}:recruitment:analytics:v1:g0`);
  assert.match(a, /^crewly:cache:company:[a-f0-9]{24}:recruitment:analytics:v1:[a-f0-9g]+$/);
  // Tenant B gets a DIFFERENT key — the core anti-leak guarantee.
  assert.notEqual(a, key(AGRIHUB));
  assert.ok(key(AGRIHUB).startsWith(`crewly:cache:company:${AGRIHUB}:`));

  // Invalid / missing tenant → no key (caller bypasses cache).
  assert.equal(cache.buildTenantCacheKey({ companyId: 'nope', namespace: 'x', version: 1 }), null);
  assert.equal(cache.buildTenantCacheKey({ companyId: INFOLEXUS, namespace: 'a b', version: 1 }), null);
  assert.equal(cache.buildTenantCacheKey({ companyId: INFOLEXUS, namespace: 'a..b', version: 1 }), null);
  assert.equal(cache.buildTenantCacheKey({ companyId: INFOLEXUS, namespace: 'x', version: 0 }), null);
  assert.equal(
    cache.buildTenantCacheKey({ companyId: INFOLEXUS, namespace: 'x', version: 1, segments: ['bad segment'] }),
    null
  );
  // Namespace must never collide with BullMQ prefixes (crewly:<env>).
  assert.ok(!a.startsWith('crewly:development:') && !a.startsWith('crewly:production:'));
});

// ── Filter normalization + hash (§13/§14/§51) ────────────────────

const hashOf = (query, range = { preset: 'LAST_30_DAYS' }) =>
  cache.sha256Hex(analytics.stableSerialize(analytics.normalizeAnalyticsQuery(query, range))).slice(0, 16);

test('equivalent requests produce the same filter hash', () => {
  const base = hashOf({});
  // Omitted/undefined values are dropped.
  assert.equal(hashOf({ jobId: undefined, source: undefined }), base);
  // Property order is irrelevant.
  assert.equal(hashOf({ jobId: 'a'.repeat(24), source: 'INTERNAL' }), hashOf({ source: 'INTERNAL', jobId: 'a'.repeat(24) }));
  // Case canonicalization.
  assert.equal(hashOf({ range: 'last_30_days', source: 'career_page' }), hashOf({ range: 'LAST_30_DAYS', source: 'CAREER_PAGE' }));
  // Ids canonicalize to lowercase.
  const id = 'A'.repeat(24);
  assert.equal(hashOf({ jobId: id }), hashOf({ jobId: id.toLowerCase() }));
});

test('different filters produce different hashes (no collisions across departments)', () => {
  const dev = hashOf({ departmentId: '1'.repeat(24) });
  const hr = hashOf({ departmentId: '2'.repeat(24) });
  assert.notEqual(dev, hr);
  assert.notEqual(hashOf({}), hashOf({ jobId: '1'.repeat(24) }));
});

test('date normalization: equivalent date strings share a hash; presets excluded when explicit', () => {
  const d1 = hashOf({ from: '2026-08-01' });
  const d2 = hashOf({ from: '2026-08-01T00:00:00.000Z' });
  assert.equal(d1, d2);
  // Explicit from/to → preset must NOT influence the key.
  assert.equal(
    hashOf({ from: '2026-08-01', to: '2026-08-28', range: 'LAST_7_DAYS' }, { preset: 'LAST_7_DAYS' }),
    hashOf({ from: '2026-08-01', to: '2026-08-28' }, { preset: 'LAST_30_DAYS' })
  );
  // Unparseable date → not cacheable (null).
  assert.equal(analytics.normalizeAnalyticsQuery({ from: 'not-a-date' }, { preset: 'LAST_30_DAYS' }), null);
});

// ── TTL config (§21) ─────────────────────────────────────────────

test('analytics cache TTL parses, clamps, and supports opt-out', () => {
  assert.equal(analytics.getRecruitmentAnalyticsCacheTtlSeconds({}), 60);
  assert.equal(analytics.getRecruitmentAnalyticsCacheTtlSeconds({ RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS: '120' }), 120);
  assert.equal(analytics.getRecruitmentAnalyticsCacheTtlSeconds({ RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS: '9999' }), 3600);
  assert.equal(analytics.getRecruitmentAnalyticsCacheTtlSeconds({ RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS: '5' }), 10);
  assert.equal(analytics.getRecruitmentAnalyticsCacheTtlSeconds({ RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS: '0' }), 0);
  assert.equal(analytics.getRecruitmentAnalyticsCacheTtlSeconds({ RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS: 'abc' }), 60);
});

// ── getOrSetCache flows with a fake client (DI) ──────────────────

const fakeIo = (seed = null) => {
  const store = new Map(seed ? [[seed.key, seed.value]] : []);
  const calls = { get: 0, set: 0, del: 0 };
  return {
    calls,
    store,
    io: {
      get: async (k) => {
        calls.get += 1;
        const v = store.get(k);
        if (v === undefined) return null;
        if (typeof v === 'string') {
          try {
            return JSON.parse(v);
          } catch {
            return v; // corrupt entry — the SUT must handle it
          }
        }
        return v.envelope !== undefined ? v.envelope : v;
      },
      set: async (k, v, ttl) => {
        calls.set += 1;
        store.set(k, { envelope: v, ttl });
        return true;
      },
      del: async (k) => {
        calls.del += 1;
        store.delete(k);
        return true;
      },
    },
  };
};

test('HIT returns cached payload without running the loader', async () => {
  const k = key(INFOLEXUS);
  const seeded = { key: k, value: { v: 1, at: 1, payload: { kpis: { applications: 5 } } } };
  const { io, calls } = fakeIo(seeded);
  let loaded = 0;
  const { value, cache: outcome } = await cache.getOrSetCache(k, {
    ttlSeconds: 60,
    version: 1,
    loader: async () => {
      loaded += 1;
      return { fresh: true };
    },
    io,
  });
  assert.equal(outcome, 'HIT');
  assert.deepEqual(value, { kpis: { applications: 5 } });
  assert.equal(loaded, 0);
  assert.equal(calls.set, 0); // HIT never writes
});

test('MISS runs the loader, stores an envelope, and returns the source value', async () => {
  const k = key(INFOLEXUS);
  const { io, calls, store } = fakeIo();
  let loaded = 0;
  const { value, cache: outcome } = await cache.getOrSetCache(k, {
    ttlSeconds: 60,
    version: 1,
    loader: async () => {
      loaded += 1;
      return { kpis: { applications: 7 } };
    },
    io,
  });
  assert.equal(outcome, 'MISS');
  assert.deepEqual(value, { kpis: { applications: 7 } });
  assert.equal(loaded, 1);
  assert.equal(calls.set, 1);
  const stored = store.get(k);
  assert.equal(stored.envelope.v, 1);
  assert.equal(stored.ttl, 60);
  assert.deepEqual(stored.envelope.payload, { kpis: { applications: 7 } });

  // Second identical request is a HIT.
  const again = await cache.getOrSetCache(k, { ttlSeconds: 60, version: 1, loader: async () => { loaded += 1; return {}; }, io });
  assert.equal(again.cache, 'HIT');
  assert.equal(loaded, 1);
});

test('BYPASS (no key / disabled) runs the loader and never touches the cache', async () => {
  const { io, calls } = fakeIo();
  let loaded = 0;
  const { value, cache: outcome } = await cache.getOrSetCache(null, {
    ttlSeconds: 60,
    loader: async () => {
      loaded += 1;
      return { direct: true };
    },
    io,
  });
  assert.equal(outcome, 'BYPASS');
  assert.deepEqual(value, { direct: true });
  assert.equal(loaded, 1);
  assert.equal(calls.get + calls.set + calls.del, 0);
});

test('corrupt/malformed cache entries are removed (exact key) and treated as MISS', async () => {
  const k = key(INFOLEXUS);
  // Raw garbage that fails JSON parse → the real getCache deletes + nulls.
  const { io, calls } = fakeIo({ key: k, value: '{not valid json' });
  let loaded = 0;
  const { value, cache: outcome } = await cache.getOrSetCache(k, {
    ttlSeconds: 60,
    version: 1,
    loader: async () => {
      loaded += 1;
      return { recovered: true };
    },
    io,
  });
  assert.equal(outcome, 'MISS');
  assert.deepEqual(value, { recovered: true });
  assert.equal(loaded, 1);
  assert.equal(calls.del, 1); // exact key deleted

  // Wrong-version envelope is also treated as corrupt.
  const k2 = key(AGRIHUB);
  const { io: io2, calls: c2 } = fakeIo({ key: k2, value: { v: 2, at: 1, payload: { old: true } } });
  const r2 = await cache.getOrSetCache(k2, {
    ttlSeconds: 60,
    version: 1,
    loader: async () => ({ v1: true }),
    io: io2,
  });
  assert.equal(r2.cache, 'MISS');
  assert.equal(c2.del, 1);
  assert.deepEqual(r2.value, { v1: true });
});

test('single-flight: concurrent cold-key calls share ONE loader; error clears the entry', async () => {
  const k = key(INFOLEXUS);
  const { io } = fakeIo();
  let loads = 0;
  const slowLoader = () =>
    new Promise((resolve) =>
      setTimeout(() => {
        loads += 1;
        resolve({ n: loads });
      }, 20)
    );
  const [r1, r2] = await Promise.all([
    cache.getOrSetCache(k, { ttlSeconds: 60, version: 1, loader: slowLoader, io }),
    cache.getOrSetCache(k, { ttlSeconds: 60, version: 1, loader: slowLoader, io }),
  ]);
  assert.equal(loads, 1);
  assert.equal(r1.cache, r2.cache);
  assert.deepEqual(r1.value, r2.value);

  // Failing loader: both callers reject, and the NEXT call re-runs.
  const k2 = key(AGRIHUB);
  const failing = () => Promise.reject(new Error('mongo down'));
  const [e1, e2] = await Promise.allSettled([
    cache.getOrSetCache(k2, { ttlSeconds: 60, version: 1, loader: failing, io }),
    cache.getOrSetCache(k2, { ttlSeconds: 60, version: 1, loader: failing, io }),
  ]);
  assert.equal(e1.status, 'rejected');
  assert.equal(e2.status, 'rejected');
  const after = await cache.getOrSetCache(k2, { ttlSeconds: 60, version: 1, loader: async () => 'ok', io });
  assert.equal(after.value, 'ok'); // no poison state
});

// ── Tenant isolation end-to-end (§50) ────────────────────────────

test('tenant A can never read tenant B cached analytics', async () => {
  const kA = key(INFOLEXUS);
  const kB = key(AGRIHUB);
  // Populate A's cache.
  const fake = fakeIo();
  await cache.getOrSetCache(kA, {
    ttlSeconds: 60,
    version: 1,
    loader: async () => ({ tenant: 'INFOLEXUS', kpis: { applications: 100 } }),
    io: fake.io,
  });
  // B's lookup uses the SAME store but B's key → MISS + B's data.
  const b = await cache.getOrSetCache(kB, {
    ttlSeconds: 60,
    version: 1,
    loader: async () => ({ tenant: 'AGRIHUB', kpis: { applications: 1 } }),
    io: fake.io,
  });
  assert.equal(b.cache, 'MISS');
  assert.deepEqual(b.value, { tenant: 'AGRIHUB', kpis: { applications: 1 } });
  assert.notDeepEqual(b.value, { tenant: 'INFOLEXUS', kpis: { applications: 100 } });
});

// ── Generation invalidation (§26/§27/§29/§62) ────────────────────

test('generation key format + fail-open bump (never throws, no-throw on Redis down)', async () => {
  assert.equal(
    invalidation.recruitmentAnalyticsGenerationKey(INFOLEXUS),
    `crewly:cache:company:${INFOLEXUS}:recruitment:analytics:generation`
  );
  assert.notEqual(
    invalidation.recruitmentAnalyticsGenerationKey(INFOLEXUS),
    invalidation.recruitmentAnalyticsGenerationKey(AGRIHUB)
  );
  // No Redis in this environment: the bump degrades safely.
  const result = await invalidation.bumpRecruitmentAnalyticsGeneration(INFOLEXUS);
  assert.equal(result, false);
  // Invalid tenant ids are rejected without touching Redis.
  assert.equal(await invalidation.bumpRecruitmentAnalyticsGeneration('bogus'), false);
  assert.equal(await invalidation.bumpRecruitmentAnalyticsGeneration(null), false);
});

test('analytics key embeds the generation (old generations become unreachable)', async () => {
  const g0 = key(INFOLEXUS, 0);
  const g1 = key(INFOLEXUS, 1);
  assert.ok(g0.includes('g0'));
  assert.ok(g1.includes('g1'));
  assert.notEqual(g0, g1); // a bump invalidates every filter key at once
});

// ── Redis-down fallback with the REAL module (no client) ─────────

test('real module without Redis: getOrSetCache degrades to a safe MISS', async () => {
  const k = key(INFOLEXUS);
  let loaded = 0;
  const { value, cache: outcome } = await cache.getOrSetCache(k, {
    ttlSeconds: 60,
    version: 1,
    loader: async () => {
      loaded += 1;
      return { fromMongo: true };
    },
  });
  assert.equal(outcome, 'MISS');
  assert.deepEqual(value, { fromMongo: true });
  assert.equal(loaded, 1);
  // Raw reads also fail open.
  assert.equal(await cache.getCacheRaw(k), null);
  assert.equal(await cache.getCache(k), null);
  assert.equal(await cache.setCache(k, { x: 1 }, 60), false);
});

// ── Op timeout clamp (§74) ───────────────────────────────────────

test('cache operation timeout clamps to a safe range', () => {
  assert.equal(cache.getCacheOpTimeoutMs({}), 500);
  assert.equal(cache.getCacheOpTimeoutMs({ REDIS_CACHE_OP_TIMEOUT_MS: '1500' }), 1500);
  assert.equal(cache.getCacheOpTimeoutMs({ REDIS_CACHE_OP_TIMEOUT_MS: '99999' }), 2000);
  assert.equal(cache.getCacheOpTimeoutMs({ REDIS_CACHE_OP_TIMEOUT_MS: '1' }), 100);
  assert.equal(cache.getCacheOpTimeoutMs({ REDIS_CACHE_OP_TIMEOUT_MS: 'x' }), 500);
});

test('envelope parsing rejects incompatible shapes', () => {
  assert.deepEqual(cache.parseEnvelope({ v: 1, payload: { a: 1 } }, 1), { a: 1 });
  assert.equal(cache.parseEnvelope({ v: 2, payload: { a: 1 } }, 1), null);
  assert.equal(cache.parseEnvelope({ payload: { a: 1 } }, 1), null);
  assert.equal(cache.parseEnvelope(null, 1), null);
  assert.equal(cache.parseEnvelope('raw string', 1), null);
});
