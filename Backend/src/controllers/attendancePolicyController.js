// ─────────────────────────────────────────────────────────────
// Phase 31.1 — Attendance Policy controllers (thin).
// Policy rules live in services/attendance/attendancePolicyRules.js;
// orchestration in services/attendance/attendancePolicyService.js.
// ─────────────────────────────────────────────────────────────
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  activatePolicy,
  getCurrentPolicy,
  listPolicyHistory,
  saveDraftPolicy,
} from '../services/attendance/attendancePolicyService.js';

export const getAttendancePolicy = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const result = await getCurrentPolicy({ companyId: req.companyId });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.configured ? 'Attendance policy fetched' : 'Attendance policy not configured',
    data: result.policy,
    meta: { configured: result.configured, hasActive: result.hasActive },
  });
});

export const saveAttendancePolicyDraft = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { expectedConfigVersion, ...input } = req.body || {};
  // DB Logic - DB logics
  const result = await saveDraftPolicy({
    companyId: req.companyId,
    input,
    actor: req.user,
    req,
    expectedConfigVersion: expectedConfigVersion ?? null,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.created ? 'Attendance policy draft created' : 'Attendance policy draft saved',
    data: result.policy,
    meta: { created: result.created },
  });
});

export const activateAttendancePolicy = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { expectedConfigVersion } = req.body || {};
  // DB Logic - DB logics
  const result = await activatePolicy({
    companyId: req.companyId,
    actor: req.user,
    req,
    expectedConfigVersion: expectedConfigVersion ?? null,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Attendance policy activated',
    data: result.policy,
  });
});

export const getAttendancePolicyHistory = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { limit } = req.query;
  // DB Logic - DB logics
  const result = await listPolicyHistory({ companyId: req.companyId, limit });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Attendance policy history fetched',
    data: result.history,
  });
});
