// ─────────────────────────────────────────────────────────────
// Phase 31.4 — work-mode request routes.
// Mounted at /api/attendance/work-mode-requests (see routes/index.js),
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
  approveAttendanceWorkModeRequest,
  cancelAttendanceWorkModeRequest,
  getAttendanceWorkModeRequest,
  listMyAttendanceWorkModeRequests,
  listPendingAttendanceWorkModeRequests,
  rejectAttendanceWorkModeRequest,
  submitAttendanceWorkModeRequest,
} from '../controllers/attendanceWorkModeController.js';
import {
  workModeRequestCreateValidator,
  workModeRequestDecideValidator,
  workModeRequestIdValidator,
} from '../validators/attendanceWorkModeValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// Employee self-service. Literal paths first so /mine and /pending
// are never captured as :requestId.
router.post(
  '/',
  checkWriteAccess,
  requirePermission('ATTENDANCE_WORK_MODE_REQUEST'),
  workModeRequestCreateValidator,
  submitAttendanceWorkModeRequest,
);

router.get(
  '/mine',
  requirePermission('ATTENDANCE_WORK_MODE_REQUEST'),
  listMyAttendanceWorkModeRequests,
);

router.get(
  '/pending',
  requirePermission('ATTENDANCE_WORK_MODE_REVIEW'),
  listPendingAttendanceWorkModeRequests,
);

router.get(
  '/:requestId',
  requirePermission('ATTENDANCE_WORK_MODE_REQUEST'),
  workModeRequestIdValidator,
  getAttendanceWorkModeRequest,
);

router.post(
  '/:requestId/cancel',
  checkWriteAccess,
  requirePermission('ATTENDANCE_WORK_MODE_REQUEST'),
  workModeRequestIdValidator,
  cancelAttendanceWorkModeRequest,
);

router.post(
  '/:requestId/approve',
  checkWriteAccess,
  requirePermission('ATTENDANCE_WORK_MODE_REVIEW'),
  workModeRequestDecideValidator,
  approveAttendanceWorkModeRequest,
);

router.post(
  '/:requestId/reject',
  checkWriteAccess,
  requirePermission('ATTENDANCE_WORK_MODE_REVIEW'),
  workModeRequestDecideValidator,
  rejectAttendanceWorkModeRequest,
);

export default router;
