// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT CONTROLLER
//
//  Thin by design: parse → call the service → answer. Every rule lives in
//  fnfRules.js, every query in fnfService.js.
//
//  Two audiences share this controller:
//    · HR / Payroll / Finance — company-wide, permission + scope gated
//    · Employee — self-service: `req.user._id` is the ONLY employee id ever
//      used, so a crafted employeeId can never widen the query (§3 / §24).
// ═══════════════════════════════════════════════════════════════════════════
import fnfService from '../services/payroll/fnfService.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

// The 29.1 payroll scope decides how far a scoped user can see; null means
// "the whole company" and is never derived from the request body.
const scopeOf = (req) => req.payrollEmployeeIds || null;

const fileResponse = (res, { filename, content, contentType = 'application/octet-stream' }) => {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(content?.length || 0));
  return res.end(content);
};

// ── §19 — the HR dashboard ─────────────────────────────────────────────────

export const getDashboard = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '' } = req.query;

  // DB Logic - DB logics
  const data = await fnfService.getDashboard({
    companyId: req.companyId,
    month,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Settlement dashboard fetched', data });
});

// ── §19 — the settlement list (search + department filter) ─────────────────

export const listSettlements = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '', status = '', search = '', departmentId = '' } = req.query;

  // DB Logic - DB logics
  const data = await fnfService.listSettlements({
    companyId: req.companyId,
    month,
    status,
    search,
    departmentId,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Settlements fetched', data });
});

export const getSettlement = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;

  // DB Logic - DB logics
  const data = await fnfService.getSettlement({
    companyId: req.companyId,
    settlementId,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Settlement fetched', data });
});

// ── §5 — open a settlement from the Exit module ────────────────────────────

export const createSettlement = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId, resignationId, month, lastWorkingDate, noticePeriodDays, noticeDecision } = req.body;

  // DB Logic - DB logics
  const data = await fnfService.createSettlement({
    companyId: req.companyId,
    employeeId,
    resignationId: resignationId || null,
    month,
    lastWorkingDate,
    noticePeriodDays,
    noticeDecision,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: 'Final settlement created', data });
});

// ── §7 — calculate / recalculate ───────────────────────────────────────────

export const calculateSettlement = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;

  // DB Logic - DB logics
  const data = await fnfService.recalculate({
    companyId: req.companyId,
    settlementId,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Final settlement calculated', data });
});

// ── §9 / §10 — payable and recovery items ──────────────────────────────────

export const updateItems = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;
  const { payables = null, recoveries = null } = req.body;

  // DB Logic - DB logics
  const data = await fnfService.updateItems({
    companyId: req.companyId,
    settlementId,
    payables,
    recoveries,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Settlement items updated', data });
});

// ── §12 — the notice decision ──────────────────────────────────────────────

export const setNoticeDecision = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;
  const { decision, noticePeriodDays } = req.body;

  // DB Logic - DB logics
  const data = await fnfService.setNoticeDecision({
    companyId: req.companyId,
    settlementId,
    decision,
    noticePeriodDays,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Notice decision updated', data });
});

// ── §15 — HR review ────────────────────────────────────────────────────────

export const hrReview = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;
  const { checklist = null, complete = false, remarks = '' } = req.body;

  // DB Logic - DB logics
  const data = await fnfService.hrReview({
    companyId: req.companyId,
    settlementId,
    checklist,
    complete,
    remarks,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: complete ? 'Settlement sent to Finance' : 'Checklist saved',
    data,
  });
});

// ── §13 / §9 — Finance adds a recovery for an unreturned asset ──────────────
//
// One narrow capability, and the only edit Finance may make: money the
// company takes BACK. A payable stays with the Payroll Admin, and the salary
// figures are not touched here at all.

export const addRecovery = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;
  const { type, amount, reason, label } = req.body;

  // DB Logic - DB logics
  const data = await fnfService.addRecovery({
    companyId: req.companyId,
    settlementId,
    item: { type, amount, reason, label },
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Recovery added to the settlement', data });
});

// ── §16 — Finance approval ─────────────────────────────────────────────────

export const financeDecision = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;
  const { action, remarks = '' } = req.body;

  // DB Logic - DB logics
  const data = await fnfService.financeDecision({
    companyId: req.companyId,
    settlementId,
    action,
    remarks,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: String(action).toUpperCase() === 'APPROVE'
      ? 'Settlement approved — ready for payment'
      : 'Settlement returned to HR review',
    data,
  });
});

// ── §5 — payment ───────────────────────────────────────────────────────────

export const markPaid = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;
  const { paidAt, reference, method } = req.body;

  // DB Logic - DB logics
  const data = await fnfService.markPaid({
    companyId: req.companyId,
    settlementId,
    paidAt,
    reference,
    method,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Settlement marked paid', data });
});

// ── §14 — close / reopen ───────────────────────────────────────────────────

export const closeSettlement = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;

  // DB Logic - DB logics
  const data = await fnfService.closeSettlement({
    companyId: req.companyId,
    settlementId,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Settlement closed', data });
});

export const reopenSettlement = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;
  const { remarks } = req.body;

  // DB Logic - DB logics
  const data = await fnfService.reopenSettlement({
    companyId: req.companyId,
    settlementId,
    remarks,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Settlement reopened', data });
});

// ── §17 — the F&F statement ────────────────────────────────────────────────

export const requestStatement = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;

  // DB Logic - DB logics
  const data = await fnfService.requestStatement({
    companyId: req.companyId,
    settlementId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.queued
      ? 'F&F statement queued — it will appear here shortly'
      : 'F&F statement generated',
    data,
  });
});

export const downloadStatement = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { settlementId } = req.params;

  // DB Logic - DB logics
  const data = await fnfService.downloadStatement({
    companyId: req.companyId,
    settlementId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return fileResponse(res, { ...data, contentType: 'application/pdf' });
});

// ── §21 — the bulk settlement register ─────────────────────────────────────

export const exportRegister = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '', format = 'CSV' } = req.query;

  // DB Logic - DB logics
  const data = await fnfService.getRegister({
    companyId: req.companyId,
    month,
    format,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return fileResponse(res, {
    filename: data.filename,
    content: data.content,
    contentType: String(format).toUpperCase() === 'XLSX'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv; charset=utf-8',
  });
});

export const requestRegister = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '', format = 'CSV' } = req.body;

  // DB Logic - DB logics
  const data = await fnfService.requestRegister({
    companyId: req.companyId,
    month,
    format,
    actor: req.user,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.queued ? 'Register queued — it will appear in the downloads list' : 'Register generated',
    data,
  });
});

export const listFiles = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month = '' } = req.query;

  // DB Logic - DB logics
  const data = await fnfService.listFiles({ companyId: req.companyId, month });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Settlement files fetched', data });
});

export const downloadFile = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { fileId } = req.params;

  // DB Logic - DB logics
  const data = await fnfService.downloadFile({
    companyId: req.companyId,
    fileId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return fileResponse(res, data);
});

// ── §18 — the employee portal ──────────────────────────────────────────────

export const getMySettlement = asyncHandler(async (req, res) => {
  // DB Logic - DB logics — the employee id comes from the JWT, never the URL.
  const data = await fnfService.getMySettlement({
    companyId: req.companyId,
    employeeId: req.user._id,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: data ? 'Settlement fetched' : 'No settlement yet', data });
});

export const downloadMyStatement = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const data = await fnfService.downloadMyStatement({
    companyId: req.companyId,
    employeeId: req.user._id,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return fileResponse(res, { ...data, contentType: 'application/pdf' });
});
