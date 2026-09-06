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
