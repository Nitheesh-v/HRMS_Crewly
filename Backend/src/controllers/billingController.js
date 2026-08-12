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
import crypto from 'crypto';
import Payment from '../models/Payment.js';
import Subscription from '../models/Subscription.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { PLAN_CATALOG, priceFor } from '../utils/plans.js';
import { sendMail, receiptEmail } from '../utils/mailer.js';
import { notifyUser } from '../utils/notify.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const razorConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

// Read the company's subscription straight from MongoDB.
// Safety net: every registered company SHOULD have one, but if it
// is missing we return an unsaved placeholder — the upgrade flow
// will fill it with real values before saving.
const loadSubscription = async (companyId) => {
  const sub = await Subscription.findOne({ company: companyId });
  if (sub) return sub;
  return new Subscription({
    company: companyId,
    plan: 'TRIAL',
    status: 'ACTIVE',
    startDate: new Date(),
    endDate: new Date(),
  });
};

// Razorpay SDK loaded lazily — only when keys exist
let razorpay = null;
const getRazorpay = async () => {
  if (!razorpay) {
    const { default: Razorpay } = await import('razorpay');
    razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  }
  return razorpay;
};

// GET /api/billing/plans
export const getPlans = asyncHandler(async (req, res) => {
  const data = Object.entries(PLAN_CATALOG).map(([key, p]) => ({ key, ...p }));
  return ApiResponse.success(res, { message: 'Plans', data });
});

// GET /api/billing/subscription — current plan + live usage
export const getSubscription = asyncHandler(async (req, res) => {
  const sub = await loadSubscription(req.companyId);
  const usage = {
    employees: await User.countDocuments({ companyId: req.companyId, status: 'ACTIVE' }),
    employeeLimit: sub?.limits?.employees ?? PLAN_CATALOG.TRIAL.limits.employees,
  };
  return ApiResponse.success(res, {
    message: 'Subscription',
    data: { subscription: sub, company: { name: req.company?.name, code: req.company?.code }, usage },
  });
});

// POST /api/billing/checkout { plan, months } → order (real or mock)
export const checkout = asyncHandler(async (req, res) => {
  const { plan } = req.body;
  const months = Number(req.body.months) === 12 ? 12 : 1;
  const planDef = PLAN_CATALOG[plan];
  if (!planDef || plan === 'TRIAL') throw ApiError.badRequest('Choose a valid paid plan: BASIC, PRO or ENTERPRISE');

  const amount = priceFor(plan, months);

  // 1) create the local PENDING payment first (receipt for the order)
  const payment = await Payment.create({
    companyId: req.companyId, payer: req.user._id, plan, months, amount,
    gateway: razorConfigured() ? 'razorpay' : 'mock',
  });

  // 2) gateway order
  if (razorConfigured()) {
    try {
      const rzp = await getRazorpay();
      const order = await rzp.orders.create({ amount: amount * 100, currency: 'INR', receipt: String(payment._id) });
      payment.orderId = order.id;
      await payment.save();
    } catch (err) {
      payment.status = 'FAILED';
      await payment.save();
      throw ApiError.badRequest(`Payment gateway error: ${err.message}`);
    }
  } else {
    payment.orderId = `order_mock_${payment._id}`;
    await payment.save();
  }

  return ApiResponse.created(res, {
    message: 'Checkout created',
    data: {
      paymentId: payment._id,
      orderId: payment.orderId,
      amount, months,
      mock: !razorConfigured(),
      keyId: razorConfigured() ? process.env.RAZORPAY_KEY_ID : null,
    },
  });
});

// POST /api/billing/verify — success → upgrade subscription
export const verifyPayment = asyncHandler(async (req, res) => {
  const { paymentId, razorpay_payment_id, razorpay_signature } = req.body;
  const payment = await Payment.findOne({ _id: paymentId, companyId: req.companyId });
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.status === 'SUCCESS') throw ApiError.badRequest('This payment is already completed');

  let verified = false;
  if (payment.gateway === 'mock') {
    verified = req.body.mock === true; // test-mode explicit confirm
  } else {
    // Real Razorpay: HMAC-SHA256(orderId|paymentId) must match signature
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${payment.orderId}|${razorpay_payment_id}`)
      .digest('hex');
    verified = expected === razorpay_signature;
    if (verified) payment.gatewayPaymentId = razorpay_payment_id;
  }

  if (!verified) {
    payment.status = 'FAILED';
    await payment.save();
    throw ApiError.badRequest('Payment verification failed');
  }

  // ✅ success — upgrade the subscription (loaded from DB!)
  const sub = await loadSubscription(req.companyId);
  const planDef = PLAN_CATALOG[payment.plan];
  const now = Date.now();
  // Mid-cycle paid renewal extends from current endDate; trial/expired starts now
  const base = sub.status !== 'EXPIRED' && new Date(sub.endDate).getTime() > now
    ? new Date(sub.endDate).getTime()
    : now;
  const newEnd = new Date(base + planDef.days * payment.months * DAY_MS);

  sub.plan = payment.plan;
  sub.status = 'ACTIVE';
  sub.startDate = new Date(now);
  sub.endDate = newEnd;
  sub.limits = { ...planDef.limits };
  await sub.save();

  payment.status = 'SUCCESS';
  await payment.save();

  // 📧 receipt + 🔔 notification (non-fatal)
  sendMail({
    to: req.user.email,
    ...receiptEmail({
      companyName: req.company?.name, planName: planDef.name,
      amount: payment.amount, months: payment.months, endDate: newEnd, paymentId: payment.orderId,
    }),
  });
  notifyUser(req.companyId, req.user._id, {
    type: 'BILLING', title: `${planDef.name} plan activated 🎉`,
    message: `₹${payment.amount.toLocaleString('en-IN')} paid · valid until ${newEnd.toLocaleDateString('en-IN')}`,
    link: '/app/billing',
  });

  return ApiResponse.success(res, {
    message: `${planDef.name} plan activated — full access restored 🎉`,
    data: { plan: sub.plan, status: sub.status, endDate: sub.endDate, limits: sub.limits },
  });
});

// GET /api/billing/payments — company payment history
export const listPayments = asyncHandler(async (req, res) => {
  const payments = await Payment.find({ companyId: req.companyId }).sort('-createdAt').limit(50);
  return ApiResponse.success(res, { message: 'Payments', data: payments });
});