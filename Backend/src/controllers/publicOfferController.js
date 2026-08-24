import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  acceptPublicOffer,
  getPublicOffer,
  getPublicOfferDocument,
  recordPublicOfferView,
  rejectPublicOffer,
} from '../services/publicOfferService.js';

export const publicOfferRead = asyncHandler(async (req, res) => {
  // Data from frontend - secure candidate token from the public portal
  const rawToken = req.params.secureToken;
  // DB Logic - token-derived authority only; no employee session is consulted
  const offer = await getPublicOffer({ rawToken });
  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  return ApiResponse.success(res, { message: 'Offer fetched', data: offer });
});

export const publicOfferView = asyncHandler(async (req, res) => {
  // Data from frontend - deliberate post-render portal signal
  const rawToken = req.params.secureToken;
  // DB Logic - scanner-safe GET stays read-only; this POST records the genuine view
  const offer = await recordPublicOfferView({ rawToken, requestContext: req });
  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  return ApiResponse.success(res, { message: 'Offer view recorded', data: offer });
});

export const publicOfferDocumentRead = asyncHandler(async (req, res) => {
  // Data from frontend - token-authorized document request
  const rawToken = req.params.secureToken;
  // DB Logic - exact checksummed approved snapshot
  const document = await getPublicOfferDocument({ rawToken, requestContext: req });
  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${document.fileName}"`);
  res.setHeader('X-Document-Checksum', document.checksum);
  res.type('application/pdf').send(document.buffer);
});

export const publicOfferAccept = asyncHandler(async (req, res) => {
  // Data from frontend - explicit candidate confirmation POST
  const rawToken = req.params.secureToken;
  // DB Logic - atomic, retry-idempotent offer and candidate transition
  const result = await acceptPublicOffer({ rawToken, requestContext: req });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: result.idempotent ? 'Offer acceptance was already recorded' : 'Offer accepted', data: result.offer, meta: { idempotent: result.idempotent } });
});

export const publicOfferReject = asyncHandler(async (req, res) => {
  // Data from frontend - explicit candidate confirmation and optional reason
  const rawToken = req.params.secureToken;
  const rejection = { category: req.body.category, comment: req.body.comment };
  // DB Logic - atomic, retry-idempotent offer and candidate transition
  const result = await rejectPublicOffer({ rawToken, rejection, requestContext: req });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: result.idempotent ? 'Offer rejection was already recorded' : 'Offer rejected', data: result.offer, meta: { idempotent: result.idempotent } });
});
