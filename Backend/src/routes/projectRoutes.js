import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import * as projectController from '../controllers/projectController.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus,
  requireFeature('projects')
);

router.get(
  '/',
  requirePermission(
    'PROJECT_READ'
  ),
  projectController.listProjects
);

router.post(
  '/',
  checkWriteAccess,
  requirePermission(
    'PROJECT_CREATE'
  ),
  projectController.createProject
);

router.get(
  '/:id',
  requirePermission(
    'PROJECT_READ'
  ),
  projectController.getProject
);

router.put(
  '/:id',
  checkWriteAccess,
  requirePermission(
    'PROJECT_UPDATE'
  ),
  projectController.updateProject
);

router.delete(
  '/:id',
  checkWriteAccess,
  requirePermission(
    'PROJECT_DELETE'
  ),
  projectController.deleteProject
);

export default router;

export {
  router as projectRoutes,
};