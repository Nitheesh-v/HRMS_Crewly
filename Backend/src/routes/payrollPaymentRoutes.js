// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.8 — SALARY PAYMENT ROUTES  (/api/payroll/payments)
//
//  Guards, never role names (§4):
//    READ       → view batches, payments, download history, download a file
//    GENERATE   → create a batch, generate a file, retry, cancel
//    CONFIRM    → confirm the batch was paid, reopen a failed batch
//    MARK_PAID  → mark one employee paid or failed
//
//  Every route runs protect + tenantContext + checkSubscriptionStatus +
//  requireFeature('payroll'), and reads are narrowed by the 29.1 payroll
//  scope. Crewly prepares payment here; it never talks to a bank (§25).
// ═══════════════════════════════════════════════════════════════════════════
import { Router } from 'express';

import {
  cancelPaymentBatch,
  createPaymentBatch,
  createRetryBatch,
  downloadPaymentFile,
  generatePaymentFile,
  getPaymentBatch,
  getPaymentDashboard,
  listPaymentBatches,
  markBatchPaid,
  markPaymentEmployee,
  reopenPaymentBatch,
  validatePaymentBatch,
} from '../controllers/payrollPaymentController.js';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { requirePermission } from '../middlewares/permissionMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  assertEmployeeInPaymentScope,
  payrollPaymentScope,
} from '../middlewares/payrollPaymentScope.js';
import {
  cancelPaymentBatchValidator,
  createPaymentBatchValidator,
  generatePaymentFileValidator,
  markPaymentEmployeeValidator,
  payrollPaymentBatchIdParamValidator,
  payrollPaymentEmployeeParamValidator,
  payrollPaymentFileIdParamValidator,
  payrollPaymentMonthQueryValidator,
} from '../validators/payrollPaymentValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

const readAccess = [
  requirePermission('PAYROLL_PAYMENT_READ'),
  requireFeature('payroll'),
  payrollPaymentScope,
];

const writeAccess = (permission) => [
  checkWriteAccess,
  requirePermission(permission),
  requireFeature('payroll'),
];

// Reopening a batch puts money back in play — it is a confirmation-grade act.
const confirmAccess = writeAccess('PAYROLL_PAYMENT_CONFIRM');

// §17 — dashboard (cached, §19).
router.get('/dashboard', ...readAccess, payrollPaymentMonthQueryValidator, getPaymentDashboard);

// §12 / §18 — download history payload, before the :batchId routes so the
// ids never collide.
router.get('/files/:fileId/download', ...readAccess, payrollPaymentFileIdParamValidator, downloadPaymentFile);

// §18 — batch list.
router.get('/', ...readAccess, payrollPaymentMonthQueryValidator, listPaymentBatches);

// §5 / §6 — create a batch from the approved payroll.
router.post(
  '/',
  ...writeAccess('PAYROLL_PAYMENT_GENERATE'),
  createPaymentBatchValidator,
  createPaymentBatch,
);

// §7 — bank validation report.
router.get(
  '/:batchId/validate',
  ...readAccess,
  payrollPaymentBatchIdParamValidator,
  validatePaymentBatch,
);

// §10 / §20 — generate the bank transfer file.
router.post(
  '/:batchId/files',
  ...writeAccess('PAYROLL_PAYMENT_GENERATE'),
  payrollPaymentBatchIdParamValidator,
  generatePaymentFileValidator,
  generatePaymentFile,
);

// §13 — confirm the whole batch.
router.post(
  '/:batchId/mark-all-paid',
  ...confirmAccess,
  payrollPaymentBatchIdParamValidator,
  markBatchPaid,
);

// §14 — one employee's outcome.
router.patch(
  '/:batchId/employees/:employeeId',
  checkWriteAccess,
  requirePermission('PAYROLL_PAYMENT_MARK_PAID'),
  requireFeature('payroll'),
  payrollPaymentScope,
  assertEmployeeInPaymentScope,
  payrollPaymentEmployeeParamValidator,
  markPaymentEmployeeValidator,
  markPaymentEmployee,
);

// §16 — retry the failures in a fresh batch.
router.post(
  '/:batchId/retry',
  ...writeAccess('PAYROLL_PAYMENT_GENERATE'),
  payrollPaymentBatchIdParamValidator,
  createRetryBatch,
);

// §8 / §22 — cancel.
router.post(
  '/:batchId/cancel',
  ...writeAccess('PAYROLL_PAYMENT_GENERATE'),
  payrollPaymentBatchIdParamValidator,
  cancelPaymentBatchValidator,
  cancelPaymentBatch,
);

// §4 — reopen a failed batch.
router.post(
  '/:batchId/reopen',
  ...confirmAccess,
  payrollPaymentBatchIdParamValidator,
  reopenPaymentBatch,
);

// §18 — batch detail. Declared last so the specific paths above win.
router.get('/:batchId', ...readAccess, payrollPaymentBatchIdParamValidator, getPaymentBatch);

export default router;
