import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  getPublicPreOnboarding,
  getPublicPreOnboardingDocument,
  recordPublicPreOnboardingView,
  uploadPublicPreOnboardingDocument,
} from '../services/publicPreOnboardingService.js';

export const publicPreOnboardingRead = asyncHandler(async (req, res) => {
  // Data from frontend - secure candidate token from the public portal
  const rawToken = req.params.secureToken;
  // DB Logic - token-derived authority only; no employee session is consulted
  const data = await getPublicPreOnboarding({ rawToken });
  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  return ApiResponse.success(res, {
    message: 'Pre-onboarding fetched',
    data,
  });
});

export const publicPreOnboardingView = asyncHandler(async (req, res) => {
  // Data from frontend - deliberate post-render portal signal
  const rawToken = req.params.secureToken;
  // DB Logic - scanner-safe GET stays read-only; this POST records the genuine view
  const data = await recordPublicPreOnboardingView({ rawToken });
  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  return ApiResponse.success(res, {
    message: 'Pre-onboarding view recorded',
    data,
  });
});

export const publicPreOnboardingUpload = asyncHandler(async (req, res) => {
  // Data from frontend - multipart document upload for one snapshotted requirement
  const rawToken = req.params.secureToken;
  const requirementCode = req.params.requirementCode;
  const file = req.file;
  const documentNumber = req.body?.documentNumber;
  const expiryDate = req.body?.expiryDate;
  // DB Logic - token authority + requirement snapshot rules
  const result = await uploadPublicPreOnboardingDocument({
    rawToken,
    requirementCode,
    file,
    documentNumber,
    expiryDate,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'Document uploaded',
    data: result,
  });
});

export const publicPreOnboardingDocumentRead = asyncHandler(async (req, res) => {
  // Data from frontend - token-authorized own document request
  const rawToken = req.params.secureToken;
  const documentCode = req.params.documentCode;
  // DB Logic - only the candidate's own document for this case
  const document = await getPublicPreOnboardingDocument({
    rawToken,
    documentCode,
    requestContext: req,
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
