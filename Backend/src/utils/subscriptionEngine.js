import Subscription from "../models/Subscription.js";
import SubscriptionHistory from "../models/SubscriptionHistory.js";
import User from "../models/User.js";
import Department from "../models/Department.js";
import Document from "../models/Document.js";
import Candidate from "../models/Candidate.js";
import JobPosting from "../models/JobPosting.js";
import UsageMetric from "../models/UsageMetric.js";
import { getPlan, getPlanPrice } from "./platformPlans.js";

const PLAN_ALIASES = {
  FREE_TRIAL: "TRIAL",
  STARTER: "BASIC",
  PROFESSIONAL: "PRO",
};

const PUBLIC_CODES = {
  FREE: "FREE",
  TRIAL: "FREE_TRIAL",
  BASIC: "STARTER",
  PRO: "PROFESSIONAL",
  ENTERPRISE: "ENTERPRISE",
};

const FEATURE_ALIASES = {
  advancedAnalytics: "analytics",
  api: "apiAccess",
  exports: "export",
};

const WRITABLE_STATUSES = [
  "TRIAL",
  "ACTIVE",
  "EXPIRING",
  "EXPIRING_SOON",
  "GRACE_PERIOD",
];

export const normalizePlanCode = (code) => {
  const normalized = String(code || "").toUpperCase();

  return PLAN_ALIASES[normalized] || normalized;
};

export const publicPlanCode = (code) => PUBLIC_CODES[code] || code;

export const getCurrentSubscription = async (companyId) => {
  if (!companyId) {
    throw new Error("Company context required");
  }

  return Subscription.findOne({
    company: companyId,
  }).populate("planRef");
};

export const getCurrentPlan = async (companyId, subscription = null) => {
  const current = subscription || (await getCurrentSubscription(companyId));

  if (!current) return null;

  if (current.planRef) {
    return current.planRef;
  }

  return getPlan(current.plan);
};

export const getSubscriptionStatus = async (companyId) => {
  const subscription = await getCurrentSubscription(companyId);

  return subscription?.status || "EXPIRED";
};

export const hasFeature = async (companyId, requestedFeature) => {
  const subscription = await getCurrentSubscription(companyId);

  if (!subscription) return false;

  const plan = await getCurrentPlan(companyId, subscription);

  const feature = FEATURE_ALIASES[requestedFeature] || requestedFeature;

  if (plan?.features && plan.features[feature] !== undefined) {
    return !!plan.features[feature];
  }

  const modules = subscription.enabledModules?.length
    ? subscription.enabledModules
    : plan?.enabledModules || [];

  const normalizedModules = modules.map((moduleName) =>
    moduleName.toLowerCase(),
  );

  return (
    modules.includes("ALL") || normalizedModules.includes(feature.toLowerCase())
  );
};

export const getUsage = async (companyId, resource) => {
  const monthStart = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
  );

  const stringMonthStart = monthStart.toISOString().slice(0, 10);

  const counters = {
    employees: () =>
      User.countDocuments({
        companyId,
        role: "EMPLOYEE",
        status: "ACTIVE",
      }),

    users: () =>
      User.countDocuments({
        companyId,
        status: "ACTIVE",
      }),

    managers: () =>
      User.countDocuments({
        companyId,
        role: "MANAGER",
        status: "ACTIVE",
      }),

    teamLeads: () =>
      User.countDocuments({
        companyId,
        role: "TEAM_LEAD",
        status: "ACTIVE",
      }),

    hrManagers: () =>
      User.countDocuments({
        companyId,
        role: "HR_MANAGER",
        status: "ACTIVE",
      }),

    departments: () =>
      Department.countDocuments({
        companyId,
      }),

    storageMB: async () => {
      const rows = await Document.aggregate([
        {
          $match: {
            companyId,
          },
        },
        {
          $group: {
            _id: null,
            bytes: {
              $sum: "$size",
            },
          },
        },
      ]);

      return Math.ceil((rows[0]?.bytes || 0) / 1024 / 1024);
    },

    recruitmentCandidatesMonthly: () =>
      Candidate.countDocuments({
        companyId,

        createdAt: {
          $gte: monthStart,
        },
      }),

    jobPostingsMonthly: () =>
      JobPosting.countDocuments({
        companyId,

        createdAt: {
          $gte: monthStart,
        },
      }),

    apiRequestsMonthly: async () => {
      const rows = await UsageMetric.aggregate([
        {
          $match: {
            companyId,

            date: {
              $gte: stringMonthStart,
            },
          },
        },
        {
          $group: {
            _id: null,

            count: {
              $sum: "$apiRequests",
            },
          },
        },
      ]);

      return rows[0]?.count || 0;
    },

    fileUploadsMonthly: async () => {
      const rows = await UsageMetric.aggregate([
        {
          $match: {
            companyId,

            date: {
              $gte: stringMonthStart,
            },
          },
        },
        {
          $group: {
            _id: null,

            count: {
              $sum: "$fileUploads",
            },
          },
        },
      ]);

      return rows[0]?.count || 0;
    },
  };

  if (!counters[resource]) {
    return 0;
  }

  return counters[resource]();
};

export const checkLimit = async (companyId, resource, increment = 1) => {
  const subscription = await getCurrentSubscription(companyId);

  const plan = await getCurrentPlan(companyId, subscription);

  const rawLimit = plan?.limits?.[resource] ?? subscription?.limits?.[resource];

  const limit = Number(rawLimit);

  const used = await getUsage(companyId, resource);

  const configured = Number.isFinite(limit) && limit >= 0;

  return {
    resource,
    used,
    limit: configured ? limit : null,
    increment,

    allowed: !configured || used + increment <= limit,

    plan: publicPlanCode(subscription?.plan),
  };
};

export const isExpired = (subscription) => {
  if (!subscription) return true;

  return (
    ["EXPIRED", "SUSPENDED", "CANCELLED"].includes(subscription.status) ||
    new Date(subscription.endDate).getTime() < Date.now()
  );
};

export const isInGracePeriod = (subscription) =>
  subscription?.status === "GRACE_PERIOD" &&
  new Date(subscription.graceEndsAt).getTime() >= Date.now();

export const canWrite = (subscription) =>
  !!subscription &&
  !subscription.readOnly &&
  WRITABLE_STATUSES.includes(subscription.status);

export const recordHistory = async ({
  subscription,
  event,
  actor = null,
  reason = "",
  paymentReference = "",
  previousState = null,
  newState = null,
  eventKey = null,
  req = null,
  metadata = {},
}) => {
  try {
    return await SubscriptionHistory.create({
      companyId: subscription.company,

      subscription: subscription._id,

      event,

      oldPlan: previousState?.plan || "",

      newPlan: newState?.plan || subscription.plan,

      oldStatus: previousState?.status || "",

      newStatus: newState?.status || subscription.status,

      changedBy: actor,
      reason,
      paymentReference,

      requestId: req?.headers?.["x-request-id"] || "",

      ip: req?.ip || "",

      previousState,
      newState,
      eventKey,
      metadata,
    });
  } catch (error) {
    // Duplicate event key means this notification/history
    // event was already recorded.
    if (error.code !== 11000) {
      console.warn("[subscription-history]", error.message);
    }

    return null;
  }
};

const snapshotPlan = (plan) => ({
  name: plan?.name || "",
  code: plan?.key || "",
  prices: plan?.prices || {},
  limits: plan?.limits || {},
  features: plan?.features || {},
});

export const validatePlanChange = async (companyId, targetPlanCode) => {
  const targetCode = normalizePlanCode(targetPlanCode);

  const targetPlan = await getPlan(targetCode);

  if (!targetPlan) {
    return {
      allowed: false,
      message: "Plan not found",
      violations: [],
    };
  }

  const resources = [
    "employees",
    "users",
    "managers",
    "teamLeads",
    "hrManagers",
    "departments",
    "storageMB",
  ];

  const violations = [];

  for (const resource of resources) {
    const limit = Number(targetPlan.limits?.[resource]);

    if (!Number.isFinite(limit) || limit < 0) {
      continue;
    }

    const used = await getUsage(companyId, resource);

    if (used > limit) {
      violations.push({
        resource,
        used,
        limit,
      });
    }
  }

  return {
    allowed: violations.length === 0,

    targetPlan,
    violations,

    message:
      violations.length > 0
        ? "Current usage exceeds the target plan limits"
        : "Plan change allowed",
  };
};

export const changePlan = async ({
  companyId,
  targetPlanCode,
  actor,
  reason = "",
  paymentReference = "",
  req = null,
}) => {
  const subscription = await getCurrentSubscription(companyId);

  if (!subscription) {
    throw new Error("Subscription not found");
  }

  const validation = await validatePlanChange(companyId, targetPlanCode);

  if (!validation.allowed) {
    return validation;
  }

  const previous = subscription.toObject();

  const currentPlan = await getCurrentPlan(companyId, subscription);

  const oldPrice = getPlanPrice(currentPlan, subscription.billingCycle);

  const newPrice = getPlanPrice(
    validation.targetPlan,
    subscription.billingCycle,
  );

  subscription.previousPlan = subscription.plan;

  subscription.plan = validation.targetPlan.key;

  subscription.planRef = validation.targetPlan._id || null;

  subscription.planSnapshot = snapshotPlan(validation.targetPlan);

  subscription.limits = validation.targetPlan.limits;

  subscription.enabledModules = validation.targetPlan.enabledModules || [];

  subscription.status = "ACTIVE";

  subscription.readOnly = false;

  await subscription.save();

  const event =
    newPrice >= oldPrice ? "SUBSCRIPTION_UPGRADED" : "SUBSCRIPTION_DOWNGRADED";

  await recordHistory({
    subscription,
    event,
    actor,
    reason,
    paymentReference,
    previousState: previous,
    newState: subscription.toObject(),
    req,
  });

  return {
    allowed: true,
    subscription,
    event,
  };
};

export const renewSubscription = async ({
  companyId,
  actor,
  months = 1,
  paymentReference = "",
  req = null,
}) => {
  const subscription = await getCurrentSubscription(companyId);

  if (!subscription) {
    throw new Error("Subscription not found");
  }

  const previous = subscription.toObject();

  const base = Math.max(Date.now(), new Date(subscription.endDate).getTime());

  subscription.startDate = new Date();

  subscription.endDate = new Date(
    base + Number(months) * 30 * 24 * 60 * 60 * 1000,
  );

  subscription.renewalDate = subscription.endDate;

  subscription.status = "ACTIVE";

  subscription.paymentStatus = "PAID";

  subscription.graceEndsAt = null;

  subscription.pastDueAt = null;

  subscription.pastDueEndsAt = null;

  subscription.readOnly = false;

  await subscription.save();

  await recordHistory({
    subscription,
    event: "SUBSCRIPTION_RENEWED",
    actor,
    paymentReference,
    previousState: previous,
    newState: subscription.toObject(),
    req,
  });

  return subscription;
};

export const cancelSubscription = async ({
  companyId,
  actor,
  reason = "",
  req = null,
}) => {
  const subscription = await getCurrentSubscription(companyId);

  if (!subscription) {
    throw new Error("Subscription not found");
  }

  const previous = subscription.toObject();

  subscription.status = "CANCELLED";

  subscription.cancelledAt = new Date();

  subscription.cancellationReason = reason;

  subscription.autoRenew = false;

  subscription.readOnly = true;

  await subscription.save();

  await recordHistory({
    subscription,
    event: "SUBSCRIPTION_CANCELLED",
    actor,
    reason,
    previousState: previous,
    newState: subscription.toObject(),
    req,
  });

  return subscription;
};

export const restoreSubscription = async ({
  companyId,
  actor,
  reason = "",
  req = null,
}) => {
  const subscription = await getCurrentSubscription(companyId);

  if (!subscription) {
    throw new Error("Subscription not found");
  }

  const previous = subscription.toObject();

  subscription.status = "ACTIVE";

  subscription.restoredAt = new Date();

  subscription.cancelledAt = null;

  subscription.suspendedAt = null;

  subscription.readOnly = false;

  await subscription.save();

  await recordHistory({
    subscription,
    event: "SUBSCRIPTION_RESTORED",
    actor,
    reason,
    previousState: previous,
    newState: subscription.toObject(),
    req,
  });

  return subscription;
};

export const subscriptionView = async (companyId) => {
  const subscription = await getCurrentSubscription(companyId);

  if (!subscription) {
    return null;
  }

  const plan = await getCurrentPlan(companyId, subscription);

  const features = plan?.features || {};

  const usage = {};

  for (const resource of Object.keys(plan?.limits || {})) {
    const used = await getUsage(companyId, resource);

    usage[resource] = {
      used,
      limit: plan.limits[resource],
    };
  }

  return {
    subscription,

    plan: {
      ...plan,
      key: publicPlanCode(subscription.plan),
    },

    features,
    usage,

    status: subscription.status,

    canWrite: canWrite(subscription),

    isExpired: isExpired(subscription),

    inGracePeriod: isInGracePeriod(subscription),
  };
};
