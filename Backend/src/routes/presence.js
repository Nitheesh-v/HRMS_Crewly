// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PRESENCE HTTP ROUTES
//
//  Mirrors the shape Phase 36 AI uses (routes/ai.js):
//    router.use(protect, tenantContext)              — auth then tenant
//    router.route('/me').get(...)                     — self read
//    router.route('/me/status').put(...)             — self mutation
//    router.route('/me/status-message').put(...)     — self mutation
//    router.route('/me/work-location').put(...)      — self mutation
//    router.route('/config').get(...).put(...)       — admin (SETTINGS_MANAGE)
//
//  Why a dedicated middleware order and no global prefix here:
//    every other route file in this repo does the same. The presence routes
//    are mounted under /api/presence from routes/index.js.
//
//  RBAC NOTE
//    The admin /config endpoints use SETTINGS_MANAGE — the same permission
//    Phase 36 AI uses. There is no `presence:admin` permission in this
//    repo and inventing one would mean a registry change plus a
//    SYSTEM_PERMISSION_VERSION bump plus a migration. So 37.1 reuses
//    SETTINGS_MANAGE, exactly as the 36.2 RBAC note records.
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { requirePermission } from '../middlewares/permissionMiddleware.js';

import {
  presenceConfigValidator,
  presenceStatusMessageValidator,
  presenceStatusValidator,
  presenceWorkLocationValidator,
} from '../validators/presence/presenceValidator.js';

import * as presenceController from '../controllers/presenceController.js';

const router = Router();

router.use(protect, tenantContext);

// Self-service reads — any authenticated employee may read their own state.
router.route('/me').get(presenceController.getMe);

// Self-service mutations. The validator refuses identity-override fields
// (Phase 37 §19). Policy decisions live in the service.
router
  .route('/me/status')
  .put(presenceStatusValidator, presenceController.putStatus);

router
  .route('/me/status-message')
  .put(presenceStatusMessageValidator, presenceController.putStatusMessage);

router
  .route('/me/work-location')
  .put(presenceWorkLocationValidator, presenceController.putWorkLocation);

// Tenant admin endpoints. SETTINGS_MANAGE is the existing admin permission
// (see the 36.2 RBAC note in routes/ai.js).
router
  .route('/config')
  .get(requirePermission('SETTINGS_MANAGE'), presenceController.getConfig)
  .put(
    requirePermission('SETTINGS_MANAGE'),
    presenceConfigValidator,
    presenceController.putConfig,
  );

export default router;

export { router as presenceRoutes };