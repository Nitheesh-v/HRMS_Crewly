import mongoose from 'mongoose';

const platformTokenSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: [
        'PASSWORD_RESET',
        'TWO_FACTOR',
      ],
      required: true,
      index: true,
    },

    // Only a SHA-256 hash is stored.
    tokenHash: {
      type: String,
      required: true,
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

    attempts: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

platformTokenSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

export default mongoose.model(
  'PlatformToken',
  platformTokenSchema
);

export { platformTokenSchema };