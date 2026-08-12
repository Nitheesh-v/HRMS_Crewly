import { Router } from 'express';
import { applyLeave, getMyLeaves, getPendingRequests, getLeaveRequests, decideLeave, cancelLeave } from '../controllers/leaveController.js';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext, readOnlyIfExpired } from '../middlewares/tenantMiddleware.js';
import { applyLeaveValidator, decideLeaveValidator } from '../validators/leaveValidator.js';
import { validate } from '../validators/authValidator.js';
import { ROLES } from '../utils/constants.js';

const router = Router();
router.use(protect, tenantContext);

const SENIORS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD];

// Self-service (all company users)
router.post('/', readOnlyIfExpired, applyLeaveValidator, validate, applyLeave);
router.get('/my', getMyLeaves);
router.patch('/:id/cancel', readOnlyIfExpired, cancelLeave);

// Approval workflow (Manager/TL subtree · HR/Admin whole company)
router.get('/pending', authorize(...SENIORS), getPendingRequests);
router.get('/requests', authorize(...SENIORS), getLeaveRequests);
router.patch('/:id/decide', readOnlyIfExpired, authorize(...SENIORS), decideLeaveValidator, validate, decideLeave);

export default router;