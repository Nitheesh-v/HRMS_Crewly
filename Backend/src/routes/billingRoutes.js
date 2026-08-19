import { Router } from 'express';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { ROLES } from '../utils/constants.js';
import { getPlans, getSubscription, checkout, verifyPayment, listPayments,listInvoices } from '../controllers/billingController.js';
 // ⏳ Phase 13: expiry reminders (self-starting)



const router = Router();

// ⚠️ readOnlyIfExpired is intentionally NOT applied here:
// an EXPIRED company must be able to pay & renew (the escape hatch).
router.use(protect, tenantContext);

router.get('/plans', authorize(ROLES.COMPANY_ADMIN), getPlans);
router.get('/subscription', authorize(ROLES.COMPANY_ADMIN), getSubscription);
router.get('/payments', authorize(ROLES.COMPANY_ADMIN), listPayments);
router.post('/checkout', authorize(ROLES.COMPANY_ADMIN), checkout);
router.post('/verify', authorize(ROLES.COMPANY_ADMIN), verifyPayment);
router.get(
  '/invoices',
  listInvoices
);

export default router;