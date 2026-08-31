// ─────────────────────────────────────────────────────────────
// Phase 29.1 — Company Payroll Setup controller (thin layer)
//
// · The tenant ALWAYS comes from req.companyId — never from the body.
// · All business rules live in services/payroll/payrollSetupService.js.
// · Response contract (frontend PayrollSetupPage depends on it):
//     GET   /api/payroll/setup            → data: { config, evaluation, summary, cache }
//     POST  /api/payroll/setup/start      → data: { config, evaluation, started }
//     PATCH /api/payroll/setup/:section   → data: { config, evaluation, summary }
//     POST  /api/payroll/setup/activate   → data: { config, evaluation, summary }
//     POST  /api/payroll/setup/suspend    → data: { config, evaluation, summary }
// ─────────────────────────────────────────────────────────────
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  activatePayrollSetup,
  getPayrollSetup,
  startPayrollSetup,
  suspendPayrollSetup,
  updatePayrollSetupSection,
} from '../services/payroll/payrollSetupService.js';

const actorOf = (req) => ({
  id: req.user?._id || null,
  name: req.user?.name || '',
  role: req.user?.role || '',
});

const requireTenant = (req) => {
  if (!req.companyId) {
    // Platform staff have no tenant context — they never get a shortcut
    // into a customer's payroll configuration (§3).
    throw ApiError.forbidden('Payroll setup is only available inside a company context');
  }
  return req.companyId;
};

// GET /api/payroll/setup
export const getPayrollSetupConfig = asyncHandler(async (req, res) => {
  const companyId = requireTenant(req);
  const result = await getPayrollSetup({ companyId });
  return ApiResponse.success(res, { message: 'Payroll setup', data: result });
});

// POST /api/payroll/setup/start
export const startSetup = asyncHandler(async (req, res) => {
  const companyId = requireTenant(req);
  const result = await startPayrollSetup({ companyId, actor: actorOf(req), req });
  return ApiResponse.success(res, {
    message: result.started ? 'Payroll setup started' : 'Payroll setup already started',
    data: result,
  });
});

// PATCH /api/payroll/setup/:section  (LEGAL | STATUTORY | POLICY | BANK)
export const updateSection = asyncHandler(async (req, res) => {
  const companyId = requireTenant(req);
  const result = await updatePayrollSetupSection({
    companyId,
    section: req.params.section,
    payload: req.body || {},
    actor: actorOf(req),
    req,
    expectedVersion: req.body?.configVersion ?? req.body?.expectedVersion ?? null,
  });
  return ApiResponse.success(res, { message: 'Payroll setup saved', data: result });
});

// POST /api/payroll/setup/activate
export const activateSetup = asyncHandler(async (req, res) => {
  const companyId = requireTenant(req);
  const result = await activatePayrollSetup({
    companyId,
    actor: actorOf(req),
    req,
    expectedVersion: req.body?.configVersion ?? req.body?.expectedVersion ?? null,
  });
  return ApiResponse.success(res, { message: 'Payroll activated', data: result });
});

// POST /api/payroll/setup/suspend
export const suspendSetup = asyncHandler(async (req, res) => {
  const companyId = requireTenant(req);
  const result = await suspendPayrollSetup({
    companyId,
    reason: req.body?.reason || '',
    actor: actorOf(req),
    req,
  });
  return ApiResponse.success(res, { message: 'Payroll suspended', data: result });
});
