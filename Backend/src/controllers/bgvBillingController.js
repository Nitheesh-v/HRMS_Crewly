import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import {
  bgvBillingOverview,
  bgvAwaitingCandidateResponses,
  cancelUnansweredBgvRequest,
} from '../services/bgv/bgvBillingService.js';

// GET /api/super-admin/bgv-billing/overview
export const bgvBilling = asyncHandler(async (req, res) => {
  // Data from frontend - filter choices only (status/page/pageSize)
  const { status, page, pageSize } = req.query;

  // DB Logic - read-only reporting over immutable order snapshots;
  // platform session + permit() are the only authority.
  const data = await bgvBillingOverview({
    filters: { status, page, pageSize },
  });

  // Data to frontend - billing rows + revenue summary
  return ApiResponse.success(res, { message: 'BGV billing overview', data });
});

// GET /api/super-admin/bgv-billing/awaiting-candidate
export const bgvAwaitingCandidate = asyncHandler(async (req, res) => {
  // Data from frontend - paging only
  const { page, pageSize } = req.query;

  // DB Logic - PAID orders whose latest consent invitation is unanswered;
  // the server computes expired/cancellable, the client never decides.
  const data = await bgvAwaitingCandidateResponses({ filters: { page, pageSize } });

  // Data to frontend - unanswered-request rows
  return ApiResponse.success(res, { message: 'BGV requests awaiting candidate', data });
});

// POST /api/super-admin/bgv-billing/cancel/:orderId
export const cancelUnansweredBgv = asyncHandler(async (req, res) => {
  // Data from frontend - reason for the stale-cancel
  const { orderId } = req.params;
  const { reason } = req.body;

  // DB Logic - platform stale-cancel: only after the invitation expired,
  // reason >= 10 chars, token revoked, SystemEvent audit; releases the
  // candidate (openKey cleared). Actor comes from the platform session.
  const data = await cancelUnansweredBgvRequest({
    orderId,
    reason,
    actorId: req.user?._id,
  });

  // Data to frontend - cancelled confirmation
  return ApiResponse.success(res, { message: 'Unanswered BGV request cancelled', data });
});
