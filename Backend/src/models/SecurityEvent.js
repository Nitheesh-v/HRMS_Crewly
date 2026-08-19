import mongoose from 'mongoose';

export const SECURITY_EVENT_TYPES = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'ALL_SESSIONS_REVOKED',
  'SESSION_REVOKED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET_COMPLETED',
  'ACCOUNT_LOCKED',
  'ACCOUNT_UNLOCKED',
  'REFRESH_TOKEN_ROTATED',
  'REFRESH_TOKEN_REUSE_DETECTED',
  'NEW_DEVICE_LOGIN',
  'MFA_ENABLED',
  'MFA_DISABLED',
  'SUSPICIOUS_ACTIVITY',
];

const securityEventSchema =
  new mongoose.Schema(
    {
      companyId: {
        type:
          mongoose.Schema.Types
            .ObjectId,
        ref: 'Company',
        default: null,
        index: true,
      },

      user: {
        type:
          mongoose.Schema.Types
            .ObjectId,
        ref: 'User',
        default: null,
        index: true,
      },

      sessionId: {
        type: String,
        default: '',
        index: true,
      },

      event: {
        type: String,
        enum:
          SECURITY_EVENT_TYPES,
        required: true,
        index: true,
      },

      success: {
        type: Boolean,
        default: true,
        index: true,
      },

      reason: {
        type: String,
        default: '',
        maxlength: 500,
      },

      ipAddress: {
        type: String,
        default: '',
        index: true,
      },

      userAgent: {
        type: String,
        default: '',
      },

      device: {
        browser: {
          type: String,
          default: 'Unknown',
        },

        operatingSystem: {
          type: String,
          default: 'Unknown',
        },

        deviceType: {
          type: String,
          default: 'Unknown',
        },
      },

      metadata: {
        type:
          mongoose.Schema.Types
            .Mixed,
        default: {},
      },

      createdAt: {
        type: Date,
        default: Date.now,
      },

      expiresAt: {
        type: Date,
        required: true,
      },
    },
    {
      versionKey: false,
    }
  );

securityEventSchema.index({
  companyId: 1,
  createdAt: -1,
});

securityEventSchema.index({
  user: 1,
  createdAt: -1,
});

securityEventSchema.index({
  event: 1,
  success: 1,
  createdAt: -1,
});

securityEventSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

export default mongoose.model(
  'SecurityEvent',
  securityEventSchema
);

export {
  securityEventSchema,
};