import crypto from "crypto";
import jwt from "jsonwebtoken";
import env from "../config/env.js";
import User from "../models/User.js";
import SecuritySession from "../models/SecuritySession.js";
import RefreshToken from "../models/RefreshToken.js";
import {
  getRequestIp,
  getSecurityPolicy,
  hashToken,
  parseDevice,
  randomToken,
} from "./securityPolicy.js";
import { recordAudit, recordSecurityEvent } from "./securityauditService.js";

const REFRESH_COOKIE = "crewly_refresh";

const cookieString = (value, options = {}) => {
  const parts = [
    `${REFRESH_COOKIE}=${value}`,
    "Path=/api/auth",
    "HttpOnly",
    `SameSite=${options.sameSite || "Lax"}`,
  ];

  if (options.maxAge) {
    parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
};

const readCookie = (req, name) => {
  const cookieHeader = req.headers.cookie || "";

  const cookies = Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");

        if (separator < 0) {
          return [part, ""];
        }

        return [
          part.slice(0, separator),

          decodeURIComponent(part.slice(separator + 1)),
        ];
      }),
  );

  return cookies[name] || "";
};

const createAccessToken = ({ user, sessionId, minutes }) =>
  jwt.sign(
    {
      sub: String(user._id),

      companyId: user.companyId ? String(user.companyId) : null,

      sessionId,

      tokenVersion: user.tokenVersion || 0,
    },
    env.JWT_SECRET,
    {
      expiresIn: `${minutes}m`,
    },
  );

const revokeTokenFamily = async ({ tokenFamily, userId, reason }) => {
  const now = new Date();

  await Promise.all([
    RefreshToken.updateMany(
      {
        tokenFamily,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: now,
        },
      },
    ),

    SecuritySession.updateMany(
      {
        tokenFamily,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: now,
          revokeReason: reason,
        },
      },
    ),

    User.updateOne(
      {
        _id: userId,
      },
      {
        $inc: {
          tokenVersion: 1,
        },
      },
    ),
  ]);
};

export const setRefreshCookie = (res, refreshToken, maxAge) => {
  res.setHeader(
    "Set-Cookie",
    cookieString(encodeURIComponent(refreshToken), {
      maxAge,

      secure: env.NODE_ENV === "production",

      sameSite: env.NODE_ENV === "production" ? "None" : "Lax",
    }),
  );
};

export const clearRefreshCookie = (res) => {
  res.setHeader(
    "Set-Cookie",
    cookieString("", {
      maxAge: 0,

      secure: env.NODE_ENV === "production",

      sameSite: env.NODE_ENV === "production" ? "None" : "Lax",
    }),
  );
};

export const getRefreshToken = (req) => readCookie(req, REFRESH_COOKIE);

export const createUserSession = async ({ user, req, res }) => {
  const policy = await getSecurityPolicy(user.companyId);

  const accessMinutes = policy.sessions.accessTokenMinutes;

  const refreshDays = policy.sessions.refreshTokenDays;

  const sessionId = crypto.randomUUID();

  const tokenFamily = crypto.randomUUID();

  const rawRefreshToken = randomToken(64);

  const refreshHash = hashToken(rawRefreshToken);

  const expiresAt = new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000);

  const ipAddress = getRequestIp(req);

  const userAgent = req.headers["user-agent"] || "";

  const session = await SecuritySession.create({
    user: user._id,
    companyId: user.companyId,
    sessionId,
    tokenFamily,
    ipAddress,
    userAgent,
    device: parseDevice(userAgent),
    expiresAt,
  });

  await RefreshToken.create({
    user: user._id,
    companyId: user.companyId,
    session: session._id,
    sessionId,
    tokenFamily,
    tokenHash: refreshHash,
    expiresAt,
    ipAddress,
    userAgent,
  });

  const accessToken = createAccessToken({
    user,
    sessionId,
    minutes: accessMinutes,
  });

  setRefreshCookie(res, rawRefreshToken, refreshDays * 24 * 60 * 60 * 1000);

  return {
    accessToken,
    sessionId,
    expiresAt,
    accessTokenExpiresIn: accessMinutes * 60,
  };
};

export const rotateRefreshToken = async ({ req, res }) => {
  const rawToken = getRefreshToken(req);

  if (!rawToken) {
    const error = new Error("Refresh token missing");

    error.statusCode = 401;
    throw error;
  }

  const tokenHash = hashToken(rawToken);

  const token = await RefreshToken.findOne({
    tokenHash,
  });

  if (!token) {
    const error = new Error("Invalid refresh token");

    error.statusCode = 401;
    throw error;
  }

  // Used/revoked token means possible token theft.
  if (token.usedAt || token.revokedAt) {
    token.reuseDetectedAt = new Date();

    await token.save();

    await revokeTokenFamily({
      tokenFamily: token.tokenFamily,

      userId: token.user,

      reason: "Refresh token reuse detected",
    });

    await recordSecurityEvent({
      req,
      companyId: token.companyId,
      userId: token.user,
      sessionId: token.sessionId,

      event: "REFRESH_TOKEN_REUSE_DETECTED",

      success: false,

      reason: "A previously used refresh token was presented.",
    });

    await recordAudit({
      req,
      companyId: token.companyId,
      actorId: token.user,
      action: "REFRESH_TOKEN_REUSE_DETECTED",
      resource: "SecuritySession",
      resourceId: token.session,
      statusCode: 401,
      critical: true,
    });

    clearRefreshCookie(res);

    const error = new Error("Session revoked for security reasons");

    error.statusCode = 401;
    throw error;
  }

  if (new Date(token.expiresAt).getTime() <= Date.now()) {
    const error = new Error("Refresh token expired");

    error.statusCode = 401;
    throw error;
  }

  const [user, session] = await Promise.all([
    User.findOne({
      _id: token.user,
      companyId: token.companyId,
      status: "ACTIVE",
    }),

    SecuritySession.findOne({
      _id: token.session,
      revokedAt: null,
      expiresAt: {
        $gt: new Date(),
      },
    }),
  ]);

  if (!user || !session) {
    clearRefreshCookie(res);

    const error = new Error("Session expired or revoked");

    error.statusCode = 401;
    throw error;
  }

  const policy = await getSecurityPolicy(user.companyId);

  const newRawToken = randomToken(64);

  const newHash = hashToken(newRawToken);

  const newExpiresAt = new Date(
    Date.now() + policy.sessions.refreshTokenDays * 24 * 60 * 60 * 1000,
  );

  // Atomic use prevents two requests rotating one token.
  const used = await RefreshToken.updateOne(
    {
      _id: token._id,
      usedAt: null,
      revokedAt: null,
    },
    {
      $set: {
        usedAt: new Date(),

        rotatedToHash: newHash,
      },
    },
  );

  if (used.modifiedCount !== 1) {
    await revokeTokenFamily({
      tokenFamily: token.tokenFamily,
      userId: token.user,
      reason: "Concurrent refresh token reuse",
    });

    clearRefreshCookie(res);

    const error = new Error("Session revoked for security reasons");

    error.statusCode = 401;
    throw error;
  }

  await RefreshToken.create({
    user: user._id,
    companyId: user.companyId,
    session: session._id,
    sessionId: session.sessionId,
    tokenFamily: token.tokenFamily,
    tokenHash: newHash,
    expiresAt: newExpiresAt,
    ipAddress: getRequestIp(req),
    userAgent: req.headers["user-agent"] || "",
  });

  session.lastActivityAt = new Date();

  session.expiresAt = newExpiresAt;

  await session.save();

  const accessToken = createAccessToken({
    user,
    sessionId: session.sessionId,
    minutes: policy.sessions.accessTokenMinutes,
  });

  setRefreshCookie(
    res,
    newRawToken,
    policy.sessions.refreshTokenDays * 24 * 60 * 60 * 1000,
  );

  await recordSecurityEvent({
    req,
    companyId: user.companyId,
    userId: user._id,
    sessionId: session.sessionId,
    event: "REFRESH_TOKEN_ROTATED",
  });

  return {
    accessToken,
    accessTokenExpiresIn: policy.sessions.accessTokenMinutes * 60,
  };
};

export const revokeCurrentSession = async ({ req, res, user, sessionId }) => {
  const now = new Date();

  const session = await SecuritySession.findOne({
    user: user._id,
    companyId: user.companyId,
    sessionId,
  });

  if (session) {
    session.revokedAt = now;

    session.revokedBy = user._id;

    session.revokeReason = "User logout";

    await session.save();

    await RefreshToken.updateMany(
      {
        session: session._id,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: now,
        },
      },
    );
  }

  clearRefreshCookie(res);

  await recordSecurityEvent({
    req,
    companyId: user.companyId,
    userId: user._id,
    sessionId,
    event: "LOGOUT",
  });
};

export const revokeAllUserSessions = async ({
  req,
  res,
  user,
  reason = "User requested logout from all devices",
}) => {
  const now = new Date();

  await Promise.all([
    SecuritySession.updateMany(
      {
        user: user._id,
        companyId: user.companyId,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: now,
          revokedBy: user._id,
          revokeReason: reason,
        },
      },
    ),

    RefreshToken.updateMany(
      {
        user: user._id,
        companyId: user.companyId,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: now,
        },
      },
    ),

    User.updateOne(
      {
        _id: user._id,
      },
      {
        $inc: {
          tokenVersion: 1,
        },
      },
    ),
  ]);

  clearRefreshCookie(res);

  await recordSecurityEvent({
    req,
    companyId: user.companyId,
    userId: user._id,
    event: "ALL_SESSIONS_REVOKED",
  });
};
