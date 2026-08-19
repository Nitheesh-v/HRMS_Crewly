// ─────────────────────────────────────────────────────────────
// Subscription — one per company. Plan limits are enforced by
// userController (employee count) and tenantMiddleware (expiry).
// Plans: TRIAL → BASIC / PRO / ENTERPRISE (upgraded via billing).
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
    plan: {
      type: String,
      enum: [
        'FREE',
        'TRIAL',
        'BASIC',
        'PRO',
        'ENTERPRISE',
      ],
      default: 'TRIAL',
    },

    // Optional reference to the reusable plan definition.
    planRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SubscriptionPlan',
      default: null,
    },

    status: {
      type: String,
      enum: [
        'TRIAL',
        'ACTIVE',
        'EXPIRING_SOON',
                'EXPIRING',
        'PAST_DUE',
        'GRACE_PERIOD',
        'EXPIRED',
        'SUSPENDED',
        'CANCELLED',
      ],
      default: 'TRIAL',
      index: true,
    },

    startDate: {
      type: Date,
      required: true,
    },

    endDate: {
      type: Date,
      required: true,
      index: true,
    },

    trialEndDate: {
      type: Date,
      default: null,
    },

    graceEndsAt: {
      type: Date,
      default: null,
    },

    renewalDate: {
      type: Date,
      default: null,
    },

    billingCycle: {
      type: String,
      enum: ['MONTHLY', 'YEARLY'],
      default: 'MONTHLY',
    },

    paymentStatus: {
      type: String,
      enum: [
        'NONE',
        'PENDING',
        'PAID',
        'FAILED',
        'REFUNDED',
      ],
      default: 'NONE',
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

    autoRenew: {
      type: Boolean,
      default: false,
    },

    pastDueAt: {
      type: Date,
      default: null,
    },

    pastDueEndsAt: {
      type: Date,
      default: null,
    },

    suspendedAt: {
      type: Date,
      default: null,
    },

    restoredAt: {
      type: Date,
      default: null,
    },

    cancellationReason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },

    readOnly: {
      type: Boolean,
      default: false,
    },

    previousPlan: {
      type: String,
      default: '',
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    limits: {
      employees: { type: Number, default: 10 },
      storageMB: { type: Number, default: 512 },
      administrators: { type: Number, default: 2 },
      departments: { type: Number, default: 5 },
      branches: { type: Number, default: 1 },
      apiRequestsMonthly: {
        type: Number,
        default: 10000,
      },
    },

    enabledModules: {
      type: [String],
      default: [],
    },

        // Snapshot prevents historical subscriptions changing when
    // a Super Admin later edits the plan definition.
    planSnapshot: {
      name: {
        type: String,
        default: '',
      },

      code: {
        type: String,
        default: '',
      },

      prices: {
        monthly: {
          type: Number,
          default: 0,
        },

        yearly: {
          type: Number,
          default: 0,
        },

        currency: {
          type: String,
          default: 'INR',
        },
      },

      limits: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },

      features: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
    },

    lastReminderDays: {
      type: Number,
      default: null,
    },

    advancedRbac: {
  type: Boolean,
  default: false,
},

    lastReminderAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);



subscriptionSchema.index({
  status: 1,
  endDate: 1,
});

subscriptionSchema.index({
  plan: 1,
  status: 1,
});

subscriptionSchema.index({
  renewalDate: 1,
  status: 1,
});

subscriptionSchema.index({
  paymentStatus: 1,
  status: 1,
});

subscriptionSchema.index({
  autoRenew: 1,
  endDate: 1,
});


export default mongoose.model('Subscription', subscriptionSchema);