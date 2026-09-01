// ─────────────────────────────────────────────────────────────
// Phase 29.8 — Salary payment scope middleware (§3 / §23)
//
// Reuses the 29.1 payroll scope: a manager sees their own team,
// COMPANY scope sees everyone. `null` means "whole company"
// downstream, which is exactly what the service understands.
//
// No companyId from the client is ever trusted: the scope is
// resolved from req.companyId and the actor's own role.
// ─────────────────────────────────────────────────────────────
import ApiError from '../utils/ApiError.js';
import { resolvePayrollVisibility } from '../services/payroll/payrollAccessService.js';

export const payrollPaymentScope = async (req, res, next) => {
  try {
    req.payrollVisibility = await resolvePayrollVisibility({
      actor: req.user,
      permission: 'PAYROLL_PAYMENT_READ',
      companyId: req.companyId,
    });
    return next();
  } catch {
    return next(ApiError.forbidden('Payroll payment access denied'));
  }
};

// Per-employee writes must stay inside the actor's scope.
export const assertEmployeeInPaymentScope = (req, res, next) => {
  const allowed = req.payrollVisibility?.allowedEmployeeIds;
  if (!Array.isArray(allowed)) return next();

  const inScope = allowed.some((id) => String(id) === String(req.params.employeeId));
  if (!inScope) return next(ApiError.forbidden('Payroll payment access denied'));

  return next();
};

export default payrollPaymentScope;
