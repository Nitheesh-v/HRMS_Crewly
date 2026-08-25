import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  createDocumentRequirement,
  deactivateDocumentRequirement,
  getCandidateDocumentFile,
  getPreOnboarding,
  listDocumentRequirements,
  listPreOnboardings,
  markPreOnboardingReady,
  rejectCandidateDocument,
  resendPreOnboardingInvite,
  startPreOnboarding,
  updateDocumentRequirement,
  verifyCandidateDocument,
} from '../services/preOnboardingService.js';

const actorId = (req) => req.user._id;

export const preOnboardingList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query;
  // DB Logic - DB logics
  const result = await listPreOnboardings({
    companyId: req.companyId,
    query,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Pre-onboarding cases fetched',
    data: result.cases,
    meta: result.meta,
  });
});

export const preOnboardingDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { preOnboardingId } = req.params;
  // DB Logic - DB logics
  const result = await getPreOnboarding({
    companyId: req.companyId,
    preOnboardingId,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Pre-onboarding case fetched',
    data: result.case,
    meta: {
      documents: result.documents,
      history: result.history,
    },
  });
});

export const preOnboardingStart = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;
  // DB Logic - DB logics
  const result = await startPreOnboarding({
    companyId: req.companyId,
    candidateId,
    actorId: actorId(req),
    requestContext: req,
    sendInvite: req.body?.sendInvite !== false,
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: result.idempotent
      ? 'Pre-onboarding case already exists'
      : 'Pre-onboarding started',
    data: result,
  });
});

export const preOnboardingResendInvite = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { preOnboardingId } = req.params;
  // DB Logic - DB logics
  const result = await resendPreOnboardingInvite({
    companyId: req.companyId,
    preOnboardingId,
    actorId: actorId(req),
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Pre-onboarding invite resent',
    data: result,
  });
});

export const preOnboardingDocumentVerify = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { preOnboardingId, documentId } = req.params;
  // DB Logic - DB logics
  const result = await verifyCandidateDocument({
    companyId: req.companyId,
    preOnboardingId,
    documentId,
    actorId: actorId(req),
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.idempotent
      ? 'Document was already verified'
      : 'Document verified',
    data: result,
  });
});

export const preOnboardingDocumentReject = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { preOnboardingId, documentId } = req.params;
  const reason = req.body?.reason;
  // DB Logic - DB logics
  const result = await rejectCandidateDocument({
    companyId: req.companyId,
    preOnboardingId,
    documentId,
    actorId: actorId(req),
    reason,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Document requires resubmission',
    data: result,
  });
});

export const preOnboardingMarkReady = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { preOnboardingId } = req.params;
  // DB Logic - DB logics
  const result = await markPreOnboardingReady({
    companyId: req.companyId,
    preOnboardingId,
    actorId: actorId(req),
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.idempotent
      ? 'Candidate was already marked ready to join'
      : 'Candidate marked ready to join',
    data: result,
  });
});

export const preOnboardingDocumentFile = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { preOnboardingId, documentId } = req.params;
  // DB Logic - DB logics
  const document = await getCandidateDocumentFile({
    companyId: req.companyId,
    preOnboardingId,
    documentId,
    actorId: actorId(req),
    requestContext: req,
    actorType: 'TENANT_USER',
  });
  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${document.fileName}"`
  );
  res.setHeader('X-Document-Checksum', document.checksum);
  return res.type(document.mimeType).send(document.buffer);
});

export const documentRequirementList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  // DB Logic - DB logics
  const rows = await listDocumentRequirements({
    companyId: req.companyId,
    actorId: actorId(req),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Document requirements fetched',
    data: rows,
  });
});

export const documentRequirementCreate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const payload = req.body;
  // DB Logic - DB logics
  const row = await createDocumentRequirement({
    companyId: req.companyId,
    actorId: actorId(req),
    payload,
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'Document requirement created',
    data: row,
  });
});

export const documentRequirementUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { requirementId } = req.params;
  const payload = req.body;
  // DB Logic - DB logics
  const row = await updateDocumentRequirement({
    companyId: req.companyId,
    actorId: actorId(req),
    requirementId,
    payload,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Document requirement updated',
    data: row,
  });
});

export const documentRequirementDeactivate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { requirementId } = req.params;
  // DB Logic - DB logics
  const row = await deactivateDocumentRequirement({
    companyId: req.companyId,
    actorId: actorId(req),
    requirementId,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Document requirement deactivated',
    data: row,
  });
});
