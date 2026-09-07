// Phase 30.9 — ADDITIONAL INFORMATION REQUESTS & controlled resubmission.
//
// Boundaries (read before changing):
//  - AUTHORIZATION: only the CURRENT assigned active verifier creates
//    requests (30.7 chain, reused verbatim). Specialization alone grants
//    nothing; former verifiers are denied; tenant HR has no create path.
//  - CHECK-SCOPE: category must belong to the assigned check's allowlist;
//    an EMPLOYMENT verifier can never request Identity documents.
//  - CONSENT: the candidate must already hold a CONSENTED 30.4 decision;
//    a request never creates or broadens consent.
//  - CONTROLLED POST-SUBMISSION EXCEPTION: the frozen 30.5 package is NOT
//    unlocked; candidate responses flow ONLY through this service's
//    explicit endpoints and only for the requested category.
//  - VERSION HISTORY: replacement uploads reuse 30.5 versioning — the
//    prior file becomes REPLACED (historical), never deleted.
//  - NO AUTOMATED DECISIONS: creating a request sets the operational state
//    AWAITING_CANDIDATE only. No UNABLE_TO_VERIFY / FAILED / REJECTED /
//    CLEAR / pipeline mutation / charge anywhere here.
//  - NOTIFICATION: Crewly sends (synchronous sensitive mail, 30.4 pattern);
//    the raw portal token never enters any queue payload; SMTP failure
//    never deletes the request nor fabricates a response.

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import env from '../../config/env.js';
import logger from '../../config/logger.js';
import BgvOrder from '../../models/BgvOrder.js';
import Company from '../../models/Company.js';
import Candidate from '../../models/Candidate.js';
import BgvConsentAccessToken from '../../models/BgvConsentAccessToken.js';
import BgvCollectionCase from '../../models/BgvCollectionCase.js';
import BgvEvidenceFile from '../../models/BgvEvidenceFile.js';
import BgvInfoRequest from '../../models/BgvInfoRequest.js';
import BgvCheckVerification from '../../models/BgvCheckVerification.js';
import ApiError from '../../utils/ApiError.js';
import { sendMail, bgvInfoRequestedEmail } from '../../utils/mailer.js';
import { hashToken, randomToken } from '../../utils/securityPolicy.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { isCommerciallyAuthorized } from './bgvOrderRules.js';
import { loadOwnAssignment } from './bgvAssignmentService.js';
import { loadAuthorizedContext } from './bgvCollectionService.js';
import { validateReferenceRecord } from './bgvCollectionRules.js';
import { storeBgvEvidence } from './bgvEvidenceStorageService.js';
import { BGV_CONSENT_PURPOSE, BGV_CONSENT_TOKEN_MAX_DAYS } from './bgvConsentRules.js';
import {
  CATEGORY_LABELS,
  INFO_REQUEST_CATEGORIES,
  requestResponseSpec,
  sanitizeRequestMessage,
  sanitizeResponseText,
} from './bgvInfoRequestRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);
const CHECK_LABELS = {
  IDENTITY: 'Identity verification',
  ADDRESS: 'Address verification',
  EDUCATION: 'Education verification',
  EMPLOYMENT: 'Employment verification',
  REFERENCE: 'Reference verification',
};

// ── default collaborators ─────────────────────────────────────────
const defaultLoadOrderById = ({ orderId }) =>
  isObjectId(orderId) ? BgvOrder.findOne({ _id: orderId }).lean() : Promise.resolve(null);
const defaultLoadCase = ({ companyId, orderId }) =>
  BgvCollectionCase.findOne({ companyId, bgvOrder: orderId }).lean();
const defaultLoadCompany = ({ companyId }) => Company.findOne({ _id: companyId }).select('name').lean();
const defaultLoadCandidate = ({ companyId, candidateId }) =>
  Candidate.findOne({ _id: candidateId, companyId }).select('name email').lean();
const defaultLoadLatestToken = ({ companyId, orderId }) =>
  BgvConsentAccessToken.findOne({ companyId, bgvOrder: orderId }).sort({ createdAt: -1 }).lean();
const defaultRevokeActiveTokens = ({ companyId, orderId }) =>
  BgvConsentAccessToken.updateMany(
    { companyId, bgvOrder: orderId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
const defaultInsertToken = (doc) => BgvConsentAccessToken.create(doc);
const defaultInsertRequest = (doc) => BgvInfoRequest.create(doc);
const defaultFindRequestById = ({ requestId }) =>
  isObjectId(requestId) ? BgvInfoRequest.findOne({ _id: requestId }).lean() : Promise.resolve(null);
const defaultFindOpenByCategory = ({ orderId, checkType, category }) =>
  BgvInfoRequest.findOne({ bgvOrder: orderId, checkType, category, status: 'OPEN' }).lean();
const defaultListRequests = ({ caseId }) =>
  BgvInfoRequest.find({ bgvCollectionCase: caseId }).sort({ requestedAt: 1 }).lean();
const defaultListRequestsForCheck = ({ orderId, checkType }) =>
  BgvInfoRequest.find({ bgvOrder: orderId, checkType }).sort({ requestedAt: 1 }).lean();
const defaultUpdateRequest = ({ requestId, onlyStatus, set }) =>
  BgvInfoRequest.findOneAndUpdate(
    { _id: requestId, ...(onlyStatus ? { status: onlyStatus } : {}) },
    { $set: set },
    { returnDocument: 'after' }
  ).lean();
const defaultFindVerification = ({ orderId, checkType }) =>
  BgvCheckVerification.findOne({ bgvOrder: orderId, checkType, activeKey: 'CURRENT' }).lean();
const defaultInsertVerification = (doc) => BgvCheckVerification.create(doc);
const defaultSetVerificationState = ({ verificationId, notStates, state }) =>
  BgvCheckVerification.findOneAndUpdate(
    { _id: verificationId, activeKey: 'CURRENT', conclusion: null, state: { $nin: notStates } },
    { $set: { state } },
    { returnDocument: 'after' }
  ).lean();
const defaultListActiveFiles = ({ companyId, caseId, category }) =>
  BgvEvidenceFile.find({ companyId, bgvCollectionCase: caseId, isActive: true, ...(category ? { category } : {}) }).lean();
const defaultListResponseFiles = ({ requestId }) =>
  BgvEvidenceFile.find({ bgvInfoRequest: requestId }).sort({ uploadedAt: 1 }).lean();
const defaultCreateFile = (doc) => BgvEvidenceFile.create(doc);
const defaultUpdateFile = ({ fileId, set }) =>
  BgvEvidenceFile.findOneAndUpdate({ _id: fileId }, { $set: set }, { returnDocument: 'after' }).lean();
const defaultPersistCase = ({ companyId, caseId, set }) =>
  BgvCollectionCase.findOneAndUpdate({ _id: caseId, companyId }, { $set: set }, { returnDocument: 'after' }).lean();
const defaultStoreFile = (args) => storeBgvEvidence(args);
const defaultSendMail = (payload) => sendMail(payload);
const defaultAudit = (entry) => recordAudit(entry);

const auditSafe = (audit, entry) => audit(entry).catch(() => {});

const safeRequest = (request) => ({
  id: String(request._id),
  checkType: request.checkType,
  category: request.category,
  categoryLabel: CATEGORY_LABELS[request.category] || request.category,
  responseKind: request.responseKind,
  evidenceCategory: request.evidenceCategory || null,
  message: request.message || '',
  status: request.status,
  requestedAt: request.requestedAt,
  respondedAt: request.respondedAt || null,
  resolvedAt: request.resolvedAt || null,
  resolvedBy: request.resolvedBy ? String(request.resolvedBy) : null,
  cancelledAt: request.cancelledAt || null,
  requestedByVerifierId: String(request.requestedBy),
  response: {
    text: request.response?.text || '',
    fileCount: request.response?.fileCount || 0,
    referenceRecordAdded: Boolean(request.response?.referenceRecordAdded),
  },
});

const ensureVerificationRow = async ({ order, checkType, deps }) => {
  const findVerification = deps.findVerification || defaultFindVerification;
  const insertVerification = deps.insertVerification || defaultInsertVerification;
  const existing = await findVerification({ orderId: order._id, checkType });
  if (existing) return existing;
  try {
    return await insertVerification({
      companyId: order.companyId,
      bgvOrder: order._id,
      candidate: order.candidate,
      checkType,
      state: 'IN_PROGRESS',
      activities: [],
      discrepancies: [],
      conclusion: null,
    });
  } catch (error) {
    if (error?.code === 11000) return findVerification({ orderId: order._id, checkType });
    throw error;
  }
};

// ── verifier: create request (+ Crewly notification) ──────────────
export const createInfoRequest = async ({ verifierId, orderId, checkType, category, message = '', requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const findOpenByCategory = deps.findOpenByCategory || defaultFindOpenByCategory;
  const insertRequest = deps.insertRequest || defaultInsertRequest;
  const loadLatestToken = deps.loadLatestToken || defaultLoadLatestToken;
  const revokeActiveTokens = deps.revokeActiveTokens || defaultRevokeActiveTokens;
  const insertToken = deps.insertToken || defaultInsertToken;
  const send = deps.sendMail || defaultSendMail;
  const setVerificationState = deps.setVerificationState || defaultSetVerificationState;

  const safeCheck = String(checkType || '').toUpperCase();
  const safeCategory = String(category || '').toUpperCase();
  // Current-assignment authorization (30.7 chain reused verbatim).
  await loadOwnAssignment({ verifierId, orderId, checkType: safeCheck, deps });
  const order = await loadOrderById({ orderId });
  if (!order || !isCommerciallyAuthorized(order)) throw ApiError.notFound('BGV order not found');
  if (!(order.items || []).some((item) => item.type === safeCheck)) {
    throw ApiError.conflict('This check was not purchased for this BGV order');
  }
  // Category allowlist per assigned check — frontend cannot invent ids.
  if (!(INFO_REQUEST_CATEGORIES[safeCheck] || []).includes(safeCategory)) {
    throw ApiError.badRequest('Request category is not allowed for this check');
  }
  const spec = requestResponseSpec(safeCheck, safeCategory);
  if (!spec) throw ApiError.badRequest('Request category is not allowed for this check');

  // Locked 30.8 findings are never silently reopened by a request (§24).
  const findVerification = deps.findVerification || defaultFindVerification;
  const verification = await findVerification({ orderId: order._id, checkType: safeCheck });
  if (verification?.state === 'SUBMITTED' || verification?.conclusion) {
    throw ApiError.conflict('This check has submitted findings — additional information requires the QA workflow');
  }

  // Double-click protection: an equivalent OPEN request is returned as-is.
  const existing = await findOpenByCategory({ orderId: order._id, checkType: safeCheck, category: safeCategory });
  if (existing) return { request: safeRequest(existing), idempotent: true, notificationSent: false };

  const loadCase = deps.loadCase || defaultLoadCase;
  const collectionCase = await loadCase({ companyId: order.companyId, orderId: order._id });
  if (!collectionCase || collectionCase.status !== 'SUBMITTED') {
    throw ApiError.conflict('Additional information requires the candidate to have submitted the BGV package');
  }

  const request = await insertRequest({
    companyId: order.companyId,
    bgvOrder: order._id,
    candidate: order.candidate,
    bgvCollectionCase: collectionCase._id,
    checkType: safeCheck,
    category: safeCategory,
    responseKind: spec.kind,
    evidenceCategory: spec.evidenceCategory || null,
    message: sanitizeRequestMessage(message),
    requestedBy: verifierId,
    status: 'OPEN',
  });

  // Operational state only — the check waits for the candidate. Never a
  // conclusion, never a failure, never a pipeline change.
  const verificationRow = await ensureVerificationRow({ order, checkType: safeCheck, deps });
  await setVerificationState({
    verificationId: verificationRow._id,
    notStates: ['SUBMITTED', 'AWAITING_CANDIDATE'],
    state: 'AWAITING_CANDIDATE',
  });

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_INFO_REQUEST_CREATED',
    resource: 'BgvInfoRequest',
    resourceId: request._id,
    metadata: { orderCode: order.orderCode, checkType: safeCheck, category: safeCategory, verifierId: String(verifierId), phase: '30.9' },
  });

  // ── Crewly notification (30.4 security pattern): rotate a hash-only
  //    portal token, carry the completed CONSENTED decision, send the link
  //    synchronously — raw token never enters any queue payload.
  let notificationSent = false;
  try {
    const latest = await loadLatestToken({ companyId: order.companyId, orderId: order._id });
    if (!latest || latest.finalDecision !== 'CONSENTED') {
      throw ApiError.conflict('Candidate consent is required before requesting information');
    }
    await revokeActiveTokens({ companyId: order.companyId, orderId: order._id });
    const rawToken = randomToken(48);
    const expiresAt = new Date(Date.now() + BGV_CONSENT_TOKEN_MAX_DAYS * 24 * 60 * 60 * 1000);
    const tokenRecord = await insertToken({
      companyId: order.companyId,
      candidate: order.candidate,
      bgvOrder: order._id,
      purpose: BGV_CONSENT_PURPOSE,
      tokenHash: hashToken(rawToken),
      expiresAt,
      issuedBy: null,
      orderCode: order.orderCode,
      // Rotation carries the completed decision — it never reopens it.
      finalDecision: 'CONSENTED',
      decidedAt: latest.decidedAt || new Date(),
    });
    const clientOrigin = String(env.CLIENT_URL || '').split(',')[0].trim().replace(/\/$/, '');
    const portalUrl = `${clientOrigin}/candidate/bgv-consent/${rawToken}`;
    const loadCompany = deps.loadCompany || defaultLoadCompany;
    const loadCandidate = deps.loadCandidate || defaultLoadCandidate;
    const [company, candidate] = await Promise.all([
      loadCompany({ companyId: order.companyId }),
      loadCandidate({ companyId: order.companyId, candidateId: order.candidate }),
    ]);
    const mail = bgvInfoRequestedEmail({
      candidateName: collectionCase?.identity?.legalName || candidate?.name || 'Candidate',
      companyName: company?.name || '',
      checkLabel: CHECK_LABELS[safeCheck],
      categoryLabel: CATEGORY_LABELS[safeCategory],
      message: request.message,
      portalUrl,
      expiresAt,
    });
    const delivery = await send({ to: candidate?.email || '', ...mail, sensitive: true });
    notificationSent = Boolean(delivery?.delivered);
    await (deps.updateRequest || defaultUpdateRequest)({
      requestId: request._id,
      set: { portalTokenRecord: tokenRecord._id },
    });
    if (delivery?.delivered && delivery?.mode === 'MOCK' && ['development', 'test'].includes(String(env.NODE_ENV || 'development'))) {
      logger.info(`[DEV ONLY] BGV info-request portal for ${order.orderCode}: ${portalUrl}`);
    }
  } catch (sendError) {
    // SMTP failure: the request stands; delivery status is audited; no
    // candidate response is fabricated and nothing is rolled back.
    notificationSent = false;
  }
  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_INFO_REQUEST_NOTIFICATION',
    resource: 'BgvInfoRequest',
    resourceId: request._id,
    metadata: { orderCode: order.orderCode, delivered: notificationSent, phase: '30.9' }, // no token, no URL
  });

  return { request: safeRequest(request), idempotent: false, notificationSent };
};

// ── candidate: list own requests through the secure portal ────────
export const listCandidateRequests = async ({ rawToken, deps = {} }) => {
  const listRequests = deps.listRequests || defaultListRequests;
  const ctx = await loadAuthorizedContext({ rawToken, deps });
  const requests = await listRequests({ caseId: ctx.collectionCase._id });
  return {
    requests: requests.map((request) => ({
      ...safeRequest(request),
      // Candidate sees their own response echo; verifier notes are the
      // bounded safe message only.
      ownResponseText: request.response?.text || '',
    })),
  };
};

const loadOwnOpenRequest = async ({ rawToken, requestId, deps, requiredKind = null }) => {
  const findRequestById = deps.findRequestById || defaultFindRequestById;
  const ctx = await loadAuthorizedContext({ rawToken, deps });
  const request = await findRequestById({ requestId });
  // Isolation: a request from another candidate's case is invisible here.
  if (!request || String(request.bgvCollectionCase) !== String(ctx.collectionCase._id)) {
    throw ApiError.notFound('Information request not found');
  }
  if (request.status !== 'OPEN') {
    throw ApiError.conflict('This request is no longer open for responses');
  }
  if (requiredKind && request.responseKind !== requiredKind) {
    throw ApiError.conflict('This request expects a different response type');
  }
  return { ctx, request };
};

// ── candidate: upload a replacement/addition (versioned, private) ─
export const uploadResponseFile = async ({ rawToken, requestId, file, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const storeFile = deps.storeFile || defaultStoreFile;
  const createFile = deps.createFile || defaultCreateFile;
  const updateFile = deps.updateFile || defaultUpdateFile;
  const listActiveFiles = deps.listActiveFiles || defaultListActiveFiles;

  const { ctx, request } = await loadOwnOpenRequest({ rawToken, requestId, deps, requiredKind: 'FILE' });
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw ApiError.badRequest('A file is required');
  }

  // Controlled exception: only the requested evidence category, only via
  // this endpoint. Prior versions become REPLACED — never deleted.
  const category = request.evidenceCategory;
  const previousActive = await listActiveFiles({ companyId: ctx.token.companyId, caseId: ctx.collectionCase._id, category });
  const previous = previousActive[0] || null;
  if (previous) {
    await updateFile({ fileId: previous._id, set: { isActive: false, status: 'REPLACED', replacedAt: new Date() } });
  }
  const stored = await storeFile({ buffer: file.buffer, companyId: ctx.token.companyId, caseId: ctx.collectionCase._id });
  const evidence = await createFile({
    companyId: ctx.token.companyId,
    bgvCollectionCase: ctx.collectionCase._id,
    bgvOrder: ctx.collectionCase.bgvOrder,
    checkType: request.checkType,
    category,
    recordId: null,
    version: previous ? (previous.version || 1) + 1 : 1,
    originalFileName: String(file.originalname || 'document').slice(0, 180),
    mimeType: file.mimetype,
    fileSize: file.size,
    storageProvider: stored.storageProvider,
    storageKey: stored.storageKey,
    checksumSha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    scanStatus: 'NOT_CONFIGURED', // honest: never a fake CLEAN
    status: 'ACTIVE',
    isActive: true,
    uploadedAt: new Date(),
    bgvInfoRequest: request._id,
  });

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_INFO_RESPONSE_FILE_ADDED',
    resource: 'BgvEvidenceFile',
    resourceId: evidence._id,
    metadata: { category, version: evidence.version, requestId: String(request._id), phase: '30.9' }, // no filename/content
  });

  return {
    id: String(evidence._id),
    category,
    version: evidence.version,
    fileSize: evidence.fileSize,
    uploadedAt: evidence.uploadedAt,
    previousVersion: previous ? previous.version : null, // v1 remains historical
  };
};

// ── candidate: add ONE alternate reference (controlled) ───────────
export const addAlternateReference = async ({ rawToken, requestId, record = {}, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const persistCase = deps.persistCase || defaultPersistCase;
  const updateRequest = deps.updateRequest || defaultUpdateRequest;

  const { ctx, request } = await loadOwnOpenRequest({ rawToken, requestId, deps, requiredKind: 'REFERENCE_RECORD' });
  if (request.response?.referenceRecordAdded) {
    throw ApiError.conflict('An alternate reference was already provided for this request');
  }
  const problem = validateReferenceRecord(record);
  if (problem) throw ApiError.badRequest(problem);

  const references = [...(ctx.collectionCase.references || [])];
  references.push({
    name: String(record.name).trim().slice(0, 120),
    organization: String(record.organization || '').trim().slice(0, 200),
    designation: String(record.designation || '').trim().slice(0, 120),
    relationship: String(record.relationship).trim().slice(0, 120),
    email: String(record.email || '').trim().toLowerCase().slice(0, 160),
    phone: String(record.phone || '').trim().slice(0, 20),
    context: String(record.context || '').trim().slice(0, 300),
  });
  const updated = await persistCase({ companyId: ctx.token.companyId, caseId: ctx.collectionCase._id, set: { references } });
  if (!updated) throw ApiError.conflict('Could not persist the reference');

  const marked = await updateRequest({
    requestId: request._id,
    onlyStatus: 'OPEN',
    set: { 'response.referenceRecordAdded': true },
  });
  if (!marked) throw ApiError.conflict('The request changed concurrently — retry');

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_INFO_REFERENCE_ADDED',
    resource: 'BgvInfoRequest',
    resourceId: request._id,
    metadata: { checkType: request.checkType, phase: '30.9' }, // no referee PII
  });
  return { added: true };
};

// ── candidate: explicit response submission (GET never submits) ───
export const submitInfoResponse = async ({ rawToken, requestId, text = '', requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const updateRequest = deps.updateRequest || defaultUpdateRequest;
  const listResponseFiles = deps.listResponseFiles || defaultListResponseFiles;
  const setVerificationState = deps.setVerificationState || defaultSetVerificationState;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const { ctx, request } = await loadOwnOpenRequest({ rawToken, requestId, deps });

  const responseSet = { respondedAt: new Date() };
  if (request.responseKind === 'TEXT') {
    const safe = sanitizeResponseText(text);
    if (safe.length < 3) throw ApiError.badRequest('A clarification is required to submit this response');
    responseSet['response.text'] = safe;
  }
  if (request.responseKind === 'FILE') {
    const files = await listResponseFiles({ requestId: request._id });
    if (files.length === 0) {
      throw ApiError.badRequest('Upload the requested document before submitting the response');
    }
    responseSet['response.fileCount'] = files.length;
  }
  if (request.responseKind === 'REFERENCE_RECORD' && !request.response?.referenceRecordAdded) {
    throw ApiError.badRequest('Provide the alternate reference before submitting the response');
  }

  // Explicit OPEN → CANDIDATE_RESPONDED claim.
  const updated = await updateRequest({ requestId: request._id, onlyStatus: 'OPEN', set: { ...responseSet, status: 'CANDIDATE_RESPONDED' } });
  if (!updated) throw ApiError.conflict('This request was submitted concurrently — reload');

  // The check returns to verifier availability (request stays unresolved
  // until the verifier reviews it).
  const order = await loadOrderById({ orderId: request.bgvOrder });
  const findVerification = deps.findVerification || defaultFindVerification;
  const verification = await findVerification({ orderId: request.bgvOrder, checkType: request.checkType });
  if (verification) {
    await setVerificationState({ verificationId: verification._id, notStates: ['SUBMITTED'], state: 'IN_PROGRESS' });
  }

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_INFO_RESPONSE_SUBMITTED',
    resource: 'BgvInfoRequest',
    resourceId: request._id,
    metadata: { orderCode: order?.orderCode || '', checkType: request.checkType, kind: request.responseKind, phase: '30.9' }, // no response body
  });
  // NOTE: the response is evidence/input — never auto-trusted, never a
  // verification conclusion, never a pipeline change.
  return { request: safeRequest(updated) };
};

// ── verifier: view requests + responses for the assigned check ────
export const verifierListRequests = async ({ verifierId, orderId, checkType, deps = {} }) => {
  const listRequestsForCheck = deps.listRequestsForCheck || defaultListRequestsForCheck;
  const listResponseFiles = deps.listResponseFiles || defaultListResponseFiles;
  await loadOwnAssignment({ verifierId, orderId, checkType, deps });
  const requests = await listRequestsForCheck({ orderId, checkType: String(checkType).toUpperCase() });
  const rows = [];
  for (const request of requests) {
    const files = await listResponseFiles({ requestId: request._id });
    rows.push({
      ...safeRequest(request),
      // Response evidence metadata only; bytes flow through the existing
      // assignment-authorized 30.7 download route (same check).
      responseFiles: files.map((file) => ({
        id: String(file._id),
        category: file.category,
        version: file.version,
        fileName: file.originalFileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        uploadedAt: file.uploadedAt,
      })),
    });
  }
  return { requests: rows };
};

// ── verifier: resolve / cancel ────────────────────────────────────
const closeRequest = async ({ verifierId, orderId, checkType, requestId, from, to, extraSet, auditAction, deps, requestContext }) => {
  const audit = deps.audit || defaultAudit;
  const updateRequest = deps.updateRequest || defaultUpdateRequest;
  const setVerificationState = deps.setVerificationState || defaultSetVerificationState;
  const listRequestsForCheck = deps.listRequestsForCheck || defaultListRequestsForCheck;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  await loadOwnAssignment({ verifierId, orderId, checkType, deps });
  const updated = await updateRequest({ requestId, onlyStatus: from, set: extraSet });
  if (!updated) throw ApiError.conflict('The request is not in the expected state');

  // If no other OPEN request remains, the check leaves AWAITING_CANDIDATE.
  const remaining = await listRequestsForCheck({ orderId, checkType: String(checkType).toUpperCase() });
  const openLeft = remaining.some((entry) => entry.status === 'OPEN' && String(entry._id) !== String(requestId));
  if (!openLeft) {
    const findVerification = deps.findVerification || defaultFindVerification;
    const verification = await findVerification({ orderId, checkType: String(checkType).toUpperCase() });
    if (verification) {
      await setVerificationState({ verificationId: verification._id, notStates: ['SUBMITTED'], state: 'IN_PROGRESS' });
    }
  }
  const order = await loadOrderById({ orderId });
  await auditSafe(audit, {
    req: requestContext,
    action: auditAction,
    resource: 'BgvInfoRequest',
    resourceId: updated._id,
    metadata: { orderCode: order?.orderCode || '', checkType: updated.checkType, category: updated.category, verifierId: String(verifierId), phase: '30.9' },
  });
  void to;
  return { request: safeRequest(updated) };
};

export const resolveInfoRequest = async ({ verifierId, orderId, checkType, requestId, requestContext = null, deps = {} }) =>
  closeRequest({
    verifierId,
    orderId,
    checkType,
    requestId,
    from: 'CANDIDATE_RESPONDED',
    to: 'RESOLVED',
    extraSet: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: verifierId },
    auditAction: 'BGV_INFO_REQUEST_RESOLVED',
    deps,
    requestContext,
  });

export const cancelInfoRequest = async ({ verifierId, orderId, checkType, requestId, requestContext = null, deps = {} }) =>
  closeRequest({
    verifierId,
    orderId,
    checkType,
    requestId,
    from: 'OPEN',
    to: 'CANCELLED',
    extraSet: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: verifierId },
    auditAction: 'BGV_INFO_REQUEST_CANCELLED',
    deps,
    requestContext,
  });
