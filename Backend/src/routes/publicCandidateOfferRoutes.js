import { Router } from 'express';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import { offerTokenRateLimitKey } from '../services/offerTokenService.js';
import {
  publicOfferAccept,
  publicOfferDocumentRead,
  publicOfferRead,
  publicOfferReject,
  publicOfferView,
} from '../controllers/publicOfferController.js';
import {
  publicOfferDecisionRules,
  publicOfferReadRules,
  publicOfferRejectRules,
} from '../validators/publicOfferValidator.js';

const router = Router();

const readLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 80,
  keyGenerator: (req) => `${req.ip}:${offerTokenRateLimitKey(req.params.secureToken)}`,
  message: 'Too many offer requests. Please try again later.',
});

const decisionLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 10,
  keyGenerator: (req) => `${req.ip}:${offerTokenRateLimitKey(req.params.secureToken)}:decision`,
  message: 'Too many offer decisions. Please try again later.',
});

router.get('/:secureToken', readLimit, publicOfferReadRules, publicOfferRead);
router.post('/:secureToken/view', readLimit, publicOfferReadRules, publicOfferView);
router.get('/:secureToken/document', readLimit, publicOfferReadRules, publicOfferDocumentRead);
router.post('/:secureToken/accept', decisionLimit, publicOfferDecisionRules, publicOfferAccept);
router.post('/:secureToken/reject', decisionLimit, publicOfferRejectRules, publicOfferReject);

export default router;
