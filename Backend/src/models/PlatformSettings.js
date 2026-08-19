import mongoose from 'mongoose';

const platformSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'GLOBAL',
      unique: true,
    },

    platform: {
      name: {
        type: String,
        default: 'Crewly HRMS',
      },

      logoUrl: {
        type: String,
        default: '',
      },

      timezone: {
        type: String,
        default: 'Asia/Kolkata',
      },

      currency: {
        type: String,
        default: 'INR',
      },

      supportEmail: {
        type: String,
        default: '',
      },
    },

    subscription: {
      defaultTrialDays: {
        type: Number,
        default: 14,
        min: 0,
        max: 365,
      },

      gracePeriodDays: {
        type: Number,
        default: 7,
        min: 0,
        max: 90,
      },

      expirationBehavior: {
        type: String,
        enum: [
          'READ_ONLY',
          'FEATURE_RESTRICTED',
          'FULL_ACCESS_BLOCKED',
        ],
        default: 'READ_ONLY',
      },

      reminderDays: {
        type: [Number],
        default: [30, 15, 7, 3, 1],
      },
    },

    notifications: {
      emailEnabled: {
        type: Boolean,
        default: true,
      },

      inAppEnabled: {
        type: Boolean,
        default: true,
      },

      systemAlertsEnabled: {
        type: Boolean,
        default: true,
      },
    },

    security: {
      requireStrongPasswords: {
        type: Boolean,
        default: true,
      },

      superAdminSessionHours: {
        type: Number,
        default: 8,
        min: 1,
        max: 168,
      },

      maxLoginAttempts: {
        type: Number,
        default: 5,
        min: 3,
        max: 20,
      },
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model(
  'PlatformSettings',
  platformSettingsSchema
);

export { platformSettingsSchema };