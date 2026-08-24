import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { submitCandidateApplication } from '../services/candidateApplicationService.js';

export const publicCandidateApplication = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { companySlug, jobCode } = req.params;
  const fields = req.body;

  // DB Logic - DB logics
  const result = await submitCandidateApplication({
    companySlug,
    jobCode,
    fields,
    file: req.file,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    statusCode: 202,
    message: 'Your application has been received.',
    data: result,
  });
});
