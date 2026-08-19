import { Router } from 'express';
import * as authNS from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import * as controller from '../controllers/subscriptionController.js';

const protect =
  authNS.protect ||
  authNS.default?.protect ||
  authNS.default;

const router = Router();

router.use(
  protect,
  tenantContext
);

router.get(
  '/current',
  controller.current
);

router.get(
  '/usage',
  controller.usage
);

router.get(
  '/features',
  controller.features
);

router.get(
  '/history',
  controller.history
);

router.get(
  '/plans',
  controller.plans
);

router.get(
  '/limits/:resource',
  controller.limit
);

router.get(
  '/features/:feature',
  controller.feature
);

router.post(
  '/quote',
  controller.quotePlanChange
);

router.post(
  '/downgrade',
  controller.downgrade
);

router.post(
  '/cancel',
  controller.cancel
);

router.post(
  '/restore',
  controller.restore
);

router.patch(
  '/auto-renew',
  controller.toggleAutoRenew
);

export default router;
export {
  router as subscriptionRoutes,
};