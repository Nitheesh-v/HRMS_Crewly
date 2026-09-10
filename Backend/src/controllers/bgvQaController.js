import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import {
  generateReport,
  platformReportDownload,
  platformReportView,
  qaApprove,
  qaDetail,
  qaEvidenceDownload,
  qaQueue,
  qaReturn,
  releaseReport,
  reportReadiness,
  retryReportPdf,
} from '../services/bgv/bgvQaReportService.js';

// Phase 30.10 — internal BGV QA review + final report release.
// Routes mount behind requireSuperAdmin + permit('bgv-qa:*'): tenant HR and
// verifiers are on separate session stacks and can never reach this surface.
// QA decides APPROVE / RETURN_FOR_CORRECTION only — never hire/reject.

// GET /api/super-admin/bgv-qa/queue
export const bgvQaQueue = asyncHandler(async (req, res) => {
  // Data from frontend - filter choices only (status/checkType/conclusion/text)
  const { status, checkType, conclusion, orderCode } = req.query;

  // DB Logic - platform QA queue; only verifier-submitted work appears
  const data = await qaQueue({ filters: { status, checkType, conclusion, orderCode } });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'BGV QA queue', data });
});

// GET /api/super-admin/bgv-qa/check/:orderId/:checkType
export const bgvQaCheckDetail = asyncHandler(async (req, res) => {
  // Data from frontend - order + check from the queue row
  const { orderId, checkType } = req.params;

  // DB Logic - sensitive internal view: activities, findings, revisions,
  // info-request history, evidence METADATA (bytes via the download route)
  const data = await qaDetail({ orderId, checkType });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'QA check detail', data });
});

// GET /api/super-admin/bgv-qa/check/:orderId/:checkType/evidence/:fileId
export const bgvQaEvidenceDownload = asyncHandler(async (req, res) => {
  // Data from frontend - evidence id within the reviewed check
  const { orderId, checkType, fileId } = req.params;

  // DB Logic - ownership-checked private read, audited; no public URLs
  const { buffer, file } = await qaEvidenceDownload({
    actorId: req.user._id,
    orderId,
    checkType,
    fileId,
    requestContext: req,
  });

  // Data to frontend - streamed privately
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  return res.status(200).type(file.mimeType || 'application/octet-stream').send(buffer);
});

// POST /api/super-admin/bgv-qa/check/:orderId/:checkType/approve
export const bgvQaApprove = asyncHandler(async (req, res) => {
  // Data from frontend - order + check from the QA detail
  const { orderId, checkType } = req.params;

  // DB Logic - QA approval of the current PENDING revision (idempotent;
  // the verifier finding is preserved, never edited by QA)
  const data = await qaApprove({
    actorId: req.user._id,
    orderId,
    checkType,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: data.idempotent ? 'Already approved' : 'Check approved', data });
});

// POST /api/super-admin/bgv-qa/check/:orderId/:checkType/return
export const bgvQaReturn = asyncHandler(async (req, res) => {
  // Data from frontend - mandatory return reason
  const { orderId, checkType } = req.params;
  const { reason } = req.body;

  // DB Logic - RETURN_FOR_CORRECTION: reason enforced, original submission
  // preserved, current verifier corrects via a new revision
  const data = await qaReturn({
    actorId: req.user._id,
    orderId,
    checkType,
    reason,
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: data.idempotent ? 'Already returned' : 'Returned for correction', data });
});

// GET /api/super-admin/bgv-qa/report/:orderId
export const bgvQaReportStatus = asyncHandler(async (req, res) => {
  // Data from frontend - order id
  const { orderId } = req.params;

  // DB Logic - readiness engine + current report lifecycle state
  const [readiness, view] = await Promise.all([
    reportReadiness({ orderId }),
    (async () => {
      try {
        return await platformReportView({ orderId });
      } catch {
        return { report: null };
      }
    })(),
  ]);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Report status', data: { readiness, report: view.report } });
});

// POST /api/super-admin/bgv-qa/report/:orderId/generate
export const bgvQaGenerateReport = asyncHandler(async (req, res) => {
  // Data from frontend - order id only
  const { orderId } = req.params;

  // DB Logic - backend readiness gate; immutable snapshot + private PDF;
  // duplicate generation is idempotent (one report per order+version)
  const data = await generateReport({ actorId: req.user._id, orderId, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: data.idempotent ? 'Report already generated' : 'Report generated',
    data,
  });
});

// POST /api/super-admin/bgv-qa/report/:orderId/pdf-retry
export const bgvQaRetryReportPdf = asyncHandler(async (req, res) => {
  // Data from frontend - order id only
  const { orderId } = req.params;

  // DB Logic - deterministic re-render from the stored snapshot; findings
  // are never regenerated and release state is never faked
  const data = await retryReportPdf({ actorId: req.user._id, orderId, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'PDF retry complete', data });
});

// POST /api/super-admin/bgv-qa/report/:orderId/release
export const bgvQaReleaseReport = asyncHandler(async (req, res) => {
  // Data from frontend - order id only
  const { orderId } = req.params;

  // DB Logic - explicit release boundary (generated ≠ released); idempotent
  const data = await releaseReport({ actorId: req.user._id, orderId, requestContext: req });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: data.idempotent ? 'Report already released' : 'Report released', data });
});

// GET /api/super-admin/bgv-qa/report/:orderId/download
export const bgvQaReportDownload = asyncHandler(async (req, res) => {
  // Data from frontend - order id only
  const { orderId } = req.params;

  // DB Logic - platform-authorized private download, audited
  const { buffer, fileName, checksum } = await platformReportDownload({
    actorId: req.user._id,
    orderId,
    requestContext: req,
  });

  // Data to frontend - streamed privately; storage keys never leave backend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  if (checksum) res.setHeader('X-BGV-Report-Sha256', checksum);
  return res.status(200).type('application/pdf').send(buffer);
});
