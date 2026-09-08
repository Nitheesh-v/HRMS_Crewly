// Phase 30.3 — PAID BGV ORDER controllers (tenant HR).
//
// Entry is ONLY through the Phase 30.1 INITIATE BGV decision; the service
// re-validates eligibility itself, so no hidden frontend button can widen
// access. Tenant authority comes exclusively from req.companyId.

import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  cancelBgvOrder,
  createBgvOrder,
  getBgvOrderForCandidate,
  initiateBgvOrderPayment,
  listPurchasableBgvServices,
  verifyBgvOrderPayment,
} from '../services/bgv/bgvOrderService.js';
import {
  getHrConsentStatus,
  issueBgvConsentInvitation,
} from '../services/bgv/bgvConsentService.js';
import { getHrCollectionStatus } from '../services/bgv/bgvCollectionService.js';
import { getHrAssignmentStatus } from '../services/bgv/bgvAssignmentService.js';
import {
  tenantReportDownload,
  tenantReportSummary,
} from '../services/bgv/bgvQaReportService.js';

const actorId = (req) => req.user._id;

// GET /api/recruitment/bgv-purchase/services
export const bgvPurchasableServices = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  // DB Logic - tenant-safe projection of the ACTIVE catalogue (read-only).
  const data = await listPurchasableBgvServices();

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Purchasable BGV services',
    data,
  });
});

// POST /api/recruitment/candidates/:candidateId/bgv-order
export const bgvOrderCreate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;

  // DB Logic - server-priced, duplicate-safe order creation.
  const result = await createBgvOrder({
    companyId: req.companyId,
    candidateRef: candidateId,
    actorId: actorId(req),
    payload: req.body ?? {},
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.reused
      ? 'Existing BGV order returned'
      : 'BGV order created — proceed to payment',
    data: result,
  });
});

// GET /api/recruitment/candidates/:candidateId/bgv-order
export const bgvOrderForCandidate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;

  // DB Logic - refresh/resume: Mongo is the truth.
  const data = await getBgvOrderForCandidate({
    companyId: req.companyId,
    candidateRef: candidateId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV order status',
    data,
  });
});

// POST /api/recruitment/bgv-orders/:orderId/payment/initiate
export const bgvOrderPaymentInitiate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { orderId } = req.params;

  // DB Logic - server creates the provider order with the SERVER amount.
  const result = await initiateBgvOrderPayment({
    companyId: req.companyId,
    orderId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Payment initiated',
    data: result,
  });
});

// POST /api/recruitment/bgv-orders/:orderId/payment/verify
export const bgvOrderPaymentVerify = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { orderId } = req.params;

  // DB Logic - server-side signature verification; idempotent on PAID.
  const result = await verifyBgvOrderPayment({
    companyId: req.companyId,
    orderId,
    payload: req.body ?? {},
    actorId: actorId(req),
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.idempotent
      ? 'Payment already confirmed'
      : 'Payment confirmed — BGV checks purchased',
    data: result,
  });
});

// POST /api/recruitment/bgv-orders/:orderId/cancel
export const bgvOrderCancel = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { orderId } = req.params;

  // DB Logic - cancel only an unpaid order.
  const result = await cancelBgvOrder({
    companyId: req.companyId,
    orderId,
    actorId: actorId(req),
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV order cancelled',
    data: result,
  });
});

// ── Phase 30.4 — candidate consent invitation (HR) ───────────────

// POST /api/recruitment/bgv-orders/:orderId/consent-invitation
export const bgvConsentInvitationIssue = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { orderId } = req.params;

  // DB Logic - issue or safely rotate the candidate consent invitation;
  // requires the 30.3 PAID commercial state (never payment-provider fields).
  const result = await issueBgvConsentInvitation({
    companyId: req.companyId,
    orderId,
    actorId: actorId(req),
    requestContext: req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.reissued
      ? 'Invitation reissued — the previous link is no longer valid'
      : 'Candidate consent invitation sent',
    data: result,
  });
});

// GET /api/recruitment/candidates/:candidateId/bgv-consent-status
export const bgvConsentStatus = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;

  // DB Logic - tenant-scoped consent visibility; PAID stays visible and
  // distinct from CONSENTED.
  const data = await getHrConsentStatus({
    companyId: req.companyId,
    candidateRef: candidateId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV consent status',
    data,
  });
});

// Phase 30.5 — GET /api/recruitment/candidates/:candidateId/bgv-collection-status
export const bgvCollectionStatus = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateId } = req.params;

  // DB Logic - tenant-scoped collection visibility: high-level status only
  // (AWAITING_CANDIDATE / CANDIDATE_DRAFT / CANDIDATE_SUBMITTED). Raw
  // evidence files are NOT exposed to HR in 30.5 (minimum-necessary).
  const data = await getHrCollectionStatus({
    companyId: req.companyId,
    candidateRef: candidateId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV collection status',
    data,
  });
});

// Phase 30.7 — GET /api/recruitment/candidates/:candidateId/bgv-assignment-status
export const bgvAssignmentProgress = asyncHandler(async (req, res) => {
  // Data from frontend - candidate reference (tenant-scoped via req.companyId)
  const { candidateId } = req.params;

  // DB Logic - tenant HR sees ONLY high-level per-check operational state
  // (UNASSIGNED / ASSIGNED / IN_PROGRESS). No internal verifier identity,
  // no evidence, no assignment management — that is platform-only.
  const data = await getHrAssignmentStatus({
    companyId: req.companyId,
    candidateRef: candidateId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV assignment progress',
    data,
  });
});

// ── Phase 30.10 — released final BGV report (tenant HR) ───────────

// GET /api/recruitment/candidates/:candidateId/bgv-final-report
export const bgvFinalReportSummary = asyncHandler(async (req, res) => {
  // Data from frontend - candidate reference (tenant-scoped)
  const { candidateId } = req.params;

  // DB Logic - authority is req.companyId ONLY (tenant context middleware);
  // a body/query companyId can never select another tenant's report.
  // Unreleased reports are invisible here (generated ≠ released).
  const data = await tenantReportSummary({
    companyId: req.companyId,
    candidateId,
  });

  // Data to frontend - safe report summary or null
  return ApiResponse.success(res, { message: 'BGV final report', data });
});

// GET /api/recruitment/candidates/:candidateId/bgv-final-report/download
export const bgvFinalReportDownload = asyncHandler(async (req, res) => {
  // Data from frontend - candidate reference (tenant-scoped)
  const { candidateId } = req.params;

  // DB Logic - RELEASED + same-tenant + BACKGROUND_VERIFICATION_READ are
  // enforced; storage keys never leave the backend; download is audited.
  const { buffer, fileName, checksum } = await tenantReportDownload({
    companyId: req.companyId,
    candidateId,
    requestContext: req,
  });

  // Data to frontend - private controlled stream; no permanent public URL
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  if (checksum) res.setHeader('X-BGV-Report-Sha256', checksum);
  return res.status(200).type('application/pdf').send(buffer);
});
