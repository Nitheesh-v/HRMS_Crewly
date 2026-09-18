import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import AdminSession from '../models/AdminSession.js';

export const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_ADMIN',
  'BILLING_ADMIN',
];

export const PLATFORM_PERMISSIONS = {
  SUPER_ADMIN: ['*'],

  PLATFORM_ADMIN: [
    'dashboard:read',
    'companies:read',
    'users:read',
    'usage:read',
    'health:read',
    'audit:read',
    'settings:manage',
    'revenue:read',
    // 28.8: can VIEW queue/worker/cache operations, but cannot
    // retry, remove, pause, run reconciliation, or invalidate
    // (those require operations:manage — SUPER_ADMIN only).
    'operations:read',
    // Phase 30.10 — internal BGV QA review + report release. QA is a
    // Crewly/Infolexus platform function (never a tenant User, never a
    // verifier principal). SUPER_ADMIN holds it via "*"; other platform
    // users gain it through this role or User.platformPermissions.
    'bgv-qa:review',
    'bgv-qa:release',
  ],

  SUPPORT_ADMIN: [
    'dashboard:read',
    'companies:read',
    'users:read',
    'support:manage',
  ],

  BILLING_ADMIN: [
    'dashboard:read',
    'companies:read',
    'subscriptions:manage',
    // Phase 30.2 — Crewly BGV catalogue & pricing is a commercial platform
    // operation: BILLING_ADMIN manages it; SUPER_ADMIN via '*'; tenants are
    // rejected at the platform gate before any of this is reachable.
    'bgv-catalog:read',
    'bgv-catalog:manage',
    'plans:manage',
    'billing:manage',
    'revenue:read',
  ],
};

// Runs after the existing protect middleware.
// It adds session revocation and platform permissions.
export const superAdminSession = async (
  req,
  res,
  next
) => {
  try {
    if (
      !PLATFORM_ROLES.includes(
        req.user?.role
      )
    ) {
      return res.status(403).json({
        statusCode: 403,
        success: false,
        message:
          'Platform administrator access required',
      });
    }

    const token =
      req.headers.authorization
        ?.split(' ')[1];

    const decoded = token
      ? jwt.verify(
          token,
          env.JWT_SECRET
        )
      : null;

    if (!decoded?.sessionId) {
      return res.status(401).json({
        statusCode: 401,
        success: false,
        message:
          'Super Admin session required',
      });
    }

    const session =
      await AdminSession.findOne({
        sessionId: decoded.sessionId,
        user: req.user._id,
        revokedAt: null,

        expiresAt: {
          $gt: new Date(),
        },
      });

    if (!session) {
      return res.status(401).json({
        statusCode: 401,
        success: false,
        message:
          'Session expired or revoked',
      });
    }

    session.lastSeenAt = new Date();
    await session.save();

    req.adminSession = session;

    req.platformPermissions =
      req.user.platformPermissions?.length
        ? req.user.platformPermissions
        : PLATFORM_PERMISSIONS[
            req.user.role
          ] || [];

    next();
  } catch {
    return res.status(401).json({
      statusCode: 401,
      success: false,
      message:
        'Invalid Super Admin session',
    });
  }
};

export const permit =
  (...permissions) =>
  (req, res, next) => {
    const owned =
      req.platformPermissions || [];

    if (
      owned.includes('*') ||
      permissions.some((permission) =>
        owned.includes(permission)
      )
    ) {
      return next();
    }

    return res.status(403).json({
      statusCode: 403,
      success: false,
      message:
        'Insufficient platform permission',
    });
  };

// Simple dependency-free login attempt protection.
// Phase 32.4 — platform login-attempt protection is SHARED: counters
// live in Redis (crewly:<env>:rl:super-admin-login:<ip:email-digest>)
// via the ONE rate-limit store, so API #1/#2/#N enforce a single
// budget. Degraded Redis → identical bounded in-process semantics.
// Contract preserved: 5 failures block the ip+email pair for a
// 15-minute window; successful login clears. No raw email in keys
// (§13 digest); the account-lockout product boundary is untouched —
// this remains the same attempt guard, now multi-instance honest.
import {
  createRateLimitStore,
} from '../utils/rateLimitStore.js';

import { hashToken } from '../utils/securityPolicy.js';

const LOGIN_FAILURE_MAXIMUM = 5;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const adminEmailFingerprint = (email) =>
  hashToken(String(email || '').trim().toLowerCase()).slice(0, 16);

export const createSuperAdminLoginGuard = ({ store = null } = {}) => {
  const sharedStore =
    store ||
    createRateLimitStore({
      sharedName: 'super-admin-login',

      windowMs: LOGIN_WINDOW_MS,
    });

  const guard = async (req, res, next) => {
    const key =
      `${req.ip}:` +
      `${adminEmailFingerprint(req.body?.email)}`;

    try {
      const failures = await sharedStore.peek(key);

      if ((failures || 0) >= LOGIN_FAILURE_MAXIMUM) {
        return res.status(429).json({
          statusCode: 429,
          success: false,
          message:
            'Too many login attempts. Try again later.',
        });
      }

      req.recordAdminLoginFailure = () => {
        void sharedStore
          .hit(key, LOGIN_FAILURE_MAXIMUM - 1)
          .catch(() => {});
      };

      req.clearAdminLoginAttempts = () => {
        void sharedStore.clear(key).catch(() => {});
      };
    } catch {
      // A broken counter must never take the login route down.
    }

    next();
  };

  return guard;
};

export const superAdminLoginGuard = createSuperAdminLoginGuard();