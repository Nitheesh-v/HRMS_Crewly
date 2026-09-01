// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.8 — SALARY PAYMENT CONTROLLER (thin)
//
//  Every handler follows the house convention:
//    // Data from frontend  → what the request carries
//    // DB Logic            → one service call
//    // Data to frontend    → the response
//
//  Tenancy comes from req.companyId (never from the body) and the payroll
//  scope from req.payrollVisibility. No bank logic lives here, and no full
//  account number is ever serialised into a JSON response (§23).
// ═══════════════════════════════════════════════════════════════════════════
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import payrollPaymentService from '../services/payroll/payrollPaymentService.js';

const scopeOf = (req) => req.payrollVisibility?.allowedEmployeeIds ?? null;

// §17 — the payment dashboard: batches + KPI cards (cached, §19).
export const getPaymentDashboard = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const month = req.query?.month ? String(req.query.month) : '';

  // DB Logic - DB logics
  const data = await payrollPaymentService.getDashboard({
    companyId: req.companyId,
    month,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payment dashboard fetched', data });
});

// §18 — batch list.
export const listPaymentBatches = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const month = req.query?.month ? String(req.query.month) : '';

  // DB Logic - DB logics
  const batches = await payrollPaymentService.listBatches({
    companyId: req.companyId,
    month,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payment batches fetched', data: batches });
});

// §18 — one batch: summary, employees, failures and download history.
// §18 / §22 — the audit trail of one batch: every status change, employee
// outcome and file event, newest first.
export const getPaymentBatchAudit = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { batchId } = req.params;

  // DB Logic - DB logics
  const data = await payrollPaymentService.getBatchAudit({
    companyId: req.companyId,
    batchId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payment batch audit fetched', data });
});

export const getPaymentBatch = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { batchId } = req.params;

  // DB Logic - DB logics
  const data = await payrollPaymentService.getBatch({
    companyId: req.companyId,
    batchId,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payment batch fetched', data });
});

// §7 — re-run bank validation over the batch.
export const validatePaymentBatch = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { batchId } = req.params;

  // DB Logic - DB logics
  const data = await payrollPaymentService.validateBatch({
    companyId: req.companyId,
    batchId,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Bank validation complete', data });
});

// §5 / §6 — create a batch from an approved payroll.
export const createPaymentBatch = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, paymentDate } = req.body || {};

  // DB Logic - DB logics
  const data = await payrollPaymentService.createBatch({
    companyId: req.companyId,
    month,
    paymentDate,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payment batch created', data });
});

// §10 / §20 — generate the bank transfer file (queued when Redis is up).
export const generatePaymentFile = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { batchId } = req.params;
  const { format } = req.body || {};

  // DB Logic - DB logics
  const outcome = await payrollPaymentService.generateFile({
    companyId: req.companyId,
    batchId,
    format: format || 'CSV',
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  // The binary payload is never serialised into JSON: it is streamed by the
  // download endpoint below.
  return ApiResponse.success(res, {
    message: outcome.queued
      ? 'Bank file queued — it will be ready shortly'
      : 'Bank file generated',
    data: outcome.file,
    meta: { queued: outcome.queued, format: outcome.format },
  });
});

// §12 — download a generated file and count the download.
export const downloadPaymentFile = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { fileId } = req.params;

  // DB Logic - DB logics
  const { file, content, binary } = await payrollPaymentService.downloadFile({
    companyId: req.companyId,
    fileId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  const isExcel = file.format === 'XLSX';
  const body = isExcel ? binary : content;

  res.setHeader(
    'Content-Type',
    isExcel
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv; charset=utf-8',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.batchId}-salary-payment.${isExcel ? 'xlsx' : 'csv'}"`,
  );
  return res.status(200).send(body);
});

// §13 — confirm the whole batch.
export const markBatchPaid = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { batchId } = req.params;

  // DB Logic - DB logics
  const data = await payrollPaymentService.markAllPaid({
    companyId: req.companyId,
    batchId,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payments confirmed', data });
});

// §14 — mark one employee paid or failed.
export const markPaymentEmployee = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { batchId, employeeId } = req.params;
  const { status, failureReason, remarks } = req.body || {};

  // DB Logic - DB logics
  const data = await payrollPaymentService.markEmployee({
    companyId: req.companyId,
    batchId,
    employeeId,
    status,
    failureReason,
    remarks,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payment updated', data });
});

// §16 — create a retry batch for the failures.
export const createRetryBatch = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { batchId } = req.params;

  // DB Logic - DB logics
  const data = await payrollPaymentService.createRetryBatch({
    companyId: req.companyId,
    batchId,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Retry batch created', data });
});

// §8 / §22 — cancel a batch.
export const cancelPaymentBatch = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { batchId } = req.params;
  const { reason } = req.body || {};

  // DB Logic - DB logics
  const batch = await payrollPaymentService.cancelBatch({
    companyId: req.companyId,
    batchId,
    reason,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payment batch cancelled', data: batch });
});

// §4 — reopen a failed batch so it can be fixed and regenerated.
export const reopenPaymentBatch = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { batchId } = req.params;

  // DB Logic - DB logics
  const data = await payrollPaymentService.reopenBatch({
    companyId: req.companyId,
    batchId,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payment batch reopened', data });
});
