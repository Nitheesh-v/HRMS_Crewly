// ============================================================
//  PHASE 30.1 — BGV CHECK FRAMEWORK routes
//
//  Mounted at /api/bgv (routes/index.js). No collision with the
//  27.15 family under /api/recruitment/background-verification*.
//  /checks/stats and /checks/mine are declared BEFORE /checks/:id
//  so they are not swallowed by the MongoId param route.
// ============================================================

import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import { requirePermission } from '../middlewares/permissionMiddleware.js';
import { bgvEvidenceUpload } from '../middlewares/bgvEvidenceUpload.js';
import {
  bgvCaseSeedChecks,
  bgvCheckAssign,
  bgvCheckDetail,
  bgvCheckEvidenceAdd,
  bgvCheckEvidenceDownload,
  bgvCheckExtendSla,
  bgvCheckList,
  bgvCheckMine,
  bgvCheckReopen,
  bgvCheckStats,
  bgvCheckStatusUpdate,
} from '../controllers/bgvCheckController.js';
import {
  bgvCaseIdRules,
} from '../validators/backgroundVerificationValidator.js';
import {
  bgvCheckAssignRules,
  bgvCheckIdRules,
  bgvCheckListRules,
  bgvCheckStatusRules,
  bgvEvidenceRules,
  bgvExtendSlaRules,
  bgvReopenRules,
} from '../validators/bgvCheckValidator.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus,
  requireFeature('recruitment')
);

router.get(
  '/checks',
  requirePermission('BGV_CHECK_READ'),
  bgvCheckListRules,
  bgvCheckList
);
router.get(
  '/checks/stats',
  requirePermission('BGV_CHECK_READ'),
  bgvCheckStats
);
router.get(
  '/checks/mine',
  requirePermission('BGV_CHECK_READ'),
  bgvCheckListRules,
  bgvCheckMine
);
router.get(
  '/checks/:checkId',
  requirePermission('BGV_CHECK_READ'),
  bgvCheckIdRules,
  bgvCheckDetail
);
router.get(
  '/checks/:checkId/evidence/:evidenceId',
  requirePermission('BGV_CHECK_READ'),
  bgvCheckIdRules,
  bgvCheckEvidenceDownload
);
router.post(
  '/checks/:checkId/assign',
  checkWriteAccess,
  requirePermission('BGV_CHECK_ASSIGN'),
  bgvCheckAssignRules,
  bgvCheckAssign
);
router.post(
  '/checks/:checkId/status',
  checkWriteAccess,
  requirePermission('BGV_CHECK_VERIFY'),
  bgvCheckStatusRules,
  bgvCheckStatusUpdate
);
router.post(
  '/checks/:checkId/evidence',
  checkWriteAccess,
  requirePermission('BGV_EVIDENCE_MANAGE'),
  bgvEvidenceUpload,
  bgvEvidenceRules,
  bgvCheckEvidenceAdd
);
router.post(
  '/checks/:checkId/extend-sla',
  checkWriteAccess,
  requirePermission('BGV_CHECK_VERIFY'),
  bgvExtendSlaRules,
  bgvCheckExtendSla
);
router.post(
  '/checks/:checkId/reopen',
  checkWriteAccess,
  requirePermission('BGV_CHECK_REOPEN'),
  bgvReopenRules,
  bgvCheckReopen
);
router.post(
  '/cases/:caseId/seed-checks',
  checkWriteAccess,
  requirePermission('BGV_CHECK_ASSIGN'),
  bgvCaseIdRules,
  bgvCaseSeedChecks
);

export default router;
