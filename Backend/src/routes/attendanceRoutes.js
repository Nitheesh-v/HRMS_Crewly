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
import {
  getPresence,
} from '../controllers/attendancePresenceController.js';
import {
  downloadTeamTimesheets,
  getMyTimesheetMonth,
  getScopedEmployeeTimesheet,
  getTeamTimesheetTable,
} from '../controllers/attendanceTimesheetController.js';
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

// Phase 31.9 — Who's Working live board. Same scoped oversight
// permission as the register/report above (no new permission);
// org scope is derived backend-side in the presence service.
router.get(
  '/presence',
  requirePermission(
    'ATTENDANCE_READ'
  ),
  getPresence
);

// Phase 31.10 — Attendance calendar & timesheets (read-only).
// Self month for every employee; team table, scoped drill-down
// and CSV export under the same oversight permission as the
// register/report/presence above (no new permission). Org scope
// is derived backend-side in the timesheet service.
router.get(
  '/timesheets/mine',
  requireAnyPermission([
    'ATTENDANCE_READ_SELF',
    'ATTENDANCE_READ',
  ]),
  getMyTimesheetMonth
);

router.get(
  '/timesheets/team',
  requirePermission(
    'ATTENDANCE_READ'
  ),
  getTeamTimesheetTable
);

router.get(
  '/timesheets/export',
  requirePermission(
    'ATTENDANCE_READ'
  ),
  downloadTeamTimesheets
);

router.get(
  '/timesheets/employee/:employeeId',
  requirePermission(
    'ATTENDANCE_READ'
  ),
  getScopedEmployeeTimesheet
);

export default router;