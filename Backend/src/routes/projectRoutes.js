import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import * as projectController from '../controllers/projectController.js';

const router = Router();

router.use(protect, tenantContext);

router.route('/')
  .get(projectController.listProjects)
  .post(projectController.createProject);

router.route('/:id')
  .get(projectController.getProject)
  .put(projectController.updateProject)
  .delete(projectController.deleteProject);

export default router;
export { router as projectRoutes };