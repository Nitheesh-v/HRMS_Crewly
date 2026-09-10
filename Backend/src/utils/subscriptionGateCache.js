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
//  - Invalidation is exact: Subscription model post-save/delete hooks
//    call invalidateSubscriptionGateCache(companyId) on the SAME process.
//  - Redis OFF / cache empty = plain Mongo read (degraded mode).
//  - Only the boolean gate reads the cache; mutation paths still load
//    the live document.

const gateCache = new Map();

const MIN_TTL_MS = 5000;
const MAX_TTL_MS = 60000;
const DEFAULT_TTL_MS = 15000;

export const getGateCacheTtlMs = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.SUBSCRIPTION_GATE_CACHE_TTL_MS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, parsed));
};

export const invalidateSubscriptionGateCache = (companyId) => {
  if (!companyId) return false;
  return gateCache.delete(String(companyId));
};

export const readSubscriptionGateCache = (companyId) => {
  const entry = gateCache.get(String(companyId));
  if (!entry) return null;
  if (Date.now() - entry.at > getGateCacheTtlMs()) {
    gateCache.delete(String(companyId));
    return null;
  }
  return entry.value;
};

export const writeSubscriptionGateCache = (companyId, value) => {
  if (!companyId) return;
  gateCache.set(String(companyId), { at: Date.now(), value });
  // Bounded: a tenant-sized map is fine, but never let it grow unbounded.
  if (gateCache.size > 500) {
    const oldest = gateCache.keys().next().value;
    gateCache.delete(oldest);
  }
};

export const _resetSubscriptionGateCacheForTests = () => gateCache.clear();
