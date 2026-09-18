// Phase 30.4 — public candidate BGV consent portal routes.
// Mounted BEFORE authenticated tenant middleware (token is the authority).
// Rate limits mirror the offer portal pattern.

import { Router } from 'express';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import {
  publicBgvConsentDecline,
  publicBgvConsentGive,
  publicBgvConsentRead,
} from '../controllers/publicBgvConsentController.js';
import {
  bgvConsentDecisionRules,
  bgvConsentReadRules,
} from '../validators/backgroundVerificationValidator.js';
import { hashToken } from '../utils/securityPolicy.js';

const router = Router();

const consentRateLimitKey = (rawToken) => `bgv-consent:${hashToken(rawToken || '')}`;

const readLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 80,
  keyGenerator: (req) => `${req.ip}:${consentRateLimitKey(req.params.secureToken)}`,
  message: 'Too many BGV consent requests. Please try again later.',
});

const decisionLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 10,
  keyGenerator: (req) =>
    `${req.ip}:${consentRateLimitKey(req.params.secureToken)}:decision`,
  message: 'Too many BGV consent decisions. Please try again later.',
});

// Scanner-safe GET: may view, can never decide.
router.get('/:secureToken', readLimit, bgvConsentReadRules, publicBgvConsentRead);
router.post('/:secureToken/consent', decisionLimit, bgvConsentDecisionRules, publicBgvConsentGive);
router.post('/:secureToken/decline', decisionLimit, bgvConsentDecisionRules, publicBgvConsentDecline);

export default router;
