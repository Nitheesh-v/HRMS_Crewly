import { Router } from 'express';
import {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} from '../controllers/departmentController.js';
import { protect } from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkUsageLimit,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import {
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import {
  createDepartmentValidator,
  updateDepartmentValidator,
} from '../validators/orgValidator.js';
import {
  validate,
} from '../validators/authValidator.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus
);

router.get(
  '/',
  requirePermission(
    'DEPARTMENT_READ'
  ),
  getDepartments
);

router.post(
  '/',
  checkWriteAccess,
  requirePermission(
    'DEPARTMENT_CREATE'
  ),
  checkUsageLimit(
    'departments'
  ),
  createDepartmentValidator,
  validate,
  createDepartment
);

router.put(
  '/:id',
  checkWriteAccess,
  requirePermission(
    'DEPARTMENT_UPDATE'
  ),
  updateDepartmentValidator,
  validate,
  updateDepartment
);

router.delete(
  '/:id',
  checkWriteAccess,
  requirePermission(
    'DEPARTMENT_DELETE'
  ),
  deleteDepartment
);

export default router;