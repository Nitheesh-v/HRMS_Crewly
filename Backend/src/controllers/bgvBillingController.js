import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { bgvBillingOverview } from '../services/bgv/bgvBillingService.js';

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
