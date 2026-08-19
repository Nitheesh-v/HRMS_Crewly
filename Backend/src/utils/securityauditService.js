import AuditLog from '../models/AuditLog.js';
import SecurityEvent from '../models/SecurityEvent.js';
import {
  getRequestIp,
  getSecurityPolicy,
  parseDevice,
} from './securityPolicy.js';

const SENSITIVE_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  'apiSecret',
  'cardNumber',
  'cvv',
  'razorpay_signature',
];

const isSensitiveKey = (key) => {
  const normalized =
    String(key).toLowerCase();

  return SENSITIVE_KEYS.some(
    (sensitiveKey) =>
      normalized.includes(
        sensitiveKey.toLowerCase()
      )
  );
};

export const sanitizeAuditValue = (
  value,
  depth = 0
) => {
  if (
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (depth > 5) {
    return '[MAX_DEPTH]';
  }

  if (
    typeof value === 'string'
  ) {
    return value.length > 2000
      ? `${value.slice(0, 2000)}…`
      : value;
  }

  if (
    typeof value !== 'object'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) =>
        sanitizeAuditValue(
          item,
          depth + 1
        )
      );
  }

  const sanitized = {};

  Object.entries(value).forEach(
    ([key, item]) => {
      sanitized[key] =
        isSensitiveKey(key)
          ? '[REDACTED]'
          : sanitizeAuditValue(
              item,
              depth + 1
            );
    }
  );

  return sanitized;
};

export const recordSecurityEvent = async ({
  req = null,
  companyId = null,
  userId = null,
  sessionId = '',
  event,
  success = true,
  reason = '',
  metadata = {},
}) => {
  try {
    const policy =
      await getSecurityPolicy(
        companyId
      );

    const retentionDays =
      policy?.retention
        ?.loginHistoryDays ||
      180;

    const userAgent =
      req?.headers?.[
        'user-agent'
      ] || '';

    return await SecurityEvent.create({
      companyId,
      user: userId,
      sessionId,
      event,
      success,
      reason:
        String(reason || '')
          .slice(0, 500),

      ipAddress:
        req
          ? getRequestIp(req)
          : '',

      userAgent,
      device:
        parseDevice(userAgent),

      metadata:
        sanitizeAuditValue(
          metadata
        ),

      expiresAt: new Date(
        Date.now() +
          retentionDays *
            24 *
            60 *
            60 *
            1000
      ),
    });
  } catch (error) {
    console.warn(
      '[security-event]',
      error.message
    );

    return null;
  }
};

export const recordAudit = async ({
  req,
  action,
  companyId = null,
  actorId = null,
  actorName = '',
  actorRole = '',
  resource = '',
  resourceId = null,
  targetUserId = null,
  previousValue = null,
  newValue = null,
  statusCode = 200,
  metadata = {},
  critical = false,
}) => {
  const payload = {
    companyId,
    actor:
      actorId ||
      req?.user?._id ||
      null,

    actorName:
      actorName ||
      req?.user?.name ||
      '',

    actorRole:
      actorRole ||
      req?.user?.role ||
      '',

    action,
    method:
      req?.method ||
      'SYSTEM',

    path:
      req?.originalUrl
        ?.split('?')[0] ||
      '/system',

    statusCode,

    ip:
      req
        ? getRequestIp(req)
        : '',

    userAgent:
      req?.headers?.[
        'user-agent'
      ] || '',

    requestId:
      req?.headers?.[
        'x-request-id'
      ] || '',

    targetType:
      resource,

    targetId:
      resourceId,

    targetUser:
      targetUserId,

    previousValue:
      sanitizeAuditValue(
        previousValue
      ),

    newValue:
      sanitizeAuditValue(
        newValue
      ),

    metadata:
      sanitizeAuditValue(
        metadata
      ),
  };

  try {
    if (critical) {
      // Security-critical records complete before response.
      return await AuditLog.create(
        payload
      );
    }

    // Normal business audit is best effort.
    AuditLog.create(
      payload
    ).catch((error) => {
      console.warn(
        '[audit-log]',
        error.message
      );
    });

    return null;
  } catch (error) {
    console.warn(
      '[audit-log]',
      error.message
    );

    return null;
  }
};

export const changedFields = (
  previous = {},
  next = {},
  allowedFields = []
) => {
  const before = {};
  const after = {};

  allowedFields.forEach((field) => {
    const oldValue =
      previous?.[field];

    const newValue =
      next?.[field];

    if (
      JSON.stringify(oldValue) !==
      JSON.stringify(newValue)
    ) {
      before[field] =
        oldValue;

      after[field] =
        newValue;
    }
  });

  return {
    changed:
      Object.keys(after).length >
      0,

    previousValue: before,
    newValue: after,
  };
};