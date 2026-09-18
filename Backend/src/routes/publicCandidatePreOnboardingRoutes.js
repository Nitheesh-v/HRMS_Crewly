import { Router } from 'express';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import { preOnboardingUpload } from '../middlewares/preOnboardingUpload.js';
import { preOnboardingTokenRateLimitKey } from '../services/preOnboardingTokenService.js';
import {
  publicPreOnboardingDocumentRead,
  publicPreOnboardingRead,
  publicPreOnboardingUpload,
  publicPreOnboardingView,
} from '../controllers/publicPreOnboardingController.js';
import {
  publicDocumentReadRules,
  publicPreOnboardingTokenRules,
  publicUploadRules,
} from '../validators/preOnboardingValidator.js';

const router = Router();

const readLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 80,
  keyGenerator: (req) =>
    `${req.ip}:${preOnboardingTokenRateLimitKey(req.params.secureToken)}`,
  message: 'Too many pre-onboarding requests. Please try again later.',
});

const uploadLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 20,
  keyGenerator: (req) =>
    `${req.ip}:${preOnboardingTokenRateLimitKey(req.params.secureToken)}:upload`,
  message: 'Too many document uploads. Please try again later.',
});

router.get(
  '/:secureToken',
  readLimit,
  publicPreOnboardingTokenRules,
  publicPreOnboardingRead
);
router.post(
  '/:secureToken/view',
  readLimit,
  publicPreOnboardingTokenRules,
  publicPreOnboardingView
);
router.post(
  '/:secureToken/documents/:requirementCode',
  uploadLimit,
  preOnboardingUpload,
  publicUploadRules,
  publicPreOnboardingUpload
);
router.get(
  '/:secureToken/documents/:documentCode',
  readLimit,
  publicDocumentReadRules,
  publicPreOnboardingDocumentRead
);

export default router;
