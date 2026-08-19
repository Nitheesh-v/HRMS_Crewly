import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import {
  upsertStructureValidator,
  generatePayrollValidator,
  monthQueryValidator,
} from '../validators/payrollValidator.js';
import {
  getMyPayslips,
  getStructures,
  upsertStructure,
  generatePayroll,
  listPayroll,
  markPaid,
  downloadPayslip,
} from '../controllers/payrollController.js';

const router = Router();

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus
);

// Employee self-service remains available according to permission.
router.get(
  '/my',
  requireAnyPermission([
    'PAYSLIP_READ_SELF',
    'PAYROLL_READ',
  ]),
  getMyPayslips
);

router.get(
  '/structures',
  requirePermission(
    'PAYROLL_READ'
  ),
  requireFeature('payroll'),
  getStructures
);

router.put(
  '/structure/:userId',
  checkWriteAccess,
  requirePermission(
    'PAYROLL_UPDATE'
  ),
  requireFeature('payroll'),
  upsertStructureValidator,
  upsertStructure
);

router.post(
  '/generate',
  checkWriteAccess,
  requirePermission(
    'PAYROLL_CREATE'
  ),
  requireFeature('payroll'),
  generatePayrollValidator,
  generatePayroll
);

router.get(
  '/',
  requirePermission(
    'PAYROLL_READ'
  ),
  requireFeature('payroll'),
  monthQueryValidator,
  listPayroll
);

router.patch(
  '/:id/pay',
  checkWriteAccess,
  requireAnyPermission([
    'PAYROLL_APPROVE',
    'PAYROLL_MANAGE',
  ]),
  requireFeature('payroll'),
  markPaid
);

router.get(
  '/:id/payslip',
  requireAnyPermission([
    'PAYSLIP_READ_SELF',
    'PAYROLL_READ',
  ]),
  downloadPayslip
);

export default router;