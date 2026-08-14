// Phase 18 routes. The gate() helper checks req.user.role —
// payroll is HR/Admin only, platform stats SUPER_ADMIN only.
import { Router } from 'express';
import * as authNS from "../middlewares/authMiddleware.js" // ⚠️ if boot fails here, use '../middlewares/authMiddleware.js' (match YOUR folder name)
import * as analyticsController from '../controllers/analyticsController.js';
import * as saasAnalyticsController from '../controllers/saasAnalyticsController.js';
import * as reportBuilderController from '../controllers/reportBuilderController.js';

const protect = authNS.protect || authNS.default?.protect || authNS.default;

// small role-checker middleware (403 if the role isn't allowed)
function gate(...allowedRoles) {
  return function checkRole(req, res, next) {
    const role = req.user?.role;
    if (role && (allowedRoles.includes(role) || role === 'SUPER_ADMIN')) return next();
    return res.status(403).json({ statusCode: 403, success: false, message: 'Forbidden' });
  };
}

const SENIORS = gate('COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD');
const HR_ONLY = gate('COMPANY_ADMIN', 'HR_MANAGER');
const SUPER_ONLY = gate('SUPER_ADMIN');

const router = Router();
router.use(protect); // every route below needs a logged-in user

// company analytics (managers/TLs auto-scoped inside the controller)
router.get('/analytics/overview', SENIORS, analyticsController.overview);
router.get('/analytics/attendance', SENIORS, analyticsController.attendance);
router.get('/analytics/leaves', SENIORS, analyticsController.leaves);
router.get('/analytics/payroll', HR_ONLY, analyticsController.payroll);      // 💰 HR/Admin only
router.get('/analytics/work', SENIORS, analyticsController.work);
router.get('/analytics/recruitment', HR_ONLY, analyticsController.recruitment);
router.get('/analytics/my', analyticsController.myStats);                    // any role: own data only

// platform analytics
router.get('/saas/overview', SUPER_ONLY, saasAnalyticsController.saasOverview);

// report builder
router.get('/report-builder/meta', SENIORS, reportBuilderController.builderMeta);
router.post('/report-builder/run', SENIORS, reportBuilderController.runReport);
router.post('/report-builder/export', SENIORS, reportBuilderController.exportReport);

export default router;
export { router as analyticsRoutes };