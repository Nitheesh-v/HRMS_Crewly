import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { requirePermission } from '../middlewares/permissionMiddleware.js';

import {
  aiChatValidator,
  chatbotValidator,
  previewContextValidator,
  updateConfigValidator,
} from '../validators/ai/aiValidator.js';

import * as aiController from '../controllers/aiController.js';

// Phase 36.1/36.2 — AI suite HTTP surface.
//
//   POST /api/ai/chat              one guarded completion (36.1)
//   POST /api/ai/chatbot           one employee-facing turn (36.3)
//   GET  /api/ai/config            this tenant's AI config + month spend (36.2)
//   PUT  /api/ai/config            the tenant's kill switch / quota / allowlist (36.2)
//   GET  /api/ai/context/preview   the caller's own redacted context (36.2)
//   GET  /api/ai/usage             the admin token dashboard (36.6)
//
// Middleware order is the project law: auth → tenant, then RBAC, then the
// handler. Subscription gating is deliberately absent — the AI suite has no
// subscription-plan gate in this phase; the tenant kill switch and the quota
// are the cost controls.
//
// RBAC NOTE (36.2): the repo has NO `ai:admin` permission, and inventing one
// would mean a registry change plus a SYSTEM_PERMISSION_VERSION bump plus a
// migration for every existing tenant. The config endpoints therefore use the
// existing SETTINGS_MANAGE (scope ALL), which COMPANY_ADMIN already inherits.
// Note also that requirePermission refuses SUPER_ADMIN by design — platform
// roles cannot use customer-company permissions — so a platform super-admin
// still has no route to manage a tenant's AI config. That gap is recorded in
// docs/PHASE_36_2_HR_CONTEXT_RETRIEVER.md §8 for 36.3/36.4.
const router = Router();

router.use(protect, tenantContext);

router.route('/chat').post(aiChatValidator, aiController.chat);

// Phase 36.3 - the employee chatbot. The rate limit is enforced inside the
// controller (its own 32.4 tier), NOT as route middleware, so one request is
// charged exactly once.
router.route('/chatbot').post(chatbotValidator, aiController.askChatbot);

// 36.7 — the reply languages this tenant offers, for the assistant widget's
// selector.
//
// NO RBAC, deliberately. The widget is open to every employee and its
// selector must list what the admin enabled, so an employee has to be able
// to ask. Nothing here is sensitive: it is a list of presentation
// preferences, with no quota, no enabled flag and no usage. Reading a
// tenant's QUOTA still needs SETTINGS_MANAGE, and that route is unchanged.
router.route('/languages').get(aiController.getChatLanguages);

router
  .route('/config')
  .get(requirePermission('SETTINGS_MANAGE'), aiController.getConfig)
  .put(
    requirePermission('SETTINGS_MANAGE'),
    updateConfigValidator,
    aiController.updateConfig,
  );

// No RBAC: any authenticated user may preview their OWN context. Identity is
// server-derived, so there is nothing to escalate — the only risk is the
// data-dump one, which the controller's dedicated limiter answers.
router
  .route('/context/preview')
  .get(previewContextValidator, aiController.previewContext);

// Phase 36.6 — the admin usage dashboard.
//
// SETTINGS_MANAGE for the same reason the config endpoints use it: there is
// no `ai:admin` permission in this repo, and inventing one would mean a
// registry change plus a SYSTEM_PERMISSION_VERSION bump plus a migration
// for every existing tenant. COMPANY_ADMIN already inherits
// SETTINGS_MANAGE, so this reaches exactly the people who need it.
//
// Placed AFTER /config so the RBAC note above stays attached to the
// preview route it describes.
router
  .route('/usage')
  .get(requirePermission('SETTINGS_MANAGE'), aiController.getUsage);

export default router;

export { router as aiRoutes };
