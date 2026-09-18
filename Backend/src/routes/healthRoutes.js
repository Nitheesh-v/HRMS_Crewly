import { Router } from 'express';
import {
  liveness,
  readiness,
  legacyHealth,
} from '../controllers/healthController.js';

// ============================================================
//  PHASE 32.2 — INFRASTRUCTURE HEALTH PROBES.
//
//  Public (load balancer / orchestrator), intentionally tiny:
//  - no auth, no tenant middleware, no subscription gate
//  - mounted before the audit trail (no per-probe writes)
//  - no business queries, no Redis I/O (cached state only)
//  - no auth-style rate limiting (§27: probes must not inherit
//    login-limiter behavior); they are cheap bounded GETs.
//
//  Mounted at /api/health (legacy), /api/health/live, /api/health/ready.
// ============================================================

const router = Router();

router.get('/live', liveness);

router.get('/ready', readiness);

router.get('/', legacyHealth);

export default router;

export { router as healthRoutes };
