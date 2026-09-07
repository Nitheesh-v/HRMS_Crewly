// Phase 30.5 — public candidate BGV collection controllers.
// Token-authorized; no employee session. Every action requires explicit
// 30.4 CONSENT + a commercially authorized order (service-enforced).

import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  downloadBgvEvidence,
  removeBgvEvidence,
  removeEducationRecord,
  removeEmploymentRecord,
  removeReferenceRecord,
  resolveCollectionPortal,
  saveAddressInformation,
  saveEducationRecord,
  saveEmploymentRecord,
  saveIdentityInformation,
  saveReferenceRecord,
  submitBgvPackage,
  uploadBgvEvidence,
} from '../services/bgv/bgvCollectionService.js';

// GET /api/public/candidate/bgv-collection/:secureToken
export const bgvCollectionRead = asyncHandler(async (req, res) => {
  // Data from frontend - secure candidate portal token
  const rawToken = req.params.secureToken;

  // DB Logic - consent gate + purchased checks + draft state (read-only)
  const data = await resolveCollectionPortal({ rawToken });

  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  return ApiResponse.success(res, { message: 'BGV collection fetched', data });
});

// POST /api/public/candidate/bgv-collection/:secureToken/identity
export const bgvCollectionIdentitySave = asyncHandler(async (req, res) => {
  // Data from frontend - identity form (the full number is never retained)
  const rawToken = req.params.secureToken;
  const input = req.body || {};

  // DB Logic - consent gate + purchased-check + masking (service)
  const data = await saveIdentityInformation({ rawToken, input, requestContext: req });

  // Data to frontend - masked identifier only
  return ApiResponse.success(res, { message: 'Identity information saved', data });
});

// POST /api/public/candidate/bgv-collection/:secureToken/address
export const bgvCollectionAddressSave = asyncHandler(async (req, res) => {
  // Data from frontend - structured address form
  const rawToken = req.params.secureToken;
  const input = req.body || {};

  // DB Logic - consent gate + purchased-check + validation (service)
  const data = await saveAddressInformation({ rawToken, input, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Address information saved', data });
});

// POST /api/public/candidate/bgv-collection/:secureToken/education
export const bgvCollectionEducationSave = asyncHandler(async (req, res) => {
  // Data from frontend - education record (create when no recordId)
  const rawToken = req.params.secureToken;
  const { recordId, ...record } = req.body || {};

  // DB Logic - repeatable structured record, purchased-check gated
  const data = await saveEducationRecord({ rawToken, recordId, record, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Education record saved', data });
});

// DELETE /api/public/candidate/bgv-collection/:secureToken/education/:recordId
export const bgvCollectionEducationRemove = asyncHandler(async (req, res) => {
  // Data from frontend - record to remove (draft only)
  const { secureToken, recordId } = req.params;

  // DB Logic - removal blocked after final submission (service)
  const data = await removeEducationRecord({ rawToken: secureToken, recordId, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Education record removed', data });
});

// POST /api/public/candidate/bgv-collection/:secureToken/employment
export const bgvCollectionEmploymentSave = asyncHandler(async (req, res) => {
  // Data from frontend - employment record (create when no recordId)
  const rawToken = req.params.secureToken;
  const { recordId, ...record } = req.body || {};

  // DB Logic - repeatable structured record, purchased-check gated
  const data = await saveEmploymentRecord({ rawToken, recordId, record, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Employment record saved', data });
});

// DELETE /api/public/candidate/bgv-collection/:secureToken/employment/:recordId
export const bgvCollectionEmploymentRemove = asyncHandler(async (req, res) => {
  // Data from frontend - record to remove (draft only)
  const { secureToken, recordId } = req.params;

  // DB Logic - removal blocked after final submission (service)
  const data = await removeEmploymentRecord({ rawToken: secureToken, recordId, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Employment record removed', data });
});

// POST /api/public/candidate/bgv-collection/:secureToken/reference
export const bgvCollectionReferenceSave = asyncHandler(async (req, res) => {
  // Data from frontend - referee record (no calls/emails are sent in 30.5)
  const rawToken = req.params.secureToken;
  const { recordId, ...record } = req.body || {};

  // DB Logic - structured referee record, purchased-check gated
  const data = await saveReferenceRecord({ rawToken, recordId, record, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Reference saved', data });
});

// DELETE /api/public/candidate/bgv-collection/:secureToken/reference/:recordId
export const bgvCollectionReferenceRemove = asyncHandler(async (req, res) => {
  // Data from frontend - record to remove (draft only)
  const { secureToken, recordId } = req.params;

  // DB Logic - removal blocked after final submission (service)
  const data = await removeReferenceRecord({ rawToken: secureToken, recordId, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Reference removed', data });
});

// POST /api/public/candidate/bgv-collection/:secureToken/files
export const bgvCollectionFileUpload = asyncHandler(async (req, res) => {
  // Data from frontend - multipart evidence file + category (+ recordId)
  const rawToken = req.params.secureToken;
  const category = req.body?.category;
  const recordId = req.body?.recordId || '';

  // DB Logic - private storage, purchased-check gate, honest scan, versioning
  const data = await uploadBgvEvidence({
    rawToken,
    category,
    recordId,
    file: req.file,
    requestContext: req,
  });

  // Data to frontend - safe metadata only (never a storage key or URL)
  return ApiResponse.created(res, { message: 'Evidence uploaded', data });
});

// GET /api/public/candidate/bgv-collection/:secureToken/files/:fileId
export const bgvCollectionFileDownload = asyncHandler(async (req, res) => {
  // Data from frontend - token + file id (ids alone never authorize)
  const { secureToken, fileId } = req.params;

  // DB Logic - server-side relationship resolution (own case only)
  const file = await downloadBgvEvidence({ rawToken: secureToken, fileId, requestContext: req });

  // Data to frontend - streamed attachment, no public URL involved
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('X-Document-Checksum', file.checksum);
  return res.type(file.mimeType).send(file.buffer);
});

// DELETE /api/public/candidate/bgv-collection/:secureToken/files/:fileId
export const bgvCollectionFileRemove = asyncHandler(async (req, res) => {
  // Data from frontend - file to remove (draft only)
  const { secureToken, fileId } = req.params;

  // DB Logic - removal blocked after final submission (service)
  const data = await removeBgvEvidence({ rawToken: secureToken, fileId, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Evidence removed', data });
});

// POST /api/public/candidate/bgv-collection/:secureToken/submit
export const bgvCollectionSubmit = asyncHandler(async (req, res) => {
  // Data from frontend - explicit final submission (POST only, never GET)
  const rawToken = req.params.secureToken;

  // DB Logic - backend readiness gate; freezes the case; idempotent replay
  const data = await submitBgvPackage({ rawToken, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.idempotent
      ? 'Your BGV information was already submitted'
      : 'BGV information submitted successfully',
    data,
  });
});
