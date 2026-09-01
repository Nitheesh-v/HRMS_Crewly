// ─────────────────────────────────────────────────────────────
// Phase 29.6 — Payroll run scope middleware (§3 / §30)
//
// Reuses the 29.1 payroll scope: a manager sees their own team's
// payroll results, COMPANY scope sees the whole company. `null`
// means "whole company" downstream, which is exactly the
// permission the service already understands.
//
// No companyId from the client is ever trusted: the scope is
// resolved from req.companyId and the actor's own role.
// ─────────────────────────────────────────────────────────────
import ApiError from '../utils/ApiError.js';
import { resolvePayrollVisibility } from '../services/payroll/payrollAccessService.js';

export const payrollRunScope = async (req, res, next) => {
  try {
    const visibility = await resolvePayrollVisibility({
      actor: req.user,
      permission: 'PAYROLL_RUN_READ',
      companyId: req.companyId,
    });

    req.payrollVisibility = visibility;
    return next();
  } catch (error) {
    return next(ApiError.forbidden('Payroll access denied'));
  }
};

// A single-employee read must sit inside the actor's scope.
export const assertEmployeeInScope = (req, res, next) => {
  const allowed = req.payrollVisibility?.allowedEmployeeIds;
  if (!Array.isArray(allowed)) return next();

  const inScope = allowed.some((id) => String(id) === String(req.params.employeeId));
  if (!inScope) return next(ApiError.forbidden('Payroll access denied'));

  return next();
};

export default payrollRunScope;
