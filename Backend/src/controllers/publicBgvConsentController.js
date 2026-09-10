// Phase 30.4 — public candidate BGV consent portal controllers.
// Token-authorized; no employee session. GET is decision-free (scanner-safe);
// consent/decline are explicit POSTs only.

import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  recordBgvConsentDecision,
  resolvePublicBgvConsent,
} from '../services/bgv/bgvConsentService.js';

// GET /api/public/candidate/bgv-consent/:secureToken
export const publicBgvConsentRead = asyncHandler(async (req, res) => {
  // Data from frontend - secure candidate token from the public portal
  const rawToken = req.params.secureToken;

  // DB Logic - decision-free read: views are telemetry, never consent.
  const data = await resolvePublicBgvConsent({ rawToken });

  // Data to frontend - response to frontend
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  return ApiResponse.success(res, { message: 'BGV consent request fetched', data });
});

// POST /api/public/candidate/bgv-consent/:secureToken/consent
export const publicBgvConsentGive = asyncHandler(async (req, res) => {
  // Data from frontend - explicit candidate confirmation
  const rawToken = req.params.secureToken;

  // DB Logic - explicit POST consent; idempotent on identical repeats.
  const result = await recordBgvConsentDecision({ rawToken, decision: 'CONSENTED' });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.idempotent
      ? 'Your consent was already recorded'
      : 'Consent recorded. Crewly will guide you through the required information in the next step.',
    data: result,
  });
});

// POST /api/public/candidate/bgv-consent/:secureToken/decline
export const publicBgvConsentDecline = asyncHandler(async (req, res) => {
  // Data from frontend - explicit candidate decline
  const rawToken = req.params.secureToken;

  // DB Logic - explicit POST decline; a decline is not a verification failure.
  const result = await recordBgvConsentDecision({ rawToken, decision: 'DECLINED' });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.idempotent
      ? 'Your decline was already recorded'
      : 'Decline recorded. The organisation has been notified of your decision.',
    data: result,
  });
});
