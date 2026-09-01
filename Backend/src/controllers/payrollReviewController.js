// ─────────────────────────────────────────────────────────────
// Phase 29.7 — Payroll Review & Approval controller (thin layer)
//
// Authorization, tenant scoping and the payroll-month guards
// happen in the route (protect → tenantContext →
// requirePermission → requireFeature). Every business rule lives
// in services/payroll/payrollReviewRules.js (pure) and
// payrollReviewService.js (persistence).
//
// This controller never calculates salary — the numbers come
// from the 29.6 snapshots (§21).
// ─────────────────────────────────────────────────────────────
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import payrollReviewService from '../services/payroll/payrollReviewService.js';

const scopeOf = (req) => req.payrollVisibility?.allowedEmployeeIds ?? null;

// §7 / §16 — the review workspace for one month.
export const getPayrollReview = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;

  // DB Logic - DB logics
  const state = await payrollReviewService.getReviewDashboard({
    companyId: req.companyId,
    month,
    actor: req.user,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll review fetched', data: state });
});

// §8 — employee review list with per-employee state and errors.
export const listPayrollReviewEmployees = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;

  // DB Logic - DB logics
  const state = await payrollReviewService.getReview({
    companyId: req.companyId,
    month,
    actor: req.user,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Payroll review employees fetched',
    data: state.results.map((row) => ({
      ...row,
      review: state.review.employeeReviews?.find(
        (entry) => String(entry.employeeId) === String(row.employeeId),
      ) || null,
      reviewErrors: state.errorRows.find(
        (entry) => String(entry.employeeId) === String(row.employeeId),
      )?.errors || [],
    })),
    meta: {
      status: state.review.status,
      checklist: state.checklist,
      checklistProgress: state.checklistProgress,
      canLock: state.canLock,
    },
  });
});

// §9 — one employee's payroll breakdown for review.
export const getPayrollReviewEmployee = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, employeeId } = req.params;

  // DB Logic - DB logics
  const state = await payrollReviewService.getReview({
    companyId: req.companyId,
    month,
    actor: req.user,
    allowedEmployeeIds: scopeOf(req),
  });

  const result = state.results.find((row) => String(row.employeeId) === String(employeeId));
  if (!result) {
    return ApiResponse.success(res, { message: 'No payroll record for this employee', data: null });
  }

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Payroll breakdown fetched',
    data: {
      ...result,
      review: state.review.employeeReviews?.find(
        (entry) => String(entry.employeeId) === String(employeeId),
      ) || null,
      reviewErrors: state.errorRows.find(
        (entry) => String(entry.employeeId) === String(employeeId),
      )?.errors || [],
      status: state.review.status,
      readOnly: ['LOCKED', 'PENDING_FINANCE_APPROVAL', 'APPROVED'].includes(state.review.status),
      remarks: state.review.remarks || [],
    },
  });
});

// §10 / §22 — the error report.
export const listPayrollReviewErrors = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;

  // DB Logic - DB logics
  const { errorRows, errors } = await payrollReviewService.listErrorRows({
    companyId: req.companyId,
    month,
    actor: req.user,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Payroll error report fetched',
    data: errorRows,
    meta: errors,
  });
});

// §17 — what changed between snapshot versions.
export const getPayrollDifferences = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;

  // DB Logic - DB logics
  const differences = await payrollReviewService.getDifferences({
    companyId: req.companyId,
    month,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll differences fetched', data: differences });
});

// §11 — tick one checklist box.
export const setPayrollChecklist = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, item } = req.params;
  const { value } = req.body || {};

  // DB Logic - DB logics
  const state = await payrollReviewService.setChecklist({
    companyId: req.companyId,
    month,
    item,
    value,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Checklist updated', data: state });
});

// §15 — append a remark to the payroll discussion.
export const addPayrollRemark = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;
  const { message, channel } = req.body || {};

  // DB Logic - DB logics
  const review = await payrollReviewService.addRemark({
    companyId: req.companyId,
    month,
    actor: req.user,
    message,
    channel,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Remark added', data: review.remarks });
});

// §8 / §18 — review one employee (mark reviewed / add a note).
export const reviewPayrollEmployee = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, employeeId } = req.params;
  const { state, note } = req.body || {};

  // DB Logic - DB logics
  const result = await payrollReviewService.reviewEmployee({
    companyId: req.companyId,
    month,
    employeeId,
    state,
    note,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Employee reviewed', data: result });
});

// §18 — bulk review actions (never modify a salary value).
export const runPayrollReviewBulkAction = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;
  const { action, employeeIds } = req.body || {};

  // DB Logic - DB logics
  const result = await payrollReviewService.bulkAction({
    companyId: req.companyId,
    month,
    action,
    employeeIds: Array.isArray(employeeIds) ? employeeIds : [],
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Review action applied', data: result });
});

// §12 — lock payroll.
export const lockPayroll = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;

  // DB Logic - DB logics
  const state = await payrollReviewService.lock({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll locked', data: state });
});

// §13 — reopen payroll (always with a reason).
export const reopenPayroll = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;
  const { reason } = req.body || {};

  // DB Logic - DB logics
  const state = await payrollReviewService.reopen({
    companyId: req.companyId,
    month,
    reason,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll reopened', data: state });
});

// §14 — submit to finance, then approve or reject.
export const submitPayrollForApproval = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;

  // DB Logic - DB logics
  const state = await payrollReviewService.submitForApproval({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll sent to finance', data: state });
});

export const approvePayroll = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;

  // DB Logic - DB logics
  const state = await payrollReviewService.approve({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll approved', data: state });
});

export const rejectPayroll = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;
  const { reason } = req.body || {};

  // DB Logic - DB logics
  const state = await payrollReviewService.reject({
    companyId: req.companyId,
    month,
    reason,
    actor: req.user,
    req,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll rejected', data: state });
});

// §19 / §21 — export reports (queued when Redis is up, inline otherwise).
export const createPayrollExport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;
  const { reportKey } = req.body || {};

  // DB Logic - DB logics
  const outcome = await payrollReviewService.createExport({
    companyId: req.companyId,
    month,
    reportKey,
    actor: req.user,
    allowedEmployeeIds: scopeOf(req),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: outcome.queued
      ? 'Report queued — it will appear when ready'
      : 'Report generated',
    data: outcome.export,
    // The inline path returns the CSV straight away so the UI never waits.
    meta: { queued: outcome.queued, content: outcome.queued ? '' : outcome.content },
  });
});

export const getPayrollExport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { exportId } = req.params;

  // DB Logic - DB logics
  const row = await payrollReviewService.getExport({ companyId: req.companyId, exportId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Export fetched', data: row });
});
