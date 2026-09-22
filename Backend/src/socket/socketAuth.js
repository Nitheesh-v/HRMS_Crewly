// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.1 — CHAT SOCKET HANDSHAKE AUTHENTICATION
//
//  A Socket.IO handshake is NOT an Express request: NONE of the tenant
//  middleware chain in src/app.js / src/routes/index.js runs for it —
//  no `protect`, no `tenantContext`, no `auditTrail`, no rate limiter.
//  So this module re-expresses `protect` (src/middlewares/authMiddleware.js)
//  for the socket handshake with the SAME accept/reject decisions: every
//  token `protect` would 401/403 is refused here, and nothing `protect`
//  would admit is refused. The two are pinned against each other by
//  test/chatSocketFoundation.test.js so they cannot silently drift.
//
//  One deliberate ordering difference: the principal gates (BGV verifier,
//  kiosk) are evaluated BEFORE the subject check, so the internal reason
//  is precise ("wrong portal") rather than incidental ("no subject").
//  Reasons are internal only — both orders reject identically.
//
//  Token source: socket.handshake.auth.token ONLY.
//    · NOT the query string (a token in a URL reaches proxy/access logs)
//    · NOT a cookie (no cookies on sockets — locked decision; also removes
//      the CSRF surface a cookie-bearing handshake would create)
//
//  Tenant derivation: companyId comes from the Mongo User document. The
//  signed token claim is only COMPARED against it (exactly as `protect`
//  does). A client-supplied companyId is never read — there is no code
//  path that reads one.
//
//  Returns { ok, reason } — never throws. Reasons are internal only; the
//  client always receives the one generic CHAT_UNAUTHORIZED contract.
// ═══════════════════════════════════════════════════════════════════════════
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import Company from '../models/Company.js';
import SecuritySession from '../models/SecuritySession.js';
import User from '../models/User.js';

/**
 * MUST mirror the PLATFORM_ROLES list in src/middlewares/authMiddleware.js
 * (that list is module-private there, so it is restated here and pinned by
 * a source-comparison test rather than duplicated silently).
 */
const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_ADMIN',
  'BILLING_ADMIN',
];

/** Kiosk token discriminators (src/services/attendance/attendanceKioskService.js). */
const KIOSK_TOKEN_TYPES = ['kiosk', 'kiosk-employee'];

/** Company statuses refused by `tenantContext` (src/middlewares/tenantMiddleware.js). */
const REFUSED_COMPANY_STATUSES = ['SUSPENDED', 'DEACTIVATED', 'ARCHIVED'];

/** Internal-only reasons. Never sent to a client. */
export const SOCKET_AUTH_REASONS = Object.freeze({
  MISSING_TOKEN: 'MISSING_TOKEN',
  MALFORMED_TOKEN: 'MALFORMED_TOKEN',
  EXPIRED_TOKEN: 'EXPIRED_TOKEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  INVALID_SUBJECT: 'INVALID_SUBJECT',
  WRONG_PORTAL: 'WRONG_PORTAL',
  ACCOUNT_MISSING: 'ACCOUNT_MISSING',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  LEGACY_TOKEN: 'LEGACY_TOKEN',
  SESSION_INVALID: 'SESSION_INVALID',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  NO_TENANT: 'NO_TENANT',
  COMPANY_UNAVAILABLE: 'COMPANY_UNAVAILABLE',
});

const fail = (reason) => ({ ok: false, reason });

/**
 * Verifies one socket handshake token.
 *
 * Every dependency is injectable so the suite is hermetic (no Mongo, no
 * Redis, no network) while the production defaults are the real models.
 *
 * @param {string|undefined} token  socket.handshake.auth.token
 * @returns {Promise<{ok:true, userId:string, companyId:string, sessionId:string}
 *                  | {ok:false, reason:string}>}
 */
export const verifyChatSocketToken = async (
  token,
  {
    verifyJwt = (value) => jwt.verify(value, env.JWT_SECRET),
    findUser = (userId) =>
      User.findById(userId)
        .select('status role companyId tokenVersion')
        .lean(),
    findSession = (filter) => SecuritySession.findOne(filter).select('sessionId').lean(),
    findCompany = (companyId) => Company.findById(companyId).select('status').lean(),
    now = () => new Date(),
  } = {},
) => {
  // ── 1. Token presence (auth payload only) ──────────────────────────────
  const raw = typeof token === 'string' ? token.trim() : '';

  if (!raw) return fail(SOCKET_AUTH_REASONS.MISSING_TOKEN);

  // ── 2. Signature + expiry ──────────────────────────────────────────────
  let decoded;

  try {
    decoded = verifyJwt(raw);
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      return fail(SOCKET_AUTH_REASONS.EXPIRED_TOKEN);
    }

    return fail(
      error?.name === 'JsonWebTokenError'
        ? SOCKET_AUTH_REASONS.MALFORMED_TOKEN
        : SOCKET_AUTH_REASONS.INVALID_TOKEN,
    );
  }

  if (!decoded || typeof decoded !== 'object') {
    return fail(SOCKET_AUTH_REASONS.INVALID_TOKEN);
  }

  // ── 3. Principal gates FIRST, before anything else is interpreted
  //       (mirrors protect's 30.6 rule, evaluated even earlier so the
  //       internal reason is precise rather than incidental).
  //
  //       BGV verifier tokens are a separate internal principal and can
  //       never ride a tenant surface.
  if (decoded.principalType === 'BGV_VERIFIER') {
    return fail(SOCKET_AUTH_REASONS.WRONG_PORTAL);
  }

  // Belt-and-braces: kiosk device + kiosk employee-context tokens are
  // subject-less by construction (they carry `stationId`/`userId`, never
  // `sub`), but refuse them explicitly so a future claim change can never
  // open a chat socket — same posture as src/routes/realtimeRoutes.js.
  if (KIOSK_TOKEN_TYPES.includes(String(decoded.typ || ''))) {
    return fail(SOCKET_AUTH_REASONS.WRONG_PORTAL);
  }

  // ── 4. Subject. Customer tokens carry `sub`; `id` is the legacy and
  //       platform shape (both fail the customer-validity check below).
  const userId = decoded.sub || decoded.id;

  if (!userId) return fail(SOCKET_AUTH_REASONS.INVALID_SUBJECT);

  // ── 5. Account + session reads run concurrently (independent once
  //       keyed by verified claims — same perf note as protect).
  const [user, securitySession] = await Promise.all([
    findUser(userId),
    decoded.sessionId
      ? findSession({
          sessionId: decoded.sessionId,
          user: userId,
          companyId: decoded.companyId || null,
          revokedAt: null,
          expiresAt: { $gt: now() },
        })
      : null,
  ]);

  if (!user) return fail(SOCKET_AUTH_REASONS.ACCOUNT_MISSING);

  if (user.status !== 'ACTIVE') return fail(SOCKET_AUTH_REASONS.ACCOUNT_INACTIVE);

  // ── 6. Platform principals have no tenant. `protect` lets them through
  //       to superAdminSession (AdminSession-based); a chat socket is a
  //       TENANT surface, so they are refused here.
  if (!user.companyId && PLATFORM_ROLES.includes(user.role)) {
    return fail(SOCKET_AUTH_REASONS.WRONG_PORTAL);
  }

  // ── 7. Customer-token validity: rejects legacy `generateToken` tokens
  //       (no sessionId / no tokenVersion) and platform tokens alike.
  const customerTokenIsValid =
    Boolean(decoded.sessionId) &&
    decoded.tokenVersion !== undefined &&
    String(decoded.companyId || '') === String(user.companyId || '') &&
    Number(decoded.tokenVersion) === Number(user.tokenVersion || 0);

  if (!customerTokenIsValid) {
    return fail(
      String(decoded.companyId || '') !== String(user.companyId || '')
        ? SOCKET_AUTH_REASONS.TENANT_MISMATCH
        : SOCKET_AUTH_REASONS.LEGACY_TOKEN,
    );
  }

  if (!securitySession) return fail(SOCKET_AUTH_REASONS.SESSION_INVALID);

  // ── 8. Tenant status gate (the socket equivalent of `tenantContext`).
  const companyId = String(user.companyId);

  if (!companyId) return fail(SOCKET_AUTH_REASONS.NO_TENANT);

  const company = await findCompany(companyId);

  if (!company) return fail(SOCKET_AUTH_REASONS.NO_TENANT);

  if (REFUSED_COMPANY_STATUSES.includes(company.status)) {
    return fail(SOCKET_AUTH_REASONS.COMPANY_UNAVAILABLE);
  }

  // companyId is DERIVED FROM MONGO. The token claim was only compared.
  return {
    ok: true,
    userId: String(userId),
    companyId,
    sessionId: String(securitySession.sessionId),
  };
};

/**
 * Builds the Engine.IO `allowRequest`-independent handshake middleware.
 * Kept separate so the pure verifier above stays unit-testable without a
 * Socket.IO instance.
 */
export const createChatHandshakeAuth = ({
  availability,
  verify = verifyChatSocketToken,
  unauthorized,
  onRefusal = () => {},
}) =>
  async (socket, next) => {
    // Availability is checked FIRST: a refused feature must not spend a
    // Mongo round-trip, and must not leak whether auth would have passed.
    const refusal = availability.refusal();

    if (refusal) {
      onRefusal('FEATURE_UNAVAILABLE');

      const unavailableError = new Error(refusal.message);

      unavailableError.data = { ...refusal };

      return next(unavailableError);
    }

    const result = await verify(socket?.handshake?.auth?.token);

    if (!result.ok) {
      onRefusal(result.reason);

      const error = new Error(unauthorized.message);

      error.data = { ...unauthorized };

      return next(error);
    }

    // Server-derived identity only. Nothing below is client-controlled.
    socket.data.userId = result.userId;
    socket.data.companyId = result.companyId;
    socket.data.sessionId = result.sessionId;

    return next();
  };
