import { Router } from 'express';
import {
  applyLeave,
  getMyLeaves,
  getPendingRequests,
  getLeaveRequests,
  decideLeave,
  cancelLeave,
} from '../controllers/leaveController.js';
import { protect } from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import {
  applyLeaveValidator,
  decideLeaveValidator,
} from '../validators/leaveValidator.js';
import {
  validate,
} from '../validators/authValidator.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus
);

// Employee self-service.
router.post(
  '/',
  checkWriteAccess,
  requireAnyPermission([
    'LEAVE_CREATE_SELF',
    'LEAVE_CREATE',
  ]),
  applyLeaveValidator,
  validate,
  applyLeave
);

router.get(
  '/my',
  requireAnyPermission([
    'LEAVE_READ_SELF',
    'LEAVE_READ',
  ]),
  getMyLeaves
);

router.patch(
  '/:id/cancel',
  checkWriteAccess,
  requireAnyPermission([
    'LEAVE_UPDATE_SELF',
    'LEAVE_UPDATE',
  ]),
  cancelLeave
);

// Company/team approval.
// Existing controllers retain org-subtree scoping.
router.get(
  '/pending',
  requirePermission(
    'LEAVE_READ'
  ),
  getPendingRequests
);

router.get(
  '/requests',
  requirePermission(
    'LEAVE_READ'
  ),
  getLeaveRequests
);

router.patch(
  '/:id/decide',
  checkWriteAccess,
  requireAnyPermission([
    'LEAVE_APPROVE',
    'LEAVE_REJECT',
  ]),
  decideLeaveValidator,
  validate,
  decideLeave
);

export default router;