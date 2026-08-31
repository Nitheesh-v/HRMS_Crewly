// ============================================================
// saasAnalyticsController.js — SUPER ADMIN only.
// Platform-level numbers: companies, users, subscriptions, MRR, ARR.
// NOTE: super admin has no companyId — this file intentionally
// reads ACROSS companies (that's its whole job).
// ============================================================
import * as core from '../utils/reportingCore.js';

const ok = (res, status, data, message) => res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) => res.status(status).json({ statusCode: status, success: false, message });

// ⚙️ YOUR PRICES — edit these to match your real plans (₹ per month).
// MRR/ARR are calculated ONLY from companies on these paid plans.
export const PLAN_PRICING = { TRIAL: 0, BASIC: 499, PRO: 1499, ENTERPRISE: 3999 };

// Company docs may store plan/status under slightly different names —
// these two helpers read whichever exists. Easy to adjust later.
const getPlan = (company) => {
  return String(company.plan || company.subscriptionPlan || 'TRIAL').toUpperCase();
};
const getStatus = (company) => {
  return String(company.status || company.subscriptionStatus || 'ACTIVE').toUpperCase();
};

// MRR rule (business formula, one place only):
// paying = has a paid plan AND status is not expired/suspended/cancelled
const isPaying = (company) => {
  const notPaying = ['EXPIRED', 'SUSPENDED', 'CANCELLED', 'TRIAL_EXPIRED'];
  return getPlan(company) !== 'TRIAL' && !notPaying.includes(getStatus(company));
};
const monthlyRevenueOf = (companies) => {
  let total = 0;
  companies.forEach((company) => {
    if (isPaying(company)) total += PLAN_PRICING[getPlan(company)] || 0;
  });
  return total;
};

// GET /api/saas/overview
export const saasOverview = async (req, res) => {
  try {
    const Company = await core.getModel('Company');
    const User = await core.getModel('User');

    // Companies are few (even 1000s is tiny) → plain find + JS grouping is fine here
    const companies = await core.safe(
      () => Company.find({}).select('name plan status subscriptionStatus subscriptionPlan createdAt').lean(),
      []
    );

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const companiesBeforeThisMonth = companies.filter((c) => new Date(c.createdAt) < monthStart);

    // group companies by a key function → [{ name, count }]
    const groupBy = (getKey) => {
      const counts = {};
      companies.forEach((c) => {
        const key = getKey(c);
        counts[key] = (counts[key] || 0) + 1;
      });
      return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    };

    // ---- MRR / ARR ----
    const mrrNow = monthlyRevenueOf(companies);
    const mrrLastMonth = monthlyRevenueOf(companiesBeforeThisMonth);
    const mrrByPlan = {};
    companies.forEach((c) => {
      if (isPaying(c)) {
        const plan = getPlan(c);
        mrrByPlan[plan] = (mrrByPlan[plan] || 0) + (PLAN_PRICING[plan] || 0);
      }
    });
    const mrrGrowthPct = mrrLastMonth > 0 ? core.pct(mrrNow - mrrLastMonth, mrrLastMonth) : (mrrNow > 0 ? 100 : 0);

    // ---- platform users (logins need tracking later; we show what exists) ----
    const [usersByStatus, newUsersThisMonth] = await Promise.all([
      core.safe(() => User.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]), []),
      core.safe(() => User.countDocuments({ createdAt: { $gte: monthStart } }), 0),
    ]);
    const countStatus = (id) => usersByStatus.find((u) => u._id === id)?.count || 0;

    return ok(res, 200, {
      companies: {
        total: companies.length,
        byStatus: groupBy(getStatus),
        byPlan: groupBy(getPlan),
        trial: companies.filter((c) => getPlan(c) === 'TRIAL').length,
        newThisMonth: companies.filter((c) => new Date(c.createdAt) >= monthStart).length,
      },
      users: {
        total: usersByStatus.reduce((s, u) => s + u.count, 0),
        active: countStatus('ACTIVE'),
        inactive: countStatus('INACTIVE'),
        newThisMonth: newUsersThisMonth,
      },
      revenue: {
        mrr: mrrNow,
        mrrPrevMonth: mrrLastMonth,
        mrrGrowthPct,
        mrrByPlan: Object.entries(mrrByPlan).map(([plan, mrr]) => ({ plan, mrr })),
        arr: mrrNow * 12, // ARR = MRR × 12 (same formula everywhere)
        payingCompanies: companies.filter(isPaying).length,
      },
      pricing: PLAN_PRICING,
    }, 'SaaS analytics');
  } catch (error) {
    return fail(res, 500, error.message);
  }
};