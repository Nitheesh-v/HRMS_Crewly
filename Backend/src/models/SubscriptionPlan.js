import mongoose from "mongoose";

export const PLAN_KEYS = ["FREE", "TRIAL", "BASIC", "PRO", "ENTERPRISE"];

const subscriptionPlanSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      enum: PLAN_KEYS,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    // PRO is displayed as "Professional".
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    prices: {
      monthly: { type: Number, default: 0, min: 0 },
      yearly: { type: Number, default: 0, min: 0 },
      currency: {
        type: String,
        default: "INR",
        uppercase: true,
      },
    },

    limits: {
      employees: { type: Number, default: 10, min: 1 },
      storageMB: { type: Number, default: 512, min: 0 },
      administrators: { type: Number, default: 2, min: 1 },
      departments: { type: Number, default: 5, min: 1 },
      branches: { type: Number, default: 1, min: 1 },
      users: {
        type: Number,
        default: 10,
        min: 1,
      },

      managers: {
        type: Number,
        default: 1,
        min: 0,
      },

      teamLeads: {
        type: Number,
        default: 2,
        min: 0,
      },

      hrManagers: {
        type: Number,
        default: 1,
        min: 0,
      },

      fileUploadsMonthly: {
        type: Number,
        default: 100,
        min: 0,
      },

      reportsMonthly: {
        type: Number,
        default: 20,
        min: 0,
      },

      recruitmentCandidatesMonthly: {
        type: Number,
        default: 0,
        min: 0,
      },

      jobPostingsMonthly: {
        type: Number,
        default: 0,
        min: 0,
      },
      apiRequestsMonthly: {
        type: Number,
        default: 10000,
        min: 0,
      },
    },

    features: {
      payroll: {
        type: Boolean,
        default: false,
      },

      attendance: {
        type: Boolean,
        default: true,
      },

      performance: {
        type: Boolean,
        default: false,
      },

      recruitment: {
        type: Boolean,
        default: false,
      },

      reports: {
        type: Boolean,
        default: false,
      },

      analytics: {
        type: Boolean,
        default: false,
      },

      apiAccess: {
        type: Boolean,
        default: false,
      },

      export: {
        type: Boolean,
        default: false,
      },

      documents: {
        type: Boolean,
        default: true,
      },

      projects: {
        type: Boolean,
        default: true,
      },

      expenses: {
        type: Boolean,
        default: true,
      },

      assets: {
        type: Boolean,
        default: true,
      },
    },

    enabledModules: {
      type: [String],
      default: ["ATTENDANCE", "LEAVES", "TASKS", "DOCUMENTS"],
    },

    supportLevel: {
      type: String,
      enum: ["COMMUNITY", "EMAIL", "PRIORITY", "DEDICATED"],
      default: "EMAIL",
    },
    configVersion: {
  type: Number,
  default: 0,
},

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

subscriptionPlanSchema.index({
  isActive: 1,
  key: 1,
});

export default mongoose.model("SubscriptionPlan", subscriptionPlanSchema);

export { subscriptionPlanSchema };
