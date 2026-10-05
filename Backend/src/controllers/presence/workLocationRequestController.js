// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST CONTROLLER (HTTP layer)
//
//  Seven handlers, all thin. Every handler follows the three-comment
//  convention used by the rest of the repo: `// Data from frontend`,
//  `// DB Logic`, `// Data to frontend`.
//
//  Identity rule (spec §9, §19, §43): the controller never trusts a
//  payload for `companyId`, `userId`, `employeeId`, `approverId`, or
//  `reviewedBy`. All of those come from the auth middleware.
// ═══════════════════════════════════════════════════════════════════════════

import ApiResponse from '../../utils/ApiResponse.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { resolveUserPermissions } from '../../utils/permissionService.js';
import {
  workLocationRequestService,
} from '../../services/presence/workLocationRequestService.js';

const service = workLocationRequestService();

// 5-min TTL grant cache (matches 31.4 attendanceWorkModeController).
const grantCache = new Map();
const GRANT_TTL_MS = 5 * 60 * 1000;

const holdsReviewGrant = async (user) => {
  if (!user) return false;
  const key = String(user._id || user.id);
  const cached = grantCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  try {
    const { allowed } = await resolveUserPermissions(user);
    const value = allowed?.has('PRESENCE_WORK_MODE_REVIEW') === true;
    grantCache.set(key, { value, expiresAt: Date.now() + GRANT_TTL_MS });
    return value;
  } catch {
    return false;
  }
};

const resetGrantCacheForTests = () => grantCache.clear();
const _test = { resetGrantCacheForTests };

// POST /api/presence/work-location-requests
export const submitWorkLocationRequest = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  // (companyId and userId come from req; the validator refused any
  // client-supplied identity field in req.body.)
  // DB Logic
  const created = await service.submitRequest({
    companyId: req.companyId,
    requester: req.user,
    input: req.body || {},
  });
  // Data to frontend
  return ApiResponse.created(res, {
    message: 'WFH request submitted',
    data: created,
  });
});

// GET /api/presence/work-location-requests/me
export const listMyWorkLocationRequests = asyncHandler(async (req, res) => {
  // DB Logic
  const mine = await service.listMyRequests({
    companyId: req.companyId,
    userId: req.user._id,
  });
  // Data to frontend
  return ApiResponse.success(res, {
    message: 'My WFH requests',
    data: mine,
  });
});

// GET /api/presence/work-location-requests/pending
export const listPendingWorkLocationRequests = asyncHandler(async (req, res) => {
  // DB Logic
  const queue = await service.listReviewQueue({
    companyId: req.companyId,
    viewer: req.user,
  });
  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Pending WFH requests',
    data: { requests: queue },
  });
});

// GET /api/presence/work-location-requests/:requestId
export const getWorkLocationRequest = asyncHandler(async (req, res) => {
  // Data from frontend
  // DB Logic
  const row = await service.getRequest({
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    asReviewer: await holdsReviewGrant(req.user),
  });
  // Data to frontend
  return ApiResponse.success(res, {
    message: 'WFH request',
    data: row,
  });
});

// POST /api/presence/work-location-requests/:requestId/cancel
export const cancelWorkLocationRequest = asyncHandler(async (req, res) => {
  // DB Logic
  const cancelled = await service.cancelRequest({
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
  });
  // Data to frontend
  return ApiResponse.success(res, {
    message: 'WFH request cancelled',
    data: cancelled,
  });
});

// POST /api/presence/work-location-requests/:requestId/approve
export const approveWorkLocationRequest = asyncHandler(async (req, res) => {
  // Data from frontend
  // DB Logic
  const decided = await service.decideRequest({
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    action: 'approve',
    decisionNote: req.body?.decisionNote ?? null,
  });
  // Data to frontend
  return ApiResponse.success(res, {
    message: 'WFH request approved',
    data: decided,
  });
});

// POST /api/presence/work-location-requests/:requestId/reject
export const rejectWorkLocationRequest = asyncHandler(async (req, res) => {
  // Data from frontend
  // DB Logic
  const decided = await service.decideRequest({
    companyId: req.companyId,
    viewer: req.user,
    requestId: req.params.requestId,
    action: 'reject',
    decisionNote: req.body?.decisionNote ?? null,
  });
  // Data to frontend
  return ApiResponse.success(res, {
    message: 'WFH request rejected',
    data: decided,
  });
});

export const __test__ = _test;
