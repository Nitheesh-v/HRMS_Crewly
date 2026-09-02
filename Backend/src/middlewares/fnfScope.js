// ─────────────────────────────────────────────────────────────
// Phase 29.11 — Final Settlement scope middleware (§3 / §24)
//
// Reuses the 29.1 payroll scope exactly like 29.7–29.10 do.
//
// The employee self-service route (/mine) does NOT use this
// middleware: it never receives an employee id at all, so there
// is nothing to narrow. That is the strongest form of tenant
// isolation available — the id simply is not part of the
// request.
// ─────────────────────────────────────────────────────────────
import ApiError from '../utils/ApiError.js';
import { resolvePayrollVisibility } from '../services/payroll/payrollAccessService.js';

export const fnfScope = async (req, res, next) => {
  try {
    req.payrollVisibility = await resolvePayrollVisibility({
      actor: req.user,
      permission: 'FINAL_SETTLEMENT_READ',
      companyId: req.companyId,
    });
    req.payrollEmployeeIds = req.payrollVisibility?.allowedEmployeeIds || null;
    return next();
  } catch {
    return next(ApiError.forbidden('Final settlement access denied'));
  }
};

export default fnfScope;
