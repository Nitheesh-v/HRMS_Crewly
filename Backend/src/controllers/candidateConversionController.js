import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  convertCandidateToEmployee,
  getConversionPreview,
  getEmployeeRecruitmentOrigin,
  resendConversionAccountSetup,
} from '../services/candidateConversionService.js';

const actor = (req) => ({
  id: req.user._id,
  name: req.user.name,
  role: req.user.role,
});

export const conversionPreview = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const candidateRef = req.params.candidateId;
  // DB Logic - DB logics
  const data = await getConversionPreview({
    companyId: req.companyId,
    candidateRef,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Conversion preview fetched',
    data,
  });
});

export const convertToEmployee = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const candidateRef = req.params.candidateId;
  const payload = req.body || {};
  // DB Logic - DB logics
  const result = await convertCandidateToEmployee({
    companyId: req.companyId,
    candidateRef,
    actor: actor(req),
    payload,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: result.idempotent
      ? 'Candidate was already converted'
      : 'Candidate converted to employee',
    data: {
      employee: result.employee,
      conversion: result.conversion,
      ...(result.meta ? { meta: result.meta } : {}),
    },
  });
});

export const resendEmployeeAccountSetup = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const employeeId = req.params.employeeId;
  // DB Logic - DB logics
  const result = await resendConversionAccountSetup({
    companyId: req.companyId,
    employeeId,
    actorId: req.user._id,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.delivered
      ? 'Account setup invitation resent'
      : 'Account setup invitation could not be delivered',
    data: result,
  });
});

export const employeeRecruitmentOrigin = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const employeeId = req.params.employeeId || req.params.id;
  // DB Logic - DB logics
  const data = await getEmployeeRecruitmentOrigin({
    companyId: req.companyId,
    employeeId,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Recruitment origin fetched',
    data,
  });
});
