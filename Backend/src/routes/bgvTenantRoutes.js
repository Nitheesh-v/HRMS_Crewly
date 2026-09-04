// ============================================================
//  PHASE 30.1.1 — TENANT BGV surface (read-only summary ONLY)
//
//  This used to be the 30.1 tenant verifier family (/api/bgv/
//  checks*: assign, status, evidence, extend-sla, reopen). All of
//  that is GONE — verification is Crewly-platform operated and
//  lives at /api/super-admin/bgv. What tenants keep here is the
//  single progress chip feed the spec allows:
//
//    GET /api/bgv/cases/:caseId/checks-summary
//        → [{ checkType, status, updatedAt }]
//
//  Guard chain mirrors the 27.15 recruitment family exactly
//  (tenant session + subscription + feature flag + the case-read
//  permission), so anyone who can open the case can see how far
//  Crewly is — nothing more. Any other /api/bgv/* path 404s:
//  the verifier routes were deleted, which is stronger than 403.
// ============================================================

import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import { requirePermission } from '../middlewares/permissionMiddleware.js';
import { bgvCaseChecksSummary } from '../controllers/backgroundVerificationController.js';
import { bgvSeedRules } from '../validators/bgvCheckValidator.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus,
  requireFeature('recruitment')
);

// The caseId param validator from 30.1 also fits this route (it
// checks `param('caseId').isMongoId()`); reusing it keeps the
// validation story in one file.
router.get(
  '/cases/:caseId/checks-summary',
  requirePermission('BACKGROUND_VERIFICATION_READ'),
  bgvSeedRules,
  bgvCaseChecksSummary
);

export default router;
