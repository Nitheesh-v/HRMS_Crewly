// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY COMPLIANCE ROUTES
//
//  Mounted at /api/payroll/statutory (see routes/index.js).
//
//  Three duties, three gates (§4):
//    · READ      PAYROLL_STATUTORY_READ            (Company Admin, Payroll
//                                                   Admin, Finance, HR view)
//    · GENERATE  PAYROLL_STATUTORY_GENERATE        (Payroll Admin)
//    · FILING    PAYROLL_STATUTORY_FILING          (Finance Manager)
//
//  Separation of duties is deliberate: the person who produces a return is
//  not the person who attests that it was filed.
//
//  `/mine` is the employee's own read-only statutory card (§17). It is
//  granted by EMPLOYEE_SALARY_READ_SELF — a permission the Employee role
//  already holds — and it sends no employee id at all.
// ═══════════════════════════════════════════════════════════════════════════
import express from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { requireAnyPermission, requirePermission } from '../middlewares/permissionMiddleware.js';
import { checkWriteAccess, requireFeature } from '../middlewares/subscriptionAccess.js';
import statutoryScope from '../middlewares/statutoryScope.js';

import {
  downloadExport,
  downloadRegister,
  exportReport,
  generateReports,
  getAnnual,
  getCalendar,
  getDashboard,
  getEmployeeStatutory,
  getHistory,
  getMyStatutory,
  getReport,
  listExports,
  requestAnnualExport,
  sendReminders,
  updateCalendarTask,
  updateFilingStatus,
} from '../controllers/statutoryController.js';

import {
  annualExportValidator,
  calendarTaskValidator,
  employeeIdParamValidator,
  exportIdParamValidator,
  filingStatusValidator,
  generateStatutoryValidator,
  reminderValidator,
  statutoryCalendarQueryValidator,
  statutoryExportQueryValidator,
  statutoryHistoryQueryValidator,
  statutoryMonthQueryValidator,
  statutoryTypeParamValidator,
} from '../validators/statutoryValidator.js';

const router = express.Router();

router.use(protect, tenantContext);

// §4 — anyone who can see a statutory report may read it.
const readAccess = [
  requireAnyPermission([
    'PAYROLL_STATUTORY_READ',
    'PAYROLL_STATUTORY_GENERATE',
    'PAYROLL_STATUTORY_MANAGE',
    'PAYROLL_STATUTORY_FILING',
  ]),
  requireFeature('payroll'),
  statutoryScope,
];

const writeAccess = (permission) => [
  checkWriteAccess,
  requirePermission(permission),
  requireFeature('payroll'),
  statutoryScope,
];

// ── §17 — the employee's own statutory IDs (read-only) ─────────────────────
// Declared first so `/mine` can never be mistaken for another path segment.
router.get('/mine', requirePermission('EMPLOYEE_SALARY_READ_SELF'), requireFeature('payroll'), statutoryMonthQueryValidator, getMyStatutory);

router.get('/employees/:employeeId', ...readAccess, employeeIdParamValidator, statutoryMonthQueryValidator, getEmployeeStatutory);

// ── §5 — dashboard ─────────────────────────────────────────────────────────
router.get('/dashboard', ...readAccess, statutoryMonthQueryValidator, getDashboard);

// ── §6 — generate every applicable report for a month (§21 background) ─────
router.post('/generate', ...writeAccess('PAYROLL_STATUTORY_GENERATE'), generateStatutoryValidator, generateReports);

// ── §15 — Excel / CSV / PDF ────────────────────────────────────────────────
router.get('/export', ...readAccess, statutoryExportQueryValidator, exportReport);

// ── §13 — the monthly compliance register ──────────────────────────────────
router.get('/register', ...readAccess, statutoryHistoryQueryValidator, downloadRegister);
router.get('/history', ...readAccess, statutoryHistoryQueryValidator, getHistory);

// ── §18 — annual reports ───────────────────────────────────────────────────
router.get('/annual', ...readAccess, statutoryHistoryQueryValidator, getAnnual);
router.post('/annual/export', ...writeAccess('PAYROLL_STATUTORY_GENERATE'), annualExportValidator, requestAnnualExport);
router.get('/exports', ...readAccess, statutoryMonthQueryValidator, listExports);
router.get('/exports/:exportId', ...readAccess, exportIdParamValidator, downloadExport);

// ── §19 — the compliance calendar ──────────────────────────────────────────
router.get('/calendar', ...readAccess, statutoryCalendarQueryValidator, getCalendar);
router.post('/calendar/tasks', ...writeAccess('PAYROLL_STATUTORY_FILING'), calendarTaskValidator, updateCalendarTask);
router.post('/calendar/reminders', ...writeAccess('PAYROLL_STATUTORY_GENERATE'), reminderValidator, sendReminders);

// ── §14 / §7–§12 — one report and its filing status ────────────────────────
router.get('/reports/:type', ...readAccess, statutoryTypeParamValidator, statutoryMonthQueryValidator, getReport);
router.patch('/reports/:type/status', ...writeAccess('PAYROLL_STATUTORY_FILING'), statutoryTypeParamValidator, statutoryMonthQueryValidator, filingStatusValidator, updateFilingStatus);

export default router;
