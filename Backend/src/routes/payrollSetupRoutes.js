// ─────────────────────────────────────────────────────────────
// Phase 29.1 — Company Payroll Setup routes
// Mounted at /api/payroll/setup (see routes/index.js).
//
// Every route is: authenticated → tenant-scoped → subscription-checked →
// permission-checked → plan-feature-checked. Company isolation comes from
// req.companyId only; no route accepts a companyId from the client (§2).
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
  activateSetup,
  getPayrollSetupConfig,
  startSetup,
  suspendSetup,
  updateSection,
} from '../controllers/payrollSetupController.js';
import {
  payrollSetupActivateValidator,
  payrollSetupSectionValidator,
  payrollSetupSuspendValidator,
} from '../validators/payrollSetupValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// Read — HR Manager and Company Admin (Employee / Manager / Team Lead: denied)
router.get(
  '/',
  requirePermission('PAYROLL_SETUP_READ'),
  requireFeature('payroll'),
  getPayrollSetupConfig,
);

// Start the wizard (NOT_CONFIGURED → DRAFT), idempotent
router.post(
  '/start',
  checkWriteAccess,
  requirePermission('PAYROLL_SETUP_UPDATE'),
  requireFeature('payroll'),
  startSetup,
);

// Draft autosave for one section (§32)
router.patch(
  '/:section',
  checkWriteAccess,
  requirePermission('PAYROLL_SETUP_UPDATE'),
  requireFeature('payroll'),
  payrollSetupSectionValidator,
  updateSection,
);

// Activate payroll (§21) — Company Admin only
router.post(
  '/activate',
  checkWriteAccess,
  requirePermission('PAYROLL_SETUP_ACTIVATE'),
  requireFeature('payroll'),
  payrollSetupActivateValidator,
  activateSetup,
);

// Suspend payroll (§22)
router.post(
  '/suspend',
  checkWriteAccess,
  requirePermission('PAYROLL_SETUP_ACTIVATE'),
  requireFeature('payroll'),
  payrollSetupSuspendValidator,
  suspendSetup,
);

export default router;
