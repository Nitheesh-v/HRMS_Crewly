// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — PAYROLL ANALYTICS CONTROLLER
//
//  Thin by design: it reads `req.companyId` (never a companyId from the
//  browser), resolves what the actor is allowed to see, calls one service
//  method and wraps the answer. Every rule lives in analyticsRules.js or
//  analyticsService.js.
//
//  §24 — "Export Authorization" and §16's Finance-only CTC report are enforced
//  per route in analyticsRoutes.js; the controller repeats the financial check
//  as a belt-and-braces flag for the service.
// ═══════════════════════════════════════════════════════════════════════════
import analyticsService from '../services/payroll/analyticsService.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { hasPermission } from '../utils/permissionService.js';

const scopeOf = (req) => req.payrollEmployeeIds || null;

// §16 / §25 — the money-only reports. Asked once per request so the service
// never has to guess whether the caller may see the CTC breakdown.
const financialAccess = async (req) => {
  if (req.payrollAnalyticsFinancial !== undefined) return Boolean(req.payrollAnalyticsFinancial);
  const granted = await hasPermission(req.user, 'PAYROLL_ANALYTICS_FINANCIAL').catch(() => false);
  req.payrollAnalyticsFinancial = granted;
  return granted;
};

// ── §5 / §6 — the executive dashboard ──────────────────────────────────────

export const getDashboard = asyncHandler(async (req, res) => {
  const { month = '' } = req.query;

  const data = await analyticsService.getDashboard({
    companyId: req.companyId,
    month,
    allowedEmployeeIds: scopeOf(req),
  });

  return ApiResponse.success(res, { message: 'Payroll analytics dashboard', data });
});

// ── §6 … §17 — one report ──────────────────────────────────────────────────

export const getReport = asyncHandler(async (req, res) => {
  const { reportKey } = req.params;
  const {
    month = '',
    period = 'MONTHLY',
    financialYear = '',
    departmentId = '',
    designation = '',
    employeeId = '',
    status = '',
  } = req.query;

  const data = await analyticsService.getReport({
    companyId: req.companyId,
    reportKey,
    month,
    period,
    financialYear,
    departmentId,
    designation,
    employeeId,
    status,
    allowedEmployeeIds: scopeOf(req),
    canSeeFinancial: await financialAccess(req),
  });

  return ApiResponse.success(res, { message: 'Payroll report', data });
});

// ── §19 — exports ──────────────────────────────────────────────────────────

export const exportReport = asyncHandler(async (req, res) => {
  const { reportKey } = req.params;
  const {
    format = 'CSV',
    month = '',
    period = 'MONTHLY',
    financialYear = '',
    departmentId = '',
    designation = '',
    employeeId = '',
    status = '',
  } = req.query;

  const built = await analyticsService.downloadExport({
    companyId: req.companyId,
    reportKey,
    format: String(format).toUpperCase(),
    filters: { month, period, financialYear, departmentId, designation, employeeId, status },
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
    canSeeFinancial: await financialAccess(req),
  });

  const contentType =
    String(built.filename).endsWith('.csv')
      ? 'text/csv; charset=utf-8'
      : String(built.filename).endsWith('.pdf')
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
  return res.status(200).send(built.content);
});

// §19 / §22 — the queued path for the large ones.
export const requestExport = asyncHandler(async (req, res) => {
  const { reportKey } = req.params;
  const {
    format = 'XLSX',
    month = '',
    period = 'MONTHLY',
    financialYear = '',
    departmentId = '',
    designation = '',
    employeeId = '',
    status = '',
  } = req.body || {};

  const data = await analyticsService.requestExport({
    companyId: req.companyId,
    reportKey,
    format: String(format).toUpperCase(),
    filters: { month, period, financialYear, departmentId, designation, employeeId, status },
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
    canSeeFinancial: await financialAccess(req),
  });

  return ApiResponse.success(res, {
    message: data.queued ? 'Report queued — it will appear under Downloads' : 'Report ready',
    data,
  });
});

export const listFiles = asyncHandler(async (req, res) => {
  const { reportKey = '' } = req.query;
  const data = await analyticsService.listFiles({ companyId: req.companyId, reportKey });
  return ApiResponse.success(res, { message: 'Report files', data });
});

export const downloadFile = asyncHandler(async (req, res) => {
  const { fileId } = req.params;
  const { filename, content } = await analyticsService.downloadFile({
    companyId: req.companyId,
    fileId,
  });

  const contentType = String(filename).endsWith('.csv')
    ? 'text/csv; charset=utf-8'
    : String(filename).endsWith('.pdf')
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(content);
});

// ── §20 — scheduled reports ────────────────────────────────────────────────

export const listSchedules = asyncHandler(async (req, res) => {
  const data = await analyticsService.listSchedules({ companyId: req.companyId });
  return ApiResponse.success(res, { message: 'Scheduled reports', data });
});

export const createSchedule = asyncHandler(async (req, res) => {
  const data = await analyticsService.createSchedule({
    companyId: req.companyId,
    ...(req.body || {}),
    actor: req.user,
    req,
    canSeeFinancial: await financialAccess(req),
  });
  return ApiResponse.success(res, { message: 'Report scheduled', data });
});

export const updateSchedule = asyncHandler(async (req, res) => {
  const { scheduleId } = req.params;
  const data = await analyticsService.updateSchedule({
    companyId: req.companyId,
    scheduleId,
    patch: req.body || {},
    actor: req.user,
    req,
  });
  return ApiResponse.success(res, { message: 'Schedule updated', data });
});

export const deleteSchedule = asyncHandler(async (req, res) => {
  const { scheduleId } = req.params;
  const data = await analyticsService.deleteSchedule({
    companyId: req.companyId,
    scheduleId,
    actor: req.user,
    req,
  });
  return ApiResponse.success(res, { message: 'Schedule deleted', data });
});

// ── §22 — executive dashboard refresh ──────────────────────────────────────

export const refreshDashboard = asyncHandler(async (req, res) => {
  const { month = '' } = req.body || {};
  const data = await analyticsService.requestRefresh({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
  });
  return ApiResponse.success(res, {
    message: data.queued ? 'Dashboard refresh queued' : 'Dashboard refreshed',
    data,
  });
});

export default {
  getDashboard,
  getReport,
  exportReport,
  requestExport,
  listFiles,
  downloadFile,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  refreshDashboard,
};
