import { Router } from "express";
import mongoose from "mongoose";
import { auditTrail } from "../middlewares/auditTrail.js";
import { platformUsage } from "../middlewares/platformUsage.js";
import { getRedisHealth } from "../config/redis.js";

import authRoutes from "./authRoutes.js";
import companyRoutes from "./companyRoutes.js";
import departmentRoutes from "./departmentRoutes.js";
import userRoutes from "./userRoutes.js";
import attendanceRoutes from "./attendanceRoutes.js";
import leaveRoutes from "./leaveRoutes.js";
import projectRoutes from "./projectRoutes.js";
import taskRoutes from "./taskRoutes.js";
import payrollRoutes from "./payrollRoutes.js";
import payrollSetupRoutes from "./payrollSetupRoutes.js";
import salaryComponentRoutes from "./salaryComponentRoutes.js";
import salaryStructureRoutes from "./salaryStructureRoutes.js";
import employeePayrollRoutes from "./employeePayrollRoutes.js";
import monthlyInputRoutes from "./monthlyInputRoutes.js";
import payrollEngineRoutes from "./payrollEngineRoutes.js";
import payrollReviewRoutes from "./payrollReviewRoutes.js";
import payrollPaymentRoutes from "./payrollPaymentRoutes.js";
import payslipRoutes from "./payslipRoutes.js";
import statutoryRoutes from "./statutoryRoutes.js";
import fnfRoutes from "./fnfRoutes.js";
import analyticsRoutes from "./analyticsRoutes.js";
import recruitmentRoutes from "./recruitmentRoutes.js";
import bgvCheckRoutes from "./bgvCheckRoutes.js";
import exitRoutes from "./exitRoutes.js";
import billingRoutes from "./billingRoutes.js";
import subscriptionRoutes from "./subscriptionRoutes.js";
import systemRoutes from "./systemRoutes.js";
import profileRoutes from "./profileRoutes.js";
import selfServiceRoutes from "./selfServiceRoutes.js";
import meetingRoutes from "./meetingRoutes.js";
import notificationPrefRoutes from "./notificationPrefRoutes.js";
import scheduleRoutes from "./scheduleRoutes.js";
import payrollAnalyticsRoutes from "./analyticsRoutes.js";
import superAdminRoutes from "./superAdminRoutes.js";
import rolePermissionRoutes from "./rolePermissionRoutes.js";
import auditRoutes from "./auditRoutes.js";
import securityRoutes from "./securityRoutes.js";
import publicCareerRoutes from "./publicCareerRoutes.js";
import publicCandidateOfferRoutes from "./publicCandidateOfferRoutes.js";
import publicCandidatePreOnboardingRoutes from "./publicCandidatePreOnboardingRoutes.js";

const router = Router();

// Phase 28.1 — real infrastructure health. Public, read-only, and
// secret-safe: only up/down/disabled + safe reason labels are
// returned. Never the Redis URL, credentials, or stack traces.
// Semantics:
//   status "ok"        — MongoDB up; Redis up or intentionally disabled
//   status "degraded"  — MongoDB up, but Redis enabled and unavailable
//   status "unhealthy" — MongoDB down (the source of truth is unreachable)
// Redis "disabled" is intentional configuration, never a fault.
// success stays true: this endpoint itself is alive and reporting.
router.get("/health", (req, res) => {
  const mongodbUp = mongoose.connection.readyState === 1;
  const redis = getRedisHealth();
  const status = !mongodbUp
    ? "unhealthy"
    : redis.status === "down"
      ? "degraded"
      : "ok";

  res.json({
    success: true,
    message:
      status === "ok"
        ? "Crewly HRMS API is healthy"
        : status === "degraded"
          ? "Crewly HRMS API is running with degraded infrastructure (Redis unavailable)"
          : "Crewly HRMS API is unhealthy (MongoDB unavailable)",
    status,
    services: {
      mongodb: mongodbUp ? "up" : "down",
      redis: redis.status,
      ...(redis.reason ? { redisReason: redis.reason } : {}),
    },
    timestamp: new Date().toISOString(),
  });
});

// Public career reads are intentionally mounted before authenticated
// tenant middleware. This router contains its own rate limiting and validation.
router.use("/public/careers", publicCareerRoutes);
router.use("/public/candidate/offers", publicCandidateOfferRoutes);
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

router.use("/departments", departmentRoutes);

router.use("/users", userRoutes);

router.use("/attendance", attendanceRoutes);

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

// Phase 30.1 — BGV check framework & Verifier Workbench.
// /api/bgv/checks* + /api/bgv/cases/:caseId/seed-checks. The 27.15
// HR/case family stays under /api/recruitment/background-verification*.
router.use("/bgv", bgvCheckRoutes);

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

// Existing self-service routes are mounted at API root.
router.use("/", selfServiceRoutes);

// Schedule routes already contain /holidays, /schedules and /shifts.
router.use(scheduleRoutes);

// Analytics routes already contain their /analytics paths.
router.use(analyticsRoutes);

export default router;
