import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import SecuritySession from '../models/SecuritySession.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';

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

  const user = await User.findById(userId);

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

  const securitySession = await SecuritySession.findOne({
    sessionId: decoded.sessionId,
    user: user._id,
    companyId: user.companyId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });

  if (!securitySession) {
    throw ApiError.unauthorized('Session expired or revoked');
  }

  req.user = user;
  req.companyId = user.companyId;
  req.sessionId = securitySession.sessionId;
  req.securitySession = securitySession;

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