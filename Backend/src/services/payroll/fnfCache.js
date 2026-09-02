// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT CACHE KEYS (§20)
//
//  The brief writes the concept as `payroll:fnf:{companyId}`. Crewly's one
//  key factory (Phase 28.7) already produces exactly that shape plus the
//  tenant prefix and a version, so it is reused — the same call 29.5–29.10
//  made. MongoDB remains the source of truth; this is a fail-open read.
//
//  Shaped like statutoryCache.js: no imports beyond the Redis seam, so a dead
//  Redis can never stop a finance manager from opening a settlement.
// ═══════════════════════════════════════════════════════════════════════════
import { buildTenantCacheKey, deleteCache, noteCacheInvalidation } from '../redisCacheService.js';

export const FNF_CACHE_NAMESPACE = 'payroll-fnf';
export const FNF_CACHE_VERSION = 1;

// One suffix per cached read: the HR dashboard, the employee's own settlement
// status (§20) and the pending approval counts the nav badge reads.
export const FNF_CACHE_SUFFIXES = ['dashboard', 'employee', 'approvals'];

export const fnfCacheKey = (companyId, month = '', suffix = 'dashboard', period = '') =>
  buildTenantCacheKey({
    companyId,
    namespace: FNF_CACHE_NAMESPACE,
    version: FNF_CACHE_VERSION,
    segments: [month || 'all', suffix, period || '-'],
  });

/**
 * §20 — invalidate after calculate, HR review, Finance approval, payment or
 * close. The employee's own key goes too: the moment Finance approves, the
 * employee's portal has to stop showing "HR Reviewed".
 */
export const invalidateFnfCache = async (companyId, month = '', employeeIds = []) => {
  if (!companyId) return 0;

  const keys = new Set();
  FNF_CACHE_SUFFIXES.forEach((suffix) => {
    keys.add(fnfCacheKey(companyId, month, suffix));
    keys.add(fnfCacheKey(companyId, '', suffix));
    (employeeIds || []).forEach((employeeId) => {
      keys.add(fnfCacheKey(companyId, month, suffix, String(employeeId)));
      keys.add(fnfCacheKey(companyId, '', suffix, String(employeeId)));
    });
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

export default { fnfCacheKey, invalidateFnfCache };
