import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getRecruitmentAnalyticsOverview } from '../services/recruitmentAnalyticsService.js';

export const recruitmentAnalyticsOverview = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query || {};
  // DB Logic - DB logics
  const data = await getRecruitmentAnalyticsOverview({
    companyId: req.companyId,
    query,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Recruitment analytics fetched',
    data,
  });
});
