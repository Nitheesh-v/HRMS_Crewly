import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  assignBgvVerifier,
  cancelBackgroundVerification,
  completeBackgroundVerification,
  createBgvCheckType,
  getBackgroundVerification,
  getBgvSettings,
  getCandidateBgvSummary,
  listBackgroundVerifications,
  listBgvCheckTypes,
  startBackgroundVerification,
  updateBgvCheck,
  updateBgvCheckType,
  updateBgvSettings,
} from '../services/backgroundVerificationService.js';

const actorId = (req) => req.user._id;

export const bgvSettingsRead = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  // DB Logic - DB logics
  const data = await getBgvSettings({
    companyId: req.companyId,
    actorId: actorId(req),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV settings fetched',
    data,
  });
});

export const bgvSettingsUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const payload = req.body || {};
  // DB Logic - DB logics
  const data = await updateBgvSettings({
    companyId: req.companyId,
    actorId: actorId(req),
    payload,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV settings updated',
    data,
  });
});

export const bgvCheckTypeList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  // DB Logic - DB logics
  const data = await listBgvCheckTypes({
    companyId: req.companyId,
    actorId: actorId(req),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV check types fetched',
    data,
  });
});

export const bgvCheckTypeCreate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const payload = req.body || {};
  // DB Logic - DB logics
  const data = await createBgvCheckType({
    companyId: req.companyId,
    actorId: actorId(req),
    payload,
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'BGV check type created',
    data,
  });
});

export const bgvCheckTypeUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { checkTypeId } = req.params;
  const payload = req.body || {};
  // DB Logic - DB logics
  const data = await updateBgvCheckType({
    companyId: req.companyId,
    actorId: actorId(req),
    checkTypeId,
    payload,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV check type updated',
    data,
  });
});

export const bgvCaseList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query || {};
  // DB Logic - DB logics
  const result = await listBackgroundVerifications({
    companyId: req.companyId,
    query,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV cases fetched',
    data: result.cases,
    meta: result.meta,
  });
});

export const bgvCaseDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { caseId } = req.params;
  // DB Logic - DB logics
  const data = await getBackgroundVerification({
    companyId: req.companyId,
    caseId,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV case fetched',
    data,
  });
});

export const bgvCaseStart = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;
  // DB Logic - DB logics
  const data = await startBackgroundVerification({
    companyId: req.companyId,
    candidateRef: candidateId,
    actorId: actorId(req),
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: data.idempotent
      ? 'BGV case already exists'
      : 'Background verification started',
    data,
  });
});

export const bgvCaseAssign = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { caseId } = req.params;
  const verifierId = req.body?.verifierId;
  // DB Logic - DB logics
  const data = await assignBgvVerifier({
    companyId: req.companyId,
    caseId,
    actorId: actorId(req),
    verifierId,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Verifier assigned',
    data,
  });
});

export const bgvCheckUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { caseId, checkId } = req.params;
  const payload = req.body || {};
  // DB Logic - DB logics
  const data = await updateBgvCheck({
    companyId: req.companyId,
    caseId,
    checkId,
    actorId: actorId(req),
    payload,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV check updated',
    data,
  });
});

export const bgvCaseComplete = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { caseId } = req.params;
  const payload = req.body || {};
  // DB Logic - DB logics
  const data = await completeBackgroundVerification({
    companyId: req.companyId,
    caseId,
    actorId: actorId(req),
    payload,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.idempotent
      ? 'BGV case was already completed'
      : 'Background verification completed',
    data,
  });
});

export const bgvCaseCancel = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { caseId } = req.params;
  const reason = req.body?.reason;
  // DB Logic - DB logics
  const data = await cancelBackgroundVerification({
    companyId: req.companyId,
    caseId,
    actorId: actorId(req),
    reason,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.idempotent
      ? 'BGV case was already cancelled'
      : 'Background verification cancelled',
    data,
  });
});

export const candidateBgvSummary = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;
  // DB Logic - DB logics
  const data = await getCandidateBgvSummary({
    companyId: req.companyId,
    candidateRef: candidateId,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Candidate BGV summary fetched',
    data,
  });
});
