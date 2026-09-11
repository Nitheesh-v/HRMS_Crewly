import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import SecuritySession from '../models/SecuritySession.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { markPerf } from './perfTiming.js';

const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_ADMIN',
  'BILLING_ADMIN',
];

/*
 * Validates:
 * 1. Super Admin JWT → AdminSession is checked later by superAdminSession.
 * 2. Customer JWT → tokenVersion + active SecuritySession are checked here.
 */
export const protect = asyncHandler(async (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Not authorized — no token provided');
  }

  let decoded;

  try {
    decoded = jwt.verify(authorization.slice(7), env.JWT_SECRET);
  } catch (error) {
    const message =
      error.name === 'TokenExpiredError'
        ? 'Access token expired'
        : 'Invalid token';

    throw ApiError.unauthorized(message);
  }

  // Customer tokens use sub. Older/Super Admin tokens use id.
  const userId = decoded.sub || decoded.id;

  if (!userId) {
    throw ApiError.unauthorized('Invalid token subject');
  }

  // Phase 30.6 — principal gate BEFORE any domain DB access: verifier
  // tokens are a separate internal principal and can never ride tenant
  // routes (and tenant/platform tokens can never ride verifier routes).
  if (decoded.principalType === 'BGV_VERIFIER') {
    throw ApiError.unauthorized('Invalid token for this portal');
  }

  // Perf: the user + session reads are independent once keyed by the
  // verified token claims, so they run concurrently (2 sequential Atlas
  // round-trips → 1). Security order is UNCHANGED: every check below
  // runs in the same sequence with identical errors. Platform tokens
  // carry no sessionId, so they still pay exactly one query; a platform
  // token that does carry one fetches a session row that is ignored —
  // platform sessions are validated by superAdminSession, as before.
  const [user, securitySession] = await Promise.all([
    User.findById(userId),
    decoded.sessionId
      ? SecuritySession.findOne({
          sessionId: decoded.sessionId,
          user: userId,
          companyId: decoded.companyId || null,
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        })
      : null,
  ]);

  if (!user) {
    throw ApiError.unauthorized('Account no longer exists');
  }

  if (user.status !== 'ACTIVE') {
    throw ApiError.forbidden('Your account is deactivated');
  }

  /*
   * Super Admin remains separate.
   * The next superAdminSession middleware validates AdminSession.
   */
  if (!user.companyId && PLATFORM_ROLES.includes(user.role)) {
    req.user = user;
    req.companyId = null;
    req.sessionId = decoded.sessionId || null;

    markPerf(req, 'auth');
    return next();
  }

  /*
   * Reject old customer JWTs.
   * Customers must sign in again after this migration.
   */
  const customerTokenIsValid =
    decoded.sessionId &&
    decoded.tokenVersion !== undefined &&
    String(decoded.companyId || '') === String(user.companyId || '') &&
    Number(decoded.tokenVersion) === Number(user.tokenVersion || 0);

  if (!customerTokenIsValid) {
    throw ApiError.unauthorized(
      'Session is no longer valid. Please sign in again.',
    );
  }

  if (!securitySession) {
    throw ApiError.unauthorized('Session expired or revoked');
  }

  req.user = user;
  req.companyId = user.companyId;
  req.sessionId = securitySession.sessionId;
  req.securitySession = securitySession;
  markPerf(req, 'auth');

  // Avoid a database write on every API request.
  if (
    !securitySession.lastSeenAt ||
    Date.now() - securitySession.lastSeenAt.getTime() > 60 * 1000
  ) {
    SecuritySession.updateOne(
      { _id: securitySession._id },
      { $set: { lastSeenAt: new Date() } },
    ).catch(() => {});
  }

  next();
});

/*
 * Usage:
 * router.delete(
 *   '/resource/:id',
 *   protect,
 *   authorize('COMPANY_ADMIN'),
 *   controller,
 * );
 */
export const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    throw ApiError.forbidden(
      'You do not have permission to access this resource',
    );
  }

  next();
};
