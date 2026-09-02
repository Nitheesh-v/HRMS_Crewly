// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT ROUTES
//
//  Mounted at /api/payroll/fnf (see routes/index.js).
//
//  Four duties, four gates (§4 / §15 / §16):
//    · READ       FINAL_SETTLEMENT_READ       (HR, Payroll, Finance, Admin)
//    · CALCULATE  FINAL_SETTLEMENT_CALCULATE  (Payroll Admin)
//    · REVIEW     FINAL_SETTLEMENT_REVIEW     (HR Manager)
//    · APPROVE/PAY FINAL_SETTLEMENT_APPROVE / _PAY (Finance Manager)
//    · CLOSE/REOPEN — Company Admin only
//
//  Separation of duties is deliberate: the person who calculates a settlement
//  is not the person who approves paying it, and neither of them closes it.
//
//  `/mine/*` is the employee's own settlement (§18). It is granted by
//  FINAL_SETTLEMENT_READ_SELF — a permission every role holds — and the
//  employee id is never part of the request.
// ═══════════════════════════════════════════════════════════════════════════
import express from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { requireAnyPermission, requirePermission } from '../middlewares/permissionMiddleware.js';
import { checkWriteAccess, requireFeature } from '../middlewares/subscriptionAccess.js';
import fnfScope from '../middlewares/fnfScope.js';

import {
  calculateSettlement,
  closeSettlement,
  createSettlement,
  downloadFile,
  downloadMyStatement,
  downloadStatement,
  exportRegister,
  financeDecision,
  getDashboard,
  addRecovery,
  getMySettlement,
  getSettlement,
  hrReview,
  listFiles,
  listSettlements,
  markPaid,
  reopenSettlement,
  requestRegister,
  requestStatement,
  setNoticeDecision,
  updateItems,
} from '../controllers/fnfController.js';

import {
  addRecoveryValidator,
  createSettlementValidator,
  financeDecisionValidator,
  fnfExportQueryValidator,
  fnfListQueryValidator,
  fnfMonthQueryValidator,
  hrReviewValidator,
  markPaidValidator,
  noticeDecisionValidator,
  reopenValidator,
  settlementFileIdParamValidator,
  settlementIdParamValidator,
  updateItemsValidator,
} from '../validators/fnfValidator.js';

const router = express.Router();

router.use(protect, tenantContext);

// §4 — anyone who may look at a settlement may read it.
const readAccess = [
  requireAnyPermission([
    'FINAL_SETTLEMENT_READ',
    'FINAL_SETTLEMENT_CALCULATE',
    'FINAL_SETTLEMENT_REVIEW',
    'FINAL_SETTLEMENT_APPROVE',
    'FINAL_SETTLEMENT_PAY',
    'FINAL_SETTLEMENT_CLOSE',
    'FINAL_SETTLEMENT_REOPEN',
  ]),
  requireFeature('payroll'),
  fnfScope,
];

const writeAccess = (permission) => [
  checkWriteAccess,
  requirePermission(permission),
  requireFeature('payroll'),
  fnfScope,
];

// ── §18 — the employee's own settlement ────────────────────────────────────
// Declared first so `/mine` can never be mistaken for another path segment.
router.get('/mine', requirePermission('FINAL_SETTLEMENT_READ_SELF'), requireFeature('payroll'), getMySettlement);
router.get(
  '/mine/statement',
  requirePermission('FINAL_SETTLEMENT_READ_SELF'),
  requireFeature('payroll'),
  downloadMyStatement,
);

// ── §19 — dashboard and list ───────────────────────────────────────────────
router.get('/dashboard', ...readAccess, fnfMonthQueryValidator, getDashboard);
router.get('/', ...readAccess, fnfListQueryValidator, listSettlements);

// ── §21 — the bulk register ────────────────────────────────────────────────
router.get('/register', ...readAccess, fnfExportQueryValidator, exportRegister);
router.post(
  '/register/export',
  ...writeAccess('FINAL_SETTLEMENT_READ'),
  fnfExportQueryValidator,
  requestRegister,
);
router.get('/files', ...readAccess, fnfMonthQueryValidator, listFiles);
router.get('/files/:fileId', ...readAccess, settlementFileIdParamValidator, downloadFile);

// ── §5 — open a settlement from the Exit module ────────────────────────────
router.post('/', ...writeAccess('FINAL_SETTLEMENT_CALCULATE'), createSettlementValidator, createSettlement);

// ── §7 … §17 — one settlement ──────────────────────────────────────────────
router.get('/:settlementId', ...readAccess, settlementIdParamValidator, getSettlement);
router.post(
  '/:settlementId/calculate',
  ...writeAccess('FINAL_SETTLEMENT_CALCULATE'),
  settlementIdParamValidator,
  calculateSettlement,
);
router.patch(
  '/:settlementId/items',
  ...writeAccess('FINAL_SETTLEMENT_CALCULATE'),
  settlementIdParamValidator,
  updateItemsValidator,
  updateItems,
);
router.patch(
  '/:settlementId/notice',
  ...writeAccess('FINAL_SETTLEMENT_CALCULATE'),
  settlementIdParamValidator,
  noticeDecisionValidator,
  setNoticeDecision,
);

// §15 — HR review.
router.post(
  '/:settlementId/hr-review',
  ...writeAccess('FINAL_SETTLEMENT_REVIEW'),
  settlementIdParamValidator,
  hrReviewValidator,
  hrReview,
);

// §13 — Finance records a recovery for an asset that was not returned. Gated
// on APPROVE, because it is Finance's stage; the payload allows a recovery and
// nothing else (§9: amount + reason, and the actor is the approver).
router.post(
  '/:settlementId/recoveries',
  ...writeAccess('FINAL_SETTLEMENT_APPROVE'),
  settlementIdParamValidator,
  addRecoveryValidator,
  addRecovery,
);

// §16 — Finance approval / rejection.
router.post(
  '/:settlementId/finance',
  ...writeAccess('FINAL_SETTLEMENT_APPROVE'),
  settlementIdParamValidator,
  financeDecisionValidator,
  financeDecision,
);

// §5 — payment.
router.post(
  '/:settlementId/pay',
  ...writeAccess('FINAL_SETTLEMENT_PAY'),
  settlementIdParamValidator,
  markPaidValidator,
  markPaid,
);

// §17 — the F&F statement.
router.post(
  '/:settlementId/statement',
  ...writeAccess('FINAL_SETTLEMENT_CALCULATE'),
  settlementIdParamValidator,
  requestStatement,
);
router.get(
  '/:settlementId/statement/download',
  ...readAccess,
  settlementIdParamValidator,
  downloadStatement,
);

// §14 — close and reopen.
router.post(
  '/:settlementId/close',
  ...writeAccess('FINAL_SETTLEMENT_CLOSE'),
  settlementIdParamValidator,
  closeSettlement,
);
router.post(
  '/:settlementId/reopen',
  ...writeAccess('FINAL_SETTLEMENT_REOPEN'),
  settlementIdParamValidator,
  reopenValidator,
  reopenSettlement,
);

export default router;
