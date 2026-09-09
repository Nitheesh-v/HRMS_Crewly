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
import * as bgvCatalogue from "../controllers/superAdminBgvCatalogueController.js";
import * as bgvVerifier from "../controllers/bgvVerifierController.js";
import * as bgvOperations from "../controllers/bgvOperationsController.js";
import * as bgvQa from "../controllers/bgvQaController.js";
import * as bgvBilling from "../controllers/bgvBillingController.js";
import * as bgvOpsDash from "../controllers/bgvOperationsDashboardController.js";
import * as queueOps from "../controllers/superAdminQueueOpsController.js";
import { securityRateLimit } from "../middlewares/securityRateLimit.js";
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

// 29.13 §2 — platform-wide payroll adoption and processing metrics.
// Counts only: no customer payroll figure and no employee name.
router.get(
  "/dashboard/payroll-analytics",
  permit("dashboard:read"),
  dashboard.payrollAnalytics,
);

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

// Phase 30.2 — Crewly BGV service catalogue & pricing (platform commerce).
// Backend is the only price authority; tenants never reach these routes
// (platform gate rejects non-platform roles before DB access).

// Phase 30.6 — internal BGV verifier account management. Platform-only:
// SUPER_ADMIN via '*'; tenant HR can never reach these routes (protect +
// superAdminSession reject tenant principals before this point).
router.get("/bgv-verifiers", permit("bgv-verifiers:read"), bgvVerifier.bgvVerifierList);
router.get("/bgv-verifiers/:verifierId", permit("bgv-verifiers:read"), bgvVerifier.bgvVerifierRead);
router.post("/bgv-verifiers", permit("bgv-verifiers:manage"), bgvVerifier.bgvVerifierInvite);
router.post("/bgv-verifiers/:verifierId/resend-setup", permit("bgv-verifiers:manage"), bgvVerifier.bgvVerifierResendSetup);
router.post("/bgv-verifiers/:verifierId/revoke-setup", permit("bgv-verifiers:manage"), bgvVerifier.bgvVerifierRevokeSetup);
router.patch("/bgv-verifiers/:verifierId", permit("bgv-verifiers:manage"), bgvVerifier.bgvVerifierUpdate);
router.post("/bgv-verifiers/:verifierId/deactivate", permit("bgv-verifiers:manage"), bgvVerifier.bgvVerifierDeactivate);
router.post("/bgv-verifiers/:verifierId/reactivate", permit("bgv-verifiers:manage"), bgvVerifier.bgvVerifierReactivate);

// Phase 30.7 — BGV check assignment operations (platform-only; the new
// bgv-operations permissions are held only by SUPER_ADMIN via "*").
router.get("/bgv-operations/queue", permit("bgv-operations:read"), bgvOperations.bgvOperationsQueue);
router.get("/bgv-operations/checks/:checkType/eligible-verifiers", permit("bgv-operations:read"), bgvOperations.bgvOperationsEligibleVerifiers);
router.post("/bgv-operations/assign", permit("bgv-operations:manage"), bgvOperations.bgvOperationsAssign);
router.post("/bgv-operations/reassign", permit("bgv-operations:manage"), bgvOperations.bgvOperationsReassign);
router.post("/bgv-operations/unassign", permit("bgv-operations:manage"), bgvOperations.bgvOperationsUnassign);
// Phase 30.8 — platform-only check cancellation (CANCELLED is never a
// verifier choice; requires a business reason).
router.post("/bgv-operations/cancel-check", permit("bgv-operations:manage"), bgvOperations.bgvOperationsCancelCheck);

// Phase 30.11 — internal BGV operations dashboard (derived counts, drill-down
// queues, verifier workload, SLA config). READS are count lookups and are
// deliberately NOT audited; only the SLA configuration write is audited.
// Phase 30.12 — BGV billing reporting (read-only over immutable order
// snapshots; SUPER_ADMIN via "*", no payment mutation lives here).
router.get("/bgv-billing/overview", permit("bgv-billing:read"), bgvBilling.bgvBilling);

router.get("/bgv-ops/dashboard", permit("bgv-operations:read"), bgvOpsDash.bgvOpsDashboard);
router.get("/bgv-ops/queue", permit("bgv-operations:read"), bgvOpsDash.bgvOpsQueue);
router.get("/bgv-ops/workload", permit("bgv-operations:read"), bgvOpsDash.bgvOpsWorkload);
router.get("/bgv-ops/sla", permit("bgv-operations:read"), bgvOpsDash.bgvOpsSlaPolicyRead);
router.put("/bgv-ops/sla", permit("bgv-operations:manage"), bgvOpsDash.bgvOpsSlaPolicyUpdate);

// Phase 30.10 — internal BGV QA review + final report release.
// permit() enforces bgv-qa:* on top of the platform session; tenant HR and
// verifier principals live on separate auth stacks and cannot reach these.
// QA approves/returns findings and releases reports — it never hires/rejects.
router.get("/bgv-qa/queue", permit("bgv-qa:review"), bgvQa.bgvQaQueue);
router.get("/bgv-qa/check/:orderId/:checkType", permit("bgv-qa:review"), bgvQa.bgvQaCheckDetail);
router.get("/bgv-qa/check/:orderId/:checkType/evidence/:fileId", permit("bgv-qa:review"), bgvQa.bgvQaEvidenceDownload);
router.post("/bgv-qa/check/:orderId/:checkType/approve", permit("bgv-qa:review"), bgvQa.bgvQaApprove);
router.post("/bgv-qa/check/:orderId/:checkType/return", permit("bgv-qa:review"), bgvQa.bgvQaReturn);
router.get("/bgv-qa/report/:orderId", permit("bgv-qa:review"), bgvQa.bgvQaReportStatus);
router.post("/bgv-qa/report/:orderId/generate", permit("bgv-qa:release"), bgvQa.bgvQaGenerateReport);
router.post("/bgv-qa/report/:orderId/pdf-retry", permit("bgv-qa:release"), bgvQa.bgvQaRetryReportPdf);
router.post("/bgv-qa/report/:orderId/release", permit("bgv-qa:release"), bgvQa.bgvQaReleaseReport);
router.get("/bgv-qa/report/:orderId/download", permit("bgv-qa:review"), bgvQa.bgvQaReportDownload);

router.get(
  "/bgv-catalogue",
  permit("bgv-catalog:read"),
  bgvCatalogue.bgvCatalogueList,
);
router.patch(
  "/bgv-catalogue/:type",
  permit("bgv-catalog:manage"),
  bgvCatalogue.bgvCatalogueUpdate,
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

// ============================================================
// 28.8 — Background Operations (queue / worker / cache ops)
//
// Read actions: SUPER_ADMIN + PLATFORM_ADMIN (operations:read).
// Mutating actions: SUPER_ADMIN only (operations:manage) —
// the permit middleware grants '*' to SUPER_ADMIN.
// Conservative per-IP rate limits on every route (reads and
// writes separately) — these endpoints talk to live Redis.
// ============================================================

const opsReadLimit = securityRateLimit({
  windowMs: 60000,
  maximum: 60,
  keyGenerator: (req) => `${req.ip}:ops-read`,
});

const opsMutateLimit = securityRateLimit({
  windowMs: 60000,
  maximum: 20,
  keyGenerator: (req) => `${req.ip}:ops-mutate`,
});

router.get(
  "/operations/queues",
  permit("operations:read"),
  opsReadLimit,
  queueOps.getQueues
);

router.get(
  "/operations/queues/:queueName/failed",
  permit("operations:read"),
  opsReadLimit,
  queueOps.getFailed
);

router.get(
  "/operations/queues/:queueName/jobs/:jobId",
  permit("operations:read"),
  opsReadLimit,
  queueOps.getJobDetailHandler
);

router.get(
  "/operations/reconcile/preview",
  permit("operations:read"),
  opsReadLimit,
  queueOps.reconcilePreviewHandler
);

router.get(
  "/operations/cache",
  permit("operations:read"),
  opsReadLimit,
  queueOps.getCacheStatusHandler
);

router.post(
  "/operations/queues/:queueName/jobs/:jobId/retry",
  permit("operations:manage"),
  opsMutateLimit,
  queueOps.retryJobHandler
);

router.post(
  "/operations/queues/:queueName/retry-failed",
  permit("operations:manage"),
  opsMutateLimit,
  queueOps.batchRetryHandler
);

router.delete(
  "/operations/queues/:queueName/jobs/:jobId",
  permit("operations:manage"),
  opsMutateLimit,
  queueOps.removeJobHandler
);

router.post(
  "/operations/queues/:queueName/pause",
  permit("operations:manage"),
  opsMutateLimit,
  queueOps.pauseQueueHandler
);

router.post(
  "/operations/queues/:queueName/resume",
  permit("operations:manage"),
  opsMutateLimit,
  queueOps.resumeQueueHandler
);

router.post(
  "/operations/reconcile",
  permit("operations:manage"),
  opsMutateLimit,
  queueOps.reconcileRunHandler
);

router.post(
  "/operations/cache/invalidate",
  permit("operations:manage"),
  opsMutateLimit,
  queueOps.invalidateCacheHandler
);
router.get("/settings", permit("settings:manage"), operations.getSettings);
router.patch("/settings", permit("settings:manage"), operations.updateSettings);

router.get("/notifications", operations.notifications);
router.patch("/notifications/read-all", operations.markAllNotifications);
router.patch("/notifications/:eventId/read", operations.markNotification);

export default router;
export { router as superAdminRoutes };
