// ─────────────────────────────────────────────────────────────
// Phase 29.5 — payroll scope for monthly inputs (§4 / §24)
//
// The route proves the actor holds a payroll-input permission.
// This middleware narrows WHICH employees they may see, using the
// 29.1 payroll scope (COMPANY / TEAM / ASSIGNED_DEPARTMENTS /
// SELF). `allowedEmployeeIds === null` means the whole company —
// every query is still filtered by companyId, so a scope can only
// ever narrow, never widen.
// ─────────────────────────────────────────────────────────────
import { PAYROLL_SCOPES } from '../utils/payrollScope.js';
import { resolvePayrollVisibility } from '../services/payroll/payrollAccessService.js';

export const payrollInputScope = async (req, res, next) => {
  try {
    const visibility = await resolvePayrollVisibility({
      actor: {
        _id: req.user._id,
        companyId: req.companyId,
        role: req.user.role,
        roleRef: req.user.roleRef || null,
        department: req.user.department || null,
      },
      permission: 'PAYROLL_INPUT_READ',
    });

    req.payrollVisibility = visibility;

    // A single-employee route: reject anyone outside the visible set.
    if (req.params.employeeId && Array.isArray(visibility.allowedEmployeeIds)) {
      const allowed = visibility.allowedEmployeeIds.map(String);
      if (!allowed.includes(String(req.params.employeeId))) {
        return res.status(403).json({
          statusCode: 403,
          success: false,
          code: 'PAYROLL_ACCESS_DENIED',
          message: 'This employee is outside your payroll scope.',
        });
      }
    }

    return next();
  } catch (error) {
    return res.status(500).json({ statusCode: 500, success: false, message: error.message });
  }
};

export { PAYROLL_SCOPES };
export default payrollInputScope;
