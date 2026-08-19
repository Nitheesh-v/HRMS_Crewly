import mongoose from 'mongoose';

const companySecurityPolicySchema =
  new mongoose.Schema(
    {
      companyId: {
        type:
          mongoose.Schema.Types
            .ObjectId,
        ref: 'Company',
        required: true,
        unique: true,
        index: true,
      },

      password: {
        minimumLength: {
          type: Number,
          default: 10,
          min: 10,
          max: 128,
        },

        requireUppercase: {
          type: Boolean,
          default: true,
        },

        requireLowercase: {
          type: Boolean,
          default: true,
        },

        requireNumber: {
          type: Boolean,
          default: true,
        },

        requireSpecialCharacter: {
          type: Boolean,
          default: true,
        },

        historyCount: {
          type: Number,
          default: 5,
          min: 0,
          max: 10,
        },
      },

      sessions: {
        accessTokenMinutes: {
          type: Number,
          default: 15,
          min: 5,
          max: 60,
        },

        refreshTokenDays: {
          type: Number,
          default: 30,
          min: 1,
          max: 90,
        },

        idleTimeoutMinutes: {
          type: Number,
          default: 480,
          min: 15,
          max: 10080,
        },

        maximumActiveSessions: {
          type: Number,
          default: 10,
          min: 1,
          max: 50,
        },
      },

      lockout: {
        maximumAttempts: {
          type: Number,
          default: 5,
          min: 3,
          max: 20,
        },

        lockMinutes: {
          type: Number,
          default: 15,
          min: 5,
          max: 1440,
        },
      },

      mfa: {
        requiredForCompanyAdmin: {
          type: Boolean,
          default: false,
        },

        requiredForHrManager: {
          type: Boolean,
          default: false,
        },
      },

      notifications: {
        newDeviceLogin: {
          type: Boolean,
          default: true,
        },

        passwordChanged: {
          type: Boolean,
          default: true,
        },

        accountLocked: {
          type: Boolean,
          default: true,
        },
      },

      retention: {
        auditLogDays: {
          type: Number,
          default: 365,
          min: 90,
          max: 3650,
        },

        loginHistoryDays: {
          type: Number,
          default: 180,
          min: 30,
          max: 3650,
        },
      },

      updatedBy: {
        type:
          mongoose.Schema.Types
            .ObjectId,
        ref: 'User',
        default: null,
      },
    },
    { timestamps: true }
  );

export default mongoose.model(
  'CompanySecurityPolicy',
  companySecurityPolicySchema
);

export {
  companySecurityPolicySchema,
};