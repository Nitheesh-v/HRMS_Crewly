import { Router } from 'express';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext, readOnlyIfExpired } from '../middlewares/tenantMiddleware.js';
import { ROLES } from '../utils/constants.js';
import { upsertStructureValidator, generatePayrollValidator, monthQueryValidator } from '../validators/payrollValidator.js';
import {
  getMyPayslips, getStructures, upsertStructure,
  generatePayroll, listPayroll, markPaid, downloadPayslip,
} from '../controllers/payrollController.js';

const router = Router();
router.use(protect, tenantContext, readOnlyIfExpired);

const HR = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

router.get('/my', getMyPayslips);
router.get('/structures', authorize(...HR), getStructures);
router.put('/structure/:userId', authorize(...HR), upsertStructureValidator, upsertStructure);
router.post('/generate', authorize(...HR), generatePayrollValidator, generatePayroll);
router.get('/', authorize(...HR), monthQueryValidator, listPayroll);
router.patch('/:id/pay', authorize(...HR), markPaid);
router.get('/:id/payslip', downloadPayslip); // owner-or-HR check happens inside

export default router;