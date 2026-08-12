import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import * as meetingController from '../controllers/meetingController.js';

const router = Router();

router.use(protect, tenantContext);

router.route('/')
  .get(meetingController.listMeetings)
  .post(meetingController.createMeeting);

router.patch('/:id/cancel', meetingController.cancelMeeting);

router.route('/:id')
  .put(meetingController.updateMeeting)
  .delete(meetingController.deleteMeeting);

export default router;
export { router as meetingRoutes };