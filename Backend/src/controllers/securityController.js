import AuditLog from "../models/AuditLog.js";
import CompanySecurityPolicy from "../models/CompanySecurityPolicy.js";
import SecurityEvent from "../models/SecurityEvent.js";
import SecuritySession from "../models/SecuritySession.js";
import User from "../models/User.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { getSecurityPolicy } from "../utils/securityPolicy.js";
import { recordSecurityEvent } from "../utils/securityAuditService.js";

const DAY = 24 * 60 * 60 * 1000;

const escapeRegex = (value) =>
  String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .slice(0, 100);

/*
 * GET /api/security/dashboard
 * Company Admin and HR Manager only.
 */
export const securityDashboard = asyncHandler(async (req, res) => {
  const now = new Date();

  const dayAgo = new Date(Date.now() - DAY);

  const monthAgo = new Date(Date.now() - 30 * DAY);

  const weekAgo = new Date(Date.now() - 7 * DAY);

  const companyFilter = {
    companyId: req.companyId,
  };

  const [
    activeSessions,
    activeSessionUsers,
    failedLogins24h,
    criticalEvents30d,
    lockedAccounts,
    eventTypes,
    dailyEvents,
    recentEvents,
  ] = await Promise.all([
    SecuritySession.countDocuments({
      ...companyFilter,
      revokedAt: null,
      expiresAt: {
        $gt: now,
      },
    }),

    SecuritySession.distinct("user", {
      ...companyFilter,
      revokedAt: null,
      expiresAt: {
        $gt: now,
      },
    }),

    SecurityEvent.countDocuments({
      ...companyFilter,
      type: "LOGIN_FAILED",
      createdAt: {
        $gte: dayAgo,
      },
    }),

    SecurityEvent.countDocuments({
      ...companyFilter,
      severity: "CRITICAL",
      createdAt: {
        $gte: monthAgo,
      },
    }),

    User.countDocuments({
      ...companyFilter,
      lockedUntil: {
        $gt: now,
      },
    }),

    SecurityEvent.aggregate([
      {
        $match: {
          ...companyFilter,
          createdAt: {
            $gte: monthAgo,
          },
        },
      },

      {
        $group: {
          _id: "$type",
          count: {
            $sum: 1,
          },
        },
      },

      {
        $sort: {
          count: -1,
        },
      },

      {
        $limit: 8,
      },
    ]),

    SecurityEvent.aggregate([
      {
        $match: {
          ...companyFilter,
          createdAt: {
            $gte: weekAgo,
          },
        },
      },

      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
            },
          },

          total: {
            $sum: 1,
          },

          failed: {
            $sum: {
              $cond: ["$success", 0, 1],
            },
          },
        },
      },

      {
        $sort: {
          _id: 1,
        },
      },
    ]),

    SecurityEvent.find(companyFilter)
      .populate("user", "name email role")
      .sort("-createdAt")
      .limit(12)
      .lean(),
  ]);

  return ApiResponse.success(res, {
    message: "Security dashboard",

    data: {
      metrics: {
        activeSessions,

        activeUsers: activeSessionUsers.length,

        failedLogins24h,

        criticalEvents30d,

        lockedAccounts,
      },

      eventTypes,
      dailyEvents,
      recentEvents,
    },
  });
});

/*
 * GET /api/security/events
 *
 * Query:
 * page, limit, severity, type, search, from, to
 */
export const listSecurityEvents = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);

  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));

  const filter = {
    companyId: req.companyId,
  };

  if (["INFO", "WARNING", "CRITICAL"].includes(req.query.severity)) {
    filter.severity = req.query.severity;
  }

  if (req.query.type) {
    filter.type = String(req.query.type).slice(0, 100);
  }

  if (req.query.search) {
    const regex = new RegExp(escapeRegex(req.query.search), "i");

    filter.$or = [
      {
        message: regex,
      },
      {
        actorName: regex,
      },
      {
        type: regex,
      },
      {
        ip: regex,
      },
    ];
  }

  if (req.query.from || req.query.to) {
    filter.createdAt = {};

    const from = new Date(req.query.from || 0);

    const to = new Date(req.query.to || Date.now());

    if (!Number.isNaN(from.getTime())) {
      filter.createdAt.$gte = from;
    }

    if (!Number.isNaN(to.getTime())) {
      filter.createdAt.$lte = to;
    }
  }

  const [events, total] = await Promise.all([
    SecurityEvent.find(filter)
      .populate("user", "name email role")
      .sort("-createdAt")
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),

    SecurityEvent.countDocuments(filter),
  ]);

  return ApiResponse.success(res, {
    message: "Security events",

    data: events,

    meta: {
      page,

      pages: Math.max(1, Math.ceil(total / limit)),

      total,
      limit,
    },
  });
});

/*
 * GET /api/security/settings
 */
export const getSecuritySettings = asyncHandler(async (req, res) => {
  const policy = await getSecurityPolicy(req.companyId);

  return ApiResponse.success(res, {
    message: "Security settings",

    data: policy,
  });
});

const numberInRange = (value, minimum, maximum, label) => {
  const number = Number(value);

  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw ApiError.badRequest(
      `${label} must be between ${minimum} and ${maximum}`,
    );
  }

  return number;
};

const booleanValue = (value) => value === true;

/*
 * PATCH /api/security/settings
 * Company Admin only.
 */
export const updateSecuritySettings = asyncHandler(async (req, res) => {
  const input = req.body || {};

  const current = await getSecurityPolicy(req.companyId);

  const password = input.password || {};

  const lockout = input.lockout || {};

  const sessions = input.sessions || {};

  /*
   * Only explicitly supported fields are copied.
   * companyId is always taken from authentication.
   */
  const nextPolicy = {
    password: {
      minLength: numberInRange(
        password.minLength ?? current.password.minLength,
        8,
        64,
        "Minimum password length",
      ),

      requireUppercase:
        password.requireUppercase === undefined
          ? current.password.requireUppercase
          : booleanValue(password.requireUppercase),

      requireLowercase:
        password.requireLowercase === undefined
          ? current.password.requireLowercase
          : booleanValue(password.requireLowercase),

      requireNumber:
        password.requireNumber === undefined
          ? current.password.requireNumber
          : booleanValue(password.requireNumber),

      requireSpecial:
        password.requireSpecial === undefined
          ? current.password.requireSpecial
          : booleanValue(password.requireSpecial),

      historyCount: numberInRange(
        password.historyCount ?? current.password.historyCount,
        0,
        12,
        "Password history",
      ),

      maxAgeDays: numberInRange(
        password.maxAgeDays ?? current.password.maxAgeDays,
        0,
        365,
        "Password maximum age",
      ),
    },

    lockout: {
      maxAttempts: numberInRange(
        lockout.maxAttempts ?? current.lockout.maxAttempts,
        3,
        10,
        "Lockout attempts",
      ),

      durationMinutes: numberInRange(
        lockout.durationMinutes ?? current.lockout.durationMinutes,
        5,
        1440,
        "Lockout duration",
      ),
    },

    sessions: {
      lifetimeDays: numberInRange(
        sessions.lifetimeDays ?? current.sessions.lifetimeDays,
        1,
        90,
        "Session lifetime",
      ),

      idleTimeoutMinutes: numberInRange(
        sessions.idleTimeoutMinutes ?? current.sessions.idleTimeoutMinutes,
        15,
        129600,
        "Idle timeout",
      ),

      maxConcurrent: numberInRange(
        sessions.maxConcurrent ?? current.sessions.maxConcurrent,
        1,
        20,
        "Concurrent sessions",
      ),
    },

    auditRetentionDays: numberInRange(
      input.auditRetentionDays ?? current.auditRetentionDays,
      30,
      180,
      "Audit retention",
    ),

    notifyOnNewDevice:
      input.notifyOnNewDevice === undefined
        ? current.notifyOnNewDevice
        : booleanValue(input.notifyOnNewDevice),

    updatedBy: req.user._id,
  };

  const policy = await CompanySecurityPolicy.findOneAndUpdate(
    {
      companyId: req.companyId,
    },

    {
      $set: nextPolicy,
    },

    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  ).lean();

  /*
   * When retention is reduced, remove records that
   * are already older than the new limit.
   */
  if (nextPolicy.auditRetentionDays < current.auditRetentionDays) {
    const cutoff = new Date(Date.now() - nextPolicy.auditRetentionDays * DAY);

    await AuditLog.deleteMany({
      companyId: req.companyId,

      createdAt: {
        $lt: cutoff,
      },
    });
  }

  await recordSecurityEvent(req, {
    type: "SECURITY_POLICY_UPDATED",

    severity: "WARNING",

    message: "Company security policy updated",

    metadata: {
      auditRetentionDays: nextPolicy.auditRetentionDays,
    },
  });

  return ApiResponse.success(res, {
    message: "Security settings updated",

    data: policy,
  });
});
