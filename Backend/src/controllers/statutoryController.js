// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY COMPLIANCE CONTROLLER
//
//  Thin by design: parse → call the service → answer. Every rule lives in
//  statutoryRules.js and every query in statutoryService.js.
//
//  §3 / §24 — companyId comes from the tenant context, never from the body or
//  the query string. The self-service route (`/mine`) takes the employee id
//  from the JWT and nowhere else, so a crafted id cannot widen the read.
// ═══════════════════════════════════════════════════════════════════════════
import statutoryService from '../services/payroll/statutoryService.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

const fileResponse = (res, { filename, contentType, content }) => {
  res.setHeader('Content-Type', contentType || 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(content?.length || 0));
  return res.end(content);
};

// ── §5 — dashboard ─────────────────────────────────────────────────────────

export const getDashboard = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '' } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.getDashboard({ companyId: req.companyId, month });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Compliance dashboard fetched', data });
});

// ── §7–§12 — one report ────────────────────────────────────────────────────

export const getReport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { type } = req.params;
  const { month = '' } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.getReport({ companyId: req.companyId, month, type });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Statutory report fetched', data });
});

// ── §6 — generate every applicable report for a month ──────────────────────

export const generateReports = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.body;

  // DB Logic - DB logics
  const data = await statutoryService.generateForMonth({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.queued
      ? 'Statutory reports queued — they will appear on this page shortly'
      : 'Statutory reports generated',
    data,
  });
});

// ── §14 — filing status ────────────────────────────────────────────────────

export const updateFilingStatus = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { type } = req.params;
  const { status, filingReference = '', filingRemarks = '' } = req.body;
  const { month = '' } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.updateFilingStatus({
    companyId: req.companyId,
    month,
    type,
    status,
    filingReference,
    filingRemarks,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `Filing status updated to ${data.statusLabel}`,
    data,
  });
});

// ── §15 — exports ──────────────────────────────────────────────────────────

export const exportReport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const {
    reportKey,
    month = '',
    financialYear = '',
    format = 'CSV',
  } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.exportNow({
    companyId: req.companyId,
    reportKey,
    month,
    financialYear,
    format,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return fileResponse(res, data);
});

// ── §13 — the monthly compliance register ──────────────────────────────────

export const downloadRegister = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { financialYear = '' } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.getRegister({ companyId: req.companyId, financialYear });

  // Data to frontend - response to frontend
  return fileResponse(res, {
    filename: data.filename,
    contentType: 'text/csv; charset=utf-8',
    content: data.content,
  });
});

/** §13 — the JSON history behind the register table. */
export const getHistory = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { financialYear = '' } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.getHistory({ companyId: req.companyId, financialYear });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Compliance history fetched', data });
});

// ── §18 — annual reports ───────────────────────────────────────────────────

export const getAnnual = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { financialYear = '' } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.getAnnual({ companyId: req.companyId, financialYear });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Annual compliance reports fetched', data });
});

/** §18 / §21 — large annual reports go through the queue. */
export const requestAnnualExport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { financialYear, reportKey, format = 'XLSX' } = req.body;

  // DB Logic - DB logics
  const data = await statutoryService.requestExport({
    companyId: req.companyId,
    financialYear,
    reportKey,
    format,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.queued ? 'Report queued — it will be ready shortly' : 'Report ready',
    data,
  });
});

export const listExports = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '', financialYear = '' } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.listExports({ companyId: req.companyId, month, financialYear });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Exports fetched', data });
});

export const downloadExport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { exportId } = req.params;

  // DB Logic - DB logics
  const data = await statutoryService.downloadExport({
    companyId: req.companyId,
    exportId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return fileResponse(res, data);
});

// ── §19 — the compliance calendar ──────────────────────────────────────────

export const getCalendar = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { months = '' } = req.query;

  // DB Logic - DB logics — a bounded, validated list; junk is dropped.
  const list = String(months || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value))
    .slice(0, 12);

  // DB Logic - DB logics
  const data = await statutoryService.getCalendar({ companyId: req.companyId, months: list });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Compliance calendar fetched', data });
});

export const updateCalendarTask = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, type, done = true, note = '' } = req.body;

  // DB Logic - DB logics
  const data = await statutoryService.updateCalendarTask({
    companyId: req.companyId,
    month,
    type,
    done,
    note,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Calendar task updated', data });
});

/** §22 — "Filing Due Tomorrow → Finance". */
export const sendReminders = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '' } = req.body || {};

  // DB Logic - DB logics
  const data = await statutoryService.requestReminders({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.sent ? `${data.sent} filing reminder(s) sent` : 'Nothing is due right now',
    data,
  });
});

// ── §17 — the employee statutory view ──────────────────────────────────────

/** Admin / HR / Finance: one employee's statutory IDs, read-only. */
export const getEmployeeStatutory = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId } = req.params;
  const { month = '' } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.getEmployeeStatutory({
    companyId: req.companyId,
    employeeId,
    month,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Statutory details fetched', data });
});

/** Self-service: the employee id comes from the token, never the URL. */
export const getMyStatutory = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const employeeId = req.user._id;
  const { month = '' } = req.query;

  // DB Logic - DB logics
  const data = await statutoryService.getEmployeeStatutory({
    companyId: req.companyId,
    employeeId,
    month,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Statutory details fetched', data });
});
