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
  getAttendanceOperations,
} from '../controllers/attendanceOperationsController.js';
import {
  downloadTeamTimesheets,
  getMyTimesheetMonth,
  getScopedEmployeeTimesheet,
  getTeamTimesheetTable,
} from '../controllers/attendanceTimesheetController.js';
import {
  finalizeAttendanceMonth,
  getFinalization,
  previewFinalizationMonth,
  reopenAttendanceMonth,
  sendAttendanceToPayroll,
  validateFinalizationMonth,
} from '../controllers/attendanceFinalizationController.js';
import { attendanceEventValidator } from '../validators/attendanceEventValidator.js';
import {
  getImportById,
  getImports,
  getImportTemplate,
  postImportConfirm,
  postImportPreview,
} from '../controllers/attendanceImportController.js';
import {
  getKioskPin,
  getStations,
  patchStation,
  postKioskPin,
  postKioskPinClear,
  postStation,
  postStationRotate,
} from '../controllers/attendanceKioskController.js';
import {
  postChallenge,
  postRedeem,
  postResolve,
} from '../controllers/attendanceQrController.js';
import {
  importIdValidator,
  kioskPinClearValidator,
  kioskPinSetValidator,
  kioskStationIdValidator,
  kioskStationPatchValidator,
  kioskStationValidator,
  qrChallengeValidator,
  qrRedeemValidator,
  qrTokenValidator,
} from '../validators/attendanceCaptureValidator.js';
import { csvUpload } from '../middlewares/uploadMiddleware.js';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import {
  getAnalyticsEmployees,
  getAnalyticsExport,
  getAnalyticsMine,
  getAnalyticsOverview,
  getAnalyticsRecon,
  getAnalyticsTrends,
} from '../controllers/attendanceAnalyticsController.js';
import {
  analyticsEmployeesValidator,
  analyticsExportValidator,
  analyticsMineValidator,
  analyticsOverviewValidator,
  analyticsReconValidator,
  analyticsTrendsValidator,
} from '../validators/attendanceAnalyticsValidator.js';
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

// Phase 31.12 — HR attendance operations dashboard (read-only).
// HR/Admin-only operations permission (managers keep the scoped
// 31.9 board); company vs team scope still derives backend-side
// in the operations service via 31.9.
router.get(
  '/operations',
  requirePermission(
    'ATTENDANCE_OPERATIONS_READ'
  ),
  getAttendanceOperations
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

// Phase 31.11 — Monthly attendance finalization & payroll sync.
// Company-level authority: READ views status/validation/preview,
// MANAGE finalizes + sends, REOPEN reopens. Org scope never
// applies — finalization always covers the whole company month.
router.get(
  '/finalization/:month',
  requirePermission(
    'ATTENDANCE_FINALIZATION_READ'
  ),
  getFinalization
);

router.get(
  '/finalization/:month/validate',
  requirePermission(
    'ATTENDANCE_FINALIZATION_READ'
  ),
  validateFinalizationMonth
);

router.get(
  '/finalization/:month/preview',
  requirePermission(
    'ATTENDANCE_FINALIZATION_READ'
  ),
  previewFinalizationMonth
);

router.post(
  '/finalization/:month/finalize',
  requirePermission(
    'ATTENDANCE_FINALIZATION_MANAGE'
  ),
  finalizeAttendanceMonth
);

router.post(
  '/finalization/:month/send-to-payroll',
  requirePermission(
    'ATTENDANCE_FINALIZATION_MANAGE'
  ),
  sendAttendanceToPayroll
);

router.post(
  '/finalization/:month/reopen',
  requirePermission(
    'ATTENDANCE_FINALIZATION_REOPEN'
  ),
  reopenAttendanceMonth
);

// ─────────────────────────────────────────────────────────────
// Phase 31.14 — alternate capture (HR setup + self-service QR).
// Kiosk punch endpoints live on the separate /api/kiosk router
// (kioskAuth trust boundary); only station MANAGEMENT (HR) sits
// here. QR redemption reuses self-service attendance permissions.
// ─────────────────────────────────────────────────────────────

// Kiosk stations (HR).
router.post(
  '/kiosks',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  kioskStationValidator,
  postStation
);

router.get(
  '/kiosks',
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  getStations
);

router.patch(
  '/kiosks/:id',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  kioskStationPatchValidator,
  patchStation
);

router.post(
  '/kiosks/:id/rotate-secret',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  kioskStationIdValidator,
  postStationRotate
);

// ── 31.14 completion — Kiosk PIN self-service ────────────────
// Set/change ride the employee's own session (self-punch
// permission — whoever can punch can enroll a terminal PIN).
// HR can only CLEAR (force fresh setup), never view.
const kioskPinRateLimit = securityRateLimit({
  sharedName: 'kiosk-pin-manage',
  windowMs: 60000,
  maximum: 10,
  keyGenerator: (req) => `${req.ip}:kiosk-pin:${req.companyId}:${req.user?._id || ''}`,
  message: 'Too many Kiosk PIN attempts. Please try again shortly.',
});

router.get(
  '/kiosk-pin',
  requirePermission(
    'ATTENDANCE_CREATE_SELF'
  ),
  getKioskPin
);

router.post(
  '/kiosk-pin',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CREATE_SELF'
  ),
  kioskPinRateLimit,
  kioskPinSetValidator,
  postKioskPin
);

router.post(
  '/kiosk-pin/clear',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  kioskPinClearValidator,
  postKioskPinClear
);

// QR challenges (HR issues; employees resolve + redeem).
router.post(
  '/qr/challenges',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  qrChallengeValidator,
  postChallenge
);

router.post(
  '/qr/resolve',
  requirePermission(
    'ATTENDANCE_READ_SELF'
  ),
  qrTokenValidator,
  postResolve
);

router.post(
  '/qr/redeem',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CREATE_SELF'
  ),
  qrRedeemValidator,
  postRedeem
);

// CSV imports (HR; multipart file, memory only).
router.post(
  '/imports/preview',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  csvUpload,
  postImportPreview
);

router.post(
  '/imports/confirm',
  checkWriteAccess,
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  csvUpload,
  postImportConfirm
);

router.get(
  '/imports',
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  getImports
);

router.get(
  '/imports/template.csv',
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  getImportTemplate
);

router.get(
  '/imports/:id',
  requirePermission(
    'ATTENDANCE_CAPTURE_MANAGE'
  ),
  importIdValidator,
  getImportById
);

// ─────────────────────────────────────────────────────────────
// Phase 31.15 — historical attendance reporting & analytics.
// Read-only GETs. Analytics permission gates company/team reads
// (service enforces org scope); self analytics reuses READ_SELF.
// ─────────────────────────────────────────────────────────────

router.get(
  '/analytics/overview',
  requirePermission(
    'ATTENDANCE_ANALYTICS_READ'
  ),
  analyticsOverviewValidator,
  getAnalyticsOverview
);

router.get(
  '/analytics/trends',
  requirePermission(
    'ATTENDANCE_ANALYTICS_READ'
  ),
  analyticsTrendsValidator,
  getAnalyticsTrends
);

router.get(
  '/analytics/employees',
  requirePermission(
    'ATTENDANCE_ANALYTICS_READ'
  ),
  analyticsEmployeesValidator,
  getAnalyticsEmployees
);

// Declared before /analytics/payroll-reconciliation siblings so
// no report path is shadowed; self analytics needs no analytics
// permission (identity is the session itself).
router.get(
  '/analytics/mine',
  requirePermission(
    'ATTENDANCE_READ_SELF'
  ),
  analyticsMineValidator,
  getAnalyticsMine
);

router.get(
  '/analytics/payroll-reconciliation',
  requirePermission(
    'ATTENDANCE_ANALYTICS_READ'
  ),
  analyticsReconValidator,
  getAnalyticsRecon
);

router.get(
  '/analytics/export',
  requirePermission(
    'ATTENDANCE_ANALYTICS_READ'
  ),
  analyticsExportValidator,
  getAnalyticsExport
);

export default router;