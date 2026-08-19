import { Router } from 'express';
import {
  punchIn,
  punchOut,
  getMyToday,
  getMyAttendance,
  getCompanyAttendance,
  getMonthlyReport,
} from '../controllers/attendanceController.js';
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