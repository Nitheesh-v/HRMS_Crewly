import mongoose from 'mongoose';

export const SYSTEM_EVENT_LEVELS = [
  'INFO',
  'WARNING',
  'CRITICAL',
];

export const SYSTEM_EVENT_TYPES = [
  'COMPANY_REGISTERED',
  'SUBSCRIPTION_CREATED',
  'SUBSCRIPTION_EXPIRING',
  'SUBSCRIPTION_EXPIRED',
  'PAYMENT_FAILED',
  'SYSTEM_ERROR',
  'CRITICAL_TICKET',
  'HIGH_USAGE',
  'STORAGE_LIMIT',
  'SECURITY',
];

const systemEventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: SYSTEM_EVENT_TYPES,
      required: true,
      index: true,
    },

    level: {
      type: String,
      enum: SYSTEM_EVENT_LEVELS,
      default: 'INFO',
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    message: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },

    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
      index: true,
    },

    targetType: {
      type: String,
      default: '',
    },

    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    resolvedAt: {
      type: Date,
      default: null,
    },

    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  { timestamps: true }
);

systemEventSchema.index({
  createdAt: -1,
  level: 1,
});

export default mongoose.model(
  'SystemEvent',
  systemEventSchema
);

export { systemEventSchema };