// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST ROUTES
//
//  Mounted at /api/presence/work-location-requests. Self-service and
//  reviewer endpoints share the same router; literal paths come first
//  so /me and /pending are never captured as :requestId.
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from 'express';

import { protect } from '../../middlewares/authMiddleware.js';
import { tenantContext } from '../../middlewares/tenantMiddleware.js';
import { requirePermission } from '../../middlewares/permissionMiddleware.js';

import {
  approveWorkLocationRequest,
  cancelWorkLocationRequest,
  getWorkLocationRequest,
  listMyWorkLocationRequests,
  listPendingWorkLocationRequests,
  rejectWorkLocationRequest,
  submitWorkLocationRequest,
} from '../../controllers/presence/workLocationRequestController.js';

import {
  workLocationRequestDecideValidator,
  workLocationRequestIdParamValidator,
  workLocationRequestSubmitValidator,
} from '../../validators/presence/workLocationRequestValidator.js';

const router = Router();

router.use(protect, tenantContext);

// Employee self-service. Reads do not require a permission gate —
// the service enforces the scope.
router.post(
  '/',
  requirePermission('PRESENCE_WORK_MODE_REQUEST'),
  workLocationRequestSubmitValidator,
  submitWorkLocationRequest,
);

router.get('/me', listMyWorkLocationRequests);

router.get(
  '/pending',
  requirePermission('PRESENCE_WORK_MODE_REVIEW'),
  listPendingWorkLocationRequests,
);

router.get(
  '/:requestId',
  workLocationRequestIdParamValidator,
  getWorkLocationRequest,
);

router.post(
  '/:requestId/cancel',
  requirePermission('PRESENCE_WORK_MODE_REQUEST'),
  workLocationRequestIdParamValidator,
  cancelWorkLocationRequest,
);

router.post(
  '/:requestId/approve',
  requirePermission('PRESENCE_WORK_MODE_REVIEW'),
  workLocationRequestDecideValidator,
  approveWorkLocationRequest,
);

router.post(
  '/:requestId/reject',
  requirePermission('PRESENCE_WORK_MODE_REVIEW'),
  workLocationRequestDecideValidator,
  rejectWorkLocationRequest,
);

export default router;
