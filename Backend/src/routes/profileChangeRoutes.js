// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 38 — PROFILE CHANGE REQUEST ROUTES
//
//  Mounted at /api/profile/change-requests. NOTE the mount order in
//  routes/index.js: this router is registered BEFORE `/profile`, so the
//  literal `/change-requests/...` paths can never be swallowed by the older
//  profile router.
//
//  MIDDLEWARE CHAIN
//    protect            — identity from the access token (cookie or bearer)
//    tenantContext      — loads req.company + rejects suspended tenants
//    checkSubscriptionStatus — no writes for an expired subscription
//    checkWriteAccess   — mutation-only, same rule as every tenant module
//    requirePermission  — reviewer endpoints only ('PROFILE_CHANGE_REVIEW')
//
//  Literal paths come first (/me, /pending, /history) so they are never
//  captured as :requestId.
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import { requirePermission } from '../middlewares/permissionMiddleware.js';

import {
  approveProfileChangeRequest,
  cancelProfileChangeRequest,
  getProfileChangeRequest,
  listMyProfileChangeRequests,
  listPendingProfileChangeRequests,
  listProfileChangeHistory,
  rejectProfileChangeRequest,
  submitProfileChangeRequest,
} from '../controllers/profileChangeController.js';

import {
  profileChangeDecideValidator,
  profileChangeIdParamValidator,
  profileChangeSubmitValidator,
} from '../validators/profileChangeValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// ── Employee self-service ──────────────────────────────────────────────
// Submitting rides PROFILE_UPDATE_SELF (every role already holds it) — a
// new self permission would have to be granted to five roles for nothing.
router.post(
  '/',
  checkWriteAccess,
  requirePermission('PROFILE_UPDATE_SELF'),
  profileChangeSubmitValidator,
  submitProfileChangeRequest,
);

// Reads carry no permission gate: the service scopes them to req.user.
router.get('/me', listMyProfileChangeRequests);

// ── Reviewer queue (HR / Company Admin, org-scope enforced in service) ──
router.get(
  '/pending',
  requirePermission('PROFILE_CHANGE_REVIEW'),
  listPendingProfileChangeRequests,
);

router.get(
  '/history',
  requirePermission('PROFILE_CHANGE_REVIEW'),
  listProfileChangeHistory,
);

router.get(
  '/:requestId',
  profileChangeIdParamValidator,
  getProfileChangeRequest,
);

router.post(
  '/:requestId/cancel',
  checkWriteAccess,
  profileChangeIdParamValidator,
  cancelProfileChangeRequest,
);

router.post(
  '/:requestId/approve',
  checkWriteAccess,
  requirePermission('PROFILE_CHANGE_REVIEW'),
  profileChangeDecideValidator,
  approveProfileChangeRequest,
);

router.post(
  '/:requestId/reject',
  checkWriteAccess,
  requirePermission('PROFILE_CHANGE_REVIEW'),
  profileChangeDecideValidator,
  rejectProfileChangeRequest,
);

export default router;
