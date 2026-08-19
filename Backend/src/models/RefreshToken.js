import mongoose from 'mongoose';

const refreshTokenSchema =
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

      session: {
        type:
          mongoose.Schema.Types
            .ObjectId,
        ref: 'SecuritySession',
        required: true,
        index: true,
      },

      sessionId: {
        type: String,
        required: true,
        index: true,
      },

      tokenFamily: {
        type: String,
        required: true,
        index: true,
      },

      tokenHash: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },

      expiresAt: {
        type: Date,
        required: true,
      },

      usedAt: {
        type: Date,
        default: null,
      },

      revokedAt: {
        type: Date,
        default: null,
        index: true,
      },

      rotatedToHash: {
        type: String,
        default: '',
      },

      reuseDetectedAt: {
        type: Date,
        default: null,
      },

      ipAddress: {
        type: String,
        default: '',
      },

      userAgent: {
        type: String,
        default: '',
      },
    },
    { timestamps: true }
  );

refreshTokenSchema.index({
  user: 1,
  tokenFamily: 1,
  revokedAt: 1,
});

refreshTokenSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

export default mongoose.model(
  'RefreshToken',
  refreshTokenSchema
);

export {
  refreshTokenSchema,
};