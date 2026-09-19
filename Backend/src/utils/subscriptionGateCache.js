// Phase 29 fix-forward — in-process gate cache for the subscription
// feature check that runs on EVERY feature-gated request.
//
// Why: hasFeature() re-read Subscription + populated plan on every
// request; on slow Mongo links that round-trip dominates payroll page
// latency. The gate only needs { status-independent module/feature
// flags }, so we cache a plain summary for a short TTL.
//
// Safety:
//  - Mongo stays the source of truth; TTL is bounded (5s..60s).
//  - Invalidation is exact (same process): Subscription model
//    post-save/delete hooks call invalidateSubscriptionGateCache.
//  - Phase 32.6 — CROSS-INSTANCE invalidation: the same hooks now
//    also bump a SHARED Redis generation for the tenant
//    (crewly:cache:company:<id>:subscription:gate:generation). Every
//    instance's next read consults it; an entry stamped with an older
//    generation is reloaded. Redis-down degrades to the documented
//    local-TTL behavior (bounded staleness, exactly the pre-32.6
//    contract).
//  - Redis OFF / cache empty = plain Mongo read (degraded mode).
//  - Only the boolean gate reads the cache; mutation paths still load
//    the live document.

import {
  bumpCacheGeneration,
  readCacheGeneration,
} from './cacheGeneration.js';

const GENERATION_NAMESPACE = 'subscription:gate';

const MIN_TTL_MS = 5000;
const MAX_TTL_MS = 60000;
const DEFAULT_TTL_MS = 15000;

export const getGateCacheTtlMs = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.SUBSCRIPTION_GATE_CACHE_TTL_MS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, parsed));
};

// Factory — lets hermetic tests run TWO independent instances
// (separate local maps, separate local single-flight-style state)
// over ONE shared backend, which is exactly the multi-instance
// deployment shape. The module singleton below is the app default.
export const createSubscriptionGateCache = ({ io = null } = {}) => {
  const gateCache = new Map();

  const read = async (companyId) => {
    if (!companyId) return null;

    const key = String(companyId);

    const entry = gateCache.get(key);

    if (!entry) return null;

    if (Date.now() - entry.at > getGateCacheTtlMs()) {
      gateCache.delete(key);

      return null;
    }

    // Phase 32.6 — shared-generation check. null (Redis down) keeps
    // the local-TTL contract; a matching generation is a hit; an
    // older stamp is a miss (another instance invalidated us).
    const generation = await readCacheGeneration(GENERATION_NAMESPACE, companyId, { io });

    if (generation !== null && entry.generation !== generation) {
      gateCache.delete(key);

      return null;
    }

    return entry.value;
  };

  const write = async (companyId, value) => {
    if (!companyId) return;

    const generation = await readCacheGeneration(GENERATION_NAMESPACE, companyId, { io });

    gateCache.set(String(companyId), { at: Date.now(), value, generation });

    // Bounded: a tenant-sized map is fine, but never let it grow unbounded.
    if (gateCache.size > 500) {
      const oldest = gateCache.keys().next().value;

      gateCache.delete(oldest);
    }
  };

  const invalidate = (companyId) => {
    if (!companyId) return false;

    // Cross-instance signal: fire-and-forget, never blocks the
    // business mutation, never throws (§12).
    void bumpCacheGeneration(GENERATION_NAMESPACE, companyId, { io });

    return gateCache.delete(String(companyId));
  };

  const reset = () => gateCache.clear();

  return { read, write, invalidate, reset, size: () => gateCache.size };
};

const defaultInstance = createSubscriptionGateCache();

export const readSubscriptionGateCache = (companyId) =>
  defaultInstance.read(companyId);

export const writeSubscriptionGateCache = (companyId, value) =>
  defaultInstance.write(companyId, value);

export const invalidateSubscriptionGateCache = (companyId) =>
  defaultInstance.invalidate(companyId);

export const _resetSubscriptionGateCacheForTests = () =>
  defaultInstance.reset();
