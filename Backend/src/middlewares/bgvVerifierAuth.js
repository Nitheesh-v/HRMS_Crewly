// Phase 30.6 — dedicated BGV verifier session middleware.
//
// Principal isolation: ONLY JWTs carrying principalType 'BGV_VERIFIER'
// (issued by the verifier login) pass here. Tenant customer tokens and
// platform tokens are rejected because they lack the claim; verifier
// tokens are rejected by tenant `protect` and `superAdminSession`.
// Every request re-checks the revocable session row AND the account
// ACTIVE state (deactivation ends access immediately).

import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  resolveVerifierSession,
  VERIFIER_PRINCIPAL_TYPE,
} from '../services/bgv/bgvVerifierService.js';

export const requireVerifierAuth = asyncHandler(async (req, _res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Not authorized — no token provided');
  }

  let decoded;
  try {
    decoded = jwt.verify(authorization.slice(7), env.JWT_SECRET);
  } catch {
    throw ApiError.unauthorized('Invalid token');
  }

  // Server-side principal check — never trust a frontend flag.
  if (decoded?.principalType !== VERIFIER_PRINCIPAL_TYPE) {
    throw ApiError.unauthorized('BGV verifier session required');
  }

  const resolved = await resolveVerifierSession({ decoded });
  if (!resolved) {
    throw ApiError.unauthorized('Verifier session expired, revoked, or account inactive');
  }

  req.verifier = resolved.verifier;
  req.verifierSession = resolved.session;
  return next();
});
