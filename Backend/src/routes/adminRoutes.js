// ============================================================
// 👑 ADMIN ROUTES — mounted at /api/admin-api WITHOUT tenantContext
// (super admin has no company — tenant scoping must not run here)
// ============================================================
import express from 'express';
import * as authMwNS from '../middlewares/authMiddleware.js';
import * as constantsNS from '../utils/constants.js';
import * as adminControllerNS from '../controllers/adminController.js';

const mergeExports = (ns) => ({
  ...ns,
  ...(ns.default && typeof ns.default === 'object' ? ns.default : {}),
});

const { protect, authorize } = mergeExports(authMwNS);
const { ROLES } = mergeExports(constantsNS);
const adminController = mergeExports(adminControllerNS);

const router = express.Router();

// 🔐 Platform-level only
router.use(protect, authorize(ROLES.SUPER_ADMIN));

router.get('/overview', adminController.overview);          // headline stats + live MRR
router.get('/companies', adminController.companies);        // tenant list w/ plan, employees, days left
router.get('/revenue', adminController.revenue);            // 12-month revenue series
router.patch('/companies/:id/status', adminController.setCompanyStatus); // suspend / activate

export default router;