// ─────────────────────────────────────────────────────────────
// Phase 31.1 — Attendance Policy routes.
// Mounted at /api/attendance/policy (see routes/index.js).
// Attendance is core HR (like punching itself): subscription status is
// checked, but no plan FEATURE gate — mirrors attendanceRoutes.
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
  activateAttendancePolicy,
  getAttendancePolicy,
  getAttendancePolicyHistory,
  saveAttendancePolicyDraft,
} from '../controllers/attendancePolicyController.js';
import {
  attendancePolicyActivateValidator,
  attendancePolicyDraftValidator,
  attendancePolicyHistoryValidator,
} from '../validators/attendancePolicyValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

router.get(
  '/',
  requirePermission('ATTENDANCE_POLICY_READ'),
  getAttendancePolicy,
);

router.get(
  '/history',
  requirePermission('ATTENDANCE_POLICY_READ'),
  attendancePolicyHistoryValidator,
  getAttendancePolicyHistory,
);

router.post(
  '/draft',
  checkWriteAccess,
  requirePermission('ATTENDANCE_POLICY_MANAGE'),
  attendancePolicyDraftValidator,
  saveAttendancePolicyDraft,
);

router.post(
  '/activate',
  checkWriteAccess,
  requirePermission('ATTENDANCE_POLICY_ACTIVATE'),
  attendancePolicyActivateValidator,
  activateAttendancePolicy,
);

export default router;
