// ─────────────────────────────────────────────────────────────
// Phase 29.2 — Salary Components routes
// Mounted at /api/payroll/components (see routes/index.js).
//
// Every route is: authenticated → tenant-scoped → subscription-checked
// → permission-checked → plan-feature-checked. Tenant isolation comes
// from req.companyId only; no route accepts a companyId from the
// client, and every service query is companyId-scoped (§4).
//
// RBAC (§43) reuses the existing permission middleware — no second
// authorization system. Employees and Managers hold none of these
// permissions by default (see permissionRegistry).
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { requirePermission } from '../middlewares/permissionMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  createSalaryComponent,
  createSalaryDefaults,
  duplicateSalaryComponent,
  getSalaryComponent,
  getSalaryComponentDefaults,
  listSalaryComponents,
  setSalaryComponentStatus,
  updateSalaryComponent,
} from '../controllers/salaryComponentController.js';
import {
  salaryComponentCreateValidator,
  salaryComponentDuplicateValidator,
  salaryComponentIdValidator,
  salaryComponentListValidator,
  salaryComponentStatusValidator,
  salaryComponentUpdateValidator,
} from '../validators/salaryComponentValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// ── reads — anyone holding View Salary Components
router.get(
  '/',
  requirePermission('SALARY_COMPONENT_READ'),
  requireFeature('payroll'),
  salaryComponentListValidator,
  listSalaryComponents,
);

// Default suggestions are derived from the company's Phase 29.1 statutory
// configuration (§35 / §36) — PF off means no PF component is suggested.
router.get(
  '/defaults',
  requirePermission('SALARY_COMPONENT_READ'),
  requireFeature('payroll'),
  getSalaryComponentDefaults,
);

router.get(
  '/:componentId',
  requirePermission('SALARY_COMPONENT_READ'),
  requireFeature('payroll'),
  salaryComponentIdValidator,
  getSalaryComponent,
);

// ── writes — Manage Salary Components
router.post(
  '/',
  checkWriteAccess,
  requirePermission('SALARY_COMPONENT_MANAGE'),
  requireFeature('payroll'),
  salaryComponentCreateValidator,
  createSalaryComponent,
);

router.post(
  '/defaults',
  checkWriteAccess,
  requirePermission('SALARY_COMPONENT_MANAGE'),
  requireFeature('payroll'),
  createSalaryDefaults,
);

router.patch(
  '/:componentId',
  checkWriteAccess,
  requirePermission('SALARY_COMPONENT_MANAGE'),
  requireFeature('payroll'),
  salaryComponentUpdateValidator,
  updateSalaryComponent,
);

router.post(
  '/:componentId/duplicate',
  checkWriteAccess,
  requirePermission('SALARY_COMPONENT_MANAGE'),
  requireFeature('payroll'),
  salaryComponentDuplicateValidator,
  duplicateSalaryComponent,
);

// ── lifecycle — Activate/Deactivate is its own permission so a company
// can let payroll executives define components without letting them
// switch components on and off (separation of duties, 29.1 model).
router.post(
  '/:componentId/status',
  checkWriteAccess,
  requirePermission('SALARY_COMPONENT_ACTIVATE'),
  requireFeature('payroll'),
  salaryComponentStatusValidator,
  setSalaryComponentStatus,
);

export default router;
