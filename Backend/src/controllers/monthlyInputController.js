// ─────────────────────────────────────────────────────────────
// Phase 29.5 — Monthly Payroll Inputs controller (thin layer)
//
// Authorization, tenant scoping and the payroll-month guards
// happen in the route (protect → tenantContext →
// requirePermission → requireFeature). Every business rule lives
// in services/payroll/monthlyInputService.js +
// monthlyInputRules.js.
// ─────────────────────────────────────────────────────────────
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import monthlyInputService from '../services/payroll/monthlyInputService.js';

export const listPayrollPeriods = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend

  // DB Logic - DB logics
  const periods = await monthlyInputService.listPeriods({ companyId: req.companyId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll periods fetched', data: periods });
});

export const listMonthlyInputs = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, search, status } = req.query;

  // DB Logic - DB logics
  const result = await monthlyInputService.listInputs({
    companyId: req.companyId,
    month,
    query: { search, status },
    // §4 / §24 — narrowed by the 29.1 payroll scope (null = whole company).
    allowedEmployeeIds: req.payrollVisibility?.allowedEmployeeIds ?? null,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Monthly payroll inputs fetched',
    data: result.inputs,
    meta: {
      period: result.period,
      summary: result.summary,
      monthLabel: result.monthLabel,
      entryTypes: result.entryTypes,
      bulkActions: result.bulkActions,
    },
  });
});

// §7 / §14 / §15 — pull attendance, leave and shift figures in.
// §10 — HR notes for one employee month, saved without leaving the drawer.
export const updateMonthlyInputRemarks = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId } = req.params;
  const { month, remarks } = req.body;

  // DB Logic - DB logics
  const input = await monthlyInputService.updateRemarks({
    companyId: req.companyId,
    month,
    employeeId,
    remarks,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Notes saved', data: input });
});

export const importMonthlyInputs = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.body;

  // DB Logic - DB logics
  const result = await monthlyInputService.importAutomatic({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `Attendance and leave imported for ${result.imported} employee(s).`,
    data: result,
  });
});

export const getMonthlyInput = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId } = req.params;
  const { month } = req.query;

  // DB Logic - DB logics
  const input = await monthlyInputService.getInput({
    companyId: req.companyId,
    month,
    employeeId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Monthly input fetched', data: input });
});

export const addMonthlyInputEntry = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId } = req.params;
  const { month, ...entry } = req.body;

  // DB Logic - DB logics
  const input = await monthlyInputService.addEntry({
    companyId: req.companyId,
    month,
    employeeId,
    entry,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: 'Entry added', data: input });
});

export const updateMonthlyInputEntry = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId, entryId } = req.params;
  const { month, ...patch } = req.body;

  // DB Logic - DB logics
  const input = await monthlyInputService.updateEntry({
    companyId: req.companyId,
    month,
    employeeId,
    entryId,
    patch,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Entry updated', data: input });
});

export const removeMonthlyInputEntry = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId, entryId } = req.params;
  const { month } = req.query;

  // DB Logic - DB logics
  const input = await monthlyInputService.removeEntry({
    companyId: req.companyId,
    month,
    employeeId,
    entryId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Entry removed', data: input });
});

// §12 — every bulk action is audited per employee.
export const runBulkAction = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, action, employeeIds = [], ...payload } = req.body;

  // DB Logic - DB logics
  const result = await monthlyInputService.bulkAction({
    companyId: req.companyId,
    month,
    action,
    employeeIds,
    payload,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `Bulk action applied to ${result.touched} employee(s).`,
    data: result,
  });
});

// §11 — parse and validate first, store only after HR confirms.
export const previewMonthlyImport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, content } = req.body;

  // DB Logic - DB logics
  const preview = await monthlyInputService.previewImport({
    companyId: req.companyId,
    month,
    content,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Import preview ready', data: preview });
});

export const confirmMonthlyImport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, rows = [] } = req.body;

  // DB Logic - DB logics
  const result = await monthlyInputService.confirmImport({
    companyId: req.companyId,
    month,
    rows,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `${result.created} row(s) imported.`,
    data: result,
  });
});

// §19
export const validateMonthlyInputs = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.body;

  // DB Logic - DB logics
  const report = await monthlyInputService.validateMonth({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Validation complete', data: report });
});

// §20 — lock / reopen the month.
export const setMonthlyInputStatus = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, status } = req.body;

  // DB Logic - DB logics
  const period = await monthlyInputService.setPeriodStatus({
    companyId: req.companyId,
    month,
    status,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `Payroll month is now ${period.status.toLowerCase().replace(/_/g, ' ')}.`,
    data: period,
  });
});
