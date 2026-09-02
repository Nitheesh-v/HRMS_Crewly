// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — PAYROLL ANALYTICS CACHE KEYS (§21)
//
//  The brief writes the concept as `payroll:analytics:{companyId}:{month}`.
//  Crewly's one key factory (Phase 28.7) already produces exactly that shape
//  plus the tenant prefix and a version, so it is reused — the same call
//  29.5–29.11 made.
//
//  MongoDB remains the source of truth; this is a fail-open read. A dead Redis
//  must never stop a CFO from opening the payroll dashboard.
// ═══════════════════════════════════════════════════════════════════════════
import { buildTenantCacheKey, deleteCache, noteCacheInvalidation } from '../redisCacheService.js';

export const ANALYTICS_CACHE_NAMESPACE = 'payroll-analytics';
export const ANALYTICS_CACHE_VERSION = 1;

// One suffix per cached read (§21): the executive dashboard, the department
// summary, the trend series and the headcount metrics.
export const ANALYTICS_CACHE_SUFFIXES = ['dashboard', 'department', 'trend', 'headcount'];

export const analyticsCacheKey = (companyId, month = '', suffix = 'dashboard', period = '') =>
  buildTenantCacheKey({
    companyId,
    namespace: ANALYTICS_CACHE_NAMESPACE,
    version: ANALYTICS_CACHE_VERSION,
    segments: [month || 'all', suffix, period || '-'],
  });

/**
 * §21 — invalidate after payroll completion, a final settlement, a payroll
 * recalculation or a statutory update.
 *
 * Analytics reads across months (a trend is twelve of them), so a change to
 * one month must drop the cross-month keys too — hence the `''` entry beside
 * the specific month.
 */
export const invalidateAnalyticsCache = async (companyId, month = '') => {
  if (!companyId) return 0;

  const keys = new Set();
  ANALYTICS_CACHE_SUFFIXES.forEach((suffix) => {
    keys.add(analyticsCacheKey(companyId, month, suffix));
    keys.add(analyticsCacheKey(companyId, '', suffix));
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

export default { analyticsCacheKey, invalidateAnalyticsCache };
