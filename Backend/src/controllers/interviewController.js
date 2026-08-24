import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  cancelInterview,
  getCandidateInterviews,
  getInterviewDetail,
  getInterviewOptions,
  listInterviews,
  listMyInterviews,
  rescheduleInterview,
  scheduleInterview,
  updateInterviewStatus,
} from '../services/interviewService.js';

export const interviewOptions = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;

  // DB Logic - DB logics
  const result = await getInterviewOptions({ companyId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Interview options fetched',
    data: result,
  });
});

export const interviewEligibleInterviewers = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;

  // DB Logic - DB logics
  const result = await getInterviewOptions({ companyId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Eligible interviewers fetched',
    data: result.interviewers,
  });
});

export const interviewSchedule = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const input = req.body;

  // DB Logic - DB logics
  const result = await scheduleInterview({
    companyId: req.companyId,
    actor: req.user,
    input,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    statusCode: 201,
    message: result.stageTransition?.warning
      ? 'Interview scheduled; review the pipeline stage warning'
      : 'Interview scheduled',
    data: result,
  });
});

export const interviewList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query;

  // DB Logic - DB logics
  const result = await listInterviews({
    companyId: req.companyId,
    query,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Interviews fetched',
    data: result.interviews,
    meta: { ...result.meta, kpis: result.kpis },
  });
});

export const myInterviewList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query;

  // DB Logic - DB logics
  const result = await listMyInterviews({
    companyId: req.companyId,
    actor: req.user,
    query,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Assigned interviews fetched',
    data: result.interviews,
    meta: { ...result.meta, kpis: result.kpis },
  });
});

export const candidateInterviewList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateRef } = req.params;

  // DB Logic - DB logics
  const result = await getCandidateInterviews({
    companyId: req.companyId,
    candidateRef,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Candidate interviews fetched',
    data: result,
  });
});

export const interviewDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id: interviewId } = req.params;

  // DB Logic - DB logics
  const result = await getInterviewDetail({
    companyId: req.companyId,
    interviewId,
    actor: req.user,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Interview fetched',
    data: result,
  });
});

export const interviewReschedule = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id: interviewId } = req.params;
  const input = req.body;

  // DB Logic - DB logics
  const result = await rescheduleInterview({
    companyId: req.companyId,
    interviewId,
    actor: req.user,
    input,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Interview rescheduled',
    data: result,
  });
});

export const interviewCancel = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id: interviewId } = req.params;
  const { reason } = req.body;

  // DB Logic - DB logics
  const result = await cancelInterview({
    companyId: req.companyId,
    interviewId,
    actor: req.user,
    reason,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Interview cancelled',
    data: result,
  });
});

export const interviewStatusUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id: interviewId } = req.params;
  const { status, reason = '' } = req.body;

  // DB Logic - DB logics
  const result = await updateInterviewStatus({
    companyId: req.companyId,
    interviewId,
    actor: req.user,
    targetStatus: status,
    reason,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `Interview marked ${status.toLowerCase().replaceAll('_', ' ')}`,
    data: result,
  });
});
