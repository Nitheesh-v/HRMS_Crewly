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

// 33.14 — THE BROWSER SESSION LIVES IN COOKIES (access token included).
//
// The refresh token was already HttpOnly; the ACCESS token was not. It was
// returned in the login/refresh body and kept in localStorage, where any
// script on the page — a compromised dependency, an XSS anywhere in the SPA,
// a support-screen-share — could read it and post it to another host. Both
// browser tokens are now HttpOnly cookies, so JavaScript holds no credential
// at all. (Non-browser clients still get the token in the response body and
// may keep using `Authorization: Bearer`; that path is untouched.)
//
// WHY Path=/api AND NOT Path=/
//   · every REST route lives under /api, so the cookie rides exactly the
//     surface that needs it and nothing else;
//   · the chat socket handshake is /socket.io — this cookie is NOT sent
//     there by the browser, and the handshake never wants it: sockets
//     authenticate with a short-lived single-use ticket (33.1's "no cookies
//     on sockets" decision stays exactly as locked, plus the CSRF surface
//     a cookie-bearing handshake would create never exists).
const ACCESS_COOKIE = "crewly_access";

// The access cookie must ALSO reach /api/auth/* (logout, me, refresh), so
// its path is the /api subtree rather than the /api/auth one the refresh
// cookie uses (a refresh cookie has no business on the other 40 routers).
const ACCESS_COOKIE_PATH = "/api";

// 33.13 — HOW LONG A JUST-ROTATED TOKEN IS TREATED AS A RACE, NOT A THEFT.
//
// Rotation is single-use, and the refresh cookie is shared by every tab of the
// browser. Two tabs whose access token expires at the same moment both POST
// /auth/refresh with the SAME token: the first wins and rotates, the second
// presents a token that is one instant old. Treating that as token theft used
// to revoke the entire family AND bump User.tokenVersion — which signs the
// person out of every tab and every device, mid-work, for using two tabs.
// Inside this window the second presentation is answered with 409
// REFRESH_IN_PROGRESS: no tokens, no family revocation, no cookie cleared.
// Outside it, reuse is still theft and still nukes the family.

const cookieString = (value, options = {}) => {
  const parts = [
    `${options.name || REFRESH_COOKIE}=${value}`,
    `Path=${options.path || "/api/auth"}`,
    "HttpOnly",
    `SameSite=${options.sameSite || "Lax"}`,
  ];

  // 33.13 — `if (options.maxAge)` skipped the ONE value that matters most:
  // 0. clearRefreshCookie() therefore emptied the cookie without expiring it,
  // so it lingered as a session cookie instead of being deleted.
  if (options.maxAge !== undefined && options.maxAge !== null) {
    parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
};

/*
 * 33.14 — ONE RESPONSE, TWO COOKIES.
 *
 * login/register/refresh mint BOTH the refresh cookie and the access cookie
 * on the same response. `res.setHeader('Set-Cookie', …)` REPLACES whatever is
 * already there, so the second call would silently delete the first cookie —
 * an empty-looking bug (login "works", refresh 401s 15 minutes later). Every
 * cookie write therefore appends to whatever the response already carries.
 */
const appendCookie = (res, cookie) => {
  const existing = res.getHeader ? res.getHeader("Set-Cookie") : undefined;

  if (!existing) {
    res.setHeader("Set-Cookie", cookie);

    return;
  }

  const list = Array.isArray(existing) ? existing : [String(existing)];

  res.setHeader("Set-Cookie", [...list, cookie]);
};

/** Cookie attributes shared by both browser tokens (dev/prod split). */
const cookieOptions = (options = {}) => ({
  ...options,

  secure: env.NODE_ENV === "production",

  sameSite: env.NODE_ENV === "production" ? "None" : "Lax",
});

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

        const value = part.slice(separator + 1);

        // A malformed percent-escape in ANY cookie header must not turn every
        // protected request into a 500 (33.14: the access cookie is read on
        // every /api call now). Undecodable → raw, so signature verification
        // rejects it like any other junk token.
        try {
          return [part.slice(0, separator), decodeURIComponent(value)];
        } catch {
          return [part.slice(0, separator), value];
        }
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

export const REFRESH_RACE_GRACE_MS = 60 * 1000;

export const setRefreshCookie = (res, refreshToken, maxAge) => {
  appendCookie(
    res,
    cookieString(
      encodeURIComponent(refreshToken),
      cookieOptions({ maxAge }),
    ),
  );
};

export const clearRefreshCookie = (res) => {
  appendCookie(
    res,
    cookieString("", cookieOptions({ maxAge: 0 })),
  );
};

/*
 * 33.14 — the access token as an HttpOnly cookie.
 *
 * Same attributes as the refresh cookie (HttpOnly, SameSite=None+Secure in
 * production because customer deployments can serve the SPA from a different
 * site than the API, Lax+insecure in development), a broader path (/api, not
 * /api/auth) and a short Max-Age matching the token itself — when the cookie
 * dies, the browser simply has nothing to send and the client refreshes.
 */
export const setAccessCookie = (res, accessToken, maxAge) => {
  appendCookie(
    res,
    cookieString(
      encodeURIComponent(accessToken),
      cookieOptions({
        name: ACCESS_COOKIE,
        path: ACCESS_COOKIE_PATH,
        maxAge,
      }),
    ),
  );
};

export const clearAccessCookie = (res) => {
  appendCookie(
    res,
    cookieString("", cookieOptions({
      name: ACCESS_COOKIE,
      path: ACCESS_COOKIE_PATH,
      maxAge: 0,
    })),
  );
};

export const getRefreshToken = (req) => readCookie(req, REFRESH_COOKIE);

/** The customer access token from the cookie jar, if the browser sent one. */
export const getAccessToken = (req) => readCookie(req, ACCESS_COOKIE);

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

  // 33.14 — the browser gets its access token as a cookie too (the body copy
  // below stays for non-browser clients that cannot hold a cookie jar).
  setAccessCookie(res, accessToken, accessMinutes * 60 * 1000);

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

  // Used/revoked token means possible token theft — unless it is the benign
  // race described above.
  if (token.usedAt || token.revokedAt) {
    const usedAtMs = token.usedAt ? new Date(token.usedAt).getTime() : 0;

    const isBenignRace =
      !token.revokedAt &&
      usedAtMs > 0 &&
      Date.now() - usedAtMs <= REFRESH_RACE_GRACE_MS;

    if (isBenignRace) {
      // The winner of the race already set a fresh cookie on this browser: the
      // cookie is left ALONE (clearing it here would destroy the healthy
      // session the other tab just renewed).
      await recordSecurityEvent({
        req,
        companyId: token.companyId,
        userId: token.user,
        sessionId: token.sessionId,
        event: "REFRESH_TOKEN_CONCURRENT_REFRESH",
        success: true,
        reason: "A second client presented a refresh token this session had just rotated.",
      });

      const raceError = new Error("Refresh already in progress");

      raceError.statusCode = 409;
      raceError.code = "REFRESH_IN_PROGRESS";

      throw raceError;
    }

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

  // 33.14 — rotation replaces BOTH cookies, so the tab that wins the race
  // hands every other tab a usable access token as well.
  setAccessCookie(
    res,
    accessToken,
    policy.sessions.accessTokenMinutes * 60 * 1000,
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

  // 33.14 — logout deletes the access cookie too. Leaving it behind would
  // mean "logged out" in the UI while the browser still presents a live
  // token until it expires.
  clearAccessCookie(res);

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

  clearAccessCookie(res);

  await recordSecurityEvent({
    req,
    companyId: user.companyId,
    userId: user._id,
    event: "ALL_SESSIONS_REVOKED",
  });
};
