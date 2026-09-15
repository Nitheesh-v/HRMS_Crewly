// ─────────────────────────────────────────────────────────────
// Phase 31.8 — overtime / comp-off routes.
// Mounted at /api/attendance/overtime (see routes/index.js),
// BEFORE the generic /attendance router so no literal path is
// swallowed. Attendance is core HR (like punching itself):
// subscription status is checked, but no plan FEATURE gate.
// Reads never mutate: submit/approve/reject/cancel are POST-only.
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
  approveAttendanceOvertime,
  cancelAttendanceOvertime,
  getAttendanceOvertime,
  getOvertimeEligibility,
  listMyAttendanceOvertime,
  listPendingAttendanceOvertime,
  rejectAttendanceOvertime,
  submitAttendanceOvertime,
} from '../controllers/attendanceOvertimeController.js';
import {
  overtimeApproveValidator,
  overtimeCancelValidator,
  overtimeCreateValidator,
  overtimeEligibilityValidator,
  overtimeIdValidator,
  overtimeRejectValidator,
} from '../validators/attendanceOvertimeValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// Employee self-service. Literal paths first so /mine, /pending
// and /eligibility are never captured as :requestId.
router.get(
  '/eligibility',
  requirePermission('ATTENDANCE_OVERTIME_REQUEST'),
  overtimeEligibilityValidator,
  getOvertimeEligibility,
);

router.post(
  '/',
  checkWriteAccess,
  requirePermission('ATTENDANCE_OVERTIME_REQUEST'),
  overtimeCreateValidator,
  submitAttendanceOvertime,
);

router.get(
  '/mine',
  requirePermission('ATTENDANCE_OVERTIME_REQUEST'),
  listMyAttendanceOvertime,
);

router.get(
  '/pending',
  requirePermission('ATTENDANCE_OVERTIME_REVIEW'),
  listPendingAttendanceOvertime,
);

router.get(
  '/:requestId',
  requirePermission('ATTENDANCE_OVERTIME_REQUEST'),
  overtimeIdValidator,
  getAttendanceOvertime,
);

router.post(
  '/:requestId/cancel',
  checkWriteAccess,
  requirePermission('ATTENDANCE_OVERTIME_REQUEST'),
  overtimeCancelValidator,
  cancelAttendanceOvertime,
);

router.post(
  '/:requestId/approve',
  checkWriteAccess,
  requirePermission('ATTENDANCE_OVERTIME_REVIEW'),
  overtimeApproveValidator,
  approveAttendanceOvertime,
);

router.post(
  '/:requestId/reject',
  checkWriteAccess,
  requirePermission('ATTENDANCE_OVERTIME_REVIEW'),
  overtimeRejectValidator,
  rejectAttendanceOvertime,
);

export default router;
