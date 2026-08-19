// ─────────────────────────────────────────────────────────────
// Billing controller — plans, checkout, verify, history.
//
// ⚠️ RESPONSE CONTRACTS (BillingPage depends on these):
//   GET  /billing/plans        → data: [ {key,name,price,days,limits,features} ]
//   GET  /billing/subscription → data: { subscription, company, usage }
//   POST /billing/checkout     → data: { paymentId, orderId, amount, months,
//                                        mock, keyId }
//   POST /billing/verify       → data: { plan, endDate, status, limits }
//
// 🔑 DUAL MODE: RAZORPAY_KEY_ID set → real orders & HMAC verify;
//    not set → mock order + mock verify (full flow, no gateway).
//    NOTE: no readOnlyIfExpired on these routes — renewal is the
//    escape hatch from an EXPIRED subscription!
//
// 📌 Subscription is ALWAYS read from the DB here (not from
//    req.subscription) — the tenant middleware only attaches
//    req.company, not the subscription document.
// ─────────────────────────────────────────────────────────────
import crypto from "crypto";
import Payment from "../models/Payment.js";
import Invoice from "../models/Invoice.js";
import SystemEvent from "../models/SystemEvent.js";
import Subscription from "../models/Subscription.js";
// import User from "../models/User.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
// import { PLAN_CATALOG, priceFor } from "../utils/plans.js";
import { sendMail, receiptEmail } from "../utils/mailer.js";
import { notifyUser } from "../utils/notify.js";
import {
  changePlan,
  normalizePlanCode,
  publicPlanCode,
  recordHistory,
  renewSubscription,
  subscriptionView,
  validatePlanChange,
} from "../utils/subscriptionEngine.js";

import {
  ensureDefaultPlans,
  getPlan,
  getPlanPrice,
} from "../utils/platformPlans.js";

// const DAY_MS = 24 * 60 * 60 * 1000;
const razorConfigured = () =>
  Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

// Read the company's subscription straight from MongoDB.
// Safety net: every registered company SHOULD have one, but if it
// is missing we return an unsaved placeholder — the upgrade flow
// will fill it with real values before saving.
const loadSubscription = async (companyId) => {
  const sub = await Subscription.findOne({ company: companyId });
  if (sub) return sub;
  return new Subscription({
    company: companyId,
    plan: "TRIAL",
    status: "ACTIVE",
    startDate: new Date(),
    endDate: new Date(),
  });
};

// Razorpay SDK loaded lazily — only when keys exist
let razorpay = null;
const getRazorpay = async () => {
  if (!razorpay) {
    const { default: Razorpay } = await import("razorpay");
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpay;
};

// GET /api/billing/plans
export const getPlans = asyncHandler(async (req, res) => {
  await ensureDefaultPlans();

  const codes = ["TRIAL", "BASIC", "PRO", "ENTERPRISE"];
  const data = [];

  for (const code of codes) {
    const plan = await getPlan(code);
    if (!plan) continue;

    data.push({
      key: publicPlanCode(code),
      internalCode: code,
      name: plan.name,
      price: Number(plan.prices?.monthly || 0),
      yearlyPrice: Number(plan.prices?.yearly || 0),
      days: code === "TRIAL" ? 14 : 30,
      limits: plan.limits || {},
      features: plan.features || {},
      enabledModules: plan.enabledModules || [],
      supportLevel: plan.supportLevel,
    });
  }

  return ApiResponse.success(res, {
    message: "Plans",
    data,
  });
});

// GET /api/billing/subscription — current plan + live usage
export const getSubscription = asyncHandler(async (req, res) => {
  const view = await subscriptionView(req.companyId);

  if (!view) {
    throw ApiError.notFound("Subscription not found");
  }

  return ApiResponse.success(res, {
    message: "Subscription",
    data: {
      subscription: view.subscription,
      plan: view.plan,
      features: view.features,
      usage: view.usage,
      company: {
        name: req.company?.name,
        code: req.company?.code,
      },
      canWrite: view.canWrite,
      isExpired: view.isExpired,
      inGracePeriod: view.inGracePeriod,
    },
  });
});

// POST /api/billing/checkout { plan, months } → order (real or mock)
export const checkout = asyncHandler(async (req, res) => {
  const planAliases = {
    STARTER: "BASIC",
    PROFESSIONAL: "PRO",
  };

  const requestedPlan = String(req.body.plan || "").toUpperCase();

  const plan = planAliases[requestedPlan] || requestedPlan;

  const billingCycle =
    Number(req.body.months) === 12 ||
    req.body.billingCycle === "YEARLY"
      ? "YEARLY"
      : "MONTHLY";

  const months = billingCycle === "YEARLY" ? 12 : 1;

  const planDef = await getPlan(plan);

  if (!planDef || ["FREE", "TRIAL"].includes(plan)) {
    throw ApiError.badRequest(
      "Choose STARTER, PROFESSIONAL or ENTERPRISE"
    );
  }

  const validation = await validatePlanChange(
    req.companyId,
    plan
  );

  if (!validation.allowed) {
    const details = validation.violations
      .map(
        (item) =>
          `${item.resource}: ${item.used}/${item.limit}`
      )
      .join(", ");

    throw ApiError.badRequest(
      `${validation.message}. ${details}`
    );
  }

  const amount = getPlanPrice(planDef, billingCycle);

  if (amount <= 0) {
    throw ApiError.badRequest(
      "Selected plan does not have a valid price"
    );
  }

  // =====================================================
  // 1. CREATE LOCAL PENDING PAYMENT
  // =====================================================

  const payment = await Payment.create({
    companyId: req.companyId,
    payer: req.user._id,
    plan,
    months,
    billingCycle,
    amount,
    originalAmount: amount,
    couponCode: "",
    discountAmount: 0,
    gateway: razorConfigured() ? "razorpay" : "mock",
  });

  // =====================================================
  // 2. CREATE GATEWAY / MOCK ORDER
  // =====================================================

  if (razorConfigured()) {
    try {
      const rzp = await getRazorpay();

      const order = await rzp.orders.create({
        amount: amount * 100,
        currency: "INR",
        receipt: String(payment._id),
      });

      payment.orderId = order.id;

      await payment.save();
    } catch (err) {
      payment.status = "FAILED";

      await payment.save();

      throw ApiError.badRequest(
        `Payment gateway error: ${err.message}`
      );
    }
  } else {
    payment.orderId = `order_mock_${payment._id}`;

    await payment.save();
  }

  // =====================================================
  // 3. RECORD SUBSCRIPTION HISTORY
  // =====================================================

  const checkoutSubscription = await loadSubscription(
    req.companyId
  );

  await recordHistory({
    subscription: checkoutSubscription,
    event: "PAYMENT_STARTED",
    actor: req.user._id,
    paymentReference: payment.orderId,
    newState: {
      plan,
      amount,
      billingCycle,
    },
    req,
  });

  // =====================================================
  // 4. RETURN CHECKOUT RESPONSE
  // =====================================================

  return ApiResponse.created(res, {
    message: "Checkout created",

    data: {
      paymentId: payment._id,
      orderId: payment.orderId,

      // Public plan code
      plan: publicPlanCode(payment.plan),

      // Billing cycle
      billingCycle: payment.billingCycle,

      amount,
      months,

      mock: !razorConfigured(),

      keyId: razorConfigured()
        ? process.env.RAZORPAY_KEY_ID
        : null,
    },
  });
});

// POST /api/billing/verify — success → upgrade subscription
export const verifyPayment = asyncHandler(async (req, res) => {
  const { paymentId, razorpay_payment_id, razorpay_signature } = req.body;
  const payment = await Payment.findOne({
    _id: paymentId,
    companyId: req.companyId,
  });
  if (!payment) throw ApiError.notFound("Payment not found");
  if (payment.status === "SUCCESS")
    throw ApiError.badRequest("This payment is already completed");

  let verified = false;
  if (payment.gateway === "mock") {
    verified = req.body.mock === true; // test-mode explicit confirm
  } else {
    // Real Razorpay: HMAC-SHA256(orderId|paymentId) must match signature
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${payment.orderId}|${razorpay_payment_id}`)
      .digest("hex");
    verified = expected === razorpay_signature;
    if (verified) payment.gatewayPaymentId = razorpay_payment_id;
  }

  if (!verified) {
    payment.status = "FAILED";
    payment.failureReason = "Payment verification failed";

    await payment.save();
    const failedSubscription = await loadSubscription(
  req.companyId,
);

const isRenewal =
  failedSubscription.plan === payment.plan ||
  failedSubscription.autoRenew;

if (isRenewal) {
  const previous = failedSubscription.toObject();

  failedSubscription.paymentStatus = "FAILED";
  failedSubscription.status = "PAST_DUE";
  failedSubscription.pastDueAt = new Date();
  failedSubscription.pastDueEndsAt = new Date(
    Date.now() + 3 * 24 * 60 * 60 * 1000,
  );

  await failedSubscription.save();

  await recordHistory({
    subscription: failedSubscription,
    event: "SUBSCRIPTION_PAST_DUE",
    actor: req.user._id,
    reason: "Payment verification failed",
    paymentReference: payment.orderId,
    previousState: previous,
    newState: failedSubscription.toObject(),
    req,
  });
}

await recordHistory({
  subscription: failedSubscription,
  event: "PAYMENT_FAILED",
  actor: req.user._id,
  reason: "Payment verification failed",
  paymentReference: payment.orderId,
  newState: {
    plan: payment.plan,
    amount: payment.amount,
    paymentStatus: "FAILED",
  },
  req,
});

    await SystemEvent.create({
      type: "PAYMENT_FAILED",
      level: "WARNING",
      title: "Payment failed",
      message: `${payment.plan} payment verification failed`,
      companyId: req.companyId,
      targetType: "Payment",
      targetId: payment._id,
    });

    throw ApiError.badRequest("Payment verification failed");
  }

  // ✅ success — upgrade the subscription (loaded from DB!)
 const currentSubscription = await loadSubscription(
  req.companyId,
);

if (currentSubscription.plan !== payment.plan) {
  const result = await changePlan({
    companyId: req.companyId,
    targetPlanCode: payment.plan,
    actor: req.user._id,
    reason: "Verified subscription payment",
    paymentReference:
      payment.gatewayPaymentId || payment.orderId,
    req,
  });

  if (!result.allowed) {
    throw ApiError.badRequest(result.message);
  }
}

const sub = await renewSubscription({
  companyId: req.companyId,
  actor: req.user._id,
  months: payment.months,
  paymentReference:
    payment.gatewayPaymentId || payment.orderId,
  req,
});

sub.billingCycle = payment.billingCycle;
sub.paymentStatus = "PAID";
sub.autoRenew =
  req.body.autoRenew === true || sub.autoRenew;

await sub.save();

  payment.status = "SUCCESS";
  await payment.save();

  await recordHistory({
  subscription: sub,
  event: "PAYMENT_SUCCESS",
  actor: req.user._id,
  paymentReference:
    payment.gatewayPaymentId || payment.orderId,
  newState: {
    plan: sub.plan,
    endDate: sub.endDate,
    amount: payment.amount,
  },
  req,
});

  await Invoice.create({
    companyId: req.companyId,
    subscription: sub._id,
    payment: payment._id,
    

    invoiceNumber:
      `CRW-${new Date().getFullYear()}-` +
      `${String(payment._id).slice(-8).toUpperCase()}`,

billingPeriod: {
  start: sub.startDate,
  end: sub.endDate,
},

paymentStatus: "PAID",

paymentReference:
  payment.gatewayPaymentId || payment.orderId,

    plan: payment.plan,
    billingCycle: payment.billingCycle,
    subtotal: payment.amount,
    total: payment.amount,
    currency: payment.currency,
    status: "PAID",
    paidAt: new Date(),

    gatewayReference: payment.gatewayPaymentId || payment.orderId,
  });

  // 📧 receipt + 🔔 notification (non-fatal)
  sendMail({
    to: req.user.email,
    ...receiptEmail({
      companyName: req.company?.name,
planName: (await getPlan(sub.plan))?.name || sub.plan,
      amount: payment.amount,
      months: payment.months,
      endDate: sub.endDate,
      paymentId: payment.orderId,
    }),
  });
  notifyUser(req.companyId, req.user._id, {
    type: "BILLING",
    title: `${planDef.name} plan activated 🎉`,
    message: `₹${payment.amount.toLocaleString("en-IN")} paid · valid until ${newEnd.toLocaleDateString("en-IN")}`,
    link: "/app/billing",
  });

  return ApiResponse.success(res, {
    message: `${planDef.name} plan activated — full access restored 🎉`,
   data: {
  plan: publicPlanCode(sub.plan),
  internalPlan: sub.plan,
  status: sub.status,
  endDate: sub.endDate,
  renewalDate: sub.renewalDate,
  limits: sub.limits,
},
  });
});

// GET /api/billing/payments — company payment history
export const listPayments = asyncHandler(async (req, res) => {
  const payments = await Payment.find({ companyId: req.companyId })
    .sort("-createdAt")
    .limit(50);
  return ApiResponse.success(res, { message: "Payments", data: payments });
});



// GET /api/billing/invoices
// Company identity always comes from authenticated req.companyId.
export const listInvoices = asyncHandler(async (req, res) => {
  const invoices = await Invoice.find({
    companyId: req.companyId,
  })
    .select(
      'invoiceNumber plan billingCycle subtotal tax total ' +
        'currency status billingPeriod paymentStatus ' +
        'paymentReference paidAt refundedAt createdAt'
    )
    .sort('-createdAt')
    .limit(100)
    .lean();

  return ApiResponse.success(res, {
    message: 'Invoices',
    data: invoices,
  });
});