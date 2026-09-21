import ApiResponse from '../../utils/ApiResponse.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { resolveUserPermissions } from '../../utils/permissionService.js';
import {
  cancelWorkModeRequest,
  decideWorkModeRequest,
  getWorkModeRequest,
  listMyWorkModeRequests,
  listPendingWorkModeRequests,
  submitWorkModeRequest,
} from '../../services/attendance/attendanceWorkModeService.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.4 — work-mode request controllers (thin).
// Rules live in services/attendance/attendanceWorkModeRules.js;
// orchestration in services/attendance/attendanceWorkModeService.js.
// Employee identity ALWAYS derives from req.user; reviewers are
// scoped inside the service via the established org helpers.
// ─────────────────────────────────────────────────────────────

// Cached grant check (5-min TTL): reviewers read/cancel in-scope
// requests through the same self-service routes owners use.
const holdsReviewGrant = async (user) => {
  try {
    const { allowed } = await resolveUserPermissions(user);
    return allowed?.has('ATTENDANCE_WORK_MODE_REVIEW') === true;
  } catch {
    return false;
  }
};

export const submitAttendanceWorkModeRequest = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const created = await submitWorkModeRequest({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    requester: req.user,
    input: req.body || {},
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: 'Work-mode request submitted', data: created });
});

export const listMyAttendanceWorkModeRequests = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const mine = await listMyWorkModeRequests({
    companyId: req.companyId,
    userId: req.user._id,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'My work-mode requests', data: mine });
});

export const listPendingAttendanceWorkModeRequests = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const pending = await listPendingWorkModeRequests({
    companyId: req.companyId,
    viewer: req.user,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Pending work-mode requests', data: pending });
});

export const getAttendanceWorkModeRequest = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const row = await getWorkModeRequest({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    asReviewer: await holdsReviewGrant(req.user),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Work-mode request', data: row });
});

export const cancelAttendanceWorkModeRequest = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const cancelled = await cancelWorkModeRequest({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    asReviewer: await holdsReviewGrant(req.user),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Work-mode request cancelled', data: cancelled });
});

export const approveAttendanceWorkModeRequest = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const decided = await decideWorkModeRequest({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    action: 'APPROVE',
    reviewReason: req.body?.reviewReason ?? null,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Work-mode request approved', data: decided });
});

export const rejectAttendanceWorkModeRequest = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const decided = await decideWorkModeRequest({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    action: 'REJECT',
    reviewReason: req.body?.reviewReason ?? null,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Work-mode request rejected', data: decided });
});
