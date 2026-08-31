import SubscriptionHistory from '../models/SubscriptionHistory.js';
import {
  cancelSubscription,
  changePlan,
  checkLimit,
  getCurrentPlan,
  getCurrentSubscription,
  hasFeature,
  normalizePlanCode,
  publicPlanCode,
  restoreSubscription,
  subscriptionView,
  validatePlanChange,
} from '../utils/subscriptionEngine.js';
import {
  getPlan,
  getPlanPrice,
} from '../utils/platformPlans.js';

const ok = (
  res,
  status,
  data,
  message
) =>
  res.status(status).json({
    statusCode: status,
    success: true,
    data,
    message,
  });

const fail = (
  res,
  status,
  message,
  data = {}
) =>
  res.status(status).json({
    statusCode: status,
    success: false,
    message,
    data,
  });

const HR = [
  'COMPANY_ADMIN',
  'HR_MANAGER',
];

export const current = async (
  req,
  res
) => {
  try {
    const data =
      // DB Logic - DB logics
      await subscriptionView(
        // Data from frontend - requests from frontend
        req.companyId
      );

    if (!data) {
      return fail(
        res,
        404,
        'Subscription not found'
      );
    }

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      data,
      'Current subscription'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const features = async (
  req,
  res
) => {
  try {
    const view =
      // DB Logic - DB logics
      await subscriptionView(
        // Data from frontend - requests from frontend
        req.companyId
      );

    if (!view) {
      return fail(
        res,
        404,
        'Subscription not found'
      );
    }

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        plan: view.plan.key,
        status: view.status,
        features:
          view.features,
        canWrite:
          view.canWrite,
      },
      'Feature entitlements'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const usage = async (
  req,
  res
) => {
  try {
    const view =
      // DB Logic - DB logics
      await subscriptionView(
        // Data from frontend - requests from frontend
        req.companyId
      );

    if (!view) {
      return fail(
        res,
        404,
        'Subscription not found'
      );
    }

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        plan: view.plan.key,
        usage: view.usage,
      },
      'Subscription usage'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const history = async (
  req,
  res
) => {
  try {
    if (
      !HR.includes(
        // Data from frontend - requests from frontend
        req.user.role
      )
    ) {
      return fail(
        res,
        403,
        'Company Admin or HR access required'
      );
    }

    const rows =
      // DB Logic - DB logics
      await SubscriptionHistory.find({
        companyId:
          req.companyId,
      })
        .populate(
          'changedBy',
          'name email role'
        )
        .sort('-createdAt')
        .limit(200)
        .lean();

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      rows,
      'Subscription history'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const plans = async (
  req,
  res
) => {
  try {
    const subscription =
      // DB Logic - DB logics
      await getCurrentSubscription(
        // Data from frontend - requests from frontend
        req.companyId
      );

    const currentPlan =
      await getCurrentPlan(
        req.companyId,
        subscription
      );

    const codes = [
      'TRIAL',
      'BASIC',
      'PRO',
      'ENTERPRISE',
    ];

    const rows = [];

    for (const code of codes) {
      const plan =
        await getPlan(code);

      if (!plan) continue;

      rows.push({
        ...plan,

        key:
          publicPlanCode(code),

        internalCode: code,

        current:
          subscription?.plan ===
          code,
      });
    }

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        currentPlan:
          publicPlanCode(
            subscription?.plan
          ),

        currentPrice:
          getPlanPrice(
            currentPlan,
            subscription
              ?.billingCycle
          ),

        plans: rows,
      },
      'Available plans'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const quotePlanChange = async (
  req,
  res
) => {
  try {
    if (
      !HR.includes(
        // Data from frontend - requests from frontend
        req.user.role
      )
    ) {
      return fail(
        res,
        403,
        'Company Admin or HR access required'
      );
    }

    const targetCode =
      normalizePlanCode(
        req.body.plan
      );

    const validation =
      // DB Logic - DB logics
      await validatePlanChange(
        req.companyId,
        targetCode
      );

    if (!validation.allowed) {
      return fail(
        res,
        409,
        validation.message,
        {
          violations:
            validation.violations,
        }
      );
    }

    const subscription =
      await getCurrentSubscription(
        req.companyId
      );

    const currentPlan =
      await getCurrentPlan(
        req.companyId,
        subscription
      );

    const cycle =
      req.body.billingCycle ||
      subscription.billingCycle ||
      'MONTHLY';

    const currentPrice =
      getPlanPrice(
        currentPlan,
        cycle
      );

    const newPrice =
      getPlanPrice(
        validation.targetPlan,
        cycle
      );

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        currentPlan:
          publicPlanCode(
            subscription.plan
          ),

        newPlan:
          publicPlanCode(
            targetCode
          ),

        billingCycle: cycle,
        currentPrice,
        newPrice,

        priceDifference:
          newPrice -
          currentPrice,

        newFeatures:
          validation.targetPlan
            .features || {},

        newLimits:
          validation.targetPlan
            .limits || {},

        proceedToPayment:
          newPrice >=
          currentPrice,
      },
      'Plan change quote'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const downgrade = async (
  req,
  res
) => {
  try {
    if (
      // Data from frontend - requests from frontend
      req.user.role !==
      'COMPANY_ADMIN'
    ) {
      return fail(
        res,
        403,
        'Company Admin access required'
      );
    }

    const result =
      // DB Logic - DB logics
      await changePlan({
        companyId:
          req.companyId,

        targetPlanCode:
          req.body.plan,

        actor:
          req.user._id,

        reason:
          req.body.reason ||
          'Company requested downgrade',

        req,
      });

    if (!result.allowed) {
      return fail(
        res,
        409,
        result.message,
        {
          violations:
            result.violations,
        }
      );
    }

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      result.subscription,
      'Plan changed'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const cancel = async (
  req,
  res
) => {
  try {
    if (
      // Data from frontend - requests from frontend
      req.user.role !==
      'COMPANY_ADMIN'
    ) {
      return fail(
        res,
        403,
        'Company Admin access required'
      );
    }

    const subscription =
      // DB Logic - DB logics
      await cancelSubscription({
        companyId:
          req.companyId,

        actor:
          req.user._id,

        reason:
          req.body.reason ||
          '',

        req,
      });

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      subscription,
      'Subscription cancelled'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const restore = async (
  req,
  res
) => {
  try {
    if (
      // Data from frontend - requests from frontend
      req.user.role !==
      'COMPANY_ADMIN'
    ) {
      return fail(
        res,
        403,
        'Company Admin access required'
      );
    }

    const subscription =
      // DB Logic - DB logics
      await restoreSubscription({
        companyId:
          req.companyId,

        actor:
          req.user._id,

        reason:
          req.body.reason ||
          'Company requested restoration',

        req,
      });

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      subscription,
      'Subscription restored'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const toggleAutoRenew = async (
  req,
  res
) => {
  try {
    if (
      // Data from frontend - requests from frontend
      req.user.role !==
      'COMPANY_ADMIN'
    ) {
      return fail(
        res,
        403,
        'Company Admin access required'
      );
    }

    const subscription =
      // DB Logic - DB logics
      await getCurrentSubscription(
        req.companyId
      );

    if (!subscription) {
      return fail(
        res,
        404,
        'Subscription not found'
      );
    }

    subscription.autoRenew =
      req.body.enabled === true;

    await subscription.save();

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        autoRenew:
          subscription.autoRenew,
      },
      'Auto-renew setting updated'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const limit = async (
  req,
  res
) => {
  try {
    const result =
      // DB Logic - DB logics
      await checkLimit(
        // Data from frontend - requests from frontend
        req.companyId,
        req.params.resource,
        0
      );

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      result,
      'Limit status'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};

export const feature = async (
  req,
  res
) => {
  try {
    const allowed =
      // DB Logic - DB logics
      await hasFeature(
        // Data from frontend - requests from frontend
        req.companyId,
        req.params.feature
      );

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        feature:
          req.params.feature,
        allowed,
      },
      'Feature status'
    );
  } catch (error) {
    return fail(
      res,
      500,
      error.message
    );
  }
};