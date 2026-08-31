import crypto from "crypto";
import jwt from "jsonwebtoken";
import env from "../config/env.js";
import User from "../models/User.js";
import AdminSession from "../models/AdminSession.js";
import PlatformToken from "../models/PlatformToken.js";
import PlatformSettings from "../models/PlatformSettings.js";
import AuditLog from "../models/AuditLog.js";
import { sendMail } from "../utils/mailer.js";
import { PLATFORM_ROLES } from "../middlewares/superAdminAuth.js";

const ok = (res, status, data, message) =>
  res.status(status).json({
    statusCode: status,
    success: true,
    data,
    message,
  });

const fail = (res, status, message) =>
  res.status(status).json({
    statusCode: status,
    success: false,
    message,
  });

const hash = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const publicAdmin = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  permissions: user.platformPermissions || [],
  twoFactorEnabled: !!user.twoFactorEnabled,
});

const audit = async (req, action, metadata = {}) => {
  try {
    await AuditLog.create({
      companyId: null,

      actor: req.user?._id || null,

      actorName: req.user?.name || "",

      actorRole: req.user?.role || "SUPER_ADMIN",

      action,
      method: req.method,
      path: req.originalUrl.split("?")[0],

      statusCode: 200,
      ip: req.ip || "",
      metadata,
    });
  } catch {
    // Audit failure must not block authentication.
  }
};

const createSession = async (user, req) => {
  const settings = await PlatformSettings.findOne({
    key: "GLOBAL",
  }).lean();

  const sessionHours = settings?.security?.superAdminSessionHours || 8;

  const sessionId = crypto.randomUUID();

  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000);

  await AdminSession.create({
    user: user._id,
    sessionId,
    expiresAt,
    ip: req.ip || "",
    userAgent: req.headers["user-agent"] || "",
  });

  const token = jwt.sign(
    {
      id: user._id,
      role: user.role,
      companyId: null,
      sessionId,
    },
    env.JWT_SECRET,
    {
      expiresIn: `${sessionHours}h`,
    },
  );

  return {
    token,
    expiresAt,
  };
};

// ============================================================
// POST /api/super-admin/auth/login
// ============================================================

export const login = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const { email = "", password = "" } = req.body;

    // DB Logic - DB logics
    const user = await User.findOne({
      email: email.toLowerCase().trim(),

      companyId: null,

      role: {
        $in: PLATFORM_ROLES,
      },
    }).select("+password");

    const validPassword = user ? await user.comparePassword(password) : false;

    if (!user || !validPassword) {
      req.recordAdminLoginFailure?.();

      return fail(res, 401, "Invalid Super Admin email or password");
    }

    if (user.status !== "ACTIVE") {
      return fail(res, 403, "Platform administrator account is inactive");
    }

    req.clearAdminLoginAttempts?.();

    // Email OTP is used when 2FA is enabled.
    if (user.twoFactorEnabled) {
      const code = String(crypto.randomInt(100000, 999999));

      const challenge = await PlatformToken.create({
        user: user._id,
        type: "TWO_FACTOR",
        tokenHash: hash(code),

        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      await sendMail({
        to: user.email,
        subject: "Crewly Super Admin verification code",

        text:
          `Your verification code is ${code}. ` + `It expires in 10 minutes.`,
      });

      return ok(
        res,
        200,
        {
          requiresTwoFactor: true,
          challengeId: challenge._id,
        },
        "Verification code sent",
      );
    }

    const session = await createSession(user, req);

    user.lastLogin = new Date();
    await user.save();

    req.user = user;

    await audit(req, "SUPER_ADMIN_LOGIN", {
      sessionExpiresAt: session.expiresAt,
    });

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        user: publicAdmin(user),

        ...session,
      },
      "Super Admin login successful",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// POST /api/super-admin/auth/verify-2fa
// ============================================================

export const verifyTwoFactor = async (req, res) => {
  try {
    // DB Logic - DB logics
    const challenge = await PlatformToken.findOne({
      _id: req.body.challengeId,

      type: "TWO_FACTOR",

      usedAt: null,

      expiresAt: {
        $gt: new Date(),
      },
    });

    if (!challenge) {
      return fail(res, 400, "Verification challenge expired");
    }

    challenge.attempts += 1;

    // Data from frontend - requests from frontend
    if (challenge.attempts > 5 || challenge.tokenHash !== hash(req.body.code)) {
      await challenge.save();

      return fail(res, 401, "Invalid verification code");
    }

    challenge.usedAt = new Date();

    await challenge.save();

    const user = await User.findById(challenge.user);

    if (!user || !PLATFORM_ROLES.includes(user.role)) {
      return fail(res, 403, "Platform administrator not found");
    }

    const session = await createSession(user, req);

    user.lastLogin = new Date();
    await user.save();

    req.user = user;

    await audit(req, "SUPER_ADMIN_2FA_LOGIN");

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        user: publicAdmin(user),

        ...session,
      },
      "Verification successful",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// POST /api/super-admin/auth/forgot-password
// ============================================================

export const forgotPassword = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const email = String(req.body.email || "")
      .toLowerCase()
      .trim();

    // DB Logic - DB logics
    const user = await User.findOne({
      email,
      companyId: null,

      role: {
        $in: PLATFORM_ROLES,
      },
    });

    // Always return the same response so attackers
    // cannot discover valid platform admin emails.
    if (user) {
      const rawToken = crypto.randomBytes(32).toString("hex");

      await PlatformToken.deleteMany({
        user: user._id,
        type: "PASSWORD_RESET",
        usedAt: null,
      });

      await PlatformToken.create({
        user: user._id,
        type: "PASSWORD_RESET",
        tokenHash: hash(rawToken),

        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      const resetUrl =
        `${env.CLIENT_URL}` +
        `/super-admin/reset-password` +
        `?token=${rawToken}`;

      await sendMail({
        to: user.email,
        subject: "Reset your Crewly Super Admin password",

        text:
          `Reset your password: ${resetUrl}\n` +
          `This link expires in 30 minutes.`,
      });
    }

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {},
      "If the account exists, a reset link has been sent",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// POST /api/super-admin/auth/reset-password
// ============================================================

export const resetPassword = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const { token, password } = req.body;

    if (!password || password.length < 10) {
      return fail(res, 400, "Password must contain at least 10 characters");
    }

    // DB Logic - DB logics
    const reset = await PlatformToken.findOne({
      tokenHash: hash(token),

      type: "PASSWORD_RESET",

      usedAt: null,

      expiresAt: {
        $gt: new Date(),
      },
    });

    if (!reset) {
      return fail(res, 400, "Reset link is invalid or expired");
    }

    const user = await User.findById(reset.user).select("+password");

    if (!user) {
      return fail(res, 404, "Platform administrator not found");
    }

    // Existing User pre-save middleware hashes it.
    user.password = password;
    await user.save();

    reset.usedAt = new Date();
    await reset.save();

    // Revoke every existing session after reset.
    await AdminSession.updateMany(
      {
        user: user._id,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: new Date(),
        },
      },
    );

    // Data to frontend - response to frontend
    return ok(res, 200, {}, "Password reset successful. Please sign in.");
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PATCH /api/super-admin/auth/change-password
// ============================================================

export const changePassword = async (req, res) => {
  try {
    // DB Logic - DB logics
    const user = await User.findById(req.user._id).select("+password");

    const currentPasswordValid = await user.comparePassword(
      // Data from frontend - requests from frontend
      req.body.currentPassword,
    );

    if (!currentPasswordValid) {
      return fail(res, 400, "Current password is incorrect");
    }

    if (!req.body.newPassword || req.body.newPassword.length < 10) {
      return fail(res, 400, "New password must contain at least 10 characters");
    }

    user.password = req.body.newPassword;

    await user.save();

    // Keep the current session and revoke all others.
    await AdminSession.updateMany(
      {
        user: user._id,

        sessionId: {
          $ne: req.adminSession.sessionId,
        },

        revokedAt: null,
      },
      {
        $set: {
          revokedAt: new Date(),
          revokedBy: user._id,
        },
      },
    );

    await audit(req, "SUPER_ADMIN_PASSWORD_CHANGED");

    // Data to frontend - response to frontend
    return ok(res, 200, {}, "Password changed");
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PATCH /api/super-admin/auth/2fa
// ============================================================

export const setTwoFactor = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    req.user.twoFactorEnabled = req.body.enabled === true;

    // DB Logic - DB logics
    await req.user.save();

    await audit(
      req,
      req.user.twoFactorEnabled
        ? "SUPER_ADMIN_2FA_ENABLED"
        : "SUPER_ADMIN_2FA_DISABLED",
    );

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        enabled: req.user.twoFactorEnabled,
      },
      "Two-factor setting updated",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// GET /api/super-admin/auth/sessions
// ============================================================

export const sessions = async (req, res) => {
  try {
    // DB Logic - DB logics
    const rows = await AdminSession.find({
      user: req.user._id,

      expiresAt: {
        $gt: new Date(),
      },
    })
      .sort("-lastSeenAt")
      .lean();

    const data = rows.map((row) => ({
      ...row,

      current: row.sessionId === req.adminSession.sessionId,
    }));

    // Data to frontend - response to frontend
    return ok(res, 200, data, "Active sessions");
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// POST /api/super-admin/auth/logout-others
// ============================================================

export const logoutOthers = async (req, res) => {
  try {
    // DB Logic - DB logics
    await AdminSession.updateMany(
      {
        user: req.user._id,

        sessionId: {
          $ne: req.adminSession.sessionId,
        },

        revokedAt: null,
      },
      {
        $set: {
          revokedAt: new Date(),
          revokedBy: req.user._id,
        },
      },
    );

    await audit(req, "SUPER_ADMIN_OTHER_SESSIONS_REVOKED");

    // Data to frontend - response to frontend
    return ok(res, 200, {}, "Other sessions logged out");
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// POST /api/super-admin/auth/logout
// ============================================================

export const logout = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    req.adminSession.revokedAt = new Date();

    req.adminSession.revokedBy = req.user._id;

    // DB Logic - DB logics
    await req.adminSession.save();

    await audit(req, "SUPER_ADMIN_LOGOUT");

    // Data to frontend - response to frontend
    return ok(res, 200, {}, "Logged out");
  } catch (error) {
    return fail(res, 500, error.message);
  }
};
