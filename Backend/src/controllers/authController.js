import mongoose from 'mongoose';
import Company from '../models/Company.js';
import Subscription from '../models/Subscription.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import generateToken from '../utils/generateToken.js';
import { ROLES, PLANS, TRIAL_DAYS, SUPER_ADMIN_COMPANY_CODE } from '../utils/constants.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  companyId: user.companyId ?? null,
      avatarUrl: user.avatarUrl,
});

// Unique login code like "acme", "acme1" if taken
const generateCompanyCode = async (name) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'company';
  let code = base;
  let i = 1;
  while (await Company.exists({ code })) {
    code = `${base}${i++}`;
  }
  return code;
};

/*
 * POST /api/auth/register-company
 * Creates Company + Trial Subscription + Company Admin atomically.
 */
export const registerCompany = asyncHandler(async (req, res) => {
  const { companyName, adminName, email, password } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const code = await generateCompanyCode(companyName);

    const [company] = await Company.create([{ name: companyName, code, email }], { session });

    const trialEnd = new Date(Date.now() + TRIAL_DAYS * MS_PER_DAY);
    const [subscription] = await Subscription.create(
      [{ company: company._id, plan: PLANS.TRIAL, status: 'ACTIVE', startDate: new Date(), endDate: trialEnd }],
      { session }
    );

    company.subscription = subscription._id;
    await company.save({ session });

    const [admin] = await User.create(
      [{ name: adminName, email, password, role: ROLES.COMPANY_ADMIN, companyId: company._id }],
      { session }
    );

    await session.commitTransaction();

    ApiResponse.created(res, {
      message: 'Company registered successfully 🎉 Your 14-day trial has started.',
      data: {
        user: publicUser(admin),
        token: generateToken(admin),
        company: { name: company.name, code: company.code },
        trialEndsAt: trialEnd,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    if (error.code === 11000) {
      throw ApiError.conflict('This email is already registered in your company.');
    }
    throw error;
  } finally {
    session.endSession();
  }
});

/*
 * POST /api/auth/login
 * Body: { companyCode, email, password }
 * Super Admin logs in with companyCode = "CREWLY".
 */
export const login = asyncHandler(async (req, res) => {
  const { companyCode, email, password } = req.body;
  const code = companyCode.trim().toLowerCase();

  let user;
  let company = null;

  if (code === SUPER_ADMIN_COMPANY_CODE.toLowerCase()) {
    user = await User.findOne({ email: email.toLowerCase(), role: ROLES.SUPER_ADMIN, companyId: null }).select('+password');
  } else {
    company = await Company.findOne({ code }).populate('subscription');
    if (!company) throw ApiError.unauthorized('Invalid company code');
    if (company.status === 'SUSPENDED') {
      throw ApiError.forbidden('Your company account is suspended. Contact Crewly support.');
    }
    user = await User.findOne({ email: email.toLowerCase(), companyId: company._id }).select('+password');
  }

  if (!user) throw ApiError.unauthorized('Invalid email or password');
  if (user.status !== 'ACTIVE') throw ApiError.forbidden('Your account is deactivated. Contact your admin.');

  const isMatch = await user.comparePassword(password);
  if (!isMatch) throw ApiError.unauthorized('Invalid email or password');

  // ---- Subscription gate (Block login if expired) ----
  let subscriptionInfo = null;
  if (company?.subscription) {
    const sub = company.subscription;
    const now = Date.now();

    if (new Date(sub.endDate).getTime() < now) {
      if (sub.status !== 'EXPIRED') {
        sub.status = 'EXPIRED';
        await sub.save();
      }
      throw ApiError.forbidden('Your subscription has expired. Please renew to continue.');
    }

    const daysLeft = Math.ceil((new Date(sub.endDate).getTime() - now) / MS_PER_DAY);
    if (daysLeft <= 3 && sub.status === 'ACTIVE') {
      sub.status = 'EXPIRING_SOON';
      await sub.save();
    }
    subscriptionInfo = { plan: sub.plan, status: sub.status, daysLeft, endDate: sub.endDate };
  }

  user.lastLogin = new Date();
  await user.save();

  ApiResponse.success(res, {
    message: 'Login successful',
    data: {
      user: publicUser(user),
      token: generateToken(user),
      company: company ? { name: company.name, code: company.code } : null,
      subscription: subscriptionInfo,
    },
  });
});

/*
 * GET /api/auth/me  (protected)
 * Returns current user + company + subscription summary.
 */
export const getMe = asyncHandler(async (req, res) => {
  let companyInfo = null;
  let subscriptionInfo = null;

  if (req.companyId) {
    const company = await Company.findById(req.companyId).populate('subscription');
    if (company) {
      companyInfo = { name: company.name, code: company.code, status: company.status };
      const sub = company.subscription;
      if (sub) {
        const daysLeft = Math.max(0, Math.ceil((new Date(sub.endDate).getTime() - Date.now()) / MS_PER_DAY));
        subscriptionInfo = { plan: sub.plan, status: sub.status, daysLeft, endDate: sub.endDate, limits: sub.limits };
      }
    }
  }

  ApiResponse.success(res, {
    message: 'Current user',
    data: { user: publicUser(req.user), company: companyInfo, subscription: subscriptionInfo },
  });
});