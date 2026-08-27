import { Router } from "express";
import { auditTrail } from "../middlewares/auditTrail.js";
import { platformUsage } from "../middlewares/platformUsage.js";

import authRoutes from "./authRoutes.js";
import companyRoutes from "./companyRoutes.js";
import departmentRoutes from "./departmentRoutes.js";
import userRoutes from "./userRoutes.js";
import attendanceRoutes from "./attendanceRoutes.js";
import leaveRoutes from "./leaveRoutes.js";
import projectRoutes from "./projectRoutes.js";
import taskRoutes from "./taskRoutes.js";
import payrollRoutes from "./payrollRoutes.js";
import recruitmentRoutes from "./recruitmentRoutes.js";
import exitRoutes from "./exitRoutes.js";
import billingRoutes from "./billingRoutes.js";
import subscriptionRoutes from "./subscriptionRoutes.js";
import systemRoutes from "./systemRoutes.js";
import profileRoutes from "./profileRoutes.js";
import selfServiceRoutes from "./selfServiceRoutes.js";
import meetingRoutes from "./meetingRoutes.js";
import notificationPrefRoutes from "./notificationPrefRoutes.js";
import scheduleRoutes from "./scheduleRoutes.js";
import analyticsRoutes from "./analyticsRoutes.js";
import superAdminRoutes from "./superAdminRoutes.js";
import rolePermissionRoutes from "./rolePermissionRoutes.js";
import auditRoutes from "./auditRoutes.js";
import securityRoutes from "./securityRoutes.js";
import publicCareerRoutes from "./publicCareerRoutes.js";
import publicCandidateOfferRoutes from "./publicCandidateOfferRoutes.js";
import publicCandidatePreOnboardingRoutes from "./publicCandidatePreOnboardingRoutes.js";

const router = Router();

router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Crewly HRMS API is healthy",
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

// Existing self-service routes are mounted at API root.
router.use("/", selfServiceRoutes);

// Schedule routes already contain /holidays, /schedules and /shifts.
router.use(scheduleRoutes);

// Analytics routes already contain their /analytics paths.
router.use(analyticsRoutes);

export default router;
