import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { dispatchATSMatching } from '../services/atsDispatcher.js';
import {
  getCandidateATSResult,
  prepareATSReprocess,
} from '../services/atsMatchingService.js';

export const candidateATSResultRead = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;

  // DB Logic - DB logics
  const result = await getCandidateATSResult({
    companyId: req.companyId,
    candidateRef: candidateId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'ATS analysis fetched',
    data: result,
  });
});

export const candidateATSReprocess = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;

  // DB Logic - DB logics
  const prepared = await prepareATSReprocess({
    companyId: req.companyId,
    candidateRef: candidateId,
    actorId: req.user._id,
  });
  // 28.4: async BullMQ dispatch (never throws). The recalculation
  // intent (recalculationPending) is ALREADY persisted in Mongo, so
  // even a queue/Redis outage loses no work — recovery re-derives it.
  await dispatchATSMatching({
    companyId: req.companyId,
    candidateId: prepared.candidate._id,
    jobId: prepared.job._id,
    resumeId: prepared.resume._id,
    parseResultId: prepared.parseResult._id,
    trigger: 'MANUAL_REPROCESS',
    actorId: req.user._id,
    requestEpoch: prepared.requestedAt,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    statusCode: 202,
    message: 'ATS recalculation scheduled',
    data: {
      status: 'MATCHING_PENDING',
      candidateCode: prepared.candidate.candidateCode,
      requestedAt: prepared.requestedAt,
    },
  });
});
