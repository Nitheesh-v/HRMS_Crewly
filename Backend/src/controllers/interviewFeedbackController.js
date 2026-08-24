import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  getAllSubmittedInterviewFeedback,
  getOwnInterviewFeedback,
  getOwnInterviewScorecard,
  saveOwnInterviewFeedback,
} from '../services/interviewFeedbackService.js';

export const interviewScorecardRead = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id: interviewId } = req.params;

  // DB Logic - DB logics
  const result = await getOwnInterviewScorecard({
    companyId: req.companyId,
    interviewId,
    actorId: req.user._id,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Interview scorecard fetched',
    data: result,
  });
});

export const myInterviewFeedbackRead = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id: interviewId } = req.params;

  // DB Logic - DB logics
  const result = await getOwnInterviewFeedback({
    companyId: req.companyId,
    interviewId,
    actorId: req.user._id,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Your interview feedback fetched',
    data: result,
  });
});

export const myInterviewFeedbackSave = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id: interviewId } = req.params;
  const input = req.body;

  // DB Logic - DB logics
  const result = await saveOwnInterviewFeedback({
    companyId: req.companyId,
    interviewId,
    actor: req.user,
    input,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message:
      result.status === 'SUBMITTED'
        ? result.idempotent
          ? 'Interview feedback was already submitted'
          : 'Interview feedback submitted'
        : 'Interview feedback draft saved',
    data: result,
  });
});

export const interviewSubmittedFeedbackRead = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id: interviewId } = req.params;

  // DB Logic - DB logics
  const result = await getAllSubmittedInterviewFeedback({
    companyId: req.companyId,
    interviewId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Submitted interview feedback fetched',
    data: result,
  });
});
