import mongoose from "mongoose";
import Company from "../models/Company.js";
import Subscription from "../models/Subscription.js";
import User from "../models/User.js";
import SecuritySession from "../models/SecuritySession.js";
import SystemEvent from "../models/SystemEvent.js";
import UsageMetric from "../models/UsageMetric.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import {
  ROLES,
  PLANS,
  TRIAL_DAYS,
  SUPER_ADMIN_COMPANY_CODE,
} from "../utils/constants.js";
import { createUserSession } from "../utils/tokenService.js";
import {
  getRequestIp,
  getSecurityPolicy,
  parseDevice,
  validatePassword,
} from "../utils/securityPolicy.js";
import {
  recordAudit,
  recordSecurityEvent,
} from "../utils/securityauditService.js"

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,

  companyId: user.companyId ?? null,

  roleRef: user.roleRef || null,

  avatarUrl: user.avatarUrl,

  twoFactorEnabled: user.twoFactorEnabled || false,

  mfaEnabled: user.mfa?.enabled || false,
});

const generateCompanyCode = async (name) => {
  const base =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 12) || "company";

  let code = base;
  let suffix = 1;

  while (
    await Company.exists({
      code,
    })
  ) {
    code = `${base}${suffix++}`;
  }

  return code;
};

const subscriptionSummary = (subscription) => {
  if (!subscription) {
    return null;
  }

  const endTime = new Date(subscription.endDate).getTime();

  const daysLeft = Number.isNaN(endTime)
    ? 0
    : Math.ceil((endTime - Date.now()) / MS_PER_DAY);

  return {
    plan: subscription.plan,

    status: subscription.status,

    daysLeft,

    endDate: subscription.endDate,

    renewalDate: subscription.renewalDate,

    graceEndsAt: subscription.graceEndsAt,

    expirationBehavior: subscription.expirationBehavior,

    limits: subscription.limits,

    enabledModules: subscription.enabledModules,

    readOnly: subscription.readOnly || false,
  };
};

// Update subscription status during login without depending
// on a dashboard request or exposing another tenant.
const refreshSubscriptionStatus = async (subscription) => {
  if (!subscription) {
    return null;
  }

  const now = Date.now();

  const endTime = new Date(subscription.endDate).getTime();

  if (Number.isNaN(endTime)) {
    return subscription;
  }

  const graceEndTime = subscription.graceEndsAt
    ? new Date(subscription.graceEndsAt).getTime()
    : endTime + 7 * MS_PER_DAY;

  const daysLeft = Math.ceil((endTime - now) / MS_PER_DAY);

  if (endTime < now && now <= graceEndTime) {
    subscription.status = "GRACE_PERIOD";

    subscription.graceEndsAt = new Date(graceEndTime);

    await subscription.save();

    return subscription;
  }

  if (endTime < now) {
    subscription.status = "EXPIRED";

    subscription.readOnly = true;

    await subscription.save();

    return subscription;
  }

  if (daysLeft <= 30 && !["TRIAL", "PAST_DUE"].includes(subscription.status)) {
    subscription.status = "EXPIRING";

    await subscription.save();
  }

  return subscription;
};

// ============================================================
// POST /api/auth/register-company
// ============================================================

export const registerCompany = asyncHandler(async (req, res) => {
  const { companyName, adminName, email, password } = req.body;

  // Platform minimum applies before a company policy exists.
  const passwordValidation = validatePassword(password, {});

  if (!passwordValidation.valid) {
    throw ApiError.badRequest(passwordValidation.errors.join(", "));
  }

  const session = await mongoose.startSession();

  session.startTransaction();

  let company;
  let subscription;
  let admin;
  let committed = false;

  try {
    // DB Logic - DB logics
    const code = await generateCompanyCode(companyName);

    [company] = await Company.create(
      [
        {
          name: companyName,

          code,

          email,
        },
      ],
      { session },
    );

    const trialStart = new Date();

    const trialEnd = new Date(trialStart.getTime() + TRIAL_DAYS * MS_PER_DAY);

    [subscription] = await Subscription.create(
      [
        {
          company: company._id,

          plan: PLANS.TRIAL,

          status: "TRIAL",

          startDate: trialStart,

          endDate: trialEnd,

          trialEndDate: trialEnd,

          renewalDate: trialEnd,

          readOnly: false,
        },
      ],
      { session },
    );

    company.subscription = subscription._id;

    await company.save({
      session,
    });

    [admin] = await User.create(
      [
        {
          name: adminName,

          email,

          password,

          role: ROLES.COMPANY_ADMIN,

          companyId: company._id,

          passwordChangedAt: new Date(),
        },
      ],
      { session },
    );

    await session.commitTransaction();
    committed = true;
  } catch (error) {
    if (!committed && session.inTransaction()) {
      await session.abortTransaction();
    }

    if (error.code === 11000) {
      throw ApiError.conflict("This company or email is already registered.");
    }

    throw error;
  } finally {
    session.endSession();
  }

  SystemEvent.create({
    type: "COMPANY_REGISTERED",

    level: "INFO",

    title: "New company registered",

    message: `${company.name} ` + `(${company.code}) ` + `started a trial`,

    companyId: company._id,

    targetType: "Company",

    targetId: company._id,
  }).catch(() => {});

  const securitySession = await createUserSession({
    user: admin,
    req,
    res,
  });

  await recordSecurityEvent({
    req,

    companyId: company._id,

    userId: admin._id,

    sessionId: securitySession.sessionId,

    event: "LOGIN_SUCCESS",

    metadata: {
      source: "COMPANY_REGISTRATION",
    },
  });

  await recordAudit({
    req,

    action: "COMPANY_REGISTERED",

    companyId: company._id,

    actorId: admin._id,

    actorName: admin.name,

    actorRole: admin.role,

    resource: "Company",

    resourceId: company._id,

    newValue: {
      name: company.name,

      code: company.code,

      plan: subscription.plan,
    },

    statusCode: 201,
    critical: true,
  });

  return ApiResponse.created(res, {
    message: "Company registered successfully 🎉 Your trial has started.",

    data: {
      user: publicUser(admin),

      token: securitySession.accessToken,

      accessTokenExpiresIn: securitySession.accessTokenExpiresIn,

      company: {
        name: company.name,

        code: company.code,
      },

      subscription: subscriptionSummary(subscription),

      trialEndsAt: subscription.endDate,
    },
  });
});

// ============================================================
// POST /api/auth/login
// Customer-company login only.
// ============================================================

export const login = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { companyCode, email, password } = req.body;

  const code = String(companyCode || "")
    .trim()
    .toLowerCase();

  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();

  if (code === SUPER_ADMIN_COMPANY_CODE.toLowerCase()) {
    throw ApiError.forbidden("Use the separate Super Admin portal to sign in.");
  }

  // DB Logic - DB logics
  const company = await Company.findOne({
    code,
  }).populate("subscription");

  // Generic failure prevents company-code enumeration.
  if (
    !company ||
    ["SUSPENDED", "DEACTIVATED", "ARCHIVED"].includes(company.status)
  ) {
    await recordSecurityEvent({
      req,
      companyId: company?._id || null,

      event: "LOGIN_FAILED",

      success: false,

      reason: "Invalid company or credentials",

      metadata: {
        attemptedEmail: normalizedEmail,
      },
    });

    throw ApiError.unauthorized("Invalid company code, email or password");
  }

  const user = await User.findOne({
    email: normalizedEmail,

    companyId: company._id,
  }).select("+password");

  if (!user) {
    await recordSecurityEvent({
      req,
      companyId: company._id,

      event: "LOGIN_FAILED",

      success: false,

      reason: "Invalid credentials",

      metadata: {
        attemptedEmail: normalizedEmail,
      },
    });

    throw ApiError.unauthorized("Invalid company code, email or password");
  }

  if (user.status !== "ACTIVE") {
    throw ApiError.unauthorized("Invalid company code, email or password");
  }

  // If a previous lock expired, clear it before
  // evaluating the new login attempt.
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() <= Date.now()) {
    user.lockedUntil = null;

    user.failedLoginAttempts = 0;

    await user.save();

    await recordSecurityEvent({
      req,
      companyId: company._id,
      userId: user._id,
      event: "ACCOUNT_UNLOCKED",
      reason: "Temporary lock expired",
    });
  }

  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
    await recordSecurityEvent({
      req,
      companyId: company._id,
      userId: user._id,
      event: "LOGIN_FAILED",
      success: false,
      reason: "Account temporarily locked",
    });

    throw ApiError.unauthorized("Invalid company code, email or password");
  }

  const policy = await getSecurityPolicy(company._id);

  const passwordMatches = await user.comparePassword(password);

  if (!passwordMatches) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;

    if (user.failedLoginAttempts >= policy.lockout.maximumAttempts) {
      user.lockedUntil = new Date(
        Date.now() + policy.lockout.lockMinutes * 60 * 1000,
      );

      await recordSecurityEvent({
        req,
        companyId: company._id,
        userId: user._id,
        event: "ACCOUNT_LOCKED",
        success: false,
        reason: "Maximum failed login attempts reached",
      });
    }

    await user.save();

    await recordSecurityEvent({
      req,
      companyId: company._id,
      userId: user._id,
      event: "LOGIN_FAILED",
      success: false,
      reason: "Invalid credentials",
    });

    throw ApiError.unauthorized("Invalid company code, email or password");
  }

  user.failedLoginAttempts = 0;

  user.lockedUntil = null;

  user.lastLogin = new Date();

  await user.save();

  const subscription = await refreshSubscriptionStatus(company.subscription);

  if (
    subscription?.status === "EXPIRED" &&
    (subscription.expirationBehavior || "READ_ONLY") === "FULL_ACCESS_BLOCKED"
  ) {
    throw ApiError.forbidden(
      "Your subscription has expired. Please renew to continue.",
    );
  }

  const userAgent = req.headers["user-agent"] || "";

  const device = parseDevice(userAgent);

  const knownDevice = await SecuritySession.exists({
    user: user._id,

    companyId: company._id,

    "device.browser": device.browser,

    "device.operatingSystem": device.operatingSystem,

    revokedAt: null,
  });

  const securitySession = await createUserSession({
    user,
    req,
    res,
  });

  await recordSecurityEvent({
    req,
    companyId: company._id,
    userId: user._id,
    sessionId: securitySession.sessionId,
    event: "LOGIN_SUCCESS",
  });

  if (!knownDevice) {
    await recordSecurityEvent({
      req,
      companyId: company._id,
      userId: user._id,
      sessionId: securitySession.sessionId,
      event: "NEW_DEVICE_LOGIN",
      metadata: {
        device,
        ipAddress: getRequestIp(req),
      },
    });
  }

  await recordAudit({
    req,
    action: "LOGIN_SUCCESS",
    companyId: company._id,
    actorId: user._id,
    actorName: user.name,
    actorRole: user.role,
    resource: "SecuritySession",
    statusCode: 200,
    critical: true,
  });

  UsageMetric.updateOne(
    {
      companyId: company._id,

      date: new Date().toISOString().slice(0, 10),
    },
    {
      $inc: {
        loginCount: 1,
      },

      $addToSet: {
        activeUserIds: user._id,
      },
    },
    {
      upsert: true,
    },
  ).catch(() => {});

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Login successful",

    data: {
      user: publicUser(user),

      token: securitySession.accessToken,

      accessTokenExpiresIn: securitySession.accessTokenExpiresIn,

      company: {
        name: company.name,

        code: company.code,
      },

      subscription: subscriptionSummary(subscription),
    },
  });
});

// ============================================================
// GET /api/auth/me
// ============================================================

export const getMe = asyncHandler(async (req, res) => {
  let companyInfo = null;

  let subscriptionInfo = null;

  // Data from frontend - requests from frontend
  if (req.companyId) {
    const company = await Company.findById(req.companyId).populate(
      "subscription",
    );

    if (company) {
      companyInfo = {
        name: company.name,
        code: company.code,
        status: company.status,
      };

      subscriptionInfo = subscriptionSummary(company.subscription);
    }
  }

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Current user",

    data: {
      user: publicUser(req.user),

      company: companyInfo,

      subscription: subscriptionInfo,

      session: {
        sessionId: req.sessionId,

        lastActivityAt: req.securitySession?.lastActivityAt,
      },
    },
  });
});
