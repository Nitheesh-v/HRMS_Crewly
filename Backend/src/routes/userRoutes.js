import { Router } from 'express';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext, readOnlyIfExpired } from '../middlewares/tenantMiddleware.js';
import { ROLES } from '../utils/constants.js';
import { createUserRules, updateUserRules, resetPasswordRules } from '../validators/userDetailsValidator.js';
import { listUsers, getUser, createUser, updateUser,getOrgHierarchy, resetPassword } from '../controllers/userController.js';

const router = Router();
router.use(protect, tenantContext, readOnlyIfExpired);

const MANAGERS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD];

router.get('/', listUsers);
router.get('/hierarchy', getOrgHierarchy); // 🌳 literal path BEFORE '/:id' — order matters!
router.get('/:id', getUser);
router.post('/', authorize(...MANAGERS), createUserRules, createUser);
router.patch('/:id', authorize(...MANAGERS), updateUserRules, updateUser);
router.post('/:id/reset-password', authorize(...MANAGERS), resetPasswordRules, resetPassword);

export default router;