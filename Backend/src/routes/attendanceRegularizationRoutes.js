// ─────────────────────────────────────────────────────────────
// Phase 31.5 — attendance regularization routes.
// Mounted at /api/attendance/regularizations (see routes/index.js),
// BEFORE the generic /attendance router so no literal path is
// swallowed. Attendance is core HR (like punching itself):
// subscription status is checked, but no plan FEATURE gate.
// Reads never mutate: approve/reject/cancel are POST-only.
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import { requirePermission } from '../middlewares/permissionMiddleware.js';
import {
  approveAttendanceRegularization,
  cancelAttendanceRegularization,
  getAttendanceRegularization,
  listMyAttendanceRegularizations,
  listPendingAttendanceRegularizations,
  rejectAttendanceRegularization,
  submitAttendanceRegularization,
} from '../controllers/attendanceRegularizationController.js';
import {
  regularizationCreateValidator,
  regularizationDecideValidator,
  regularizationIdValidator,
} from '../validators/attendanceRegularizationValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// Employee self-service. Literal paths first so /mine and /pending
// are never captured as :requestId.
router.post(
  '/',
  checkWriteAccess,
  requirePermission('ATTENDANCE_REGULARIZATION_REQUEST'),
  regularizationCreateValidator,
  submitAttendanceRegularization,
);

router.get(
  '/mine',
  requirePermission('ATTENDANCE_REGULARIZATION_REQUEST'),
  listMyAttendanceRegularizations,
);

router.get(
  '/pending',
  requirePermission('ATTENDANCE_REGULARIZATION_REVIEW'),
  listPendingAttendanceRegularizations,
);

router.get(
  '/:requestId',
  requirePermission('ATTENDANCE_REGULARIZATION_REQUEST'),
  regularizationIdValidator,
  getAttendanceRegularization,
);

router.post(
  '/:requestId/cancel',
  checkWriteAccess,
  requirePermission('ATTENDANCE_REGULARIZATION_REQUEST'),
  regularizationIdValidator,
  cancelAttendanceRegularization,
);

router.post(
  '/:requestId/approve',
  checkWriteAccess,
  requirePermission('ATTENDANCE_REGULARIZATION_REVIEW'),
  regularizationDecideValidator,
  approveAttendanceRegularization,
);

router.post(
  '/:requestId/reject',
  checkWriteAccess,
  requirePermission('ATTENDANCE_REGULARIZATION_REVIEW'),
  regularizationDecideValidator,
  rejectAttendanceRegularization,
);

export default router;
