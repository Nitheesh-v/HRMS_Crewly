// ─────────────────────────────────────────────────────────────
// Phase 29.6 — Payroll Engine routes
// Mounted at /api/payroll/runs (see routes/index.js).
//
// Every route is: authenticated → tenant-scoped →
// subscription-checked → permission-checked → plan-feature-checked.
// Tenant isolation comes from req.companyId only; no route accepts
// a companyId from the client (§3 / §30).
//
// RBAC (§4) reuses the existing permission middleware:
//   · PAYROLL_RUN_READ         → dashboard, results, employee detail
//                                (Finance is view-only — approval is 29.7)
//   · PAYROLL_RUN_EXECUTE      → run / cancel a month
//   · PAYROLL_RUN_RECALCULATE  → rewrite a snapshot (§21: Payroll Admin
//                                and Company Admin only)
// Employees hold none of these (§4).
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import { assertEmployeeInScope, payrollRunScope } from '../middlewares/payrollRunScope.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  cancelPayrollRun,
  getPayrollResult,
  getPayrollRunSummary,
  listPayrollResults,
  listPayrollRuns,
  recalculatePayroll,
  runPayroll,
} from '../controllers/payrollEngineController.js';
import {
  payrollCancelValidator,
  payrollMonthParamValidator,
  payrollResultParamValidator,
  payrollResultsQueryValidator,
  payrollSelectionValidator,
} from '../validators/payrollEngineValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// §4 — a manager enters with READ and is narrowed to their own team by the
// 29.1 payroll scope; COMPANY scope sees everyone.
const readAccess = [
  requirePermission('PAYROLL_RUN_READ'),
  requireFeature('payroll'),
  payrollRunScope,
];
const runAccess = [
  checkWriteAccess,
  requirePermission('PAYROLL_RUN_EXECUTE'),
  requireFeature('payroll'),
];
const recalculateAccess = [
  checkWriteAccess,
  requireAnyPermission(['PAYROLL_RUN_RECALCULATE', 'PAYROLL_RUN_EXECUTE']),
  requireFeature('payroll'),
];

// §20 — run history.
router.get('/', ...readAccess, listPayrollRuns);

// §23 — dashboard: run, live progress and KPI cards.
router.get('/:month', ...readAccess, payrollMonthParamValidator, getPayrollRunSummary);

// §24 — employee payroll results for the month.
router.get(
  '/:month/results',
  ...readAccess,
  payrollResultsQueryValidator,
  listPayrollResults,
);

router.get(
  '/:month/results/:employeeId',
  requirePermission('PAYROLL_RUN_READ'),
  requireFeature('payroll'),
  payrollRunScope,
  assertEmployeeInScope,
  payrollResultParamValidator,
  getPayrollResult,
);

// §5 / §26 — start the calculation (BullMQ when Redis is configured).
router.post('/:month/run', ...runAccess, payrollSelectionValidator, runPayroll);

// §21 — recalculate the month, or just the selected employees.
router.post(
  '/:month/recalculate',
  ...recalculateAccess,
  payrollSelectionValidator,
  recalculatePayroll,
);

// §28 — cancel a queued run.
router.post('/:month/cancel', ...runAccess, payrollCancelValidator, cancelPayrollRun);

export default router;
