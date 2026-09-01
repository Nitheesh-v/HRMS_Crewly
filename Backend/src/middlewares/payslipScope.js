// ─────────────────────────────────────────────────────────────
// Phase 29.9 — Payslip scope middleware (§3 / §26)
//
// Reuses the 29.1 payroll scope, exactly like 29.7 and 29.8:
// a manager sees their own team, COMPANY scope sees everyone.
// `null` means "whole company" downstream.
//
// The employee self-service routes do NOT use this middleware —
// they never receive an employee id at all, so there is nothing
// to narrow. That is the strongest form of tenant isolation
// available: the id simply is not part of the request.
// ─────────────────────────────────────────────────────────────
import ApiError from '../utils/ApiError.js';
import { resolvePayrollVisibility } from '../services/payroll/payrollAccessService.js';

export const payslipScope = async (req, res, next) => {
  try {
    req.payrollVisibility = await resolvePayrollVisibility({
      actor: req.user,
      permission: 'PAYSLIP_READ',
      companyId: req.companyId,
    });
    req.payrollEmployeeIds = req.payrollVisibility?.allowedEmployeeIds || null;
    return next();
  } catch {
    return next(ApiError.forbidden('Payslip access denied'));
  }
};

export default payslipScope;
