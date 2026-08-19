import { Router } from 'express';
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
import * as meetingController from '../controllers/meetingController.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus
);

router.get(
  '/',
  requireAnyPermission([
    'MEETING_READ',
    'MEETING_READ_SELF',
  ]),
  meetingController.listMeetings
);

router.post(
  '/',
  checkWriteAccess,
  requirePermission(
    'MEETING_CREATE'
  ),
  meetingController.createMeeting
);

router.put(
  '/:id',
  checkWriteAccess,
  requirePermission(
    'MEETING_UPDATE'
  ),
  meetingController.updateMeeting
);

router.patch(
  '/:id/cancel',
  checkWriteAccess,
  requirePermission(
    'MEETING_UPDATE'
  ),
  meetingController.cancelMeeting
);

router.delete(
  '/:id',
  checkWriteAccess,
  requirePermission(
    'MEETING_DELETE'
  ),
  meetingController.deleteMeeting
);

export default router;

export {
  router as meetingRoutes,
};