// ═══════════════════════════════════════════════════════════════════════════
//  PAYROLL REVIEW CACHE KEYS (Phase 29.7, §20)
//
//  One place that owns the review cache key shape, so the review service and
//  the 29.6 engine agree on what to invalidate. The engine must drop the
//  review dashboard whenever it recalculates: figures that changed behind a
//  300-second cache are exactly the §17 "never hide a revision" hazard.
//
//  Cache is an accelerator. MongoDB is the source of truth, and every helper
//  here is fail-open — a dead Redis only ever costs a little speed.
// ═══════════════════════════════════════════════════════════════════════════
import {
  buildTenantCacheKey,
  deleteCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';

export const REVIEW_CACHE_NAMESPACE = 'payroll-review';
export const REVIEW_CACHE_VERSION = 1;

// The employee list is never cached (it is the big object), so the dashboard
// is the only key the review service writes today.
export const REVIEW_CACHE_SUFFIXES = ['dashboard'];

export const reviewCacheKey = (companyId, month, suffix = 'dashboard') =>
  buildTenantCacheKey({
    companyId,
    namespace: REVIEW_CACHE_NAMESPACE,
    version: REVIEW_CACHE_VERSION,
    segments: [month, suffix],
  });

// §20 — invalidate after lock, unlock, approval, rejection AND recalculation.
export const invalidateReviewCache = async (companyId, month) => {
  if (!companyId || !month) return 0;

  let removed = 0;
  for (const suffix of REVIEW_CACHE_SUFFIXES) {
    const key = reviewCacheKey(companyId, month, suffix);
    if (!key) continue;
    const gone = await deleteCache(key).catch(() => false);
    if (gone) {
      removed += 1;
      noteCacheInvalidation();
    }
  }
  return removed;
};
