// Phase 30.7 — BGV check assignment operations (Super Admin / platform).
//
// Authority: assignment management is a PLATFORM operational action.
// Tenant tokens never reach these routes (the platform gate rejects them
// before any platform data is read); tenant RBAC is NOT an authority here.
// Queue payloads carry safe operational context only — order reference,
// tenant company, candidate display name, check type, submission age,
// assignment state — never raw documents or identifiers.

import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { cancelCheckByOperations } from '../services/bgv/bgvWorkbenchService.js';
import {
  assignCheck,
  eligibleVerifiersForCheck,
  getHrAssignmentStatus,
  listOperationsQueue,
  reassignCheck,
  unassignCheck,
} from '../services/bgv/bgvAssignmentService.js';

// GET /api/super-admin/bgv-operations/queue
export const bgvOperationsQueue = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend (platform principal only)
  // DB Logic - submitted cases × purchased checks × current assignments
  const data = await listOperationsQueue({});
  // Data to frontend - response to frontend (safe queue rows, no evidence)
  return ApiResponse.success(res, { message: 'BGV operations queue', data });
});

// GET /api/super-admin/bgv-operations/checks/:checkType/eligible-verifiers
export const bgvOperationsEligibleVerifiers = asyncHandler(async (req, res) => {
  // Data from frontend - check type from the operations UI
  const { checkType } = req.params;
  // DB Logic - ACTIVE verifiers holding this specialization (backend filter;
  // the frontend filter is a convenience only)
  const verifiers = await eligibleVerifiersForCheck({ checkType });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Eligible verifiers', data: { verifiers } });
});

// POST /api/super-admin/bgv-operations/assign
export const bgvOperationsAssign = asyncHandler(async (req, res) => {
  // Data from frontend - order, check, verifier (platform operator picks)
  const { orderId, checkType, verifierId, reason } = req.body;
  // DB Logic - readiness gates + atomic unique-index assignment
  const data = await assignCheck({
    actorId: req.user?._id ?? null,
    orderId,
    checkType,
    verifierId,
    reason,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Check assigned', data });
});

// POST /api/super-admin/bgv-operations/reassign
export const bgvOperationsReassign = asyncHandler(async (req, res) => {
  // Data from frontend - new verifier + reason (reason required by service)
  const { orderId, checkType, verifierId, reason } = req.body;
  // DB Logic - eligibility revalidated + atomic conditional update + history
  const data = await reassignCheck({
    actorId: req.user?._id ?? null,
    orderId,
    checkType,
    newVerifierId: verifierId,
    reason,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Check reassigned', data });
});

// POST /api/super-admin/bgv-operations/unassign
export const bgvOperationsUnassign = asyncHandler(async (req, res) => {
  // Data from frontend - order + check (+ optional reason)
  const { orderId, checkType, reason } = req.body;
  // DB Logic - allowed only before work starts (ASSIGNED); history preserved
  const data = await unassignCheck({
    actorId: req.user?._id ?? null,
    orderId,
    checkType,
    reason,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Check unassigned', data });
});

// POST /api/super-admin/bgv-operations/cancel-check
export const bgvOperationsCancelCheck = asyncHandler(async (req, res) => {
  // Data from frontend - order + check + business reason (min 10 chars)
  const { orderId, checkType, reason } = req.body;

  // DB Logic - platform-only cancellation with a locked CANCELLED
  // conclusion; verifiers never see CANCELLED as a choice
  const data = await cancelCheckByOperations({
    actorId: req.user?._id ?? null,
    orderId,
    checkType,
    reason,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Check cancelled', data });
});
