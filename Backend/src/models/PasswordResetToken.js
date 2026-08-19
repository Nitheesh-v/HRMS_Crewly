import mongoose from 'mongoose';

const passwordResetTokenSchema =
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

      requestedIp: {
        type: String,
        default: '',
      },
    },
    { timestamps: true }
  );

passwordResetTokenSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

export default mongoose.model(
  'PasswordResetToken',
  passwordResetTokenSchema
);