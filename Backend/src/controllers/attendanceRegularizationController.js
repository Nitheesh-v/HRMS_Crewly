import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { resolveUserPermissions } from '../utils/permissionService.js';
import {
  cancelRegularization,
  decideRegularization,
  getRegularization,
  listMyRegularizations,
  listPendingRegularizations,
  submitRegularization,
} from '../services/attendance/attendanceRegularizationService.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.5 — attendance regularization controllers (thin).
// Rules live in services/attendance/attendanceRegularizationRules.js;
// orchestration in services/attendance/attendanceRegularizationService.js.
// Employee identity ALWAYS derives from req.user; reviewers are
// scoped inside the service via the established org helpers.
// ─────────────────────────────────────────────────────────────

// Cached grant check (5-min TTL): reviewers read/cancel in-scope
// requests through the same self-service routes owners use.
const holdsReviewGrant = async (user) => {
  try {
    const { allowed } = await resolveUserPermissions(user);
    return allowed?.has('ATTENDANCE_REGULARIZATION_REVIEW') === true;
  } catch {
    return false;
  }
};

export const submitAttendanceRegularization = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const created = await submitRegularization({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    requester: req.user,
    input: req.body || {},
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: 'Regularization request submitted', data: created });
});

export const listMyAttendanceRegularizations = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const mine = await listMyRegularizations({
    companyId: req.companyId,
    userId: req.user._id,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'My regularization requests', data: mine });
});

export const listPendingAttendanceRegularizations = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const pending = await listPendingRegularizations({
    companyId: req.companyId,
    viewer: req.user,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Pending regularization requests', data: pending });
});

export const getAttendanceRegularization = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const row = await getRegularization({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    asReviewer: await holdsReviewGrant(req.user),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Regularization request', data: row });
});

export const cancelAttendanceRegularization = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const cancelled = await cancelRegularization({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Regularization request cancelled', data: cancelled });
});

export const approveAttendanceRegularization = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const decided = await decideRegularization({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    action: 'APPROVE',
    reviewReason: req.body?.reviewReason ?? null,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Regularization request approved', data: decided });
});

export const rejectAttendanceRegularization = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const decided = await decideRegularization({
    // Data from frontend - requests from frontend
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    action: 'REJECT',
    reviewReason: req.body?.reviewReason ?? null,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Regularization request rejected', data: decided });
});
