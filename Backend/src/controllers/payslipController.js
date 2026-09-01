// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP CONTROLLER
//
//  Thin by design: parse → call the service → answer. Every rule lives in
//  payslipRules.js and every query in payslipService.js.
//
//  Two audiences share this controller:
//    · Payroll / HR / Finance — company-wide, permission + scope gated
//    · Employee — self-service: `req.user._id` is the ONLY employee id ever
//      used, so a crafted employeeId can never widen the query (§3 / §26).
// ═══════════════════════════════════════════════════════════════════════════
import payslipService from '../services/payroll/payslipService.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

// The 29.1 payroll scope decides how far a scoped user can see; null means
// "the whole company" and is never derived from the request body.
const scopeOf = (req) => req.payrollEmployeeIds || null;

const pdfResponse = (res, { filename, content, message = 'Payslip PDF' }) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(content?.length || 0));
  return res.end(content);
};

const zipResponse = (res, { filename, content }) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(content?.length || 0));
  return res.end(content);
};

// ── admin / payroll side (§27) ─────────────────────────────────────────────

export const getPayslipDashboard = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '' } = req.query;

  // DB Logic - DB logics
  const data = await payslipService.getDashboard({
    companyId: req.companyId,
    month,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payslip dashboard fetched', data });
});

export const listPayslips = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '', year = '', financialYear = '', search = '' } = req.query;

  // DB Logic - DB logics
  const data = await payslipService.listPayslips({
    companyId: req.companyId,
    month,
    year,
    financialYear,
    search,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payslips fetched', data });
});

// §17 — bulk generation. Queued when the worker is up, inline otherwise.
export const generatePayslips = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.body;

  // DB Logic - DB logics
  const result = await payslipService.generateForMonth({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.queued
      ? 'Payslip generation queued — progress will appear on this page'
      : 'Payslips generated',
    data: result,
  });
});

export const getPayslip = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { payslipId } = req.params;

  // DB Logic - DB logics
  const data = await payslipService.getPayslipView({
    companyId: req.companyId,
    payslipId,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payslip fetched', data });
});

export const downloadPayslip = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { payslipId } = req.params;

  // DB Logic - DB logics
  const data = await payslipService.downloadPayslip({
    companyId: req.companyId,
    payslipId,
    allowedEmployeeIds: scopeOf(req),
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return pdfResponse(res, { ...data, message: 'Payslip PDF' });
});

// §22 — re-render the PDF from the stored snapshot. Values never change.
export const regeneratePayslip = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { payslipId } = req.params;

  // DB Logic - DB logics
  const data = await payslipService.regeneratePayslip({
    companyId: req.companyId,
    payslipId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payslip regenerated', data });
});

// §19 — one payslip by email.
export const emailPayslip = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { payslipId } = req.params;

  // DB Logic - DB logics
  const data = await payslipService.emailPayslip({
    companyId: req.companyId,
    payslipId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.delivered ? 'Payslip emailed' : 'Payslip email could not be delivered',
    data,
  });
});

// §19 / §24 — the whole month, in the background when possible.
export const emailMonthPayslips = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.body;

  // DB Logic - DB logics
  const data = await payslipService.emailMonth({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.queued ? 'Payslip emails queued' : 'Payslip emails processed',
    data,
  });
});

// §18 — request a department or company ZIP.
export const requestBulkDownload = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, scope = 'COMPANY', departmentId = null } = req.body;

  // DB Logic - DB logics
  const data = await payslipService.requestBulkDownload({
    companyId: req.companyId,
    month,
    scope,
    departmentId: departmentId || null,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.queued ? 'Archive queued — it will be ready shortly' : 'Archive ready',
    data,
  });
});

export const listBulkDownloads = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '' } = req.query;

  // DB Logic - DB logics
  const data = await payslipService.listBulkFiles({ companyId: req.companyId, month });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Bulk downloads fetched', data });
});

export const downloadBulkFile = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { fileId } = req.params;

  // DB Logic - DB logics
  const data = await payslipService.downloadBulkFile({
    companyId: req.companyId,
    fileId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return zipResponse(res, data);
});

// ── employee self-service (§14 / §16) ──────────────────────────────────────

export const getMyPayslips = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend — the employee id comes from
  // the token, never from the query string (§3 / §26).
  const employeeId = req.user._id;

  // DB Logic - DB logics
  const data = await payslipService.getMyPayslips({ companyId: req.companyId, employeeId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payslips fetched', data });
});

export const getMyPayslip = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { payslipId } = req.params;

  // DB Logic - DB logics
  const data = await payslipService.markViewed({
    companyId: req.companyId,
    payslipId,
    employeeId: req.user._id,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payslip fetched', data });
});

export const downloadMyPayslip = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { payslipId } = req.params;

  // DB Logic - DB logics
  const data = await payslipService.downloadPayslip({
    companyId: req.companyId,
    payslipId,
    employeeId: req.user._id, // §26 — only ever their own
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return pdfResponse(res, data);
});
