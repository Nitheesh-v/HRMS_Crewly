import { Router } from 'express';
import {
  punchIn,
  punchOut,
  getMyToday,
  getMyAttendance,
  getCompanyAttendance,
  getMonthlyReport,
} from '../controllers/attendanceController.js';
import {
  getTodayLive,
  postEvent,
} from '../controllers/attendanceEventController.js';
import { attendanceEventValidator } from '../validators/attendanceEventValidator.js';
import { protect } from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus
);

// Self attendance.
router.post(
  '/punch-in',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CREATE_SELF'
  ),
  punchIn
);

router.post(
  '/punch-out',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CREATE_SELF'
  ),
  punchOut
);

router.get(
  '/today',
  requireAnyPermission([
    'ATTENDANCE_READ_SELF',
    'ATTENDANCE_READ',
  ]),
  getMyToday
);

// Phase 31.2 — advanced self-service punching. Reuses the established
// self-attendance permissions; no new permissions introduced.
router.post(
  '/events',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CREATE_SELF'
  ),
  attendanceEventValidator,
  postEvent
);

router.get(
  '/today/live',
  requireAnyPermission([
    'ATTENDANCE_READ_SELF',
    'ATTENDANCE_READ',
  ]),
  getTodayLive
);

router.get(
  '/my',
  requireAnyPermission([
    'ATTENDANCE_READ_SELF',
    'ATTENDANCE_READ',
  ]),
  getMyAttendance
);

// Company/team oversight.
// Existing controllers still enforce company/subtree scope.
router.get(
  '/company',
  requirePermission(
    'ATTENDANCE_READ'
  ),
  getCompanyAttendance
);

router.get(
  '/report',
  requirePermission(
    'ATTENDANCE_READ'
  ),
  getMonthlyReport
);

export default router;