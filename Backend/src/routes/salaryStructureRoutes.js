// ─────────────────────────────────────────────────────────────
// Phase 29.3 — Salary Structures routes
// Mounted at /api/payroll/structures (see routes/index.js).
//
// Every route is: authenticated → tenant-scoped → subscription-checked
// → permission-checked → plan-feature-checked. Tenant isolation comes
// from req.companyId only; no route accepts a companyId from the client.
//
// RBAC (§4 / §21) reuses the existing permission middleware. The spec's
// role list is expressed as PERMISSIONS, not role names, which is the
// Phase 29.1 model:
//   · HR Manager   → READ + MANAGE (create/edit/clone, no activation)
//   · Payroll Admin → READ + MANAGE + ACTIVATE (spec §4: as Company Admin)
//   · Manager / Team Lead / Employee → none by default (grantable)
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
  cloneSalaryStructure,
  createSalaryStructure,
  getSalaryStructure,
  listSalaryStructures,
  previewSalaryStructure,
  setSalaryStructureStatus,
  updateSalaryStructure,
} from '../controllers/salaryStructureController.js';
import {
  salaryStructureCloneValidator,
  salaryStructureCreateValidator,
  salaryStructureIdValidator,
  salaryStructureListValidator,
  salaryStructurePreviewValidator,
  salaryStructureStatusValidator,
  salaryStructureUpdateValidator,
} from '../validators/salaryStructureValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

router.get(
  '/',
  requirePermission('SALARY_STRUCTURE_READ'),
  requireFeature('payroll'),
  salaryStructureListValidator,
  listSalaryStructures,
);

// §9 — preview only; it never stores anything.
router.post(
  '/preview',
  requirePermission('SALARY_STRUCTURE_READ'),
  requireFeature('payroll'),
  salaryStructurePreviewValidator,
  previewSalaryStructure,
);

router.get(
  '/:structureId',
  requirePermission('SALARY_STRUCTURE_READ'),
  requireFeature('payroll'),
  salaryStructureIdValidator,
  getSalaryStructure,
);

router.post(
  '/',
  checkWriteAccess,
  requirePermission('SALARY_STRUCTURE_MANAGE'),
  requireFeature('payroll'),
  salaryStructureCreateValidator,
  createSalaryStructure,
);

router.patch(
  '/:structureId',
  checkWriteAccess,
  requirePermission('SALARY_STRUCTURE_MANAGE'),
  requireFeature('payroll'),
  salaryStructureUpdateValidator,
  updateSalaryStructure,
);

router.post(
  '/:structureId/clone',
  checkWriteAccess,
  requirePermission('SALARY_STRUCTURE_MANAGE'),
  requireFeature('payroll'),
  salaryStructureCloneValidator,
  cloneSalaryStructure,
);

// §14 — activation is its own permission so the company can let HR build
// structures without letting them switch structures on.
router.post(
  '/:structureId/status',
  checkWriteAccess,
  requirePermission('SALARY_STRUCTURE_ACTIVATE'),
  requireFeature('payroll'),
  salaryStructureStatusValidator,
  setSalaryStructureStatus,
);

export default router;
