import mongoose from 'mongoose';

const usageMetricSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    // One YYYY-MM-DD bucket per company per day.
    date: {
      type: String,
      required: true,
    },

    apiRequests: { type: Number, default: 0 },
    successfulRequests: { type: Number, default: 0 },
    failedRequests: { type: Number, default: 0 },
    fileUploads: { type: Number, default: 0 },
    loginCount: { type: Number, default: 0 },

    activeUserIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],

    moduleUsage: {
      type: Map,
      of: Number,
      default: {},
    },
  },
  { timestamps: true }
);

usageMetricSchema.index(
  { companyId: 1, date: 1 },
  { unique: true }
);

usageMetricSchema.index({ date: 1 });

export default mongoose.model(
  'UsageMetric',
  usageMetricSchema
);

export { usageMetricSchema };