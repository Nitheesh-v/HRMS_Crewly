import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { aiChatValidator } from '../validators/ai/aiValidator.js';
import * as aiController from '../controllers/aiController.js';

// Phase 36.1 — AI suite HTTP surface. ONE endpoint in this unit: the
// verification pipeline for the foundation. Features arrive in later units,
// each as its own route behind the SAME provider guards.
//
// Middleware order is the project law: auth → tenant. Subscription and RBAC
// come after, and deliberately NOT here — the AI suite has no permission of
// its own in 36.1 (every signed-in tenant user may ask; the quota and the
// rate limit are the cost controls). 36.2 adds the per-tenant feature
// allowlist, which will read the same AITenantConfig the provider already
// consults.
const router = Router();

router.use(protect, tenantContext);

router.route('/chat').post(aiChatValidator, aiController.chat);

export default router;

export { router as aiRoutes };
