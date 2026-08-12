import { Router } from 'express';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext, readOnlyIfExpired } from '../middlewares/tenantMiddleware.js';
import { ROLES } from '../utils/constants.js';
import { resignRules, decideRules } from '../validators/exitValidator.js';
import {
  resign, myResignations, listRequests, decideResignation, withdrawResignation,
} from '../controllers/exitController.js';

const router = Router();
router.use(protect, tenantContext, readOnlyIfExpired);

const HR = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

router.post('/resign', resignRules, resign);          // any role: own resignation
router.get('/my', myResignations);                    // any role: own history
router.get('/requests', authorize(...HR), listRequests);
router.patch('/:id/decide', authorize(...HR), decideRules, decideResignation);
router.patch('/:id/withdraw', withdrawResignation);   // owner check happens inside

export default router;