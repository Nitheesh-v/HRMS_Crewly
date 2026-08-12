// ============================================================
// 🛡️ SYSTEM ROUTES — notifications · analytics · audit · matrix
// Mounted at /api (see routes/index.js)
// Pure ESM — matches the rest of the Backend.
// ============================================================
import express from 'express';
import * as authMwNS from '../middlewares/authMiddleware.js';
import * as constantsNS from '../utils/constants.js';
import * as systemControllerNS from '../controllers/systemController.js';

// 🧩 Bulletproof resolver — works whether the imported file uses
// named exports (export const x) or a default object (export default {...})
const mergeExports = (ns) => ({
  ...ns,
  ...(ns.default && typeof ns.default === 'object' ? ns.default : {}),
});

const { protect, authorize } = mergeExports(authMwNS);
const { ROLES } = mergeExports(constantsNS);
const systemController = mergeExports(systemControllerNS);

const router = express.Router();

// ── Everything below needs a valid JWT ────────────────────────────────────
router.use(protect);

// 🔔 Notifications — every logged-in user
router.get('/notifications', systemController.myNotifications);
router.get('/notifications/unread-count', systemController.unreadCount);

// 🩹 mark-all — accept BOTH methods (bell calls PATCH; older clients call POST)
router.post('/notifications/read-all', systemController.markAllRead);
router.patch('/notifications/read-all', systemController.markAllRead);

// 🩹 mark-one — same dual-method safety
router.post('/notifications/:id/read', systemController.markRead);
router.patch('/notifications/:id/read', systemController.markRead);

// 📈 Analytics overview — leadership
router.get(
  '/analytics/overview',
  authorize(ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER),
  systemController.analyticsOverview
);

// 🛡️ Audit log — company admin
router.get(
  '/audit',
  authorize(ROLES.COMPANY_ADMIN, ROLES.SUPER_ADMIN),
  systemController.audit
);

// 🧩 Role-permission matrix — read-only reference, everyone can view
router.get('/permissions/matrix', systemController.permissionMatrix);

router.get('/permissions', systemController.permissionMatrix); // 🧩 alias — the original Phase 8 frontend calls /api/permissions

// Dual export — index.js can use default OR named import, both will work
export default router;
export { router as systemRoutes };