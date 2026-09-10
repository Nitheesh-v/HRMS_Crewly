// Phase 30.6 — BGV verifier controllers.
// Two surfaces:
//  * Super-Admin management (platform principal only) — internal Crewly
//    operational accounts, never tenant-managed.
//  * Dedicated verifier auth (/bgv-verifier/auth) — setup, login, profile,
//    logout, recovery. No candidate data anywhere in 30.6.

import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  completeVerifierSetup,
  deactivateVerifier,
  getVerifier,
  getVerifierProfile,
  inviteVerifier,
  listVerifiers,
  loginVerifier,
  logoutVerifier,
  reactivateVerifier,
  requestVerifierPasswordReset,
  resendVerifierSetup,
  resetVerifierPassword,
  revokeVerifierSetupInvitation,
  updateVerifierProfile,
} from '../services/bgv/bgvVerifierService.js';

// ── Super Admin management ────────────────────────────────────────

// GET /api/super-admin/bgv-verifiers
export const bgvVerifierList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  // DB Logic - safe projections only (no hashes/tokens/sessions)
  const verifiers = await listVerifiers({});
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'BGV verifiers', data: { verifiers } });
});

// GET /api/super-admin/bgv-verifiers/:verifierId
export const bgvVerifierRead = asyncHandler(async (req, res) => {
  // Data from frontend - verifier id from Super Admin UI
  const { verifierId } = req.params;
  // DB Logic - safe verifier profile
  const verifier = await getVerifier({ verifierId });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'BGV verifier', data: { verifier } });
});

// POST /api/super-admin/bgv-verifiers
export const bgvVerifierInvite = asyncHandler(async (req, res) => {
  // Data from frontend - invite form (name, email, specializations)
  const { name, email, specializations } = req.body || {};
  // DB Logic - no temporary passwords; hash-only one-time setup token email
  const result = await inviteVerifier({
    actorId: req.user?._id,
    name,
    email,
    specializations,
    requestContext: req,
  });
  // Data to frontend - safe profile only; raw token went to email only
  return ApiResponse.created(res, {
    message: 'Verifier invited — a secure setup link was emailed; no password was created',
    data: result,
  });
});

// POST /api/super-admin/bgv-verifiers/:verifierId/resend-setup
export const bgvVerifierResendSetup = asyncHandler(async (req, res) => {
  // Data from frontend - resend action
  const { verifierId } = req.params;
  // DB Logic - previous outstanding link is revoked first (rotation)
  const result = await resendVerifierSetup({ actorId: req.user?._id, verifierId, requestContext: req });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Setup invitation resent — the previous link is no longer valid', data: result });
});

// POST /api/super-admin/bgv-verifiers/:verifierId/revoke-setup
export const bgvVerifierRevokeSetup = asyncHandler(async (req, res) => {
  // Data from frontend - revoke outstanding invitation
  const { verifierId } = req.params;
  // DB Logic - pending setup tokens revoked
  const result = await revokeVerifierSetupInvitation({ actorId: req.user?._id, verifierId, requestContext: req });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Outstanding setup invitation revoked', data: result });
});

// PATCH /api/super-admin/bgv-verifiers/:verifierId
export const bgvVerifierUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - specializations / 2FA toggle
  const { verifierId } = req.params;
  const { specializations, twoFactorEnabled } = req.body || {};
  // DB Logic - allowlist validation + audit of specialization changes
  const verifier = await updateVerifierProfile({
    actorId: req.user?._id,
    verifierId,
    specializations,
    twoFactorEnabled,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Verifier updated', data: { verifier } });
});

// POST /api/super-admin/bgv-verifiers/:verifierId/deactivate
export const bgvVerifierDeactivate = asyncHandler(async (req, res) => {
  // Data from frontend - deactivation with optional reason
  const { verifierId } = req.params;
  const { reason } = req.body || {};
  // DB Logic - soft deactivation + immediate session/token revocation
  const verifier = await deactivateVerifier({ actorId: req.user?._id, verifierId, reason, requestContext: req });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Verifier deactivated — active sessions were revoked', data: { verifier } });
});

// POST /api/super-admin/bgv-verifiers/:verifierId/reactivate
export const bgvVerifierReactivate = asyncHandler(async (req, res) => {
  // Data from frontend - reactivation action
  const { verifierId } = req.params;
  // DB Logic - never issues passwords; setup-incomplete accounts return to INVITED
  const verifier = await reactivateVerifier({ actorId: req.user?._id, verifierId, requestContext: req });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Verifier reactivated', data: { verifier } });
});

// ── Dedicated verifier auth surface ───────────────────────────────

// POST /api/bgv-verifier/auth/setup
export const bgvVerifierSetup = asyncHandler(async (req, res) => {
  // Data from frontend - one-time setup token + chosen password
  const { setupToken, password } = req.body || {};
  // DB Logic - hash-only token, one-time use, platform password policy
  const result = await completeVerifierSetup({ rawToken: setupToken, password, requestContext: req });
  // Data to frontend - response to frontend (no session; login next)
  return ApiResponse.success(res, {
    message: 'Account activated — sign in through the BGV verifier login',
    data: result,
  });
});

// POST /api/bgv-verifier/auth/login
export const bgvVerifierLogin = asyncHandler(async (req, res) => {
  // Data from frontend - verifier credentials (+ optional 2FA code)
  const { email, password, challengeId, code } = req.body || {};
  // DB Logic - generic failures; optional email OTP; revocable session JWT
  const result = await loginVerifier({
    email,
    password,
    challengeId,
    code,
    requestIp: req.ip,
    userAgent: req.headers['user-agent'],
    requestContext: req,
  });
  // Data to frontend - token + safe profile only
  return ApiResponse.success(res, { message: 'Welcome to Crewly BGV Operations', data: result });
});

// GET /api/bgv-verifier/auth/me
export const bgvVerifierMe = asyncHandler(async (req, res) => {
  // Data from frontend - bearer verifier session
  // DB Logic - fresh safe profile (specializations are eligibility only)
  const verifier = await getVerifierProfile({ verifierId: req.verifier._id });
  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  return ApiResponse.success(res, { message: 'Verifier profile', data: { verifier } });
});

// POST /api/bgv-verifier/auth/logout
export const bgvVerifierLogout = asyncHandler(async (req, res) => {
  // Data from frontend - bearer verifier session
  // DB Logic - session row revoked; refresh/back cannot re-authenticate
  const result = await logoutVerifier({
    verifierId: req.verifier._id,
    sessionId: req.verifierSession.sessionId,
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Signed out of Crewly BGV Operations', data: result });
});

// POST /api/bgv-verifier/auth/forgot-password
export const bgvVerifierForgot = asyncHandler(async (req, res) => {
  // Data from frontend - recovery request
  const { email } = req.body || {};
  // DB Logic - identical response whether or not an account exists
  const result = await requestVerifierPasswordReset({ email, requestIp: req.ip, requestContext: req });
  // Data to frontend - generic anti-enumeration response
  return ApiResponse.success(res, { message: result.message, data: {} });
});

// POST /api/bgv-verifier/auth/reset-password
export const bgvVerifierReset = asyncHandler(async (req, res) => {
  // Data from frontend - one-time reset token + new password
  const { resetToken, password } = req.body || {};
  // DB Logic - one-time token; sessions revoked on password change
  const result = await resetVerifierPassword({ rawToken: resetToken, password, requestContext: req });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Password changed — sign in with your new password', data: result });
});
