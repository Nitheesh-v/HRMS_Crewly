// ─────────────────────────────────────────────────────────────
// Phase 29.5 — Monthly Payroll Inputs routes
// Mounted at /api/payroll/inputs (see routes/index.js).
//
// Every route is: authenticated → tenant-scoped → subscription-checked
// → permission-checked → plan-feature-checked. Tenant isolation comes
// from req.companyId only; no route accepts a companyId from the client.
//
// RBAC (§4) reuses the existing permission middleware:
//   · PAYROLL_INPUT_LOCK   → lock / reopen the month (§20 — Company Admin
//                            and Payroll Admin only)
//   · PAYROLL_INPUT_MANAGE → entries, bulk actions, imports, validation
//   · PAYROLL_INPUT_READ   → view (a Manager sees their TEAM through the
//                            29.1 payroll scope)
// Employees hold none of these (§4).
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import { payrollInputScope } from '../middlewares/payrollInputScope.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  addMonthlyInputEntry,
  confirmMonthlyImport,
  getMonthlyInput,
  importMonthlyInputs,
  listMonthlyInputs,
  listPayrollPeriods,
  previewMonthlyImport,
  removeMonthlyInputEntry,
  runBulkAction,
  setMonthlyInputStatus,
  updateMonthlyInputEntry,
  validateMonthlyInputs,
} from '../controllers/monthlyInputController.js';
import {
  bulkActionValidator,
  importConfirmValidator,
  importPreviewValidator,
  monthBodyValidator,
  monthlyInputEntryIdValidator,
  monthlyInputEntryPatchValidator,
  monthlyInputEntryValidator,
  monthlyInputListValidator,
  monthQueryValidator,
  periodStatusValidator,
} from '../validators/monthlyInputValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// §4 — a Manager enters with READ and sees only their TEAM through the 29.1
// payroll scope; COMPANY scope sees everyone in the company.
const readAccess = [
  requirePermission('PAYROLL_INPUT_READ'),
  requireFeature('payroll'),
  payrollInputScope,
];
const writeAccess = [
  checkWriteAccess,
  requirePermission('PAYROLL_INPUT_MANAGE'),
  requireFeature('payroll'),
];
const lockAccess = [
  checkWriteAccess,
  requireAnyPermission(['PAYROLL_INPUT_LOCK', 'PAYROLL_INPUT_MANAGE']),
  requireFeature('payroll'),
];

// §6 — payroll months.
router.get('/periods', ...readAccess, listPayrollPeriods);

// §9 / §25 — the HR workspace for one month.
router.get('/', ...readAccess, monthlyInputListValidator, listMonthlyInputs);

// §7 / §14 / §15 — automatic attendance, leave and shift import.
router.post('/import', ...writeAccess, monthBodyValidator, importMonthlyInputs);

// §19 — validation report.
router.post('/validate', ...lockAccess, monthBodyValidator, validateMonthlyInputs);

// §20 — lock / reopen.
router.post('/status', ...lockAccess, periodStatusValidator, setMonthlyInputStatus);

// §11 — preview, then confirm.
router.post('/bulk/preview', ...writeAccess, importPreviewValidator, previewMonthlyImport);
router.post('/bulk/confirm', ...writeAccess, importConfirmValidator, confirmMonthlyImport);

// §12 — bulk actions.
router.post('/bulk/action', ...writeAccess, bulkActionValidator, runBulkAction);

// §10 — one employee's monthly input.
router.get(
  '/employee/:employeeId',
  requirePermission('PAYROLL_INPUT_READ'),
  requireFeature('payroll'),
  payrollInputScope,
  monthlyInputEntryIdValidator,
  getMonthlyInput,
);

router.post(
  '/employee/:employeeId/entries',
  ...writeAccess,
  monthlyInputEntryValidator,
  addMonthlyInputEntry,
);

router.patch(
  '/employee/:employeeId/entries/:entryId',
  ...writeAccess,
  monthlyInputEntryPatchValidator,
  updateMonthlyInputEntry,
);

router.delete(
  '/employee/:employeeId/entries/:entryId',
  ...writeAccess,
  monthlyInputEntryIdValidator,
  removeMonthlyInputEntry,
);

export default router;
