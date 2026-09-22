// ─────────────────────────────────────────────────────────────
// Phase 31.3 — Attendance Location routes.
// Mounted at /api/attendance/locations (see routes/index.js).
// Attendance is core HR (like punching itself): subscription status is
// checked, but no plan FEATURE gate — mirrors attendanceRoutes.
// There is intentionally no DELETE endpoint: locations with history
// are deactivated, never destroyed.
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { protect } from '../../middlewares/authMiddleware.js';
import { tenantContext } from '../../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../../middlewares/subscriptionAccess.js';
import { requirePermission } from '../../middlewares/permissionMiddleware.js';
import {
  activateAttendanceLocation,
  createAttendanceLocation,
  deactivateAttendanceLocation,
  getAttendanceLocation,
  getAttendanceLocations,
  getEligibleAttendanceLocations,
  updateAttendanceLocation,
} from '../../controllers/attendance/attendanceLocationController.js';
import {
  attendanceLocationCreateValidator,
  attendanceLocationIdValidator,
  attendanceLocationUpdateValidator,
} from '../../validators/attendance/attendanceLocationValidator.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

// Employee self-service: active locations, safe fields only. Defined
// before /:locationId so the literal path is never captured as an id.
router.get(
  '/eligible',
  requirePermission('ATTENDANCE_READ_SELF'),
  getEligibleAttendanceLocations,
);

router.get(
  '/',
  requirePermission('ATTENDANCE_LOCATION_READ'),
  getAttendanceLocations,
);

router.post(
  '/',
  checkWriteAccess,
  requirePermission('ATTENDANCE_LOCATION_MANAGE'),
  attendanceLocationCreateValidator,
  createAttendanceLocation,
);

router.get(
  '/:locationId',
  requirePermission('ATTENDANCE_LOCATION_READ'),
  attendanceLocationIdValidator,
  getAttendanceLocation,
);

router.put(
  '/:locationId',
  checkWriteAccess,
  requirePermission('ATTENDANCE_LOCATION_MANAGE'),
  attendanceLocationUpdateValidator,
  updateAttendanceLocation,
);

router.post(
  '/:locationId/activate',
  checkWriteAccess,
  requirePermission('ATTENDANCE_LOCATION_MANAGE'),
  attendanceLocationIdValidator,
  activateAttendanceLocation,
);

router.post(
  '/:locationId/deactivate',
  checkWriteAccess,
  requirePermission('ATTENDANCE_LOCATION_MANAGE'),
  attendanceLocationIdValidator,
  deactivateAttendanceLocation,
);

export default router;
