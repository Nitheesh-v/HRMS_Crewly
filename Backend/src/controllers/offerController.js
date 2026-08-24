import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { recordAudit } from '../utils/securityauditService.js';
import {
  approveOffer,
  createOffer,
  getOffer,
  getOfferDocument,
  getOfferOptions,
  listOffers,
  returnOffer,
  sendOffer,
  submitOffer,
  updateOffer,
  withdrawOffer,
} from '../services/offerService.js';

const actor = (req) => ({
  id: req.user._id,
  name: req.user.name,
  role: req.user.role,
  type: 'TENANT_USER',
});

const auditOffer = async ({ req, action, offer, previousStatus = '' }) =>
  recordAudit({
    req,
    action,
    companyId: req.companyId,
    resource: 'OfferLetter',
    resourceId: offer._id,
    previousValue: previousStatus ? { status: previousStatus } : null,
    newValue: { status: offer.status },
    metadata: { offerCode: offer.offerCode, candidateId: offer.candidate, jobId: offer.job },
    critical: true,
  });

export const offerOptions = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  // DB Logic - DB logics
  const options = await getOfferOptions({ companyId });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer options fetched', data: options });
});

export const offerList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query;
  // DB Logic - DB logics
  const result = await listOffers({ companyId: req.companyId, query });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offers fetched', data: result.offers, meta: result.meta });
});

export const offerDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { offerId } = req.params;
  // DB Logic - DB logics
  const result = await getOffer({ companyId: req.companyId, offerId });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer fetched', data: result.offer, meta: { history: result.history } });
});

export const offerCreate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const payload = req.body;
  // DB Logic - DB logics
  const offer = await createOffer({ companyId: req.companyId, actor: actor(req), payload });
  await auditOffer({ req, action: 'OFFER_CREATED', offer });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: `${offer.offerCode} created as Draft`, data: offer });
});

export const offerUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { offerId } = req.params;
  const payload = req.body;
  // DB Logic - DB logics
  const offer = await updateOffer({
    companyId: req.companyId,
    actor: actor(req),
    offerId,
    payload,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer saved as Draft', data: offer });
});

export const offerSubmit = asyncHandler(async (req, res) => {
  // Data from frontend - explicit submit action
  const { offerId } = req.params;
  // DB Logic - DB logics
  const offer = await submitOffer({ companyId: req.companyId, actor: actor(req), offerId });
  await auditOffer({ req, action: 'OFFER_SUBMITTED_FOR_APPROVAL', offer, previousStatus: 'DRAFT' });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer submitted for approval', data: offer });
});

export const offerApprove = asyncHandler(async (req, res) => {
  // Data from frontend - explicit approval action
  const { offerId } = req.params;
  // DB Logic - approval also secures the exact checksummed PDF
  const offer = await approveOffer({ companyId: req.companyId, actor: actor(req), offerId });
  await auditOffer({ req, action: 'OFFER_APPROVED', offer, previousStatus: 'PENDING_APPROVAL' });
  await recordAudit({
    req,
    action: 'OFFER_PDF_GENERATED',
    companyId: req.companyId,
    resource: 'OfferLetter',
    resourceId: offer._id,
    metadata: {
      offerCode: offer.offerCode,
      documentChecksum: offer.document.checksum,
      documentVersion: offer.document.version,
    },
    critical: true,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer approved and document secured', data: offer });
});

export const offerReturn = asyncHandler(async (req, res) => {
  // Data from frontend - explicit approval return reason
  const { offerId } = req.params;
  const { reason } = req.body;
  // DB Logic - DB logics
  const offer = await returnOffer({ companyId: req.companyId, actor: actor(req), offerId, reason });
  await auditOffer({ req, action: 'OFFER_RETURNED', offer, previousStatus: 'PENDING_APPROVAL' });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer returned to Draft', data: offer });
});

export const offerSend = asyncHandler(async (req, res) => {
  // Data from frontend - explicit send action
  const { offerId } = req.params;
  // DB Logic - delivery must succeed before status becomes Sent
  const offer = await sendOffer({ companyId: req.companyId, actor: actor(req), offerId, requestContext: req });
  await auditOffer({ req, action: 'OFFER_SENT', offer, previousStatus: 'APPROVED' });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer delivered securely', data: offer });
});

export const offerWithdraw = asyncHandler(async (req, res) => {
  // Data from frontend - explicit withdrawal reason
  const { offerId } = req.params;
  const { reason } = req.body;
  // DB Logic - status and authority are revoked without deleting history
  const offer = await withdrawOffer({ companyId: req.companyId, actor: actor(req), offerId, reason, requestContext: req });
  await auditOffer({ req, action: 'OFFER_WITHDRAWN', offer });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer withdrawn', data: offer });
});

export const offerDocumentRead = asyncHandler(async (req, res) => {
  // Data from frontend - authenticated HR document request
  const { offerId } = req.params;
  // DB Logic - tenant-scoped checksummed document read
  const document = await getOfferDocument({
    companyId: req.companyId,
    offerId,
    actor: actor(req),
  });
  await recordAudit({ req, action: 'OFFER_DOCUMENT_ACCESSED', companyId: req.companyId, resource: 'OfferLetter', resourceId: document.offer._id, metadata: { offerCode: document.offer.offerCode, checksum: document.checksum }, critical: true });
  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${document.fileName}"`);
  res.setHeader('X-Document-Checksum', document.checksum);
  res.type('application/pdf').send(document.buffer);
});
