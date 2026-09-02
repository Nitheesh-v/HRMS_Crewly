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
  getDashboard,
  getReport,
  listFiles,
  listSchedules,
  refreshDashboard,
  requestExport,
  updateSchedule,
} from '../controllers/analyticsController.js';

import {
  analyticsDashboardValidator,
  analyticsExportBodyValidator,
  analyticsExportQueryValidator,
  analyticsFileIdParamValidator,
  analyticsFilesQueryValidator,
  analyticsReportQueryValidator,
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

// ── §5 / §6 — the executive dashboard ──────────────────────────────────────
router.get('/dashboard', ...readAccess, analyticsDashboardValidator, getDashboard);

// ── §22 — executive dashboard refresh ──────────────────────────────────────
router.post('/refresh', ...refreshAccess, refreshDashboardValidator, refreshDashboard);

// ── §19 — generated files ──────────────────────────────────────────────────
router.get('/files', ...readAccess, analyticsFilesQueryValidator, listFiles);
router.get('/files/:fileId', ...readAccess, analyticsFileIdParamValidator, downloadFile);

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
