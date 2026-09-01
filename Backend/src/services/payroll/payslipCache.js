// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP CACHE KEYS (§23)
//
//  The brief writes the concept as `payroll:payslips:{employeeId}`. Crewly's
//  one key factory (Phase 28.7) already produces exactly that shape plus the
//  tenant prefix and a version, so it is reused — the same call 29.5–29.8
//  made. MongoDB stays the source of truth; the cache is a fail-open read.
//
//  Shaped like payrollPaymentCache.js: no imports of its own beyond the Redis
//  seam, so a dead Redis can never break a payslip download.
// ═══════════════════════════════════════════════════════════════════════════
import { buildTenantCacheKey, deleteCache, noteCacheInvalidation } from '../redisCacheService.js';

export const PAYSLIP_CACHE_NAMESPACE = 'payroll-payslips';
export const PAYSLIP_CACHE_VERSION = 1;

// One suffix per cached read: the employee portal list and the admin month
// dashboard.
export const PAYSLIP_CACHE_SUFFIXES = ['employee', 'dashboard'];

export const payslipCacheKey = (companyId, month = '', employeeId = '', suffix = 'dashboard') =>
  buildTenantCacheKey({
    companyId,
    namespace: PAYSLIP_CACHE_NAMESPACE,
    version: PAYSLIP_CACHE_VERSION,
    segments: [month || 'all', employeeId || 'all', suffix],
  });

/**
 * §23 — drop every cached read for a month (the employee lists AND the admin
 * dashboard). Called after generate, regenerate, email and any status change.
 */
export const invalidatePayslipCache = async (companyId, month = '', employeeIds = []) => {
  if (!companyId) return 0;

  const keys = new Set();
  PAYSLIP_CACHE_SUFFIXES.forEach((suffix) => {
    keys.add(payslipCacheKey(companyId, month, '', suffix));
    keys.add(payslipCacheKey(companyId, '', '', suffix));
    // The employee portal is cached per employee, so the affected employees'
    // own keys have to go too.
    (employeeIds || []).forEach((employeeId) => {
      keys.add(payslipCacheKey(companyId, month, employeeId, suffix));
      keys.add(payslipCacheKey(companyId, '', employeeId, suffix));
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

export default { payslipCacheKey, invalidatePayslipCache };
