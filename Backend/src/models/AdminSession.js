import mongoose from 'mongoose';

const adminSessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    ip: {
      type: String,
      default: '',
    },

    userAgent: {
      type: String,
      default: '',
    },

    lastSeenAt: {
      type: Date,
      default: Date.now,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

    revokedAt: {
      type: Date,
      default: null,
    },

    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

adminSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

adminSessionSchema.index({
  user: 1,
  revokedAt: 1,
  expiresAt: 1,
});

export default mongoose.model(
  'AdminSession',
  adminSessionSchema
);

export { adminSessionSchema };