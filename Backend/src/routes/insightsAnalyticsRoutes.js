// ============================================================
// INSIGHTS ANALYTICS ROUTES — Analytics Hub (/app/analytics).
//
// Mounted at /api (see routes/index.js); every path below already
// contains its full /analytics or /saas prefix.
//
// Guard choice: role-based `authorize()` (systemRoutes precedent),
// NOT DB-backed requirePermission — the hub must work on localhost
// databases where the permission seed was never run. Data-level
// scoping (org subtree for team roles) is enforced inside the
// controller, never by role name alone.
// ============================================================
import express from 'express';

import { authorize, protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import { ROLES } from '../utils/constants.js';
import { analyticsPresetValidator } from '../validators/insightsValidator.js';
import {
  analyticsAttendance,
  analyticsLeaves,
  analyticsMy,
  analyticsOverview,
  analyticsPayroll,
  analyticsRecruitment,
  analyticsWork,
  saasOverview,
} from '../controllers/insightsAnalyticsController.js';

const router = express.Router();

const SENIOR = [
  ROLES.COMPANY_ADMIN,
  ROLES.HR_MANAGER,
  ROLES.MANAGER,
  ROLES.TEAM_LEAD,
];
const HR_ONLY = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

// ── Company/team tabs — seniors, org-subtree scoped for team roles ──
router.get(
  '/analytics/overview',
  protect,
  tenantContext,
  authorize(...SENIOR),
  analyticsPresetValidator,
  analyticsOverview
);
router.get(
  '/analytics/attendance',
  protect,
  tenantContext,
  authorize(...SENIOR),
  analyticsPresetValidator,
  analyticsAttendance
);
router.get(
  '/analytics/leaves',
  protect,
  tenantContext,
  authorize(...SENIOR),
  analyticsPresetValidator,
  analyticsLeaves
);
router.get(
  '/analytics/work',
  protect,
  tenantContext,
  authorize(...SENIOR),
  analyticsPresetValidator,
  analyticsWork
);

// ── Money + hiring tabs — HR roles only ──
router.get(
  '/analytics/payroll',
  protect,
  tenantContext,
  authorize(...HR_ONLY),
  analyticsPresetValidator,
  analyticsPayroll
);
router.get(
  '/analytics/recruitment',
  protect,
  tenantContext,
  authorize(...HR_ONLY),
  analyticsPresetValidator,
  analyticsRecruitment
);

// ── Self tab — any member, self data only ──
router.get('/analytics/my', protect, tenantContext, analyticsMy);

// ── Platform tab — super admin only, no tenant context ──
router.get('/saas/overview', protect, authorize(ROLES.SUPER_ADMIN), saasOverview);

export default router;
