import { Router } from 'express';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext, readOnlyIfExpired } from '../middlewares/tenantMiddleware.js';
import { ROLES } from '../utils/constants.js';
import { updateCompanyValidator } from '../validators/companyValidator.js';
import { getMyCompany, updateMyCompany } from '../controllers/companyController.js';

const router = Router();
router.use(protect, tenantContext, readOnlyIfExpired);

router.get('/my', getMyCompany);
router.put('/my', authorize(ROLES.COMPANY_ADMIN), updateCompanyValidator, updateMyCompany);

export default router;