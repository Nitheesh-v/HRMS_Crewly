import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import CompanySecurityPolicy from '../models/CompanySecurityPolicy.js';

export const PLATFORM_MINIMUMS = {
  minimumLength: 10,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecialCharacter: true,
  historyCount: 5,
};

export const getSecurityPolicy = async (
  companyId
) => {
  if (!companyId) {
    return {
      password:
        PLATFORM_MINIMUMS,

      sessions: {
        accessTokenMinutes: 15,
        refreshTokenDays: 30,
        idleTimeoutMinutes: 480,
        maximumActiveSessions: 10,
      },

      lockout: {
        maximumAttempts: 5,
        lockMinutes: 15,
      },

      notifications: {
        newDeviceLogin: true,
        passwordChanged: true,
        accountLocked: true,
      },

      retention: {
        auditLogDays: 365,
        loginHistoryDays: 180,
      },
    };
  }

  return CompanySecurityPolicy.findOneAndUpdate(
    { companyId },
    {
      $setOnInsert: {
        companyId,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  ).lean();
};

export const validatePassword = (
  password,
  companyPolicy = {}
) => {
  const requested =
    companyPolicy.password || {};

  const policy = {
    minimumLength:
      Math.max(
        PLATFORM_MINIMUMS
          .minimumLength,

        Number(
          requested.minimumLength ||
            0
        )
      ),

    requireUppercase:
      PLATFORM_MINIMUMS
        .requireUppercase ||
      requested.requireUppercase,

    requireLowercase:
      PLATFORM_MINIMUMS
        .requireLowercase ||
      requested.requireLowercase,

    requireNumber:
      PLATFORM_MINIMUMS
        .requireNumber ||
      requested.requireNumber,

    requireSpecialCharacter:
      PLATFORM_MINIMUMS
        .requireSpecialCharacter ||
      requested
        .requireSpecialCharacter,

    historyCount:
      Math.max(
        PLATFORM_MINIMUMS
          .historyCount,

        Number(
          requested.historyCount ||
            0
        )
      ),
  };

  const errors = [];

  if (
    typeof password !== 'string' ||
    password.length <
      policy.minimumLength
  ) {
    errors.push(
      `Password must contain at least ${policy.minimumLength} characters`
    );
  }

  if (
    policy.requireUppercase &&
    !/[A-Z]/.test(password)
  ) {
    errors.push(
      'Password must contain an uppercase letter'
    );
  }

  if (
    policy.requireLowercase &&
    !/[a-z]/.test(password)
  ) {
    errors.push(
      'Password must contain a lowercase letter'
    );
  }

  if (
    policy.requireNumber &&
    !/[0-9]/.test(password)
  ) {
    errors.push(
      'Password must contain a number'
    );
  }

  if (
    policy
      .requireSpecialCharacter &&
    !/[^A-Za-z0-9]/.test(
      password
    )
  ) {
    errors.push(
      'Password must contain a special character'
    );
  }

  return {
    valid:
      errors.length === 0,

    errors,
    policy,
  };
};

export const passwordWasUsed = async (
  password,
  currentHash,
  history = []
) => {
  if (
    currentHash &&
    (await bcrypt.compare(
      password,
      currentHash
    ))
  ) {
    return true;
  }

  for (const entry of history) {
    if (
      entry.hash &&
      (await bcrypt.compare(
        password,
        entry.hash
      ))
    ) {
      return true;
    }
  }

  return false;
};

export const hashToken = (
  token
) =>
  crypto
    .createHash('sha256')
    .update(String(token))
    .digest('hex');

export const randomToken = (
  bytes = 48
) =>
  crypto
    .randomBytes(bytes)
    .toString('base64url');

export const getRequestIp = (
  req
) =>
  String(
    req.headers[
      'x-forwarded-for'
    ]?.split(',')[0] ||
      req.ip ||
      req.socket
        ?.remoteAddress ||
      ''
  ).trim();

export const parseDevice = (
  userAgent = ''
) => {
  const agent =
    String(userAgent);

  const browser =
    /Edg\//.test(agent)
      ? 'Edge'
      : /Chrome\//.test(
            agent
          )
        ? 'Chrome'
        : /Firefox\//.test(
              agent
            )
          ? 'Firefox'
          : /Safari\//.test(
                agent
              )
            ? 'Safari'
            : 'Unknown';

  const operatingSystem =
    /Windows/.test(agent)
      ? 'Windows'
      : /Android/.test(
            agent
          )
        ? 'Android'
        : /iPhone|iPad/.test(
              agent
            )
          ? 'iOS'
          : /Mac OS/.test(
                agent
              )
            ? 'macOS'
            : /Linux/.test(
                  agent
                )
              ? 'Linux'
              : 'Unknown';

  const deviceType =
    /Mobile|Android|iPhone/.test(
      agent
    )
      ? 'Mobile'
      : 'Desktop';

  return {
    browser,
    operatingSystem,
    deviceType,
  };
};