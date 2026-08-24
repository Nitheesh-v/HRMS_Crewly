import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  bulkCandidateAction,
  getPipelineOptions,
  transitionCandidateStage,
} from '../services/candidatePipelineService.js';

export const candidatePipelineOptions = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;

  // DB Logic - DB logics
  const result = await getPipelineOptions({ companyId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Candidate pipeline options fetched',
    data: result,
  });
});

export const candidatePipelineStageUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id: candidateId } = req.params;
  const { stage, reason = '' } = req.body;

  // DB Logic - DB logics
  const result = await transitionCandidateStage({
    companyId: req.companyId,
    candidateId,
    targetStage: stage,
    reason,
    actorId: req.user._id,
    metadata: { source: 'MANUAL', bulk: false },
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `Candidate moved to ${result.toStage}`,
    data: result,
  });
});

export const candidatePipelineBulkAction = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const {
    candidateIds,
    action,
    targetStage = '',
    reason = '',
    userId = null,
  } = req.body;

  // DB Logic - DB logics
  const result = await bulkCandidateAction({
    companyId: req.companyId,
    companyName: req.company?.name || 'The hiring team',
    candidateIds,
    action,
    targetStage,
    reason,
    userId,
    actorId: req.user._id,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.failed.length
      ? 'Bulk candidate action completed with some failures'
      : 'Bulk candidate action completed',
    data: result,
  });
});
