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
import {
  downloadActivityEvidence,
  recordActivity,
  recordDiscrepancy,
  setWorkbenchState,
  submitConclusion,
  uploadActivityEvidence,
} from '../services/bgv/bgvWorkbenchService.js';

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

// ── Phase 30.8 — verification workbench (current-assignment-only) ──

// POST /api/bgv-verifier/work/:orderId/:checkType/activities
export const bgvVerifierActivityRecord = asyncHandler(async (req, res) => {
  // Data from frontend - method, attempt outcome, structured observations
  const { orderId, checkType } = req.params;
  const { method, outcome, observations, notes } = req.body;

  // DB Logic - method allowlist + schema sanitization enforced server-side;
  // activities append atomically (history is never overwritten)
  const data = await recordActivity({
    verifierId: req.verifier._id,
    orderId,
    checkType,
    method,
    outcome,
    observations,
    notes,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Verification activity recorded', data });
});

// POST /api/bgv-verifier/work/:orderId/:checkType/discrepancies
export const bgvVerifierDiscrepancyRecord = asyncHandler(async (req, res) => {
  // Data from frontend - structured discrepancy (field/claimed/source/severity)
  const { orderId, checkType } = req.params;

  // DB Logic - structured findings append-only; a discrepancy is a BGV
  // finding for human review — never a candidate reject/hire signal
  const data = await recordDiscrepancy({
    verifierId: req.verifier._id,
    orderId,
    checkType,
    input: req.body,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Discrepancy recorded', data });
});

// POST /api/bgv-verifier/work/:orderId/:checkType/state
export const bgvVerifierStateSet = asyncHandler(async (req, res) => {
  // Data from frontend - operational state (IN_PROGRESS / AWAITING_THIRD_PARTY)
  const { orderId, checkType } = req.params;
  const { state } = req.body;

  // DB Logic - operational state only; conclusions are a separate concept
  const data = await setWorkbenchState({
    verifierId: req.verifier._id,
    orderId,
    checkType,
    state,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Workbench state updated', data });
});

// POST /api/bgv-verifier/work/:orderId/:checkType/submit
export const bgvVerifierConclusionSubmit = asyncHandler(async (req, res) => {
  // Data from frontend - final conclusion + reason (CANCELLED not offered)
  const { orderId, checkType } = req.params;
  const { conclusion, reason } = req.body;

  // DB Logic - readiness engine validates supporting work server-side;
  // submission is an atomic conditional write (lock); idempotent for the
  // same verifier + same conclusion; locked history afterwards
  const data = await submitConclusion({
    verifierId: req.verifier._id,
    orderId,
    checkType,
    conclusion,
    reason,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Check findings submitted', data });
});

// POST /api/bgv-verifier/work/:orderId/:checkType/evidence
export const bgvVerifierEvidenceUpload = asyncHandler(async (req, res) => {
  // Data from frontend - multipart file + activitySeq (hardened uploader
  // already enforced MIME/size before this handler)
  const { orderId, checkType } = req.params;
  const { activitySeq } = req.body;

  // DB Logic - current-assignment authorization + 30.5 private storage
  // posture (no public URLs); audit with safe metadata only
  const data = await uploadActivityEvidence({
    verifierId: req.verifier._id,
    orderId,
    checkType,
    activitySeq,
    file: req.file,
    requestContext: req,
  });

  // Data to frontend - response to frontend (safe metadata, never a URL)
  return ApiResponse.created(res, { message: 'Evidence attached', data });
});

// GET /api/bgv-verifier/work/evidence/:fileId
export const bgvVerifierEvidenceDownload = asyncHandler(async (req, res) => {
  // Data from frontend - file id (ids alone never authorize)
  const { fileId } = req.params;

  // DB Logic - file → check → CURRENT assignment to THIS verifier;
  // audited sensitive read with safe metadata
  const file = await downloadActivityEvidence({
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
