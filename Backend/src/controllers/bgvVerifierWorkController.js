// Phase 30.7 — verifier workspace ("My Verification Work").
//
// Identity: ALWAYS the authenticated verifier session principal — never a
// client-supplied verifierId. Specialization alone grants NOTHING here:
// every read re-resolves the CURRENT check-level assignment. Former or
// deactivated verifiers get 404/403 with no data. No conclusions, no
// payment data, no unrelated-check evidence on this surface.

import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  downloadVerifierEvidence,
  startCheckWork,
  verifierCheckDetail,
  verifierWorkQueue,
} from '../services/bgv/bgvAssignmentService.js';

// GET /api/bgv-verifier/work
export const bgvVerifierWorkList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend (verifier principal only)
  // DB Logic - CURRENT assignments of the authenticated verifier only;
  // safe summary fields (no evidence, no identifiers, no payment data)
  const data = await verifierWorkQueue({ verifierId: req.verifier._id });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'My verification work', data });
});

// GET /api/bgv-verifier/work/:orderId/:checkType
export const bgvVerifierWorkDetail = asyncHandler(async (req, res) => {
  // Data from frontend - order + check from the verifier's own queue
  const { orderId, checkType } = req.params;
  // DB Logic - minimum-data DTO for THIS check only, projected server-side
  const data = await verifierCheckDetail({
    verifierId: req.verifier._id,
    orderId,
    checkType,
  });
  // Data to frontend - response to frontend (no giant candidate object)
  return ApiResponse.success(res, { message: 'Check details', data });
});

// POST /api/bgv-verifier/work/:orderId/:checkType/start
export const bgvVerifierWorkStart = asyncHandler(async (req, res) => {
  // Data from frontend - order + check the verifier is opening
  const { orderId, checkType } = req.params;
  // DB Logic - operational ASSIGNED → IN_PROGRESS, idempotent + audited;
  // NOT a conclusion — no PASS/FAIL/VERIFIED exists in 30.7
  const data = await startCheckWork({
    verifierId: req.verifier._id,
    orderId,
    checkType,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Verification started', data });
});

// GET /api/bgv-verifier/work/files/:fileId
export const bgvVerifierWorkFileDownload = asyncHandler(async (req, res) => {
  // Data from frontend - file id (ids alone never authorize)
  const { fileId } = req.params;
  // DB Logic - file → case → CURRENT assignment to THIS verifier, for the
  // file's own check type; audited sensitive read with safe metadata
  const file = await downloadVerifierEvidence({
    verifierId: req.verifier._id,
    fileId,
    requestContext: req,
  });
  // Data to frontend - streamed attachment, no public URL involved
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('X-Document-Checksum', file.checksum);
  return res.type(file.mimeType).send(file.buffer);
});
