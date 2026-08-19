import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkUserCreationLimit,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import {
  createUserRules,
  updateUserRules,
  resetPasswordRules,
} from '../validators/userDetailsValidator.js';
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  getOrgHierarchy,
  resetPassword,
} from '../controllers/userController.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus
);

router.get(
  '/',
  requireAnyPermission([
    'USER_READ',
    'EMPLOYEE_READ',
    'EMPLOYEE_READ_DEPARTMENT',
    'EMPLOYEE_READ_TEAM',
    'EMPLOYEE_READ_SELF',
  ]),
  listUsers
);

// Literal route must remain before /:id.
router.get(
  '/hierarchy',
  requireAnyPermission([
    'USER_READ',
    'EMPLOYEE_READ',
    'EMPLOYEE_READ_DEPARTMENT',
    'EMPLOYEE_READ_TEAM',
  ]),
  getOrgHierarchy
);

router.post(
  '/',
  checkWriteAccess,
  requirePermission(
    'USER_CREATE'
  ),
  checkUserCreationLimit,
  createUserRules,
  createUser
);

router.get(
  '/:id',
  requireAnyPermission([
    'USER_READ',
    'EMPLOYEE_READ',
    'EMPLOYEE_READ_DEPARTMENT',
    'EMPLOYEE_READ_TEAM',
    'EMPLOYEE_READ_SELF',
  ]),
  getUser
);

router.patch(
  '/:id',
  checkWriteAccess,
  requireAnyPermission([
    'USER_UPDATE',
    'EMPLOYEE_UPDATE',
    'PROFILE_UPDATE_SELF',
  ]),
  updateUserRules,
  updateUser
);

router.post(
  '/:id/reset-password',
  checkWriteAccess,
  requirePermission(
    'USER_UPDATE'
  ),
  resetPasswordRules,
  resetPassword
);

export default router;