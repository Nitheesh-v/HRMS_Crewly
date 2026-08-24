import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  recordCandidateFinalDecision,
  startCandidateFinalReview,
} from '../services/candidateDecisionService.js';

export const candidateFinalReviewStart = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;
  const input = req.body;

  // DB Logic - DB logics
  const result = await startCandidateFinalReview({
    companyId: req.companyId,
    candidateId,
    actor: req.user,
    input,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.idempotent
      ? 'Candidate is already in Final Review'
      : 'Final Review started',
    data: result,
  });
});

export const candidateFinalDecisionCreate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;
  const input = req.body;

  // DB Logic - DB logics
  const result = await recordCandidateFinalDecision({
    companyId: req.companyId,
    candidateId,
    actor: req.user,
    input,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.idempotent
      ? 'This human decision was already recorded'
      : 'Human candidate decision recorded',
    data: result,
  });
});
