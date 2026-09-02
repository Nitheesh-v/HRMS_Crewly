// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — PAYROLL ANALYTICS ROUTES
//
//  Mounted at /api/payroll/analytics (see routes/index.js).
//
//  Gates (§4 / §25):
//    · READ      PAYROLL_REPORT_READ          every report except CTC
//    · EXPORT    PAYROLL_REPORT_EXPORT        downloads and queued exports
//    · FINANCIAL PAYROLL_ANALYTICS_FINANCIAL  the §16 CTC report (Finance only)
//    · SCHEDULE  PAYROLL_ANALYTICS_SCHEDULE   §20 standing instructions
//
//  §4 — Employee: no access. There is no /mine route here at all, and no
//  employee permission grants one.
//
//  Every route also passes analyticsScope, which narrows the rows to the
//  actor's 29.1 payroll visibility — so a department-scoped manager cannot
//  have the whole company's payroll cost totalled for them.
// ═══════════════════════════════════════════════════════════════════════════
import express from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { requireAnyPermission, requirePermission } from '../middlewares/permissionMiddleware.js';
import { checkWriteAccess, requireFeature } from '../middlewares/subscriptionAccess.js';
import analyticsScope from '../middlewares/analyticsScope.js';

import {
  createSchedule,
  deleteSchedule,
  downloadFile,
  exportReport,
  getAnalyticsSettings,
  getDashboard,
  getEmployeeHistory,
  getMySalaryHistory,
  getReport,
  listFiles,
  listSchedules,
  refreshDashboard,
  requestExport,
  updateSalaryBands,
  updateSchedule,
} from '../controllers/analyticsController.js';

import {
  analyticsDashboardValidator,
  analyticsEmployeeIdParamValidator,
  analyticsExportBodyValidator,
  analyticsExportQueryValidator,
  analyticsFileIdParamValidator,
  analyticsFilesQueryValidator,
  analyticsReportQueryValidator,
  analyticsSalaryBandsValidator,
  analyticsScheduleIdParamValidator,
  createScheduleValidator,
  refreshDashboardValidator,
  updateScheduleValidator,
} from '../validators/analyticsValidator.js';

const router = express.Router();

router.use(protect, tenantContext);

// §4 — anyone who may read a payroll report may read the dashboards.
const readAccess = [
  requireAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']),
  requireFeature('payroll'),
  analyticsScope,
];

const exportAccess = [
  checkWriteAccess,
  requirePermission('PAYROLL_REPORT_EXPORT'),
  requireFeature('payroll'),
  analyticsScope,
];

// §22 — warming the executive dashboard is a cache refresh, not a standing
// instruction, so anyone who may READ the reports may ask for it. It still
// needs write access: a lapsed subscription should not be able to queue work.
const refreshAccess = [
  checkWriteAccess,
  requireAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL']),
  requireFeature('payroll'),
  analyticsScope,
];

const scheduleAccess = [
  checkWriteAccess,
  requirePermission('PAYROLL_ANALYTICS_SCHEDULE'),
  requireFeature('payroll'),
  analyticsScope,
];

// §8 — editing the salary bands is payroll configuration, not a report read:
// it changes what every future distribution report says. It rides the same
// verb as scheduling, which is already "configure analytics", rather than
// minting a new permission for one field.
const configureAccess = [
  checkWriteAccess,
  requirePermission('PAYROLL_ANALYTICS_SCHEDULE'),
  requireFeature('payroll'),
  analyticsScope,
];

// §23 — an employee's salary history is the READ of a person's salary, which
// EMPLOYEE_SALARY_READ already covers; no new permission, no v26 → v27
// migration. The analytics verb is the other way in.
const salaryHistoryAccess = [
  requireAnyPermission(['PAYROLL_REPORT_READ', 'EMPLOYEE_SALARY_READ']),
  requireFeature('payroll'),
  analyticsScope,
];

// ── §5 / §6 — the executive dashboard ──────────────────────────────────────
router.get('/dashboard', ...readAccess, analyticsDashboardValidator, getDashboard);

// ── §22 — executive dashboard refresh ──────────────────────────────────────
router.post('/refresh', ...refreshAccess, refreshDashboardValidator, refreshDashboard);

// ── §19 — generated files ──────────────────────────────────────────────────
router.get('/files', ...readAccess, analyticsFilesQueryValidator, listFiles);
router.get('/files/:fileId', ...readAccess, analyticsFileIdParamValidator, downloadFile);

// ── §23 — salary history ───────────────────────────────────────────────────
// `/mine` is declared before `/:employeeId` so "mine" can never be read as
// an id. It is gated by nothing but being logged in: an employee reading
// their own history is the one thing §2 allows them here.
router.get('/employee-history/mine', requireFeature('payroll'), getMySalaryHistory);
router.get('/employee-history/:employeeId', ...salaryHistoryAccess, analyticsEmployeeIdParamValidator, getEmployeeHistory);

// ── §8 — the company's own salary bands ────────────────────────────────────
router.get('/settings', ...readAccess, getAnalyticsSettings);
router.patch('/settings/bands', ...configureAccess, analyticsSalaryBandsValidator, updateSalaryBands);

// ── §20 — scheduled reports ────────────────────────────────────────────────
router.get('/schedules', ...scheduleAccess, listSchedules);
router.post('/schedules', ...scheduleAccess, createScheduleValidator, createSchedule);
router.patch('/schedules/:scheduleId', ...scheduleAccess, updateScheduleValidator, updateSchedule);
router.delete('/schedules/:scheduleId', ...scheduleAccess, analyticsScheduleIdParamValidator, deleteSchedule);

// ── §19 — exports ──────────────────────────────────────────────────────────
// Declared before /:reportKey so `/export` can never be read as a report key.
router.get('/export/:reportKey', ...readAccess, analyticsExportQueryValidator, exportReport);
router.post('/export/:reportKey', ...exportAccess, analyticsExportBodyValidator, requestExport);

// ── §6 … §17 — one report ──────────────────────────────────────────────────
router.get('/:reportKey', ...readAccess, analyticsReportQueryValidator, getReport);

export default router;
