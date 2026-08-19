import mongoose from 'mongoose';

export const SUBSCRIPTION_EVENTS = [
  'TRIAL_STARTED',
  'TRIAL_ENDED',
  'SUBSCRIPTION_CREATED',
  'SUBSCRIPTION_RENEWED',
  'SUBSCRIPTION_UPGRADED',
  'SUBSCRIPTION_DOWNGRADED',
  'SUBSCRIPTION_EXPIRING',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_PAST_DUE',
  'SUBSCRIPTION_SUSPENDED',
  'SUBSCRIPTION_CANCELLED',
  'SUBSCRIPTION_RESTORED',
  'PAYMENT_STARTED',
  'PAYMENT_SUCCESS',
  'PAYMENT_FAILED',
  'REMINDER_SENT',
  'FEATURE_RESTRICTED',
  'LIMIT_REACHED',
  'PLAN_UPDATED',
];

const subscriptionHistorySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      required: true,
      index: true,
    },

    event: {
      type: String,
      enum: SUBSCRIPTION_EVENTS,
      required: true,
      index: true,
    },

    oldPlan: {
      type: String,
      default: '',
    },

    newPlan: {
      type: String,
      default: '',
    },

    oldStatus: {
      type: String,
      default: '',
    },

    newStatus: {
      type: String,
      default: '',
    },

    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    reason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },

    paymentReference: {
      type: String,
      default: '',
    },

    requestId: {
      type: String,
      default: '',
    },

    ip: {
      type: String,
      default: '',
    },

    previousState: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    newState: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Used to prevent duplicate reminders.
    // Example: subscriptionId:EXPIRY:7:2026-08-31
    eventKey: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

subscriptionHistorySchema.index({
  companyId: 1,
  createdAt: -1,
});

subscriptionHistorySchema.index({
  subscription: 1,
  createdAt: -1,
});

subscriptionHistorySchema.index(
  {
    eventKey: 1,
  },
  {
    unique: true,
    sparse: true,
  }
);

// Subscription history is immutable.
// No update/delete API will be created for this model.

export default mongoose.model(
  'SubscriptionHistory',
  subscriptionHistorySchema
);

export { subscriptionHistorySchema };