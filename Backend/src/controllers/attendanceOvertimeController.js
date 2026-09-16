import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { resolveUserPermissions } from '../utils/permissionService.js';
import {
  approveOvertimeRequest,
  cancelOvertimeRequest,
  getOvertimeRequest,
  listMyEligibility,
  listMyOvertimeRequests,
  listPendingOvertimeRequests,
  rejectOvertimeRequest,
  submitOvertimeRequest,
} from '../services/attendance/attendanceOvertimeService.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.8 — overtime / comp-off controllers (thin).
// Rules live in services/attendance/attendanceOvertimeRules.js;
// orchestration in services/attendance/attendanceOvertimeService.js.
// Employee identity ALWAYS derives from req.user; reviewers are
// scoped inside the service via the established org helpers.
// ─────────────────────────────────────────────────────────────

// Cached grant check (5-min TTL): reviewers read/cancel in-scope
// requests through the same self-service routes owners use.
const holdsReviewGrant = async (user) => {
  try {
    const { allowed } = await resolveUserPermissions(user);
    return allowed?.has('ATTENDANCE_OVERTIME_REVIEW') === true;
  } catch {
    return false;
  }
};

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

export const getOvertimeEligibility = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const to = req.query.to || todayKey();
  const from = req.query.from || `${String(to).slice(0, 7)}-01`;
  // DB Logic - DB logics
  const eligibility = await listMyEligibility({
    companyId: req.companyId,
    user: req.user,
    from,
    to,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Overtime eligibility', data: eligibility });
});

export const submitAttendanceOvertime = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const created = await submitOvertimeRequest({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    requester: req.user,
    type: req.body?.type,
    attendanceDate: req.body?.attendanceDate,
    requestedMinutes: req.body?.requestedMinutes,
    reason: req.body?.reason,
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: 'Overtime request submitted', data: created });
});

export const listMyAttendanceOvertime = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const mine = await listMyOvertimeRequests({
    companyId: req.companyId,
    userId: req.user._id,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'My overtime requests', data: mine });
});

export const listPendingAttendanceOvertime = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const pending = await listPendingOvertimeRequests({
    companyId: req.companyId,
    viewer: req.user,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Pending overtime requests', data: pending });
});

export const getAttendanceOvertime = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const row = await getOvertimeRequest({
    companyId: req.companyId,
    viewer: req.user,
    // Data from frontend - requests from frontend
    requestId: req.params.requestId,
    asReviewer: await holdsReviewGrant(req.user),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Overtime request', data: row });
});

export const cancelAttendanceOvertime = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const cancelled = await cancelOvertimeRequest({
    companyId: req.companyId,
    viewer: req.user,
    // Data from frontend - requests from frontend
    requestId: req.params.requestId,
    asReviewer: await holdsReviewGrant(req.user),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Overtime request cancelled', data: cancelled });
});

export const approveAttendanceOvertime = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const decided = await approveOvertimeRequest({
    companyId: req.companyId,
    viewer: req.user,
    // Data from frontend - requests from frontend
    requestId: req.params.requestId,
    approvedMinutes: req.body?.approvedMinutes,
    reviewReason: req.body?.reviewReason ?? null,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Overtime request approved', data: decided });
});

export const rejectAttendanceOvertime = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const decided = await rejectOvertimeRequest({
    companyId: req.companyId,
    viewer: req.user,
    // Data from frontend - requests from frontend
    requestId: req.params.requestId,
    reviewReason: req.body?.reviewReason ?? null,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Overtime request rejected', data: decided });
});
