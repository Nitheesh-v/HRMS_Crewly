// ─────────────────────────────────────────────────────────────────────────────
// Phase 33.1A — SOCKET HANDSHAKE AUTHENTICATION (tenant users ONLY)
//
// The socket path does NOT traverse `protect`, so this module re-implements
// the SAME identity laws for the handshake — minus the HTTP-only parts. It
// mirrors src/middlewares/authMiddleware.js deliberately, check for check:
//
//   jwt.verify(JWT_SECRET) → subject present → verifier principal refused →
//   user exists → status ACTIVE → tenant user (has companyId) → sessionId
//   present → tokenVersion + companyId match → live SecuritySession row.
//
// The tenant is derived from the VERIFIED token and the user document only.
// The socket client never sends companyId or userId, so there is nothing to
// forge; `identity.companyId` is what every later chat query will scope by.
//
// Refused principals (each with its own internal reason for operators):
//   · kiosk device tokens   (scope: ['kiosk:session'])
//   · BGV verifier tokens   (principalType: 'BGV_VERIFIER')
//   · platform/super-admin  (no companyId — they are not tenant users and
//                            Chat is a tenant feature)
//
// The client receives ONE generic code (UNAUTHORIZED); the reason word stays
// server-side, so a failed handshake can never be used to probe which part of
// a credential was wrong.
// ─────────────────────────────────────────────────────────────────────────────
import jwt from 'jsonwebtoken';

export const SOCKET_AUTH_REASONS = Object.freeze({
  MISSING_TOKEN: 'missing_token',
  INVALID_TOKEN: 'invalid_token',
  TOKEN_EXPIRED: 'token_expired',
  KIOSK_SCOPE: 'kiosk_scope',
  VERIFIER_PRINCIPAL: 'verifier_principal',
  INVALID_SUBJECT: 'invalid_subject',
  ACCOUNT_MISSING: 'account_missing',
  ACCOUNT_INACTIVE: 'account_inactive',
  NOT_TENANT_USER: 'not_a_tenant_user',
  SESSION_CLAIM_MISSING: 'session_claim_missing',
  STALE_TOKEN: 'stale_token',
  SESSION_EXPIRED: 'session_expired',
});

const refuse = (reason) => ({ ok: false, reason });

/**
 * Verifies a raw handshake token. Never throws: every failure is a typed
 * refusal so the caller can log a safe reason and emit a generic code.
 */
export const verifySocketHandshake = async ({
  token,
  jwtSecret,
  UserModel,
  SecuritySessionModel,
} = {}) => {
  if (typeof token !== 'string' || !token.trim()) {
    return refuse(SOCKET_AUTH_REASONS.MISSING_TOKEN);
  }

  let decoded;

  try {
    // The "Bearer " prefix is accepted for parity with REST clients, but a
    // cookie is never read: there is no cookie auth surface here at all.
    decoded = jwt.verify(token.trim().replace(/^Bearer\s+/i, ''), jwtSecret);
  } catch (error) {
    return refuse(
      error?.name === 'TokenExpiredError'
        ? SOCKET_AUTH_REASONS.TOKEN_EXPIRED
        : SOCKET_AUTH_REASONS.INVALID_TOKEN,
    );
  }

  // A kiosk device token proves a STATION, not a person — and Chat is a
  // person-to-person feature. Scope check first: cheapest and most explicit.
  const scope = Array.isArray(decoded?.scope) ? decoded.scope : [];

  if (scope.includes('kiosk:session')) {
    return refuse(SOCKET_AUTH_REASONS.KIOSK_SCOPE);
  }

  // Phase 30.6 principal law: verifier tokens are a separate principal and
  // can never ride tenant surfaces.
  if (decoded?.principalType === 'BGV_VERIFIER') {
    return refuse(SOCKET_AUTH_REASONS.VERIFIER_PRINCIPAL);
  }

  // Customer tokens use sub; older/platform tokens use id.
  const userId = decoded?.sub || decoded?.id;

  if (!userId) return refuse(SOCKET_AUTH_REASONS.INVALID_SUBJECT);

  const user = await UserModel.findById(userId);

  if (!user) return refuse(SOCKET_AUTH_REASONS.ACCOUNT_MISSING);

  if (user.status !== 'ACTIVE') {
    return refuse(SOCKET_AUTH_REASONS.ACCOUNT_INACTIVE);
  }

  // Platform principals carry no companyId. Chat is tenant-scoped, so they
  // are refused here rather than being given a tenant-less stream.
  if (!user.companyId) return refuse(SOCKET_AUTH_REASONS.NOT_TENANT_USER);

  // Old customer JWTs (pre-session migration) must not open a socket.
  if (!decoded.sessionId) {
    return refuse(SOCKET_AUTH_REASONS.SESSION_CLAIM_MISSING);
  }

  const claimMatches =
    decoded.tokenVersion !== undefined &&
    String(decoded.companyId || '') === String(user.companyId || '') &&
    Number(decoded.tokenVersion) === Number(user.tokenVersion || 0);

  if (!claimMatches) return refuse(SOCKET_AUTH_REASONS.STALE_TOKEN);

  // Live session check — revocation must kill sockets the same way it kills
  // REST access (the socket is simply refused at its next handshake; see
  // socketGateway.js for the per-event revalidation rule).
  const session = await SecuritySessionModel.findOne({
    sessionId: decoded.sessionId,
    user: userId,
    companyId: decoded.companyId || null,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });

  if (!session) return refuse(SOCKET_AUTH_REASONS.SESSION_EXPIRED);

  return {
    ok: true,
    identity: {
      userId: String(user._id),
      companyId: String(user.companyId),
      role: user.role || null,
      sessionId: String(decoded.sessionId),
    },
  };
};

export default verifySocketHandshake;
