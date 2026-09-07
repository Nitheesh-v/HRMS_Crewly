// Phase 30.5 — public candidate BGV collection routes.
// Mounted BEFORE authenticated tenant middleware (the 30.4 portal token is
// the authority). Reuses the pre-onboarding upload middleware — the same
// hardened uploader, never a weaker second implementation.

import { Router } from 'express';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import { preOnboardingUpload } from '../middlewares/preOnboardingUpload.js';
import { hashToken } from '../utils/securityPolicy.js';
import {
  bgvCollectionAddressSave,
  bgvCollectionEducationRemove,
  bgvCollectionEducationSave,
  bgvCollectionEmploymentRemove,
  bgvCollectionEmploymentSave,
  bgvCollectionFileDownload,
  bgvCollectionFileRemove,
  bgvCollectionFileUpload,
  bgvCollectionIdentitySave,
  bgvCollectionRead,
  bgvCollectionReferenceRemove,
  bgvCollectionReferenceSave,
  bgvCollectionSubmit,
} from '../controllers/publicBgvCollectionController.js';
import {
  bgvCollectionAddressRules,
  bgvCollectionEducationRules,
  bgvCollectionEmploymentRules,
  bgvCollectionFileRules,
  bgvCollectionIdentityRules,
  bgvCollectionRecordRemoveRules,
  bgvCollectionReferenceRules,
  bgvCollectionSubmitRules,
  bgvCollectionTokenRules,
  bgvCollectionUploadRules,
} from '../validators/bgvCollectionValidator.js';

const router = Router();

const collectionKey = (rawToken) => `bgv-collection:${hashToken(rawToken || '')}`;

const readLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 80,
  keyGenerator: (req) => `${req.ip}:${collectionKey(req.params.secureToken)}`,
  message: 'Too many BGV collection requests. Please try again later.',
});

const writeLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 40,
  keyGenerator: (req) => `${req.ip}:${collectionKey(req.params.secureToken)}:write`,
  message: 'Too many BGV collection updates. Please try again later.',
});

const uploadLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 20,
  keyGenerator: (req) => `${req.ip}:${collectionKey(req.params.secureToken)}:upload`,
  message: 'Too many evidence uploads. Please try again later.',
});

const submitLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 10,
  keyGenerator: (req) => `${req.ip}:${collectionKey(req.params.secureToken)}:submit`,
  message: 'Too many submission attempts. Please try again later.',
});

// Summary (read-only; never triggers any decision or submission).
router.get('/:secureToken', readLimit, bgvCollectionTokenRules, bgvCollectionRead);

// Structured information (purchased checks only; service-enforced).
router.post('/:secureToken/identity', writeLimit, bgvCollectionIdentityRules, bgvCollectionIdentitySave);
router.post('/:secureToken/address', writeLimit, bgvCollectionAddressRules, bgvCollectionAddressSave);
router.post('/:secureToken/education', writeLimit, bgvCollectionEducationRules, bgvCollectionEducationSave);
router.delete('/:secureToken/education/:recordId', writeLimit, bgvCollectionRecordRemoveRules, bgvCollectionEducationRemove);
router.post('/:secureToken/employment', writeLimit, bgvCollectionEmploymentRules, bgvCollectionEmploymentSave);
router.delete('/:secureToken/employment/:recordId', writeLimit, bgvCollectionRecordRemoveRules, bgvCollectionEmploymentRemove);
router.post('/:secureToken/reference', writeLimit, bgvCollectionReferenceRules, bgvCollectionReferenceSave);
router.delete('/:secureToken/reference/:recordId', writeLimit, bgvCollectionRecordRemoveRules, bgvCollectionReferenceRemove);

// Evidence files (private storage; downloads are token-authorized only).
router.post('/:secureToken/files', uploadLimit, preOnboardingUpload, bgvCollectionUploadRules, bgvCollectionFileUpload);
router.get('/:secureToken/files/:fileId', readLimit, bgvCollectionFileRules, bgvCollectionFileDownload);
router.delete('/:secureToken/files/:fileId', writeLimit, bgvCollectionFileRules, bgvCollectionFileRemove);

// Final submission — explicit POST only; GET/refresh can never submit.
router.post('/:secureToken/submit', submitLimit, bgvCollectionSubmitRules, bgvCollectionSubmit);

export default router;
