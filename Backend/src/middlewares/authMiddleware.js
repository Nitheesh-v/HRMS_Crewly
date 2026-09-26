import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import SecuritySession from '../models/SecuritySession.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getAccessToken, getRefreshToken } from '../utils/tokenService.js';
import { markPerf } from './perfTiming.js';

const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_ADMIN',
  'BILLING_ADMIN',
];

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'XMLHttpRequest';

/** Methods a cross-site form can send; they must never change state. */
const CSRF_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * 33.14 — CSRF GATE FOR COOKIE-AUTHENTICATED WRITES.
 *
 * A cookie is ambient authority: the browser attaches it to any request to
 * the API, including one a hostile page triggered. The header below is the
 * proof that the call came from our own JavaScript (the axios layer sets it
 * on every request). A cross-site caller cannot add a custom header without
 * a CORS preflight, and the allowlist in src/app.js never approves a
 * preflight from an unknown origin — so it can send the request, but not
 * the proof.
 *
 * Scope, deliberately narrow:
 *   · only COOKIE-authenticated requests are gated (a Bearer caller already
 *     proved intent by holding a token no page can borrow);
 *   · only state-changing methods (a cross-site GET must stay harmless, and
 *     it is — the read surface is tenant-scoped, not action-taking);
 *   · the socket handshake is not affected at all: it authenticates with a
 *     short-lived ticket, never a cookie (33.1's locked decision).
 *
 * Pure and exported so the decision is testable without a request object.
 */
export const needsCsrfHeader = ({
  method,
  authSource,
  requestedWith,
} = {}) =>
  authSource === 'cookie' &&
  !CSRF_SAFE_METHODS.includes(String(method || 'GET').toUpperCase()) &&
  requestedWith !== CSRF_HEADER_VALUE;

/**
 * Express-middleware form of the same decision, for cookie-authenticated
 * routes that do NOT run `protect` — today exactly one: POST /auth/refresh,
 * which authenticates with the refresh cookie and rotates tokens. It is
 * state-changing, so a cross-site page must not be able to trigger it.
 *
 * `req.authSource` is reused when `protect` already resolved it; on the
 * refresh route there is no access token at all, so the presence of the
 * refresh cookie IS the cookie authentication.
 */
export const requireCsrfProof = (req, res, next) => {
  const authSource =
    req.authSource || (getRefreshToken(req) ? 'cookie' : 'none');

  const requestedWith = req.get
    ? req.get('X-Requested-With')
    : req.headers?.[CSRF_HEADER];

  if (!needsCsrfHeader({ method: req.method, authSource, requestedWith })) {
    return next();
  }

  return res.status(403).json({
    statusCode: 403,
    success: false,
    code: 'CSRF_HEADER_REQUIRED',
    message: 'This request was not sent by the Crewly app.',
  });
};

/*
 * Validates:
 * 1. Super Admin JWT → AdminSession is checked later by superAdminSession.
 * 2. Customer JWT → tokenVersion + active SecuritySession are checked here.
 *
 * 33.14 — TOKEN SOURCES, in precedence order:
 *   1. `Authorization: Bearer …` — non-browser clients, the platform portal
 *      (its AdminSession token is unchanged), kiosk devices, verifiers, and
 *      any script. An explicit header always wins: it is the caller stating
 *      which identity it means, and it cannot be attached by a hostile page.
 *   2. the HttpOnly `crewly_access` cookie — the customer SPA, which no
 *      longer keeps any token in JavaScript.
 * Everything below is byte-for-byte the same accept/reject logic as before.
 */
export const protect = asyncHandler(async (req, res, next) => {
  const authorization = req.headers.authorization;

  const bearerToken = authorization?.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';

  const cookieToken = bearerToken ? '' : getAccessToken(req);

  const token = bearerToken || cookieToken;

  req.authSource = bearerToken ? 'bearer' : cookieToken ? 'cookie' : 'none';

  if (!token) {
    throw ApiError.unauthorized('Not authorized — no token provided');
  }

  if (
    needsCsrfHeader({
      method: req.method,
      authSource: req.authSource,
      requestedWith: req.get
        ? req.get('X-Requested-With')
        : req.headers?.[CSRF_HEADER],
    })
  ) {
    /*
     * The error pipeline (utils/errorHandler) does not carry a custom
     * `code`, and the SPA needs to tell this apart from an expired session,
     * so the refusal is written directly — same shape as the 409 refresh
     * race (33.13).
     */
    return res.status(403).json({
      statusCode: 403,
      success: false,
      code: 'CSRF_HEADER_REQUIRED',
      message: 'This request was not sent by the Crewly app.',
    });
  }

  let decoded;

  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
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
