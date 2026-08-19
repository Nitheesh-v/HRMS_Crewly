import { Router } from "express";
import * as authMiddlewareNS from "../middlewares/authMiddleware.js";
import {
  permit,
  superAdminLoginGuard,
  superAdminSession,
} from "../middlewares/superAdminAuth.js";
import * as auth from "../controllers/superAdminAuthController.js";
import * as dashboard from "../controllers/superAdminDashboardController.js";
import * as companies from "../controllers/superAdminCompanyController.js";
import * as subscriptions from "../controllers/superAdminSubscriptionController.js";
import * as operations from "../controllers/superAdminOperationsController.js";
import {
  platformCompanyRoles,
} from '../controllers/rolePermissionController.js';



const protect =
  authMiddlewareNS.protect ||
  authMiddlewareNS.default?.protect ||
  authMiddlewareNS.default;

const router = Router();

// Separate public provider authentication.
router.post("/auth/login", superAdminLoginGuard, auth.login);
router.post("/auth/verify-2fa", superAdminLoginGuard, auth.verifyTwoFactor);
router.post("/auth/forgot-password", superAdminLoginGuard, auth.forgotPassword);
router.post("/auth/reset-password", superAdminLoginGuard, auth.resetPassword);

// Everything below needs platform role + active session.
router.use(protect, superAdminSession);

router.post("/auth/logout", auth.logout);
router.get("/auth/sessions", auth.sessions);
router.post("/auth/logout-others", auth.logoutOthers);
router.patch("/auth/change-password", auth.changePassword);
router.patch("/auth/2fa", auth.setTwoFactor);

router.get("/dashboard", permit("dashboard:read"), dashboard.dashboard);
router.get("/dashboard/charts", permit("dashboard:read"), dashboard.charts);

router.get(
  "/search",
  permit(
    "companies:read",
    "users:read",
    "subscriptions:manage",
    "support:manage",
  ),
  companies.globalSearch,
);

router.get("/companies", permit("companies:read"), companies.listCompanies);
router.post("/companies", permit("companies:manage"), companies.createCompany);
router.get(
  "/companies/:companyId",
  permit("companies:read"),
  companies.companyDetail,
);
router.patch(
  "/companies/:companyId",
  permit("companies:manage"),
  companies.updateCompany,
);
router.patch(
  "/companies/:companyId/status",
  permit("companies:manage"),
  companies.setCompanyStatus,
);
router.delete(
  "/companies/:companyId",
  permit("companies:manage"),
  companies.archiveCompany,
);
router.get(
  '/companies/:companyId/roles',
  permit(
    'companies:read'
  ),
  platformCompanyRoles
);

router.get("/users", permit("users:read"), operations.platformUsers);
router.get(
  "/platform-admins",
  permit("settings:manage", "support:manage"),
  operations.platformAdmins,
);

router.get(
  "/subscriptions",
  permit("subscriptions:manage"),
  subscriptions.listSubscriptions,
);
router.patch(
  "/subscriptions/:companyId",
  permit("subscriptions:manage"),
  subscriptions.updateSubscription,
);

router.get(
  "/plans",
  permit("plans:manage", "subscriptions:manage"),
  subscriptions.listPlans,
);
router.post("/plans", permit("plans:manage"), subscriptions.savePlan);
router.put("/plans/:key", permit("plans:manage"), (req, res, next) => {
  req.body.key = req.params.key;
  return subscriptions.savePlan(req, res, next);
});

router.get("/billing", permit("billing:manage"), subscriptions.listBilling);
router.patch(
  "/billing/payments/:paymentId",
  permit("billing:manage"),
  subscriptions.updatePayment,
);
router.get(
  "/revenue",
  permit("revenue:read", "billing:manage"),
  subscriptions.revenueAnalytics,
);

router.get("/usage", permit("usage:read"), operations.usage);
router.get("/support", permit("support:manage"), operations.support);
router.patch(
  "/support/:ticketId",
  permit("support:manage"),
  operations.updateSupport,
);
router.get("/system-health", permit("health:read"), operations.health);
router.get("/audit-logs", permit("audit:read"), operations.auditLogs);
router.get("/settings", permit("settings:manage"), operations.getSettings);
router.patch("/settings", permit("settings:manage"), operations.updateSettings);

router.get("/notifications", operations.notifications);
router.patch("/notifications/read-all", operations.markAllNotifications);
router.patch("/notifications/:eventId/read", operations.markNotification);

export default router;
export { router as superAdminRoutes };
