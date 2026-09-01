// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY CACHE KEYS (§20)
//
//  The brief writes the concept as `payroll:compliance:{companyId}:{month}`.
//  Crewly's one key factory (Phase 28.7) already produces exactly that shape
//  plus the tenant prefix and a version, so it is reused — the same call
//  29.5–29.9 made. MongoDB remains the source of truth; this is a fail-open
//  read of a derived roll-up.
//
//  Shaped like payslipCache.js: no imports beyond the Redis seam, so a dead
//  Redis can never break a compliance download.
// ═══════════════════════════════════════════════════════════════════════════
import { buildTenantCacheKey, deleteCache, noteCacheInvalidation } from '../redisCacheService.js';

export const STATUTORY_CACHE_NAMESPACE = 'payroll-compliance';
export const STATUTORY_CACHE_VERSION = 1;

// One suffix per cached read: the dashboard KPIs, the full month roll-up, the
// filing statuses, the compliance calendar and the annual reports.
export const STATUTORY_CACHE_SUFFIXES = [
  'dashboard',
  'summary',
  'filing',
  'calendar',
  'annual',
  'history',
  'report',
];

export const statutoryCacheKey = (companyId, month = '', suffix = 'dashboard', period = '') =>
  buildTenantCacheKey({
    companyId,
    namespace: STATUTORY_CACHE_NAMESPACE,
    version: STATUTORY_CACHE_VERSION,
    segments: [month || 'all', suffix, period || '-'],
  });

/**
 * §20 — invalidate after report generation, a filing status update, a
 * calendar change or a payroll recalculation. The month-scoped keys and the
 * "all months" keys both go: a history view and an annual report read across
 * months, so a single month's recalculation must drop them too.
 */
export const invalidateStatutoryCache = async (companyId, month = '') => {
  if (!companyId) return 0;

  const keys = new Set();
  STATUTORY_CACHE_SUFFIXES.forEach((suffix) => {
    keys.add(statutoryCacheKey(companyId, month, suffix));
    keys.add(statutoryCacheKey(companyId, '', suffix));
  });

  let removed = 0;
  for (const key of keys) {
    if (!key) continue;
    const gone = await deleteCache(key).catch(() => false);
    if (gone) {
      removed += 1;
      noteCacheInvalidation();
    }
  }
  return removed;
};

export default { statutoryCacheKey, invalidateStatutoryCache };
