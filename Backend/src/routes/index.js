import { Router } from "express";
import { auditTrail } from "../middlewares/auditTrail.js";
import { platformUsage } from "../middlewares/platformUsage.js";
import healthRoutes from "./healthRoutes.js";
import realtimeRoutes from "./realtimeRoutes.js";

import authRoutes from "./authRoutes.js";
import companyRoutes from "./companyRoutes.js";
import companyBrandingRoutes from "./companyBrandingRoutes.js";
import departmentRoutes from "./departmentRoutes.js";
import userRoutes from "./userRoutes.js";
import attendanceRoutes from "./attendance/attendanceRoutes.js";
import attendanceKioskRoutes from "./attendance/attendanceKioskRoutes.js";
import attendancePolicyRoutes from "./attendance/attendancePolicyRoutes.js";
import attendanceLocationRoutes from "./attendance/attendanceLocationRoutes.js";
import attendanceWorkModeRoutes from "./attendance/attendanceWorkModeRoutes.js";
import attendanceRegularizationRoutes from "./attendance/attendanceRegularizationRoutes.js";
import attendanceOvertimeRoutes from "./attendance/attendanceOvertimeRoutes.js";
import leaveRoutes from "./leaveRoutes.js";
import projectRoutes from "./projectRoutes.js";
import taskRoutes from "./taskRoutes.js";
import payrollRoutes from "./payroll/payrollRoutes.js";
import payrollSetupRoutes from "./payroll/payrollSetupRoutes.js";
import salaryComponentRoutes from "./payroll/salaryComponentRoutes.js";
import salaryStructureRoutes from "./payroll/salaryStructureRoutes.js";
import employeePayrollRoutes from "./payroll/employeePayrollRoutes.js";
import monthlyInputRoutes from "./payroll/monthlyInputRoutes.js";
import payrollEngineRoutes from "./payroll/payrollEngineRoutes.js";
import payrollReviewRoutes from "./payroll/payrollReviewRoutes.js";
import payrollPaymentRoutes from "./payroll/payrollPaymentRoutes.js";
import payslipRoutes from "./payroll/payslipRoutes.js";
import statutoryRoutes from "./payroll/statutoryRoutes.js";
import fnfRoutes from "./payroll/fnfRoutes.js";
import analyticsRoutes from "./analyticsRoutes.js";
import recruitmentRoutes from "./recruitment/recruitmentRoutes.js";
import exitRoutes from "./exitRoutes.js";
import billingRoutes from "./platform/billingRoutes.js";
import subscriptionRoutes from "./platform/subscriptionRoutes.js";
import systemRoutes from "./systemRoutes.js";
import profileRoutes from "./profileRoutes.js";
import selfServiceRoutes from "./selfServiceRoutes.js";
import meetingRoutes from "./meetingRoutes.js";
import notificationPrefRoutes from "./notificationPrefRoutes.js";
import scheduleRoutes from "./scheduleRoutes.js";
import payrollAnalyticsRoutes from "./analyticsRoutes.js";
import superAdminRoutes from "./platform/superAdminRoutes.js";
import rolePermissionRoutes from "./rolePermissionRoutes.js";
import auditRoutes from "./auditRoutes.js";
import securityRoutes from "./securityRoutes.js";
import publicCareerRoutes from "./recruitment/publicCareerRoutes.js";
import publicCandidateOfferRoutes from "./recruitment/publicCandidateOfferRoutes.js";
import publicBgvConsentRoutes from "./bgv/publicBgvConsentRoutes.js";
import publicBgvCollectionRoutes from "./bgv/publicBgvCollectionRoutes.js";
import bgvVerifierAuthRoutes from "./bgv/bgvVerifierAuthRoutes.js";
import bgvVerifierWorkRoutes from "./bgv/bgvVerifierWorkRoutes.js";
import publicCandidatePreOnboardingRoutes from "./recruitment/publicCandidatePreOnboardingRoutes.js";
import insightsAnalyticsRoutes from "./insightsAnalyticsRoutes.js";
import reportBuilderRoutes from "./reportBuilderRoutes.js";

const router = Router();

// Phase 32.2 — infrastructure health probes (liveness/readiness) plus
// the legacy Phase 28 combined probe, all mounted BEFORE the audit
// trail so frequent infrastructure polling never writes audit rows.
// Public, cheap, secret-free: see routes/healthRoutes.js + the
// Phase 32 architecture doc for the exact contracts.
router.use("/health", healthRoutes);

// Records mutation activity after the response finishes.

// Public career reads are intentionally mounted before authenticated
// tenant middleware. This router contains its own rate limiting and validation.
router.use("/public/careers", publicCareerRoutes);
router.use("/public/candidate/offers", publicCandidateOfferRoutes);
router.use("/public/candidate/bgv-consent", publicBgvConsentRoutes);
router.use("/public/candidate/bgv-collection", publicBgvCollectionRoutes);
router.use("/bgv-verifier/auth", bgvVerifierAuthRoutes);
router.use("/bgv-verifier/work", bgvVerifierWorkRoutes);
router.use(
  "/public/candidate/pre-onboarding",
  publicCandidatePreOnboardingRoutes,
);

// Records mutation activity after the response finishes.
router.use(auditTrail);

// Platform usage tracking must not perform tenant authorization.
router.use(platformUsage);

// Separate SaaS provider portal.
router.use("/super-admin", superAdminRoutes);

// Public and protected customer authentication.
router.use("/auth", authRoutes);

// Phase 21 routes use protection on each individual route.
// Do not add a router-level protect middleware here.
router.use(rolePermissionRoutes);

// Tenant modules.
router.use("/companies", companyRoutes);
router.use("/companies/my/branding", companyBrandingRoutes);

router.use("/departments", departmentRoutes);

router.use("/users", userRoutes);

// Phase 31.1 — mounted before /attendance so policy reads never fall
// through to the punch routers.
router.use("/attendance/policy", attendancePolicyRoutes);

// Phase 31.3 — same ordering for the same reason.
router.use("/attendance/locations", attendanceLocationRoutes);
// Phase 31.4 — mounted before /attendance so work-mode reads never
// fall through to the generic attendance router.
router.use("/attendance/work-mode-requests", attendanceWorkModeRoutes);
// Phase 31.5 — mounted before /attendance so regularization reads
// never fall through to the generic attendance router.
router.use("/attendance/regularizations", attendanceRegularizationRoutes);
// Phase 31.8 — mounted before /attendance so overtime reads never
// fall through to the generic attendance router.
router.use("/attendance/overtime", attendanceOvertimeRoutes);

router.use("/attendance", attendanceRoutes);

// Phase 31.14 — kiosk punch router (separate kioskAuth trust boundary).
router.use("/kiosk", attendanceKioskRoutes);

router.use("/leaves", leaveRoutes);

router.use("/projects", projectRoutes);

router.use("/tasks", taskRoutes);

router.use("/payroll", payrollRoutes);

// Phase 29.1 — Company Payroll Setup (wizard + settings dashboard)
router.use("/payroll/setup", payrollSetupRoutes);
router.use("/payroll/components", salaryComponentRoutes);
router.use("/payroll/salary-structures", salaryStructureRoutes);
router.use("/payroll/employees", employeePayrollRoutes);
router.use("/payroll/inputs", monthlyInputRoutes);
// Phase 29.6 — Payroll Calculation Engine.
router.use("/payroll/runs", payrollEngineRoutes);
// Phase 29.7 — Payroll Review & Approval.
router.use("/payroll/review", payrollReviewRoutes);
router.use("/payroll/payments", payrollPaymentRoutes);
  router.use("/payroll/payslips", payslipRoutes);
  router.use("/payroll/statutory", statutoryRoutes);
  // Phase 29.11 — Final Settlement (F&F).
  router.use("/payroll/fnf", fnfRoutes);
  // 29.12 — payroll analytics. The recruitment analytics router already
  // owns the plain `analyticsRoutes` name, so this one is namespaced.
  router.use("/payroll/analytics", payrollAnalyticsRoutes);

router.use("/recruitment", recruitmentRoutes);

router.use("/exit", exitRoutes);

router.use("/billing", billingRoutes);

router.use("/subscription", subscriptionRoutes);

router.use("/audit", auditRoutes);

router.use("/security", securityRoutes);

router.use("/profile", profileRoutes);

router.use("/meetings", meetingRoutes);

router.use("/notification-prefs", notificationPrefRoutes);

// Notifications and permission-matrix endpoints.
router.use("/", systemRoutes);

// Phase 32.11 — realtime infrastructure surface (ticket + SSE stream).
// Handlers are inert (503) unless REALTIME_ENABLED=true at boot.
router.use("/realtime", realtimeRoutes);

// Existing self-service routes are mounted at API root.
router.use("/", selfServiceRoutes);

// Schedule routes already contain /holidays, /schedules and /shifts.
router.use(scheduleRoutes);

// Analytics routes already contain their /analytics paths.
router.use(analyticsRoutes);

// Insights hub (/analytics/*, /saas/overview) + Report Builder
// (/report-builder/*) already contain their full paths. Mounted AFTER
// the payroll analytics router: its root-level /:reportKey only matches
// single-segment paths, so it can never shadow these two-segment routes.
router.use(insightsAnalyticsRoutes);
router.use(reportBuilderRoutes);

export default router;
