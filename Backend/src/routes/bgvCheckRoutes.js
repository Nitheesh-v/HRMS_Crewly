// ============================================================
//  PHASE 30.1 / 30.1.1 — BGV CHECK FRAMEWORK routes (platform)
//
//  Mounted INSIDE /api/super-admin (superAdminRoutes) — protect +
//  superAdminSession already applied there; every route below
//  adds permit(). Verification is Crewly-team only:
//    bgv:read   — queue, detail, evidence view, stats
//    bgv:verify — status, evidence, extend-SLA (any check)
//    bgv:assign — assign/reassign, reopen, seed
//  /checks/stats and /checks/mine are declared BEFORE /checks/:id
//  so they are not swallowed by the MongoId param route.
// ============================================================

import { Router } from 'express';
import { permit } from '../middlewares/superAdminAuth.js';
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
  bgvVerifierList,
} from '../controllers/bgvCheckController.js';
import {
  bgvCheckAssignRules,
  bgvCheckIdRules,
  bgvCheckListRules,
  bgvCheckStatusRules,
  bgvEvidenceRules,
  bgvExtendSlaRules,
  bgvReopenRules,
  bgvSeedRules,
} from '../validators/bgvCheckValidator.js';

const router = Router();

router.get('/checks', permit('bgv:read'), bgvCheckListRules, bgvCheckList);
router.get('/checks/stats', permit('bgv:read'), bgvCheckListRules, bgvCheckStats);
router.get('/checks/mine', permit('bgv:read'), bgvCheckListRules, bgvCheckMine);
router.get('/checks/verifiers', permit('bgv:assign'), bgvVerifierList);
router.get('/checks/:checkId', permit('bgv:read'), bgvCheckIdRules, bgvCheckDetail);
router.get(
  '/checks/:checkId/evidence/:evidenceId',
  permit('bgv:read'),
  bgvCheckIdRules,
  bgvCheckEvidenceDownload
);

// Verify work (BGV_TEAM + admins); queue operations need bgv:assign.
router.post(
  '/checks/:checkId/status',
  permit('bgv:verify', 'bgv:assign'),
  bgvCheckStatusRules,
  bgvCheckStatusUpdate
);
router.post(
  '/checks/:checkId/evidence',
  permit('bgv:verify', 'bgv:assign'),
  bgvEvidenceUpload,
  bgvEvidenceRules,
  bgvCheckEvidenceAdd
);
router.post(
  '/checks/:checkId/extend-sla',
  permit('bgv:verify', 'bgv:assign'),
  bgvExtendSlaRules,
  bgvCheckExtendSla
);

// Operations: queue management (Crewly admins only).
router.post('/checks/:checkId/assign', permit('bgv:assign'), bgvCheckAssignRules, bgvCheckAssign);
router.post('/checks/:checkId/reopen', permit('bgv:assign'), bgvReopenRules, bgvCheckReopen);
router.post('/cases/:caseId/seed-checks', permit('bgv:assign'), bgvSeedRules, bgvCaseSeedChecks);

export default router;
