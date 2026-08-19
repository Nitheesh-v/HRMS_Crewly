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
// For multi-server production deployment this can later
// move to Redis without changing the controller.
const attempts = new Map();

export const superAdminLoginGuard = (
  req,
  res,
  next
) => {
  const key =
    `${req.ip}:` +
    `${String(
      req.body?.email || ''
    ).toLowerCase()}`;

  const current =
    attempts.get(key) || {
      count: 0,
      blockedUntil: 0,
    };

  if (
    current.blockedUntil >
    Date.now()
  ) {
    return res.status(429).json({
      statusCode: 429,
      success: false,
      message:
        'Too many login attempts. Try again later.',
    });
  }

  req.recordAdminLoginFailure = () => {
    current.count += 1;

    if (current.count >= 5) {
      current.blockedUntil =
        Date.now() +
        15 * 60 * 1000;
    }

    attempts.set(key, current);
  };

  req.clearAdminLoginAttempts = () =>
    attempts.delete(key);

  next();
};