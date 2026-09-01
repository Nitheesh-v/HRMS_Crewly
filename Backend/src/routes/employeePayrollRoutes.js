// ─────────────────────────────────────────────────────────────
// Phase 29.4 — Employee Payroll Profiles routes
// Mounted at /api/payroll/employees (see routes/index.js).
//
// Every route is: authenticated → tenant-scoped → subscription-checked
// → permission-checked → plan-feature-checked → payroll-scope-checked.
// Tenant isolation comes from req.companyId only (§3).
//
// RBAC (§4) reuses the existing permission + payroll-scope machinery:
//   · EMPLOYEE_SALARY_MANAGE  → create / edit / revise / change status
//   · EMPLOYEE_SALARY_READ    → view anyone in scope
//   · EMPLOYEE_SALARY_READ_SELF → view ONLY your own profile (§4 / §24)
// The employee's own record is always readable by its owner
// (payrollAccessService, 29.1). Manager / Team Lead hold nothing by
// default — the company decides (§4).
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  getPayrollProfile,
  listPayrollProfiles,
  previewPayrollProfile,
  savePayrollProfile,
  setPayrollProfileStatus,
} from '../controllers/employeePayrollController.js';
import {
  employeeIdParamValidator,
  payrollProfileListValidator,
  payrollProfilePreviewValidator,
  payrollProfileSaveValidator,
  payrollProfileStatusValidator,
} from '../validators/employeePayrollValidator.js';
import { requirePayrollProfileAccess } from '../middlewares/payrollProfileAccess.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// An employee enters through READ_SELF; HR / Payroll through READ. Either is
// enough to knock on the door — payrollProfileAccess then decides WHICH
// profiles this actor may actually see (§4 / §24).
const readAccess = [
  requireAnyPermission(['EMPLOYEE_SALARY_READ', 'EMPLOYEE_SALARY_READ_SELF']),
  requireFeature('payroll'),
];

router.get('/', ...readAccess, payrollProfileListValidator, listPayrollProfiles);

// §9 — HR verification only; never a payroll calculation.
router.post('/preview', ...readAccess, payrollProfilePreviewValidator, previewPayrollProfile);

router.get(
  '/:employeeId',
  ...readAccess,
  employeeIdParamValidator,
  requirePayrollProfileAccess,
  getPayrollProfile,
);

router.put(
  '/:employeeId',
  checkWriteAccess,
  requirePermission('EMPLOYEE_SALARY_MANAGE'),
  requireFeature('payroll'),
  payrollProfileSaveValidator,
  requirePayrollProfileAccess,
  savePayrollProfile,
);

router.post(
  '/:employeeId/status',
  checkWriteAccess,
  requirePermission('EMPLOYEE_SALARY_MANAGE'),
  requireFeature('payroll'),
  payrollProfileStatusValidator,
  requirePayrollProfileAccess,
  setPayrollProfileStatus,
);

export default router;
