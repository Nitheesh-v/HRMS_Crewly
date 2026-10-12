// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 38 — PROFILE CHANGE REQUEST CONTROLLER (HTTP layer)
//
//  Six thin handlers. Every one follows the repo's three-comment
//  convention: `// Data from frontend`, `// DB Logic`, `// Data to frontend`.
//
//  IDENTITY RULE
//    The controller never trusts a payload for companyId, employeeId,
//    reviewer or status. All of that comes from authMiddleware /
//    tenantMiddleware (req.companyId, req.user).
//
//  READ GATES
//    Self-service reads need no permission gate — the SERVICE scopes the
//    query to the caller's own id. Reviewer endpoints sit behind
//    requirePermission('PROFILE_CHANGE_REVIEW') at the router, and the
//    service re-checks the org scope, so bypassing the UI buys nothing.
// ═══════════════════════════════════════════════════════════════════════════

import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { profileChangeService } from '../services/profile/profileChangeService.js';

const service = profileChangeService();

// POST /api/profile/change-requests
export const submitProfileChangeRequest = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  // (companyId + employee identity come from the token, never the body.)
  // DB Logic - the service snapshots the current values and persists the diff.
  const created = await service.submitRequest({
    companyId: req.companyId,
    requester: req.user,
    input: req.body || {},
  });

  // Data to frontend - response to frontend (masks applied inside)
  return ApiResponse.created(res, {
    message: 'Profile change request submitted for review',
    data: created,
  });
});

// GET /api/profile/change-requests/me
export const listMyProfileChangeRequests = asyncHandler(async (req, res) => {
  // DB Logic - own requests only, tenant-scoped
  const mine = await service.listMyRequests({
    companyId: req.companyId,
    employeeId: req.user._id,
  });

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'My profile change requests',
    data: { requests: mine },
  });
});

// GET /api/profile/change-requests/pending
export const listPendingProfileChangeRequests = asyncHandler(async (req, res) => {
  // DB Logic - the reviewer queue, already narrowed to the caller's scope
  const queue = await service.listReviewQueue({
    companyId: req.companyId,
    viewer: req.user,
    status: 'pending',
  });

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Pending profile change requests',
    data: { requests: queue },
  });
});

// GET /api/profile/change-requests/history
export const listProfileChangeHistory = asyncHandler(async (req, res) => {
  // DB Logic - decided rows (approved / rejected / cancelled)
  const queue = await service.listReviewQueue({
    companyId: req.companyId,
    viewer: req.user,
    status: req.query.status || 'approved',
  });

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Profile change request history',
    data: { requests: queue },
  });
});

// GET /api/profile/change-requests/:requestId
export const getProfileChangeRequest = asyncHandler(async (req, res) => {
  // Data from frontend - requestId only
  // DB Logic - owner OR scoped reviewer, decided by the service
  const row = await service.getRequest({
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    asReviewer: true,
  });

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Profile change request',
    data: row,
  });
});

// POST /api/profile/change-requests/:requestId/approve
export const approveProfileChangeRequest = asyncHandler(async (req, res) => {
  // Data from frontend - requestId (+ optional note)
  // DB Logic - claim → apply to the employee record → audit
  const decided = await service.decideRequest({
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    action: 'approve',
    decisionNote: req.body?.decisionNote ?? '',
  });

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Profile change approved and applied',
    data: decided,
  });
});

// POST /api/profile/change-requests/:requestId/reject
export const rejectProfileChangeRequest = asyncHandler(async (req, res) => {
  // Data from frontend - requestId + a reason the employee can act on
  // DB Logic - the profile is NOT touched; only the decision is recorded
  const decided = await service.decideRequest({
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    action: 'reject',
    decisionNote: req.body?.decisionNote ?? '',
  });

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Profile change rejected',
    data: decided,
  });
});

// POST /api/profile/change-requests/:requestId/cancel
export const cancelProfileChangeRequest = asyncHandler(async (req, res) => {
  // Data from frontend
  // DB Logic - owner or reviewer may withdraw a still-pending request
  const cancelled = await service.cancelRequest({
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
  });

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Profile change request cancelled',
    data: cancelled,
  });
});

export default {
  submitProfileChangeRequest,
  listMyProfileChangeRequests,
  listPendingProfileChangeRequests,
  listProfileChangeHistory,
  getProfileChangeRequest,
  approveProfileChangeRequest,
  rejectProfileChangeRequest,
  cancelProfileChangeRequest,
};
