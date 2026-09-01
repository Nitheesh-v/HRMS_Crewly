// ─────────────────────────────────────────────────────────────
// Phase 29.7 — Payroll Review & Approval routes
// Mounted at /api/payroll/review (see routes/index.js).
//
// Every route is: authenticated → tenant-scoped →
// subscription-checked → permission-checked → plan-feature-checked.
// Tenant isolation comes from req.companyId only (§3 / §24).
//
// RBAC (§4) reuses the existing permission middleware — no role
// names anywhere:
//   · PAYROLL_RUN_READ        → view the review workspace
//   · PAYROLL_RUN_PREPARE     → HR review: checklist, remarks, per-employee
//   · PAYROLL_RUN_LOCK        → lock payroll                        (§12)
//   · PAYROLL_RUN_REOPEN      → reopen a locked/approved payroll    (§13)
//   · PAYROLL_RUN_REVIEW      → submit to finance                   (§14)
//   · PAYROLL_RUN_APPROVE     → finance approval                    (§14)
//   · PAYROLL_RUN_REJECT      → finance rejection                   (§14)
// Employees hold none of these (§4).
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import {
  assertEmployeeInReviewScope,
  payrollReviewScope,
} from '../middlewares/payrollReviewScope.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  addPayrollRemark,
  approvePayroll,
  createPayrollExport,
  getPayrollDifferences,
  getPayrollExport,
  getPayrollReview,
  getPayrollReviewEmployee,
  listPayrollReviewEmployees,
  listPayrollReviewErrors,
  lockPayroll,
  rejectPayroll,
  reopenPayroll,
  reviewPayrollEmployee,
  runPayrollReviewBulkAction,
  setPayrollChecklist,
  submitPayrollForApproval,
} from '../controllers/payrollReviewController.js';
import {
  payrollBulkReviewValidator,
  payrollChecklistValidator,
  payrollExportIdValidator,
  payrollExportValidator,
  payrollMonthParamValidator,
  payrollReasonValidator,
  payrollRemarkValidator,
  payrollReviewEmployeeBodyValidator,
  payrollReviewEmployeeParamValidator,
} from '../validators/payrollReviewValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// Shared guards — declared once so the route table below reads cleanly.
const readAccess = [
  requirePermission('PAYROLL_RUN_READ'),
  requireFeature('payroll'),
  payrollReviewScope,
];

const writeAccess = (permission) => [
  checkWriteAccess,
  requirePermission(permission),
  requireFeature('payroll'),
];

// §7 — the review dashboard (cached, §20).
router.get('/:month', ...readAccess, payrollMonthParamValidator, getPayrollReview);

// §8 — employee review table.
router.get('/:month/employees', ...readAccess, payrollMonthParamValidator, listPayrollReviewEmployees);

// §10 / §22 — error report.
router.get('/:month/errors', ...readAccess, payrollMonthParamValidator, listPayrollReviewErrors);

// §17 — difference report between snapshot versions.
router.get(
  '/:month/differences',
  ...readAccess,
  payrollMonthParamValidator,
  getPayrollDifferences,
);

// §9 — one employee's payroll breakdown.
router.get(
  '/:month/employees/:employeeId',
  requirePermission('PAYROLL_RUN_READ'),
  requireFeature('payroll'),
  payrollReviewScope,
  assertEmployeeInReviewScope,
  payrollReviewEmployeeParamValidator,
  getPayrollReviewEmployee,
);

// §11 — HR checklist.
router.patch(
  '/:month/checklist/:item',
  ...writeAccess('PAYROLL_RUN_PREPARE'),
  payrollChecklistValidator,
  setPayrollChecklist,
);

// §15 — remarks (HR and finance both contribute, finance needs no PREPARE).
router.post(
  '/:month/remarks',
  checkWriteAccess,
  requireAnyPermission([
    'PAYROLL_RUN_PREPARE',
    'PAYROLL_RUN_REVIEW',
    'PAYROLL_RUN_APPROVE',
    'PAYROLL_RUN_REJECT',
    'PAYROLL_RUN_LOCK',
  ]),
  requireFeature('payroll'),
  payrollRemarkValidator,
  addPayrollRemark,
);

// §8 — review one employee.
router.patch(
  '/:month/employees/:employeeId',
  ...writeAccess('PAYROLL_RUN_PREPARE'),
  payrollReviewEmployeeBodyValidator,
  reviewPayrollEmployee,
);

// §18 — bulk review actions.
router.post(
  '/:month/bulk',
  ...writeAccess('PAYROLL_RUN_PREPARE'),
  payrollBulkReviewValidator,
  runPayrollReviewBulkAction,
);

// §12 — lock.
router.post('/:month/lock', ...writeAccess('PAYROLL_RUN_LOCK'), payrollMonthParamValidator, lockPayroll);

// §13 — reopen (reason required).
router.post(
  '/:month/reopen',
  ...writeAccess('PAYROLL_RUN_REOPEN'),
  payrollReasonValidator,
  reopenPayroll,
);

// §14 — submit → finance approve / reject.
router.post(
  '/:month/submit',
  ...writeAccess('PAYROLL_RUN_REVIEW'),
  payrollMonthParamValidator,
  submitPayrollForApproval,
);

router.post(
  '/:month/approve',
  ...writeAccess('PAYROLL_RUN_APPROVE'),
  payrollMonthParamValidator,
  approvePayroll,
);

router.post(
  '/:month/reject',
  ...writeAccess('PAYROLL_RUN_REJECT'),
  payrollReasonValidator,
  rejectPayroll,
);

// §19 / §21 — report exports (queued when Redis is configured).
router.post('/:month/exports', ...readAccess, payrollExportValidator, createPayrollExport);
router.get('/exports/:exportId', ...readAccess, payrollExportIdValidator, getPayrollExport);

export default router;
