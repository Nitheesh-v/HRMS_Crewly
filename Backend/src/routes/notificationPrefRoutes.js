import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import * as notificationPrefController from '../controllers/notificationPrefController.js';

const router = Router();

router.use(protect, tenantContext);

router.route('/')
  .get(notificationPrefController.getMyPrefs)
  .put(notificationPrefController.updateMyPrefs);

export default router;
export { router as notificationPrefRoutes };