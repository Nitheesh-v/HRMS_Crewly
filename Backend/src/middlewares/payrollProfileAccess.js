// ─────────────────────────────────────────────────────────────
// Phase 29.4 — per-employee payroll access (§4 / §24)
//
// The route proves the actor holds SOME payroll permission. This
// middleware proves they may touch THIS employee:
//
//   1. tenant          — same company, never negotiable
//   2. self-service    — an employee always reads their own profile
//   3. role + permission + payroll scope (COMPANY / TEAM / SELF)
//
// It reuses payrollAccessService (Phase 29.1) so there is exactly one
// place where "who may see whose salary" is decided. No new rule engine.
// ─────────────────────────────────────────────────────────────
import User from '../models/User.js';
import { canReadEmployeePayroll } from '../services/payroll/payrollAccessService.js';

const deny = (res, message = 'You cannot access this payroll profile.') =>
  res.status(403).json({ statusCode: 403, success: false, code: 'PAYROLL_ACCESS_DENIED', message });

export const requirePayrollProfileAccess = async (req, res, next) => {
  try {
    const employeeId = req.params.employeeId;

    // DB Logic - DB logics — the subject is always loaded inside the tenant.
    const subject = await User.findOne({ _id: employeeId, companyId: req.companyId })
      .select('_id name companyId department')
      .lean();

    if (!subject) {
      return res.status(404).json({
        statusCode: 404,
        success: false,
        message: 'Employee not found in your company',
      });
    }

    const allowed = await canReadEmployeePayroll({
      actor: {
        _id: req.user._id,
        companyId: req.companyId,
        role: req.user.role,
        roleRef: req.user.roleRef || null,
        department: req.user.department || null,
      },
      subject: {
        _id: subject._id,
        companyId: subject.companyId,
        department: subject.department || null,
      },
      permission: 'EMPLOYEE_SALARY_READ',
    });

    if (!allowed) return deny(res);

    // Hand the resolved employee to the controller so it never re-reads.
    req.payrollSubject = subject;

    return next();
  } catch (error) {
    return res.status(500).json({
      statusCode: 500,
      success: false,
      message: error.message,
    });
  }
};

export default requirePayrollProfileAccess;
