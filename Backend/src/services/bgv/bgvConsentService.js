// Phase 30.4 — CANDIDATE BGV CONSENT service.
//
// Security boundaries (read before changing):
//  - Commercial readiness: invitations require BgvOrder.status === 'PAID' —
//    the authoritative 30.3 business state. No Razorpay/payment-provider
//    field is ever consulted here, so future billing methods (credits,
//    invoicing, subscription BGV) reach the same boundary unchanged.
//  - RAW TOKENS ARE NEVER PERSISTED OR LOGGED: only sha256 hashes (schema
//    select:false). The raw token lives in memory between randomToken() and
//    the synchronous sensitive sendMail — it never enters a queue payload.
//  - SCANNER-SAFE GET: resolving the portal link records views only; it can
//    never consent, decline, consume the decision, start BGV, create
//    documents, contact verifiers or move the recruitment pipeline.
//  - DECISIONS ARE EXPLICIT POSTS: consent/decline are atomic null ->
//    decision claims; identical repeats replay idempotently; opposite
//    terminal decisions conflict (no silent re-consent in 30.4).
//  - Consent != verified. Decline != failed. Nothing here mutates
//    candidate.currentStage, creates BGV cases/verifiers/documents, or
//    rejects the candidate.
//  - Payment != consent (30.3); HR decision != candidate consent (30.1).
//
// All Mongo/mail/audit collaborators are injectable (deps) for hermetic
// tests; defaults are the real Mongo/mailer/audit implementations.

import mongoose from 'mongoose';
import env from '../../config/env.js';
import logger from '../../config/logger.js';
import Candidate from '../../models/Candidate.js';
import Company from '../../models/Company.js';
import BgvOrder from '../../models/BgvOrder.js';
import BgvConsentAccessToken from '../../models/BgvConsentAccessToken.js';
import ApiError from '../../utils/ApiError.js';
import { sendMail, bgvConsentInvitationEmail } from '../../utils/mailer.js';
import { hashToken, randomToken } from '../../utils/securityPolicy.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  BGV_CONSENT_PURPOSE,
  BGV_CONSENT_TOKEN_MAX_DAYS,
  CONSENT_POLICY_VERSION,
  CONSENT_STATEMENT_TEXT,
  consentStatementHash,
  deriveConsentState,
  evaluateConsentDecision,
} from './bgvConsentRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);
const genericFailure = () => ApiError.notFound('BGV consent link is unavailable');

// ── default (Mongo / mail / audit) collaborators ─────────────────
const defaultLoadOrder = ({ companyId, orderId }) =>
  isObjectId(orderId)
    ? BgvOrder.findOne({ _id: orderId, companyId }).lean()
    : Promise.resolve(null);

const defaultLoadCandidate = ({ companyId, candidateId }) =>
  Candidate.findOne({ _id: candidateId, companyId }).lean();

const defaultLoadCompany = ({ companyId }) =>
  Company.findOne({ _id: companyId }).select('name').lean();

const defaultLoadLatestToken = ({ companyId, orderId }) =>
  BgvConsentAccessToken.findOne({ companyId, bgvOrder: orderId })
    .sort({ createdAt: -1 })
    .lean();

const defaultResolveToken = (tokenHash) =>
  BgvConsentAccessToken.findOne({ tokenHash }).select('+tokenHash +activeKey').lean();

const defaultRevokeActiveTokens = ({ companyId, orderId, reason }) =>
  BgvConsentAccessToken.updateMany(
    { companyId, bgvOrder: orderId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: String(reason).slice(0, 200), activeKey: null } }
  );

const defaultInsertToken = (doc) => BgvConsentAccessToken.create(doc);

const defaultRecordView = (tokenRecordId) =>
  BgvConsentAccessToken.updateOne(
    { _id: tokenRecordId, revokedAt: null },
    { $set: { lastViewedAt: new Date() }, $inc: { viewCount: 1 } }
  );

// Atomic null -> decision claim; the ONLY way a decision is stored.
const defaultClaimDecision = ({ tokenRecordId, set }) =>
  BgvConsentAccessToken.findOneAndUpdate(
    { _id: tokenRecordId, revokedAt: null, finalDecision: null },
    { $set: set },
    { returnDocument: 'after' }
  ).lean();

const defaultReloadToken = ({ companyId, tokenRecordId }) =>
  BgvConsentAccessToken.findOne({ _id: tokenRecordId, companyId }).lean();

const defaultSendMail = (payload) => sendMail(payload);
const defaultAudit = (entry) => recordAudit(entry);

const consentPortalUrl = (rawToken) => {
  const clientOrigin = String(env.CLIENT_URL || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
  return `${clientOrigin}/candidate/bgv-consent/${rawToken}`;
};

// ── HR: issue / reissue the candidate invitation ─────────────────
export const issueBgvConsentInvitation = async ({
  companyId,
  orderId,
  actorId,
  requestContext = null,
  deps = {},
}) => {
  const loadOrder = deps.loadOrder || defaultLoadOrder;
  const loadCandidate = deps.loadCandidate || defaultLoadCandidate;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const loadLatestToken = deps.loadLatestToken || defaultLoadLatestToken;
  const revokeActiveTokens = deps.revokeActiveTokens || defaultRevokeActiveTokens;
  const insertToken = deps.insertToken || defaultInsertToken;
  const send = deps.sendMail || defaultSendMail;
  const audit = deps.audit || defaultAudit;

  // DB Logic - tenant-scoped commercial readiness gate.
  const order = await loadOrder({ companyId, orderId });
  if (!order) throw ApiError.notFound('BGV order not found');
  if (order.status !== 'PAID') {
    // The ONLY commercial-readiness check: the 30.3 business state.
    throw ApiError.conflict(
      'Candidate consent invitations require a commercially authorized (paid) BGV order'
    );
  }

  const latest = await loadLatestToken({ companyId, orderId });
  const reissued = Boolean(latest);
  if (latest?.finalDecision) {
    // A completed candidate decision is terminal — resend must never
    // invalidate or reopen it in 30.4.
    throw ApiError.conflict(
      latest.finalDecision === 'CONSENTED'
        ? 'The candidate already consented — a new invitation would not change that'
        : 'The candidate already declined — reissue requires an authorized future workflow'
    );
  }
  if (latest && !latest.revokedAt) {
    // Rotation: the previous active link stops working.
    await revokeActiveTokens({ companyId, orderId, reason: 'SUPERSEDED' });
  }

  const candidate = await loadCandidate({ companyId, candidateId: order.candidate });
  if (!candidate) throw ApiError.notFound('Candidate not found');
  const company = await loadCompany({ companyId });
  const companyName = company?.name || '';

  const expiresAt = new Date(
    Date.now() + BGV_CONSENT_TOKEN_MAX_DAYS * 24 * 60 * 60 * 1000
  );
  let rawToken = '';
  let tokenRecordId = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    rawToken = randomToken(48); // cryptographically strong, base64url
    try {
      const record = await insertToken({
        companyId,
        candidate: candidate._id,
        bgvOrder: order._id,
        purpose: BGV_CONSENT_PURPOSE,
        tokenHash: hashToken(rawToken), // hash-only persistence
        expiresAt,
        issuedBy: actorId ?? null,
        orderCode: order.orderCode,
      });
      tokenRecordId = record._id;
      break;
    } catch (error) {
      if (error?.code !== 11000 || attempt === 2) throw error;
    }
  }

  // Delivery: synchronous sensitive mail (offer pattern) — the raw token
  // never touches any queue payload.
  const message = bgvConsentInvitationEmail({
    candidateName: candidate.name,
    companyName,
    portalUrl: consentPortalUrl(rawToken),
    expiresAt,
  });
  const delivery = await send({ to: candidate.email, ...message, sensitive: true });

  // Local testing only: sensitive MOCK mail hides the body/link; print the
  // portal URL once so HR can open it without SMTP.
  if (
    delivery.delivered &&
    delivery.mode === 'MOCK' &&
    ['development', 'test'].includes(String(env.NODE_ENV || 'development'))
  ) {
    logger.info(
      `[DEV ONLY] BGV consent portal for ${order.orderCode} → ${candidate.email}: ${consentPortalUrl(rawToken)}`
    );
  }

  if (!delivery.delivered) {
    // SMTP failure must not corrupt the paid order: revoke the undelivered
    // link, keep PAID authoritative, allow a safe resend later.
    await revokeActiveTokens({ companyId, orderId, reason: 'DELIVERY_FAILED' });
    await audit({
      req: requestContext,
      action: 'BGV_CONSENT_INVITATION_FAILED',
      companyId,
      actorId,
      resource: 'BgvOrder',
      resourceId: order._id,
      metadata: { orderCode: order.orderCode, mode: delivery.mode || '' },
      statusCode: 503,
    }).catch(() => {});
    throw new ApiError(503, 'Invitation delivery failed safely — the BGV order remains paid; resend when ready');
  }

  await audit({
    req: requestContext,
    action: reissued ? 'BGV_CONSENT_INVITATION_REISSUED' : 'BGV_CONSENT_INVITATION_ISSUED',
    companyId,
    actorId,
    resource: 'BgvOrder',
    resourceId: order._id,
    metadata: { orderCode: order.orderCode, phase: '30.4' }, // no token/hash/URL
  }).catch(() => {});

  return {
    reissued,
    state: 'INVITATION_SENT',
    expiresAt,
    deliveryMode: delivery.mode || '',
    orderCode: order.orderCode,
  };
};

// ── public: scanner-safe portal read (decision-free GET) ─────────
export const resolvePublicBgvConsent = async ({ rawToken, deps = {} }) => {
  const resolveToken = deps.resolveToken || defaultResolveToken;
  const recordView = deps.recordView || defaultRecordView;
  const loadOrder = deps.loadOrderById || defaultLoadOrderById;
  const loadCandidate = deps.loadCandidate || defaultLoadCandidate;
  const loadCompany = deps.loadCompany || defaultLoadCompany;

  if (typeof rawToken !== 'string' || rawToken.length < 40 || rawToken.length > 200) {
    throw genericFailure();
  }
  const token = await resolveToken(hashToken(rawToken));
  // Purpose isolation + revocation: same generic failure as the offer portal.
  if (!token || token.purpose !== BGV_CONSENT_PURPOSE || token.revokedAt) {
    throw genericFailure();
  }
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    throw ApiError.notFound('This link has expired — ask the hiring team to resend it');
  }

  // View telemetry only — NEVER a decision (scanner-safe GET).
  await recordView(token._id).catch(() => {});

  const order = await loadOrder({ companyId: token.companyId, orderId: token.bgvOrder });
  if (!order || order.status !== 'PAID') throw genericFailure();
  const [candidate, company] = await Promise.all([
    loadCandidate({ companyId: token.companyId, candidateId: token.candidate }),
    loadCompany({ companyId: token.companyId }),
  ]);

  return {
    state: token.finalDecision === 'CONSENTED'
      ? 'CONSENTED'
      : token.finalDecision === 'DECLINED'
        ? 'DECLINED'
        : 'PENDING',
    companyName: company?.name || 'the requesting organisation',
    candidateName: candidate?.name || 'Candidate',
    orderCode: order.orderCode,
    // The checks the candidate consents to come from the PAID order
    // snapshot — later catalogue changes cannot rewrite them.
    checks: (order.items || []).map((item) => ({ type: item.type, name: item.name })),
    consentVersion: CONSENT_POLICY_VERSION,
    statement: CONSENT_STATEMENT_TEXT,
    expiresAt: token.expiresAt,
    decidedAt: token.decidedAt || null,
  };
};

const defaultLoadOrderById = ({ companyId, orderId }) =>
  BgvOrder.findOne({ _id: orderId, companyId }).lean();

// ── public: explicit POST consent / decline ──────────────────────
export const recordBgvConsentDecision = async ({ rawToken, decision, deps = {} }) => {
  const resolveToken = deps.resolveToken || defaultResolveToken;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const claimDecision = deps.claimDecision || defaultClaimDecision;
  const reloadToken = deps.reloadToken || defaultReloadToken;
  const audit = deps.audit || defaultAudit;

  if (typeof rawToken !== 'string' || rawToken.length < 40 || rawToken.length > 200) {
    throw genericFailure();
  }
  const token = await resolveToken(hashToken(rawToken));
  if (!token || token.purpose !== BGV_CONSENT_PURPOSE || token.revokedAt) {
    throw genericFailure();
  }
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    throw ApiError.notFound('This link has expired — ask the hiring team to resend it');
  }

  // Commercial readiness re-checked at decision time from the 30.3 state.
  const order = await loadOrderById({ companyId: token.companyId, orderId: token.bgvOrder });
  if (!order || order.status !== 'PAID') throw genericFailure();

  const gate = evaluateConsentDecision({ current: token.finalDecision, requested: decision });
  if (!gate.allowed) {
    throw ApiError.conflict(
      'A conflicting decision was already recorded for this invitation — contact the hiring team'
    );
  }
  if (gate.idempotent) {
    return { idempotent: true, changed: false, state: token.finalDecision };
  }

  const checksSnapshot = (order.items || []).map((item) => ({
    type: item.type,
    name: item.name,
  }));
  const claimed = await claimDecision({
    tokenRecordId: token._id,
    set: {
      finalDecision: decision,
      decidedAt: new Date(),
      consentVersion: CONSENT_POLICY_VERSION,
      consentTextHash: consentStatementHash(),
      checksSnapshot,
      orderCode: order.orderCode,
    },
  });
  if (!claimed) {
    // Concurrent opposite decision lost the race.
    const reloaded = await reloadToken({ companyId: token.companyId, tokenRecordId: token._id });
    if (reloaded?.finalDecision === decision) {
      return { idempotent: true, changed: false, state: decision };
    }
    throw ApiError.conflict('A conflicting decision was already recorded for this invitation');
  }

  await audit({
    req: null, // public candidate action — no tenant req context
    action: decision === 'CONSENTED' ? 'BGV_CONSENT_RECORDED' : 'BGV_CONSENT_DECLINED',
    companyId: token.companyId,
    actorId: null,
    actorName: 'CANDIDATE',
    resource: 'BgvConsentAccessToken',
    resourceId: token._id,
    metadata: {
      orderCode: order.orderCode,
      consentVersion: CONSENT_POLICY_VERSION, // wording provenance, no token
      phase: '30.4',
    },
  }).catch(() => {});

  // NOTE: no documents, no verifier, no BGV case, no pipeline change.
  return { idempotent: false, changed: true, state: decision };
};

// ── HR: consent visibility (tenant-scoped) ───────────────────────
export const getHrConsentStatus = async ({ companyId, candidateRef, deps = {} }) => {
  const loadCandidateByRef =
    deps.loadCandidateByRef ||
    (({ companyId: company, candidateRef: ref }) => {
      const filter = isObjectId(ref)
        ? { _id: ref, companyId: company }
        : { companyId: company, candidateCode: String(ref || '').trim().toUpperCase() };
      return Candidate.findOne(filter).lean();
    });
  const loadLatestOrder =
    deps.loadLatestOrder ||
    (({ companyId: company, candidateId }) =>
      BgvOrder.findOne({ companyId: company, candidate: candidateId, openKey: 'OPEN' }).lean());
  const loadLatestToken = deps.loadLatestToken || defaultLoadLatestToken;

  const candidate = await loadCandidateByRef({ companyId, candidateRef });
  if (!candidate) throw ApiError.notFound('Candidate not found');
  const order = await loadLatestOrder({ companyId, candidateId: candidate._id });
  if (!order) {
    return { state: 'NONE', order: null, token: null };
  }
  const token = await loadLatestToken({ companyId, orderId: order._id });
  return {
    state: deriveConsentState({ token }),
    order: {
      id: order._id,
      orderCode: order.orderCode,
      status: order.status, // PAID != CONSENTED — both stay visible
      totalDisplay: order.totalMinorUnits,
    },
    token: token
      ? {
          issuedAt: token.createdAt,
          expiresAt: token.expiresAt,
          decidedAt: token.decidedAt,
          consentVersion: token.consentVersion || '',
          viewCount: token.viewCount || 0,
          lastViewedAt: token.lastViewedAt,
        }
      : null,
  };
};
