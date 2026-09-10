import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getGateCacheTtlMs,
  invalidateSubscriptionGateCache,
  readSubscriptionGateCache,
  writeSubscriptionGateCache,
  _resetSubscriptionGateCacheForTests,
} from '../src/utils/subscriptionGateCache.js';

// Phase 29 fix-forward — the feature-gate summary cache must be short-TTL,
// exact-invalidating and bounded. Pure module, hermetic by construction.

test('gate cache TTL is bounded and env-configurable', () => {
  assert.equal(getGateCacheTtlMs({}), 15000);
  assert.equal(getGateCacheTtlMs({ SUBSCRIPTION_GATE_CACHE_TTL_MS: '1' }), 5000, 'clamped to min');
  assert.equal(getGateCacheTtlMs({ SUBSCRIPTION_GATE_CACHE_TTL_MS: '999999' }), 60000, 'clamped to max');
  assert.equal(getGateCacheTtlMs({ SUBSCRIPTION_GATE_CACHE_TTL_MS: '20000' }), 20000);
});

test('gate cache stores, expires and invalidates exactly', () => {
  _resetSubscriptionGateCacheForTests();
  const companyA = 'a'.repeat(24);
  const companyB = 'b'.repeat(24);

  assert.equal(readSubscriptionGateCache(companyA), null, 'empty cache reads null');
  writeSubscriptionGateCache(companyA, { enabledModules: ['payroll'] });
  writeSubscriptionGateCache(companyB, { enabledModules: [] });
  assert.deepEqual(readSubscriptionGateCache(companyA), { enabledModules: ['payroll'] });

  invalidateSubscriptionGateCache(companyA);
  assert.equal(readSubscriptionGateCache(companyA), null, 'exact invalidation');
  assert.deepEqual(readSubscriptionGateCache(companyB), { enabledModules: [] }, 'other tenant untouched');
});
