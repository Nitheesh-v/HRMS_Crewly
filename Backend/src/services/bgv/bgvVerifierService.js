// Phase 30.6 — INTERNAL BGV VERIFIER accounts & dedicated authentication.
//
// Security boundaries (read before changing):
//  - SECURITY DOMAIN: verifiers are Crewly/Infolexus internal operational
//    principals. They are NOT tenant Users/Employees and NOT platform
//    admins. Separate collections, separate JWT principal type, separate
//    session store; tenant `protect` and `superAdminSession` both reject
//    verifier tokens, and verifier routes reject tenant/platform tokens.
//  - NO TEMPORARY PASSWORDS: invitation → hash-only one-time SETUP token →
//    verifier chooses their own password (platform password policy).
//  - SPECIALIZATION != AUTHORIZATION: specializations mark eligibility for
//    future 30.7 assignment only; nothing here exposes candidates,
//    evidence, orders, pricing, or payment data.
//  - ENUMERATION RESISTANCE: login and forgot-password give identical
//    generic responses for unknown/inactive/wrong-credential cases.
//  - DEACTIVATION: soft status flip + revocation of ALL verifier sessions;
//    every authorized request re-checks account state; history/audit kept.
//  - TOKENS: raw values live only between randomToken() and delivery;
//    hashes are select:false; setup/reset are one-time; OTP is hashed and
//    10-minute bounded; raw values never returned to Super Admin, never
//    audited, never queued.
//
// All collaborators are injectable (deps) for hermetic tests.

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import env from '../../config/env.js';
import BgvVerifier from '../../models/BgvVerifier.js';
import BgvVerifierSession from '../../models/BgvVerifierSession.js';
import BgvVerifierToken from '../../models/BgvVerifierToken.js';
import ApiError from '../../utils/ApiError.js';
import { hashToken, randomToken, validatePassword } from '../../utils/securityPolicy.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { sendMail, bgvVerifierSetupEmail, bgvVerifierResetEmail, bgvVerifierOtpEmail } from '../../utils/mailer.js';
import {
  GENERIC_AUTH_FAILURE,
  OTP_MINUTES,
  RESET_TOKEN_MINUTES,
  SETUP_TOKEN_HOURS,
  isAllowedSpecializationList,
  isValidVerifierEmail,
  normalizeVerifierEmail,
  sanitizeVerifier,
} from './bgvVerifierRules.js';

export const VERIFIER_PRINCIPAL_TYPE = 'BGV_VERIFIER';
const SESSION_HOURS = Math.min(12, Math.max(1, Number(process.env.BGV_VERIFIER_SESSION_HOURS || 8)));
const genericAuthFailure = () => ApiError.unauthorized(GENERIC_AUTH_FAILURE);

// ── default collaborators ─────────────────────────────────────────
const defaultLoadByEmail = (email) =>
  BgvVerifier.findOne({ email }).select('+passwordHash').lean();
const defaultLoadById = (id) => BgvVerifier.findById(id).lean();
const defaultInsertVerifier = (doc) => BgvVerifier.create(doc);
const defaultUpdateVerifier = ({ verifierId, set }) =>
  BgvVerifier.findByIdAndUpdate(verifierId, { $set: set }, { returnDocument: 'after' }).lean();
const defaultSetPassword = async ({ verifierId, plain }) => {
  const hash = await import('bcryptjs').then((m) => m.default.hash(String(plain), 10));
  return BgvVerifier.findByIdAndUpdate(
    verifierId,
    { $set: { passwordHash: hash } },
    { returnDocument: 'after' }
  ).lean();
};
const defaultInsertToken = (doc) => BgvVerifierToken.create(doc);
const defaultResolveToken = (tokenHash) =>
  BgvVerifierToken.findOne({ tokenHash }).select('+tokenHash').lean();
const defaultRevokePendingTokens = ({ verifierId, purpose }) =>
  BgvVerifierToken.updateMany(
    { verifier: verifierId, purpose, usedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
const defaultConsumeToken = ({ tokenId }) =>
  BgvVerifierToken.findOneAndUpdate(
    { _id: tokenId, usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { returnDocument: 'after' }
  ).lean();
const defaultInsertSession = (doc) => BgvVerifierSession.create(doc);
const defaultLoadSession = ({ sessionId, verifierId }) =>
  BgvVerifierSession.findOne({ sessionId, verifier: verifierId, revokedAt: null, expiresAt: { $gt: new Date() } }).lean();
const defaultRevokeSession = ({ sessionId }) =>
  BgvVerifierSession.updateOne({ sessionId, revokedAt: null }, { $set: { revokedAt: new Date() } });
const defaultRevokeAllSessions = ({ verifierId }) =>
  BgvVerifierSession.updateMany({ verifier: verifierId, revokedAt: null }, { $set: { revokedAt: new Date() } });
const defaultTouchSession = ({ sessionId }) =>
  BgvVerifierSession.updateOne({ sessionId }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
const defaultSendMail = (payload) => sendMail(payload);
const defaultAudit = (entry) => recordAudit(entry);
const defaultSignSession = ({ verifierId, sessionId }) =>
  jwt.sign(
    { verifierId, sessionId, principalType: VERIFIER_PRINCIPAL_TYPE },
    env.JWT_SECRET,
    { expiresIn: `${SESSION_HOURS}h` }
  );

const verifierPortalUrl = (kind, rawToken) => {
  const origin = String(env.CLIENT_URL || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
  return kind === 'SETUP'
    ? `${origin}/bgv-verifier/setup/${rawToken}`
    : `${origin}/bgv-verifier/reset-password/${rawToken}`;
};

// ── SUPER ADMIN: invite / manage ──────────────────────────────────
export const inviteVerifier = async ({ actorId, name, email, specializations, requestContext = null, deps = {} }) => {
  const loadByEmail = deps.loadByEmail || defaultLoadByEmail;
  const insertVerifier = deps.insertVerifier || defaultInsertVerifier;
  const revokePendingTokens = deps.revokePendingTokens || defaultRevokePendingTokens;
  const insertToken = deps.insertToken || defaultInsertToken;
  const send = deps.sendMail || defaultSendMail;
  const audit = deps.audit || defaultAudit;

  const safeEmail = normalizeVerifierEmail(email);
  if (!isValidVerifierEmail(safeEmail)) throw ApiError.badRequest('A valid work email is required');
  if (String(name || '').trim().length < 2) throw ApiError.badRequest('Verifier name is required');
  if (!isAllowedSpecializationList(specializations)) {
    throw ApiError.badRequest('Choose at least one of the five approved specializations');
  }

  const existing = await loadByEmail(safeEmail);
  if (existing) throw ApiError.conflict('A verifier account already exists for this email');

  const verifier = await insertVerifier({
    name: String(name).trim(),
    email: safeEmail,
    specializations: [...new Set(specializations)],
    status: 'INVITED', // no password exists; setup email carries a one-time token
    invitedBy: actorId ?? null,
  });

  const rawToken = randomToken(48);
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_HOURS * 60 * 60 * 1000);
  await insertToken({
    verifier: verifier._id,
    purpose: 'SETUP',
    tokenHash: hashToken(rawToken), // hash-only persistence
    expiresAt,
  });

  // Delivery: synchronous sensitive mail — the raw token never enters a
  // queue payload and is never returned to the Super Admin.
  const message = bgvVerifierSetupEmail({ name: verifier.name, setupUrl: verifierPortalUrl('SETUP', rawToken), expiresAt });
  const delivery = await send({ to: safeEmail, ...message, sensitive: true });

  if (
    delivery.delivered &&
    delivery.mode === 'MOCK' &&
    ['development', 'test'].includes(String(env.NODE_ENV || 'development'))
  ) {
    // Local testing only: lets the developer open the setup page without SMTP.
    const { default: logger } = await import('../../config/logger.js');
    logger.info(`[DEV ONLY] BGV verifier setup for ${safeEmail}: ${verifierPortalUrl('SETUP', rawToken)}`);
  }

  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_INVITED',
    actorId,
    resource: 'BgvVerifier',
    resourceId: verifier._id,
    metadata: { specializations: verifier.specializations, phase: '30.6', delivered: Boolean(delivery.delivered) }, // no token/URL
  }).catch(() => {});

  return { verifier: sanitizeVerifier(verifier), deliveryMode: delivery.mode || '' };
};

export const resendVerifierSetup = async ({ actorId, verifierId, requestContext = null, deps = {} }) => {
  const loadById = deps.loadById || defaultLoadById;
  const revokePendingTokens = deps.revokePendingTokens || defaultRevokePendingTokens;
  const insertToken = deps.insertToken || defaultInsertToken;
  const send = deps.sendMail || defaultSendMail;
  const audit = deps.audit || defaultAudit;

  const verifier = await loadById(verifierId);
  if (!verifier) throw ApiError.notFound('Verifier not found');
  if (verifier.setupCompletedAt) {
    throw ApiError.conflict('This account already completed setup — use password reset instead');
  }

  // Reissue safety: the previous outstanding link stops working.
  await revokePendingTokens({ verifierId: verifier._id, purpose: 'SETUP' });
  const rawToken = randomToken(48);
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_HOURS * 60 * 60 * 1000);
  await insertToken({
    verifier: verifier._id,
    purpose: 'SETUP',
    tokenHash: hashToken(rawToken),
    expiresAt,
  });
  const message = bgvVerifierSetupEmail({ name: verifier.name, setupUrl: verifierPortalUrl('SETUP', rawToken), expiresAt });
  const delivery = await send({ to: verifier.email, ...message, sensitive: true });

  if (
    delivery.delivered &&
    delivery.mode === 'MOCK' &&
    ['development', 'test'].includes(String(env.NODE_ENV || 'development'))
  ) {
    const { default: logger } = await import('../../config/logger.js');
    logger.info(`[DEV ONLY] BGV verifier setup (resent) for ${verifier.email}: ${verifierPortalUrl('SETUP', rawToken)}`);
  }

  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_SETUP_RESENT',
    actorId,
    resource: 'BgvVerifier',
    resourceId: verifier._id,
    metadata: { phase: '30.6' },
  }).catch(() => {});

  return { verifier: sanitizeVerifier(verifier) };
};

export const revokeVerifierSetupInvitation = async ({ actorId, verifierId, requestContext = null, deps = {} }) => {
  const loadById = deps.loadById || defaultLoadById;
  const revokePendingTokens = deps.revokePendingTokens || defaultRevokePendingTokens;
  const audit = deps.audit || defaultAudit;

  const verifier = await loadById(verifierId);
  if (!verifier) throw ApiError.notFound('Verifier not found');
  await revokePendingTokens({ verifierId: verifier._id, purpose: 'SETUP' });

  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_SETUP_REVOKED',
    actorId,
    resource: 'BgvVerifier',
    resourceId: verifier._id,
    metadata: { phase: '30.6' },
  }).catch(() => {});

  return { verifier: sanitizeVerifier(verifier) };
};

export const updateVerifierProfile = async ({ actorId, verifierId, specializations, twoFactorEnabled, requestContext = null, deps = {} }) => {
  const loadById = deps.loadById || defaultLoadById;
  const updateVerifier = deps.updateVerifier || defaultUpdateVerifier;
  const audit = deps.audit || defaultAudit;

  const verifier = await loadById(verifierId);
  if (!verifier) throw ApiError.notFound('Verifier not found');

  const set = {};
  if (specializations !== undefined) {
    if (!isAllowedSpecializationList(specializations)) {
      throw ApiError.badRequest('Choose at least one of the five approved specializations');
    }
    set.specializations = [...new Set(specializations)];
  }
  if (twoFactorEnabled !== undefined) {
    set.twoFactorEnabled = Boolean(twoFactorEnabled);
  }
  if (Object.keys(set).length === 0) throw ApiError.badRequest('Nothing to update');

  const updated = await updateVerifier({ verifierId: verifier._id, set });

  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_UPDATED',
    actorId,
    resource: 'BgvVerifier',
    resourceId: verifier._id,
    // Specialization changes are audited; values are safe (no PII beyond
    // the operational allowlist).
    metadata: { specializations: updated.specializations, twoFactorEnabled: updated.twoFactorEnabled, phase: '30.6' },
  }).catch(() => {});

  return sanitizeVerifier(updated);
};

export const deactivateVerifier = async ({ actorId, verifierId, reason = '', requestContext = null, deps = {} }) => {
  const loadById = deps.loadById || defaultLoadById;
  const updateVerifier = deps.updateVerifier || defaultUpdateVerifier;
  const revokeAllSessions = deps.revokeAllSessions || defaultRevokeAllSessions;
  const revokePendingTokens = deps.revokePendingTokens || defaultRevokePendingTokens;
  const audit = deps.audit || defaultAudit;

  const verifier = await loadById(verifierId);
  if (!verifier) throw ApiError.notFound('Verifier not found');
  if (verifier.status === 'DEACTIVATED') return sanitizeVerifier(verifier);

  // Soft operational deactivation — history/audit records are preserved.
  const updated = await updateVerifier({
    verifierId: verifier._id,
    set: {
      status: 'DEACTIVATED',
      deactivatedAt: new Date(),
      deactivatedReason: String(reason || '').slice(0, 200),
    },
  });
  // Active access ends immediately: every session is revoked; outstanding
  // setup/reset tokens cannot be used while deactivated.
  await revokeAllSessions({ verifierId: verifier._id });
  await revokePendingTokens({ verifierId: verifier._id, purpose: 'SETUP' });
  await revokePendingTokens({ verifierId: verifier._id, purpose: 'RESET' });

  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_DEACTIVATED',
    actorId,
    resource: 'BgvVerifier',
    resourceId: verifier._id,
    metadata: { phase: '30.6' },
  }).catch(() => {});

  return sanitizeVerifier(updated);
};

export const reactivateVerifier = async ({ actorId, verifierId, requestContext = null, deps = {} }) => {
  const loadById = deps.loadById || defaultLoadById;
  const updateVerifier = deps.updateVerifier || defaultUpdateVerifier;
  const audit = deps.audit || defaultAudit;

  const verifier = await loadById(verifierId);
  if (!verifier) throw ApiError.notFound('Verifier not found');
  if (verifier.status !== 'DEACTIVATED') return sanitizeVerifier(verifier);

  // Reactivation never issues a password: accounts that finished setup
  // return to ACTIVE with their existing credential; accounts that never
  // completed setup return to INVITED (reinvite semantics preserved).
  const nextStatus = verifier.setupCompletedAt ? 'ACTIVE' : 'INVITED';
  const updated = await updateVerifier({
    verifierId: verifier._id,
    set: { status: nextStatus, deactivatedAt: null, deactivatedReason: '' },
  });

  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_REACTIVATED',
    actorId,
    resource: 'BgvVerifier',
    resourceId: verifier._id,
    metadata: { nextStatus, phase: '30.6' },
  }).catch(() => {});

  return sanitizeVerifier(updated);
};

export const listVerifiers = async ({ deps = {} }) => {
  const rows = await BgvVerifier.find().sort({ createdAt: -1 }).lean();
  return rows.map(sanitizeVerifier);
};

export const getVerifier = async ({ verifierId, deps = {} }) => {
  const loadById = deps.loadById || defaultLoadById;
  const verifier = await loadById(verifierId);
  if (!verifier) throw ApiError.notFound('Verifier not found');
  return sanitizeVerifier(verifier);
};

// ── VERIFIER: setup / login / session ─────────────────────────────
export const completeVerifierSetup = async ({ rawToken, password, requestContext = null, deps = {} }) => {
  const resolveToken = deps.resolveToken || defaultResolveToken;
  const consumeToken = deps.consumeToken || defaultConsumeToken;
  const setPassword = deps.setPassword || defaultSetPassword;
  const updateVerifier = deps.updateVerifier || defaultUpdateVerifier;
  const audit = deps.audit || defaultAudit;

  if (typeof rawToken !== 'string' || rawToken.length < 40) throw ApiError.notFound('Setup link is unavailable');
  const token = await resolveToken(hashToken(rawToken));
  if (!token || token.purpose !== 'SETUP' || token.revokedAt) throw ApiError.notFound('Setup link is unavailable');
  if (new Date(token.expiresAt).getTime() <= Date.now()) throw ApiError.notFound('This setup link has expired — ask the platform team to resend it');

  const policy = validatePassword(String(password || ''));
  if (!policy.valid) throw ApiError.badRequest(policy.errors[0] || 'Password does not meet the security policy');

  // One-time consumption: a replayed link (or concurrent use) loses the race.
  const consumed = await consumeToken({ tokenId: token._id });
  if (!consumed) throw ApiError.conflict('This setup link was already used');

  await setPassword({ verifierId: token.verifier, plain: password });
  const updated = await updateVerifier({
    verifierId: token.verifier,
    set: { status: 'ACTIVE', setupCompletedAt: new Date() },
  });

  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_SETUP_COMPLETED',
    resource: 'BgvVerifier',
    resourceId: token.verifier,
    metadata: { phase: '30.6' }, // no token, no password, no hash
  }).catch(() => {});

  // No session is issued — the verifier signs in via the dedicated login.
  return { verifier: sanitizeVerifier(updated) };
};

export const loginVerifier = async ({ email, password, challengeId = '', code = '', requestIp = '', userAgent = '', requestContext = null, deps = {} }) => {
  const loadByEmail = deps.loadByEmail || defaultLoadByEmail;
  const resolveToken = deps.resolveToken || defaultResolveToken;
  const consumeToken = deps.consumeToken || defaultConsumeToken;
  const insertToken = deps.insertToken || defaultInsertToken;
  const loadTokenById = deps.loadTokenById || defaultLoadTokenById;
  const insertSession = deps.insertSession || defaultInsertSession;
  const updateVerifier = deps.updateVerifier || defaultUpdateVerifier;
  const send = deps.sendMail || defaultSendMail;
  const signSession = deps.signSession || defaultSignSession;
  const audit = deps.audit || defaultAudit;

  const verifier = await loadByEmail(normalizeVerifierEmail(email));
  const validPassword = verifier ? await verifierCompare(verifier, password) : false;

  // Enumeration resistance: unknown account, wrong password, and
  // deactivated account all produce the SAME generic failure.
  if (!verifier || !validPassword || verifier.status !== 'ACTIVE') {
    throw genericAuthFailure();
  }

  // Optional email-OTP 2FA (platform pattern: hashed code, 10-minute bound).
  if (verifier.twoFactorEnabled) {
    if (!code) {
      const otp = String(crypto.randomInt(100000, 999999));
      const challenge = await insertToken({
        verifier: verifier._id,
        purpose: 'TWO_FACTOR',
        tokenHash: hashToken(otp),
        expiresAt: new Date(Date.now() + OTP_MINUTES * 60 * 1000),
        requestedIp: String(requestIp || '').slice(0, 64),
      });
      await send({ to: verifier.email, ...bgvVerifierOtpEmail({ code: otp }) });
      return { requiresTwoFactor: true, challengeId: String(challenge._id) };
    }
    const challenge = challengeId ? await loadTokenById({ tokenId: challengeId }) : null;
    if (
      !challenge ||
      String(challenge.verifier) !== String(verifier._id) ||
      challenge.purpose !== 'TWO_FACTOR' ||
      challenge.revokedAt
    ) {
      throw genericAuthFailure();
    }
    if (hashToken(String(code || '')) !== challenge.tokenHash) throw genericAuthFailure();
    const consumed = await consumeToken({ tokenId: challenge._id });
    if (!consumed) throw genericAuthFailure();
  }

  const sessionId = crypto.randomUUID();
  const session = await insertSession({
    verifier: verifier._id,
    sessionId,
    ip: String(requestIp || '').slice(0, 64),
    userAgent: String(userAgent || '').slice(0, 300),
    expiresAt: new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000),
  });
  const token = signSession({ verifierId: String(verifier._id), sessionId });
  await updateVerifier({ verifierId: verifier._id, set: { lastLoginAt: new Date() } });

  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_LOGIN',
    resource: 'BgvVerifier',
    resourceId: verifier._id,
    metadata: { phase: '30.6' }, // no session token logged
  }).catch(() => {});

  return {
    token,
    verifier: sanitizeVerifier({ ...verifier, lastLoginAt: new Date() }),
    sessionExpiresAt: session.expiresAt,
  };
};

const verifierCompare = async (verifier, password) => {
  if (!verifier?.passwordHash) return false;
  const { default: bcrypt } = await import('bcryptjs');
  return bcrypt.compare(String(password || ''), verifier.passwordHash);
};

const defaultLoadTokenById = ({ tokenId }) =>
  mongoose.isValidObjectId(tokenId)
    ? BgvVerifierToken.findById(tokenId).select('+tokenHash').lean()
    : Promise.resolve(null);

export const getVerifierProfile = async ({ verifierId, deps = {} }) => {
  const loadById = deps.loadById || defaultLoadById;
  const verifier = await loadById(verifierId);
  if (!verifier || verifier.status !== 'ACTIVE') throw ApiError.unauthorized('Verifier account is not active');
  return sanitizeVerifier(verifier);
};

export const logoutVerifier = async ({ verifierId, sessionId, requestContext = null, deps = {} }) => {
  const revokeSession = deps.revokeSession || defaultRevokeSession;
  const audit = deps.audit || defaultAudit;
  await revokeSession({ sessionId });
  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_LOGOUT',
    resource: 'BgvVerifier',
    resourceId: verifierId,
    metadata: { phase: '30.6' },
  }).catch(() => {});
  return { loggedOut: true };
};

// ── password recovery (generic, hash-only, sessions revoked) ──────
export const requestVerifierPasswordReset = async ({ email, requestIp = '', requestContext = null, deps = {} }) => {
  const loadByEmail = deps.loadByEmail || defaultLoadByEmail;
  const insertToken = deps.insertToken || defaultInsertToken;
  const send = deps.sendMail || defaultSendMail;

  // Identical response whether or not the account exists.
  const verifier = await loadByEmail(normalizeVerifierEmail(email));
  if (verifier && verifier.status === 'ACTIVE' && verifier.setupCompletedAt) {
    const rawToken = randomToken(48);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000);
    await insertToken({
      verifier: verifier._id,
      purpose: 'RESET',
      tokenHash: hashToken(rawToken),
      expiresAt,
      requestedIp: String(requestIp || '').slice(0, 64),
    });
    const message = bgvVerifierResetEmail({ name: verifier.name, resetUrl: verifierPortalUrl('RESET', rawToken), expiresAt });
    await send({ to: verifier.email, ...message, sensitive: true }).catch(() => {});
  }
  return {
    message: 'If an active BGV verifier account exists for this address, a reset link has been sent',
  };
};

export const resetVerifierPassword = async ({ rawToken, password, requestContext = null, deps = {} }) => {
  const resolveToken = deps.resolveToken || defaultResolveToken;
  const consumeToken = deps.consumeToken || defaultConsumeToken;
  const setPassword = deps.setPassword || defaultSetPassword;
  const revokeAllSessions = deps.revokeAllSessions || defaultRevokeAllSessions;
  const audit = deps.audit || defaultAudit;

  if (typeof rawToken !== 'string' || rawToken.length < 40) throw ApiError.notFound('Reset link is unavailable');
  const token = await resolveToken(hashToken(rawToken));
  if (!token || token.purpose !== 'RESET' || token.revokedAt) throw ApiError.notFound('Reset link is unavailable');
  if (new Date(token.expiresAt).getTime() <= Date.now()) throw ApiError.notFound('This reset link has expired');

  const policy = validatePassword(String(password || ''));
  if (!policy.valid) throw ApiError.badRequest(policy.errors[0] || 'Password does not meet the security policy');

  const consumed = await consumeToken({ tokenId: token._id });
  if (!consumed) throw ApiError.conflict('This reset link was already used');

  await setPassword({ verifierId: token.verifier, plain: password });
  // Existing security policy: a password change signs out existing sessions.
  await revokeAllSessions({ verifierId: token.verifier });

  await audit({
    req: requestContext,
    action: 'BGV_VERIFIER_PASSWORD_RESET',
    resource: 'BgvVerifier',
    resourceId: token.verifier,
    metadata: { phase: '30.6' },
  }).catch(() => {});

  return { reset: true };
};

// ── middleware support: session resolution ────────────────────────
export const resolveVerifierSession = async ({ decoded, deps = {} }) => {
  const loadSession = deps.loadSession || defaultLoadSession;
  const loadById = deps.loadById || defaultLoadById;
  const touchSession = deps.touchSession || defaultTouchSession;

  if (!decoded || decoded.principalType !== VERIFIER_PRINCIPAL_TYPE || !decoded.sessionId || !decoded.verifierId) {
    return null;
  }
  const session = await loadSession({ sessionId: decoded.sessionId, verifierId: decoded.verifierId });
  if (!session) return null;
  const verifier = await loadById(decoded.verifierId);
  if (!verifier || verifier.status !== 'ACTIVE') return null;
  touchSession({ sessionId: session.sessionId });
  return { verifier, session };
};
