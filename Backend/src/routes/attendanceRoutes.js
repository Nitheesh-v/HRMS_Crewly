import { Router } from 'express';
import { punchIn, punchOut, getMyToday, getMyAttendance, getCompanyAttendance, getMonthlyReport } from "../controllers/attendanceController.js"
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { tenantContext, readOnlyIfExpired } from '../middlewares/tenantMiddleware.js';
import { ROLES } from '../utils/constants.js';

const router = Router();

router.use(protect, tenantContext);

// Self-service (every company user)
router.post('/punch-in', readOnlyIfExpired, punchIn);
router.post('/punch-out', readOnlyIfExpired, punchOut);
router.get('/today', getMyToday);
router.get('/my', getMyAttendance);

// Oversight (Admin / HR see company · Manager/TL see their subtree)
const SENIORS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD];
router.get('/company', authorize(...SENIORS), getCompanyAttendance);
router.get('/report', authorize(...SENIORS), getMonthlyReport);

export default router;