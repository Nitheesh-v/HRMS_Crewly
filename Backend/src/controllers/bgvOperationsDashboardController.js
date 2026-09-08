import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import {
  OPS_STATES,
  PAGE_SIZE_CAP,
  opsQueue,
  opsSummary,
  readSlaPolicy,
  updateSlaPolicy,
  verifierWorkload,
} from '../services/bgv/bgvOperationsDashboardService.js';
import { SLA_CHECK_TYPES } from '../services/bgv/bgvSlaRules.js';

// Phase 30.11 — internal BGV operations dashboard (platform-only).
// Routes mount behind requireSuperAdmin + permit('bgv-operations:*'), so
// tenant HR, verifiers and QA principals (separate auth stacks / narrower
// permissions) can never reach this surface. Everything served here is
// DERIVED from the authoritative Phase 30.x documents on read — no second
// state machine, and reads are deliberately NOT audited (count lookups).

// GET /api/super-admin/bgv-ops/dashboard
export const bgvOpsDashboard = asyncHandler(async (req, res) => {
  // Data from frontend - none (pure derived counts)

  // DB Logic - derive all queue counts from the authoritative 30.x states
  const data = await opsSummary({});

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'BGV operations dashboard', data });
});

// GET /api/super-admin/bgv-ops/queue
export const bgvOpsQueue = asyncHandler(async (req, res) => {
  // Data from frontend - paging + safe filters only (state/checkType/
  // verifierId/orderCode/sla/sort); page size is capped server-side
  const { page, pageSize, state, checkType, verifierId, orderCode, sla, sort } = req.query;

  // DB Logic - derived rows (safe fields only: no PAN/Aadhaar/UAN, no
  // documents, notes, evidence or payment data) with server-side paging
  const data = await opsQueue({
    page,
    pageSize: Math.min(PAGE_SIZE_CAP, Number(pageSize) || 20),
    filter: {
      state: OPS_STATES.includes(state) ? state : undefined,
      checkType: SLA_CHECK_TYPES.includes(String(checkType || '').toUpperCase())
        ? String(checkType).toUpperCase()
        : undefined,
      verifierId: verifierId || undefined,
      orderCode: orderCode || undefined,
      sla: ['OVERDUE', 'DUE_SOON', 'SLA_NOT_CONFIGURED'].includes(sla) ? sla : undefined,
    },
    sort,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'BGV operations queue', data });
});

// GET /api/super-admin/bgv-ops/workload
export const bgvOpsWorkload = asyncHandler(async (req, res) => {
  // Data from frontend - none

  // DB Logic - per-verifier derived workload (never exposed to tenant HR;
  // no automatic reassignment is implied or performed here)
  const data = await verifierWorkload({});

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Verifier workload', data });
});

// GET /api/super-admin/bgv-ops/sla
export const bgvOpsSlaPolicyRead = asyncHandler(async (req, res) => {
  // Data from frontend - none

  // DB Logic - platform SLA policy; null means NOT CONFIGURED (no
  // defaults are ever seeded or invented)
  const policy = await readSlaPolicy({});

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: policy ? 'BGV SLA policy' : 'BGV SLA policy not configured',
    data: { configured: Boolean(policy), policy, checkTypes: SLA_CHECK_TYPES },
  });
});

// PUT /api/super-admin/bgv-ops/sla
export const bgvOpsSlaPolicyUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - validated SLA targets for exactly the five
  // check types (+ dueSoonHours / pause / unassigned knobs)
  const body = req.body || {};

  // DB Logic - validate (no hardcoded defaults), upsert the singleton,
  // audit the configuration write with safe metadata only
  const policy = await updateSlaPolicy({
    actorId: req.user._id,
    input: body,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'BGV SLA policy updated', data: { policy } });
});
