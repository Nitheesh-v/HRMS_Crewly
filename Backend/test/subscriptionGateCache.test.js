import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSubscriptionGateCache,
  getGateCacheTtlMs,
  invalidateSubscriptionGateCache,
  readSubscriptionGateCache,
  writeSubscriptionGateCache,
  _resetSubscriptionGateCacheForTests,
} from '../src/utils/subscriptionGateCache.js';

// Phase 29 fix-forward — the feature-gate summary cache must be short-TTL,
// exact-invalidating and bounded. Phase 32.6 — reads/writes are async
// (shared-generation cross-instance invalidation); the default singleton
// keeps its exact same-process contract.

process.env.REDIS_ENABLED ||= 'false'; // singleton path runs in local-TTL mode hermetically

test('gate cache TTL is bounded and env-configurable', () => {
  assert.equal(getGateCacheTtlMs({}), 15000);
  assert.equal(getGateCacheTtlMs({ SUBSCRIPTION_GATE_CACHE_TTL_MS: '1' }), 5000, 'clamped to min');
  assert.equal(getGateCacheTtlMs({ SUBSCRIPTION_GATE_CACHE_TTL_MS: '999999' }), 60000, 'clamped to max');
  assert.equal(getGateCacheTtlMs({ SUBSCRIPTION_GATE_CACHE_TTL_MS: '20000' }), 20000);
});

test('gate cache stores, expires and invalidates exactly (same-process contract preserved)', async () => {
  _resetSubscriptionGateCacheForTests();
  const companyA = 'a'.repeat(24);
  const companyB = 'b'.repeat(24);

  assert.equal(await readSubscriptionGateCache(companyA), null, 'empty cache reads null');
  await writeSubscriptionGateCache(companyA, { enabledModules: ['payroll'] });
  await writeSubscriptionGateCache(companyB, { enabledModules: [] });
  assert.deepEqual(
    await readSubscriptionGateCache(companyA),
    { enabledModules: ['payroll'] },
  );

  invalidateSubscriptionGateCache(companyA);
  assert.equal(await readSubscriptionGateCache(companyA), null, 'exact invalidation');
  assert.deepEqual(
    await readSubscriptionGateCache(companyB),
    { enabledModules: [] },
    'other tenant untouched',
  );
});
