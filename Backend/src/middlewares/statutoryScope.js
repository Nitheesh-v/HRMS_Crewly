// ─────────────────────────────────────────────────────────────
// Phase 29.10 — Statutory scope middleware (§3 / §24)
//
// Reuses the 29.1 payroll scope exactly like 29.7–29.9 do.
//
// One deliberate difference from payslipScope: a statutory return
// is filed for the ESTABLISHMENT, not for a team, so the totals
// are company-wide by construction. The scope still resolves and
// is attached to the request — it is what lets the employee
// self-service route prove the caller may only ever read their
// own statutory IDs, and it is what a future per-department
// export would narrow with.
// ─────────────────────────────────────────────────────────────
import ApiError from '../utils/ApiError.js';
import { resolvePayrollVisibility } from '../services/payroll/payrollAccessService.js';

export const statutoryScope = async (req, res, next) => {
  try {
    req.payrollVisibility = await resolvePayrollVisibility({
      actor: req.user,
      permission: 'PAYROLL_STATUTORY_READ',
      companyId: req.companyId,
    });
    req.payrollEmployeeIds = req.payrollVisibility?.allowedEmployeeIds || null;
    return next();
  } catch {
    return next(ApiError.forbidden('Statutory access denied'));
  }
};

export default statutoryScope;
