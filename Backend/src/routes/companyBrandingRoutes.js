import { Router } from 'express';

import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext, readOnlyIfExpired } from '../middlewares/tenantMiddleware.js';
import { brandingLogoUpload } from '../middlewares/brandingUpload.js';
import { ROLES } from '../utils/constants.js';
import { updateBrandingValidator } from '../validators/companyBrandingValidator.js';
import {
  getBranding,
  previewPayslip,
  removeLogo,
  updateSettings,
  uploadLogo,
} from '../controllers/companyBrandingController.js';

// Company Branding — mounted at /api/companies/my/branding.
// Reads are safe for any member; every mutation is COMPANY_ADMIN only
// (the established company-settings pattern, same as PUT /companies/my).
const router = Router();
router.use(protect, tenantContext, readOnlyIfExpired);

router.get('/', getBranding);
router.post('/logo', authorize(ROLES.COMPANY_ADMIN), brandingLogoUpload, uploadLogo);
router.delete('/logo', authorize(ROLES.COMPANY_ADMIN), removeLogo);
router.put('/', authorize(ROLES.COMPANY_ADMIN), updateBrandingValidator, updateSettings);
router.post('/payslip-preview', authorize(ROLES.COMPANY_ADMIN), previewPayslip);

export default router;
