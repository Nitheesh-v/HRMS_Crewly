// Phase 30.7 — verifier workspace routes ("My Verification Work").
// Mounted under /api/bgv-verifier/work. Every route requires the dedicated
// verifier principal (requireVerifierAuth): tenant tokens, Super Admin
// tokens, and anonymous requests are rejected before any handler runs.
// There are NO assignment-management routes here — verifiers can never
// assign, reassign, or self-assign; that surface is platform-only.

import { Router } from 'express';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import { requireVerifierAuth } from '../middlewares/bgvVerifierAuth.js';
import {
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
// /files/:fileId MUST precede /:orderId/:checkType (both two segments).
router.get('/files/:fileId', bgvVerifierWorkFileDownload);
router.get('/:orderId/:checkType', bgvVerifierWorkDetail);
router.post('/:orderId/:checkType/start', bgvVerifierWorkStart);

export default router;
