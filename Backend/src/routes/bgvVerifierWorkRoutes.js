// Phase 30.7 — verifier workspace routes ("My Verification Work").
// Mounted under /api/bgv-verifier/work. Every route requires the dedicated
// verifier principal (requireVerifierAuth): tenant tokens, Super Admin
// tokens, and anonymous requests are rejected before any handler runs.
// There are NO assignment-management routes here — verifiers can never
// assign, reassign, or self-assign; that surface is platform-only.

import { Router } from 'express';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import { preOnboardingUpload } from '../middlewares/preOnboardingUpload.js';
import { requireVerifierAuth } from '../middlewares/bgvVerifierAuth.js';
import {
  bgvVerifierActivityRecord,
  bgvVerifierInfoRequestCancel,
  bgvVerifierInfoRequestCreate,
  bgvVerifierInfoRequestList,
  bgvVerifierInfoRequestResolve,
  bgvVerifierConclusionSubmit,
  bgvVerifierDiscrepancyRecord,
  bgvVerifierEvidenceDownload,
  bgvVerifierEvidenceUpload,
  bgvVerifierStateSet,
  bgvVerifierWorkDetail,
  bgvVerifierWorkFileDownload,
  bgvVerifierWorkList,
  bgvVerifierWorkStart,
} from '../controllers/bgvVerifierWorkController.js';

const router = Router();

const workLimit = securityRateLimit({
  windowMs: 10 * 60 * 1000,
  maximum: 240,
  keyGenerator: (req) => `${req.verifier?._id || req.ip}:bgv-verifier-work`,
  message: 'Too many requests. Try again later.',
});

router.use(requireVerifierAuth, workLimit);

router.get('/', bgvVerifierWorkList);
// Static two-segment paths MUST precede /:orderId/:checkType.
router.get('/files/:fileId', bgvVerifierWorkFileDownload);
router.get('/evidence/:fileId', bgvVerifierEvidenceDownload);
router.get('/:orderId/:checkType', bgvVerifierWorkDetail);
router.post('/:orderId/:checkType/start', bgvVerifierWorkStart);

// Phase 30.8 — verification workbench. Verifier evidence reuses the same
// hardened uploader as candidate uploads (MIME/size allowlist, memory
// storage) — never a weaker second implementation.
router.post('/:orderId/:checkType/activities', bgvVerifierActivityRecord);
router.post('/:orderId/:checkType/discrepancies', bgvVerifierDiscrepancyRecord);
router.post('/:orderId/:checkType/state', bgvVerifierStateSet);
router.post('/:orderId/:checkType/submit', bgvVerifierConclusionSubmit);
router.post('/:orderId/:checkType/evidence', preOnboardingUpload, bgvVerifierEvidenceUpload);

// Phase 30.9 — additional information requests. Verifier creates/reviews;
// resolve/cancel are path-rooted so they never collide with check routes.
router.get('/:orderId/:checkType/info-requests', bgvVerifierInfoRequestList);
router.post('/:orderId/:checkType/info-requests', bgvVerifierInfoRequestCreate);
router.post('/info-requests/:requestId/resolve', bgvVerifierInfoRequestResolve);
router.post('/info-requests/:requestId/cancel', bgvVerifierInfoRequestCancel);

export default router;
