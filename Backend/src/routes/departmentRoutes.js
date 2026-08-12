import { Router } from 'express';
import { getDepartments, createDepartment, updateDepartment, deleteDepartment } from '../controllers/departmentController.js';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext, readOnlyIfExpired } from '../middlewares/tenantMiddleware.js';
import { createDepartmentValidator, updateDepartmentValidator } from '../validators/orgValidator.js';
import { validate } from '../validators/authValidator.js';
import { ROLES } from '../utils/constants.js';

const router = Router();

// Every route here: logged in + company loaded
router.use(protect, tenantContext);

const ADMINS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

router.get('/', getDepartments);
router.post('/', readOnlyIfExpired, authorize(...ADMINS), createDepartmentValidator, validate, createDepartment);
router.put('/:id', readOnlyIfExpired, authorize(...ADMINS), updateDepartmentValidator, validate, updateDepartment);
router.delete('/:id', readOnlyIfExpired, authorize(ROLES.COMPANY_ADMIN), deleteDepartment);

export default router;