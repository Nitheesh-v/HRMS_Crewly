import SubscriptionPlan from '../models/SubscriptionPlan.js';

export const DEFAULT_PLATFORM_PLANS = {
  FREE: {
    name: 'Free',
    prices: { monthly: 0, yearly: 0, currency: 'INR' },
    limits: {
      employees: 5,
      storageMB: 256,
      administrators: 1,
      departments: 2,
      branches: 1,
      apiRequestsMonthly: 5000,
    },
    enabledModules: ['ATTENDANCE', 'LEAVES'],
    supportLevel: 'COMMUNITY',
  },

  TRIAL: {
    name: 'Trial',
    prices: { monthly: 0, yearly: 0, currency: 'INR' },
    limits: {
      employees: 10,
      storageMB: 512,
      administrators: 2,
      departments: 5,
      branches: 1,
      apiRequestsMonthly: 10000,
    },
    features: {
  attendance: true,
  documents: true,
  projects: true,
  payroll: false,
  recruitment: false,
  performance: false,
  reports: false,
  analytics: false,
  apiAccess: false,
  export: false,
  advancedRbac: false,
},
    enabledModules: [
      'ATTENDANCE',
      'LEAVES',
      'TASKS',
      'DOCUMENTS',
      'ANALYTICS',
    ],
    supportLevel: 'EMAIL',
  },

  BASIC: {
    name: 'Basic',
    prices: { monthly: 999, yearly: 9990, currency: 'INR' },
    features: {
  payroll: true,
  attendance: true,
  performance: false,
  recruitment: false,
  reports: true,
  analytics: false,
  apiAccess: false,
  export: false,
  documents: true,
  projects: true,
  expenses: true,
  assets: true,
  advancedRbac: false,
},
    limits: {
      employees: 25,
      storageMB: 1024,
      administrators: 3,
      departments: 10,
      branches: 2,
      apiRequestsMonthly: 50000,
    },
    enabledModules: [
      'ATTENDANCE',
      'LEAVES',
      'TASKS',
      'DOCUMENTS',
      'PROJECTS',
    ],
    supportLevel: 'EMAIL',
  },

  // Existing PRO key is displayed as Professional.
  PRO: {
    name: 'Professional',
    prices: {
      monthly: 2499,
      yearly: 24990,
      currency: 'INR',
    },
  features: {
  payroll: true,
  attendance: true,
  performance: true,
  recruitment: true,
  reports: true,
  analytics: true,
  apiAccess: false,
  export: true,
  documents: true,
  projects: true,
  expenses: true,
  assets: true,
  advancedRbac: false,
},
    limits: {
      employees: 100,
      storageMB: 5120,
      administrators: 10,
      departments: 30,
      branches: 10,
      apiRequestsMonthly: 250000,
    },
    enabledModules: [
      'ATTENDANCE',
      'LEAVES',
      'TASKS',
      'DOCUMENTS',
      'PROJECTS',
      'PAYROLL',
      'RECRUITMENT',
      'PERFORMANCE',
      'ANALYTICS',
    ],
    supportLevel: 'PRIORITY',
  },

  ENTERPRISE: {
    name: 'Enterprise',
    prices: {
      monthly: 4999,
      yearly: 49990,
      currency: 'INR',
    },
  features: {
  payroll: true,
  attendance: true,
  performance: true,
  recruitment: true,
  reports: true,
  analytics: true,
  apiAccess: true,
  export: true,
  documents: true,
  projects: true,
  expenses: true,
  assets: true,
  advancedRbac: true,
},
    limits: {
      employees: 500,
      storageMB: 20480,
      administrators: 50,
      departments: 100,
      branches: 50,
      apiRequestsMonthly: 1000000,
    },
    enabledModules: ['ALL'],
    supportLevel: 'DEDICATED',
  },
};

// Seed missing plans only.
// Existing Super Admin changes are never overwritten.
const PLAN_CONFIG_VERSION = 2;

export const ensureDefaultPlans = async (
  userId = null
) => {
  for (
    const [
      key,
      defaultPlan,
    ] of Object.entries(
      DEFAULT_PLATFORM_PLANS
    )
  ) {
    let storedPlan =
      await SubscriptionPlan.findOne({
        key,
      });

    // Create plans that do not exist.
    if (!storedPlan) {
      await SubscriptionPlan.create({
        key,
        ...defaultPlan,
        configVersion:
          PLAN_CONFIG_VERSION,
        createdBy: userId,
      });

      continue;
    }

    // Run this migration only once for older plan records.
    if (
      (
        storedPlan.configVersion ||
        0
      ) <
      PLAN_CONFIG_VERSION
    ) {
      storedPlan.features = {
        ...defaultPlan.features,
      };

      storedPlan.enabledModules = [
        ...(
          defaultPlan.enabledModules ||
          []
        ),
      ];

      storedPlan.configVersion =
        PLAN_CONFIG_VERSION;

      storedPlan.updatedBy =
        userId ||
        storedPlan.updatedBy;

      await storedPlan.save();
    }
  }
};

// Database plan first, code fallback second.
export const getPlan = async (key) => {
  const normalized = String(key || '').toUpperCase();

  const stored = await SubscriptionPlan.findOne({
    key: normalized,
    isActive: true,
  }).lean();

  if (stored) return stored;

  const fallback = DEFAULT_PLATFORM_PLANS[normalized];

  return fallback
    ? {
        key: normalized,
        ...fallback,
      }
    : null;
};

export const getPlanPrice = (
  plan,
  billingCycle = 'MONTHLY'
) => {
  if (billingCycle === 'YEARLY') {
    return Number(plan?.prices?.yearly) || 0;
  }

  return Number(plan?.prices?.monthly) || 0;
};

export const usagePercent = (used, limit) => {
  if (!limit || limit <= 0) return 0;

  return Math.min(
    100,
    Math.round(
      (Number(used || 0) / limit) * 1000
    ) / 10
  );
};