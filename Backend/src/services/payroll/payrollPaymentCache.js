// ═══════════════════════════════════════════════════════════════════════════
//  PAYROLL PAYMENT CACHE KEYS (Phase 29.8, §19)
//
//  One place that owns the payment cache key shape. MongoDB is the source of
//  truth; every helper here is fail-open, so a dead Redis only costs speed.
// ═══════════════════════════════════════════════════════════════════════════
import {
  buildTenantCacheKey,
  deleteCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';

export const PAYMENT_CACHE_NAMESPACE = 'payroll-payment';
export const PAYMENT_CACHE_VERSION = 1;

export const PAYMENT_CACHE_SUFFIXES = ['dashboard', 'batches'];

export const paymentCacheKey = (companyId, month, suffix = 'dashboard') =>
  buildTenantCacheKey({
    companyId,
    namespace: PAYMENT_CACHE_NAMESPACE,
    version: PAYMENT_CACHE_VERSION,
    segments: [month || 'all', suffix],
  });

// §19 — invalidate after batch creation, file generation, confirmation,
// retry and every status change.
export const invalidatePaymentCache = async (companyId, month) => {
  if (!companyId) return 0;

  let removed = 0;
  for (const suffix of PAYMENT_CACHE_SUFFIXES) {
    const key = paymentCacheKey(companyId, month, suffix);
    if (!key) continue;
    const gone = await deleteCache(key).catch(() => false);
    if (gone) {
      removed += 1;
      noteCacheInvalidation();
    }
  }
  return removed;
};
