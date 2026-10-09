// ═══════════════════════════════════════════════════════════════════════════
//  EMPLOYEE REFERRAL ROUTES — mounted at /api/referrals
//
//  Posted jobs visible to every employee, for referral.
//
//  MIDDLEWARE CHAIN
//    protect                 — identity from the access token (cookie/bearer)
//    tenantContext           — loads req.company, rejects suspended tenants
//    checkSubscriptionStatus — no reads/writes for an expired subscription
//    checkWriteAccess        — mutation-only, same rule as every tenant module
//
//  NO requirePermission, deliberately: the gate is tenant membership. Every
//  authenticated employee may list posted openings and refer; HR-side
//  pipeline actions on the created candidate stay behind the existing
//  recruitment permissions in their own routes.
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';

import {
  listMine,
  listOpenings,
  referCandidate,
} from '../controllers/recruitment/employeeReferralController.js';

const router = Router();

router.use(protect, tenantContext);

// Data from frontend - requests from frontend
router.get('/openings', checkSubscriptionStatus, listOpenings);
router.get('/mine', checkSubscriptionStatus, listMine);

// DB Logic - DB logics / Data to frontend - response to frontend (in the controller)
router.post('/:jobCode', checkSubscriptionStatus, checkWriteAccess, referCandidate);

export default router;
