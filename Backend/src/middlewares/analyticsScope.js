// ─────────────────────────────────────────────────────────────
// Phase 29.12 — Payroll Analytics scope middleware (§3 / §25)
//
// Reuses the 29.1 payroll scope exactly like 29.7–29.11 do.
//
// Analytics is the one payroll module where "can this person see
// this row?" is not only about the actor's role but about the
// row's department: a manager scoped to two departments must not
// have the whole company's payroll cost summed up for them.
//
// There is no employee portal here (§4: Employee — No access),
// so every route is company-scoped and scope-narrowed.
// ─────────────────────────────────────────────────────────────
import ApiError from '../utils/ApiError.js';
import { resolvePayrollVisibility } from '../services/payroll/payrollAccessService.js';

export const analyticsScope = async (req, res, next) => {
  try {
    req.payrollVisibility = await resolvePayrollVisibility({
      actor: req.user,
      permission: 'PAYROLL_REPORT_READ',
      companyId: req.companyId,
    });
    req.payrollEmployeeIds = req.payrollVisibility?.allowedEmployeeIds || null;
    return next();
  } catch {
    return next(ApiError.forbidden('Payroll analytics access denied'));
  }
};

export default analyticsScope;
