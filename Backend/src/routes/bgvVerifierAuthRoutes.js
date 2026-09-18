// Phase 30.6 — dedicated BGV verifier authentication routes.
// Separate surface ("Crewly BGV Operations") — not the tenant login, not
// the Super Admin login. Verifier tokens are a distinct JWT principal.

import { Router } from 'express';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import { requireVerifierAuth } from '../middlewares/bgvVerifierAuth.js';
import {
  bgvVerifierForgot,
  bgvVerifierLogin,
  bgvVerifierLogout,
  bgvVerifierMe,
  bgvVerifierReset,
  bgvVerifierSetup,
} from '../controllers/bgvVerifierController.js';

const router = Router();

const loginLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 10,
  keyGenerator: (req) => `${req.ip}:bgv-verifier-login`,
  message: 'Too many login attempts. Try again later.',
});

const recoveryLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 5,
  keyGenerator: (req) => `${req.ip}:bgv-verifier-recovery`,
  message: 'Too many requests. Try again later.',
});

// Public account setup / recovery.
router.post('/setup', recoveryLimit, bgvVerifierSetup);
router.post('/login', loginLimit, bgvVerifierLogin);
router.post('/forgot-password', recoveryLimit, bgvVerifierForgot);
router.post('/reset-password', recoveryLimit, bgvVerifierReset);

// Session-protected profile + logout (verifier principal only).
router.get('/me', requireVerifierAuth, bgvVerifierMe);
router.post('/logout', requireVerifierAuth, bgvVerifierLogout);

export default router;
