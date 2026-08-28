import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { recordAudit } from '../utils/securityauditService.js';
import { getCandidateParsedResume } from '../services/candidateInboxService.js';
import { dispatchResumeProcessing } from '../services/resumeProcessingDispatcher.js';
import { requestResumeReprocess } from '../services/resumeProcessingService.js';

export const candidateParsedResumeRead = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateRef } = req.params;

  // DB Logic - DB logics
  const result = await getCandidateParsedResume({
    companyId: req.companyId,
    candidateRef,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Parsed resume fetched',
    data: result,
  });
});

export const candidateResumeReprocess = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateRef } = req.params;

  // DB Logic - DB logics
  const result = await requestResumeReprocess({
    companyId: req.companyId,
    candidateRef,
    actorId: req.user._id,
  });

  await recordAudit({
    req,
    action: 'RESUME_REPROCESS_REQUESTED',
    companyId: req.companyId,
    resource: 'CandidateResume',
    resourceId: result.resume._id,
    statusCode: 202,
    metadata: {
      candidateCode: result.candidate.candidateCode,
      parserVersion: result.parserVersion,
      status: result.status,
      attempt: result.resume.parsingAttempts,
    },
    critical: true,
  });

  // 28.4: async BullMQ dispatch (never throws — the RETRY_PENDING
  // Mongo intent is the recovery source if the queue is down).
  void dispatchResumeProcessing({
    companyId: req.companyId,
    candidateId: result.candidate._id,
    resumeId: result.resume._id,
    parsingRequestedAt: result.resume.parsingRequestedAt,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    statusCode: 202,
    message: 'Resume reprocessing scheduled',
    data: {
      candidateCode: result.candidate.candidateCode,
      status: result.status,
      parserVersion: result.parserVersion,
      requestedAt: result.resume.parsingRequestedAt,
    },
  });
});
