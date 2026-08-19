import { Router } from 'express';
import * as authNS from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import * as analyticsController from '../controllers/analyticsController.js';
import * as reportBuilderController from '../controllers/reportBuilderController.js';

const protect =
  authNS.protect ||
  authNS.default?.protect ||
  authNS.default;

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus
);

router.get(
  '/analytics/overview',
  requirePermission(
    'REPORT_READ'
  ),
  requireFeature(
    'analytics'
  ),
  analyticsController.overview
);

router.get(
  '/analytics/attendance',
  requirePermission(
    'ATTENDANCE_READ'
  ),
  requireFeature(
    'analytics'
  ),
  analyticsController.attendance
);

router.get(
  '/analytics/leaves',
  requirePermission(
    'LEAVE_READ'
  ),
  requireFeature(
    'analytics'
  ),
  analyticsController.leaves
);

router.get(
  '/analytics/payroll',
  requirePermission(
    'PAYROLL_READ'
  ),
  requireFeature(
    'payroll'
  ),
  analyticsController.payroll
);

router.get(
  '/analytics/work',
  requireAnyPermission([
    'PROJECT_READ',
    'TASK_READ',
  ]),
  requireFeature(
    'analytics'
  ),
  analyticsController.work
);

router.get(
  '/analytics/recruitment',
  requirePermission(
    'RECRUITMENT_READ'
  ),
  requireFeature(
    'recruitment'
  ),
  analyticsController.recruitment
);

// Own stats remains available to self-service users.
router.get(
  '/analytics/my',
  requireAnyPermission([
    'EMPLOYEE_READ_SELF',
    'ATTENDANCE_READ_SELF',
    'TASK_READ_SELF',
  ]),
  analyticsController.myStats
);

router.get(
  '/report-builder/meta',
  requirePermission(
    'REPORT_READ'
  ),
  requireFeature(
    'reports'
  ),
  reportBuilderController.builderMeta
);

router.post(
  '/report-builder/run',
  requirePermission(
    'REPORT_READ'
  ),
  requireFeature(
    'reports'
  ),
  reportBuilderController.runReport
);

router.post(
  '/report-builder/export',
  requirePermission(
    'REPORT_EXPORT'
  ),
  requireFeature(
    'reports'
  ),
  requireFeature(
    'export'
  ),
  reportBuilderController.exportReport
);

export default router;

export {
  router as analyticsRoutes,
};