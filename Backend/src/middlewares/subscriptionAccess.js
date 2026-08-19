import {
  canWrite,
  checkLimit,
  getCurrentSubscription,
  hasFeature,
} from "../utils/subscriptionEngine.js";
import { recordHistory } from "../utils/subscriptionEngine.js";

const denied = (res, status, code, message, data = {}) =>
  res.status(status).json({
    statusCode: status,
    success: false,
    code,
    message,
    data,
  });

export const checkSubscriptionStatus = async (req, res, next) => {
  try {
    if (!req.companyId) {
      return denied(res, 400, "COMPANY_REQUIRED", "Company context required");
    }

    const subscription = await getCurrentSubscription(req.companyId);

    if (!subscription) {
      return denied(
        res,
        403,
        "SUBSCRIPTION_REQUIRED",
        "No subscription is assigned to this company",
      );
    }

    req.subscription = subscription;

    if (subscription.status === "SUSPENDED") {
      return denied(
        res,
        403,
        "SUBSCRIPTION_SUSPENDED",
        "This subscription is suspended. Contact Crewly support.",
      );
    }

    if (subscription.status === "CANCELLED") {
      return denied(
        res,
        403,
        "SUBSCRIPTION_CANCELLED",
        "This subscription is cancelled. Renew to restore access.",
      );
    }

    next();
  } catch (error) {
    return denied(res, 500, "SUBSCRIPTION_CHECK_FAILED", error.message);
  }
};

export const checkWriteAccess = async (req, res, next) => {
  try {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      return next();
    }

    const subscription =
      req.subscription || (await getCurrentSubscription(req.companyId));

    if (!canWrite(subscription)) {
      return denied(
        res,
        403,
        "SUBSCRIPTION_READ_ONLY",
        "Your subscription does not currently allow write operations.",
        {
          status: subscription?.status,

          upgradeUrl: "/app/subscription",
        },
      );
    }

    next();
  } catch (error) {
    return denied(res, 500, "WRITE_CHECK_FAILED", error.message);
  }
};

export const requireFeature = (feature) => async (req, res, next) => {
  try {
    const allowed = await hasFeature(req.companyId, feature);

    if (!allowed) {
      return denied(
        res,
        403,
        "FEATURE_NOT_AVAILABLE",
        "This feature is not included in your current plan.",
        {
          feature,

          upgradeUrl: "/app/subscription",
        },
      );
    }

    next();
  } catch (error) {
    return denied(res, 500, "FEATURE_CHECK_FAILED", error.message);
  }
};

export const checkUsageLimit =
  (resource, increment = 1) =>
  async (req, res, next) => {
    try {
      const result = await checkLimit(req.companyId, resource, increment);

      if (!result.allowed) {
        return denied(
          res,
          403,
          "LIMIT_REACHED",
          `${resource} limit reached. ` +
            `Your ${result.plan} plan supports ${result.limit}.`,
          {
            ...result,

            upgradeUrl: "/app/subscription",
          },
        );
      }

      req.usageLimit = result;
      next();
    } catch (error) {
      return denied(res, 500, "LIMIT_CHECK_FAILED", error.message);
    }
  };

export const checkUserCreationLimit = async (req, res, next) => {
  try {
    const role = req.body.role || "EMPLOYEE";

    const roleResource = {
      EMPLOYEE: "employees",
      MANAGER: "managers",
      TEAM_LEAD: "teamLeads",
      HR_MANAGER: "hrManagers",
    };

    const resources = ["users", roleResource[role]].filter(Boolean);

    for (const resource of resources) {
      const result = await checkLimit(req.companyId, resource, 1);

      if (!result.allowed) {
        await recordHistory({
          subscription:
            req.subscription || (await getCurrentSubscription(req.companyId)),

          event: "LIMIT_REACHED",
          actor: req.user._id,
          reason: `${resource} limit reached`,
          req,
          metadata: result,
        });

        return denied(
          res,
          403,
          "LIMIT_REACHED",
          `${resource} limit reached. ` +
            `Your ${result.plan} plan supports ${result.limit}.`,
          {
            ...result,
            upgradeUrl: "/app/subscription",
          },
        );
      }
    }

    next();
  } catch (error) {
    return denied(res, 500, "USER_LIMIT_CHECK_FAILED", error.message);
  }
};

export const requireConfiguredFeature = (feature) => [
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature(feature),
];

export const requireActiveSubscription = [
  checkSubscriptionStatus,
  checkWriteAccess,
];
