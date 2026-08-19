import Subscription from '../models/Subscription.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import Payment from '../models/Payment.js';
import Invoice from '../models/Invoice.js';
import AuditLog from '../models/AuditLog.js';
import SystemEvent from '../models/SystemEvent.js';
import {
  ensureDefaultPlans,
  getPlan,
  getPlanPrice,
} from '../utils/platformPlans.js';

const ok = (res, status, data, message) =>
  res.status(status).json({
    statusCode: status,
    success: true,
    data,
    message,
  });

const fail = (res, status, message) =>
  res.status(status).json({
    statusCode: status,
    success: false,
    message,
  });

const escapeRegex = (value = '') =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const audit = async (
  req,
  action,
  companyId,
  targetType,
  targetId,
  previousValue,
  newValue
) => {
  try {
    await AuditLog.create({
      companyId: null,
      actor: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      statusCode: 200,
      ip: req.ip || '',
      targetCompany: companyId || null,
      targetType,
      targetId,
      previousValue,
      newValue,
    });
  } catch {
    // Audit failure must not block the workflow.
  }
};

// ============================================================
// GET /api/super-admin/subscriptions
// ============================================================

export const listSubscriptions = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const match = {};

    if (req.query.status && req.query.status !== 'ALL') {
      match.status = req.query.status;
    }

    if (req.query.plan && req.query.plan !== 'ALL') {
      match.plan = req.query.plan;
    }

    if (req.query.expiringDays) {
      match.endDate = {
        $gte: new Date(),
        $lte: new Date(
          Date.now() +
            Number(req.query.expiringDays) *
              24 *
              60 *
              60 *
              1000
        ),
      };
    }

    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: 'companies',
          localField: 'company',
          foreignField: '_id',
          as: 'companyDoc',
        },
      },
      {
        $set: {
          companyDoc: {
            $arrayElemAt: ['$companyDoc', 0],
          },
        },
      },
      {
        $match: {
          'companyDoc.archivedAt': null,
        },
      },
    ];

    if (req.query.search?.trim()) {
      const search = new RegExp(
        escapeRegex(req.query.search.trim()),
        'i'
      );

      pipeline.push({
        $match: {
          $or: [
            { 'companyDoc.name': search },
            { 'companyDoc.code': search },
          ],
        },
      });
    }

    const [rows, countRows] = await Promise.all([
      Subscription.aggregate([
        ...pipeline,
        { $sort: { endDate: 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            company: {
              id: '$companyDoc._id',
              name: '$companyDoc.name',
              code: '$companyDoc.code',
              status: '$companyDoc.status',
            },
            plan: 1,
            status: 1,
            startDate: 1,
            endDate: 1,
            trialEndDate: 1,
            graceEndsAt: 1,
            renewalDate: 1,
            billingCycle: 1,
            paymentStatus: 1,
            expirationBehavior: 1,
            limits: 1,
            enabledModules: 1,
          },
        },
      ]),

      Subscription.aggregate([
        ...pipeline,
        { $count: 'total' },
      ]),
    ]);

    const total = countRows[0]?.total || 0;

    return ok(
      res,
      200,
      {
        rows,
        meta: {
          page,
          limit,
          total,
          pages: Math.max(1, Math.ceil(total / limit)),
        },
      },
      'Subscriptions'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PATCH /api/super-admin/subscriptions/:companyId
// ============================================================

export const updateSubscription = async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      company: req.params.companyId,
    });

    if (!subscription) {
      return fail(res, 404, 'Subscription not found');
    }

    const previous = subscription.toObject();
    const planKey = String(
      req.body.plan || subscription.plan
    ).toUpperCase();

    const plan = await getPlan(planKey);

    if (!plan) {
      return fail(res, 400, 'Invalid plan');
    }

    const statuses = [
      'TRIAL',
      'ACTIVE',
      'EXPIRING_SOON',
      'GRACE_PERIOD',
      'EXPIRED',
      'SUSPENDED',
      'CANCELLED',
    ];

    if (
      req.body.status &&
      !statuses.includes(req.body.status)
    ) {
      return fail(res, 400, 'Invalid subscription status');
    }

    if (subscription.plan !== planKey) {
      subscription.previousPlan = subscription.plan;
    }

    subscription.plan = planKey;
    subscription.planRef = plan._id || null;
    subscription.limits = {
      ...plan.limits,
      ...(req.body.limits || {}),
    };

    subscription.enabledModules =
      req.body.enabledModules ||
      plan.enabledModules ||
      subscription.enabledModules;

    if (req.body.status) {
      subscription.status = req.body.status;
    }

    if (req.body.startDate) {
      subscription.startDate = new Date(req.body.startDate);
    }

    if (req.body.endDate) {
      subscription.endDate = new Date(req.body.endDate);
    }

    if (req.body.trialEndDate !== undefined) {
      subscription.trialEndDate = req.body.trialEndDate
        ? new Date(req.body.trialEndDate)
        : null;
    }

    if (req.body.graceEndsAt !== undefined) {
      subscription.graceEndsAt = req.body.graceEndsAt
        ? new Date(req.body.graceEndsAt)
        : null;
    }

    if (req.body.billingCycle) {
      subscription.billingCycle = req.body.billingCycle;
    }

    if (req.body.paymentStatus) {
      subscription.paymentStatus = req.body.paymentStatus;
    }

    if (req.body.expirationBehavior) {
      subscription.expirationBehavior =
        req.body.expirationBehavior;
    }

    subscription.renewalDate = subscription.endDate;

    if (
      subscription.status === 'CANCELLED' &&
      !subscription.cancelledAt
    ) {
      subscription.cancelledAt = new Date();
    }

    await subscription.save();

    await audit(
      req,
      'PLATFORM_SUBSCRIPTION_CHANGED',
      subscription.company,
      'Subscription',
      subscription._id,
      previous,
      subscription.toObject()
    );

    await SystemEvent.create({
      type: 'SUBSCRIPTION_CREATED',
      level: 'INFO',
      title: 'Subscription updated',
      message:
        `${previous.plan} → ${subscription.plan} ` +
        `(${subscription.status})`,
      companyId: subscription.company,
      targetType: 'Subscription',
      targetId: subscription._id,
    });

    return ok(
      res,
      200,
      subscription,
      'Subscription updated'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PLAN MANAGEMENT
// ============================================================

export const listPlans = async (req, res) => {
  try {
    await ensureDefaultPlans(req.user._id);

    const plans = await SubscriptionPlan.find({})
      .sort('prices.monthly')
      .lean();

    return ok(res, 200, plans, 'Plans');
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

export const savePlan = async (req, res) => {
  try {
    const key = String(req.body.key || '').toUpperCase();

    if (!key) {
      return fail(res, 400, 'Plan key is required');
    }

    const previous = await SubscriptionPlan.findOne({
      key,
    }).lean();

    const plan = await SubscriptionPlan.findOneAndUpdate(
      { key },
      {
        $set: {
          name: req.body.name || key,
          description: req.body.description || '',
          prices: req.body.prices,
          limits: req.body.limits,
          enabledModules: req.body.enabledModules || [],
          supportLevel: req.body.supportLevel,
          isActive: req.body.isActive !== false,
          updatedBy: req.user._id,
        },

        $setOnInsert: {
          key,
          createdBy: req.user._id,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      }
    );

    await audit(
      req,
      previous
        ? 'PLATFORM_PLAN_UPDATED'
        : 'PLATFORM_PLAN_CREATED',
      null,
      'SubscriptionPlan',
      plan._id,
      previous,
      plan.toObject()
    );

    return ok(
      res,
      previous ? 200 : 201,
      plan,
      previous ? 'Plan updated' : 'Plan created'
    );
  } catch (error) {
    return fail(
      res,
      error.code === 11000 ? 409 : 500,
      error.message
    );
  }
};

// ============================================================
// BILLING
// ============================================================

export const listBilling = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const paymentMatch = {};

    if (req.query.status && req.query.status !== 'ALL') {
      paymentMatch.status = req.query.status;
    }

    const [payments, paymentTotal, invoices, invoiceTotal] =
      await Promise.all([
        Payment.find(paymentMatch)
          .populate('companyId', 'name code')
          .sort('-createdAt')
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),

        Payment.countDocuments(paymentMatch),

        Invoice.find({})
          .populate('companyId', 'name code')
          .sort('-createdAt')
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),

        Invoice.countDocuments(),
      ]);

    return ok(
      res,
      200,
      {
        payments,
        invoices,
        meta: {
          page,
          limit,
          paymentTotal,
          invoiceTotal,
        },
      },
      'Billing'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

export const updatePayment = async (req, res) => {
  try {
    const statuses = [
      'PENDING',
      'SUCCESS',
      'FAILED',
      'REFUNDED',
    ];

    if (!statuses.includes(req.body.status)) {
      return fail(res, 400, 'Invalid payment status');
    }

    const payment = await Payment.findById(
      req.params.paymentId
    );

    if (!payment) {
      return fail(res, 404, 'Payment not found');
    }

    const previous = payment.toObject();

    payment.status = req.body.status;
    payment.failureReason =
      req.body.failureReason || payment.failureReason;

    if (req.body.status === 'REFUNDED') {
      payment.refundedAmount =
        Number(req.body.refundedAmount) || payment.amount;
      payment.refundedAt = new Date();
    }

    await payment.save();

    if (payment.status === 'REFUNDED') {
      await Invoice.updateOne(
        { payment: payment._id },
        {
          $set: {
            status: 'REFUNDED',
            refundedAt: payment.refundedAt,
          },
        }
      );
    }

    await audit(
      req,
      'PLATFORM_PAYMENT_UPDATED',
      payment.companyId,
      'Payment',
      payment._id,
      previous,
      payment.toObject()
    );

    return ok(res, 200, payment, 'Payment updated');
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// REVENUE ANALYTICS
// ============================================================

export const revenueAnalytics = async (req, res) => {
  try {
    const start = new Date(
      new Date().getFullYear() - 1,
      0,
      1
    );

    const [payments, subscriptions, failedPayments] =
      await Promise.all([
        Payment.find({
          status: 'SUCCESS',
          createdAt: { $gte: start },
        })
          .select(
            'amount plan months billingCycle createdAt companyId'
          )
          .lean(),

        Subscription.find({})
          .select(
            'company plan previousPlan status billingCycle ' +
              'startDate endDate createdAt updatedAt'
          )
          .lean(),

        Payment.countDocuments({
          status: 'FAILED',
          createdAt: { $gte: start },
        }),
      ]);

    const monthMap = {};
    const planRevenue = {};

    payments.forEach((payment) => {
      const month =
        `${payment.createdAt.getFullYear()}-` +
        `${String(payment.createdAt.getMonth() + 1).padStart(
          2,
          '0'
        )}`;

      monthMap[month] =
        (monthMap[month] || 0) +
        Number(payment.amount || 0);

      planRevenue[payment.plan] =
        (planRevenue[payment.plan] || 0) +
        Number(payment.amount || 0);
    });

    let mrr = 0;

    const active = subscriptions.filter((subscription) =>
      [
        'ACTIVE',
        'EXPIRING_SOON',
        'GRACE_PERIOD',
      ].includes(subscription.status)
    );

    for (const subscription of active) {
      const plan = await getPlan(subscription.plan);
      const price = getPlanPrice(
        plan,
        subscription.billingCycle
      );

      mrr +=
        subscription.billingCycle === 'YEARLY'
          ? price / 12
          : price;
    }

    const monthlyRevenue = Object.entries(monthMap)
      .sort(([first], [second]) =>
        first.localeCompare(second)
      )
      .map(([label, revenue]) => ({
        label,
        revenue,
      }));

    return ok(
      res,
      200,
      {
        mrr: Math.round(mrr),
        arr: Math.round(mrr * 12),
        monthlyRevenue,
        yearlyRevenue: monthlyRevenue.reduce(
          (sum, row) => sum + row.revenue,
          0
        ),
        byPlan: Object.entries(planRevenue).map(
          ([plan, revenue]) => ({
            plan,
            revenue,
          })
        ),
        newSubscriptions: subscriptions.filter(
          (row) => row.createdAt >= start
        ).length,
        upgrades: subscriptions.filter(
          (row) =>
            row.previousPlan &&
            row.previousPlan !== row.plan
        ).length,
        cancellations: subscriptions.filter(
          (row) => row.status === 'CANCELLED'
        ).length,
        renewals: subscriptions.filter(
          (row) =>
            row.status === 'ACTIVE' &&
            row.updatedAt > row.startDate
        ).length,
        failedPayments,
      },
      'Revenue analytics'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};