// ─────────────────────────────────────────────────────────────
// Phase 29.6 — Payroll Engine controller (thin layer)
//
// Authorization, tenant scoping and the payroll-month guards
// happen in the route (protect → tenantContext →
// requirePermission → requireFeature). Every business rule lives
// in services/payroll/payrollEngineRules.js (pure) and
// payrollEngineService.js (persistence).
// ─────────────────────────────────────────────────────────────
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import payrollEngineService from '../services/payroll/payrollEngineService.js';

export const listPayrollRuns = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend

  // DB Logic - DB logics
  const runs = await payrollEngineService.listRuns({ companyId: req.companyId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll runs fetched', data: runs });
});

// §23 — dashboard: the run, its live progress and the KPI cards.
export const getPayrollRunSummary = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;

  // DB Logic - DB logics
  const { run, summary, cached } = await payrollEngineService.getRunSummary({
    companyId: req.companyId,
    month,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Payroll summary fetched',
    data: { run, summary },
    meta: { cached },
  });
});

// §24 — employee payroll results for the month.
export const listPayrollResults = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;
  const { status, search } = req.query;

  // DB Logic - DB logics
  const results = await payrollEngineService.listResults({
    companyId: req.companyId,
    month,
    status: status || 'ALL',
    search,
    // §3 / §30 — narrowed by the 29.1 payroll scope (null = whole company).
    allowedEmployeeIds: req.payrollVisibility?.allowedEmployeeIds ?? null,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll results fetched', data: results });
});

export const getPayrollResult = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, employeeId } = req.params;

  // DB Logic - DB logics
  const result = await payrollEngineService.getResult({
    companyId: req.companyId,
    month,
    employeeId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll result fetched', data: result });
});

// §5 / §26 — start the run (queued when Redis is up, inline otherwise).
export const runPayroll = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;
  const { employeeIds } = req.body || {};

  // DB Logic - DB logics
  const { run, queued } = await payrollEngineService.startRun({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
    employeeIds: Array.isArray(employeeIds) ? employeeIds : null,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: queued
      ? 'Payroll run queued — progress updates live'
      : 'Payroll run completed (no queue configured, calculated inline)',
    data: run,
    meta: { queued },
  });
});

// §21 — recalculate the month or a single employee as a NEW snapshot version.
export const recalculatePayroll = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;
  const { employeeIds } = req.body || {};

  // DB Logic - DB logics
  const outcome = await payrollEngineService.recalculate({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
    employeeIds: Array.isArray(employeeIds) && employeeIds.length ? employeeIds : null,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Payroll recalculated — a new snapshot version was written',
    data: outcome,
  });
});

// §28 — cancel a queued run before the worker starts it.
export const cancelPayrollRun = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params;

  // DB Logic - DB logics
  const run = await payrollEngineService.cancelRun({
    companyId: req.companyId,
    month,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Payroll run cancelled', data: run });
});
