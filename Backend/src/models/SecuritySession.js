import mongoose from 'mongoose';

const securitySessionSchema =
  new mongoose.Schema(
    {
      user: {
        type:
          mongoose.Schema.Types
            .ObjectId,
        ref: 'User',
        required: true,
        index: true,
      },

      companyId: {
        type:
          mongoose.Schema.Types
            .ObjectId,
        ref: 'Company',
        required: true,
        index: true,
      },

      sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },

      tokenFamily: {
        type: String,
        required: true,
        index: true,
      },

      ipAddress: {
        type: String,
        default: '',
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

      loginAt: {
        type: Date,
        default: Date.now,
      },

      lastActivityAt: {
        type: Date,
        default: Date.now,
        index: true,
      },

      expiresAt: {
        type: Date,
        required: true,
      },

      revokedAt: {
        type: Date,
        default: null,
        index: true,
      },

      revokedBy: {
        type:
          mongoose.Schema.Types
            .ObjectId,
        ref: 'User',
        default: null,
      },

      revokeReason: {
        type: String,
        default: '',
      },
    },
    { timestamps: true }
  );

securitySessionSchema.index({
  user: 1,
  companyId: 1,
  revokedAt: 1,
  expiresAt: 1,
});

securitySessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

export default mongoose.model(
  'SecuritySession',
  securitySessionSchema
);

export {
  securitySessionSchema,
};