// ============================================================
// 👑 ADMIN CONTROLLER — platform (super admin) insights
// Read-heavy; all queries platform-wide (no companyId scoping here
// by design — this is the SaaS owner looking across tenants).
// ============================================================
import * as CompanyNS from '../models/Company.js';
import * as SubscriptionNS from '../models/Subscription.js';
import * as PaymentNS from '../models/Payment.js';
import * as UserNS from '../models/User.js';
import * as asyncHandlerNS from '../utils/asyncHandler.js';

const pickModel = (ns) =>
  typeof ns.default === 'function' ? ns.default : ns.default || ns;

const Company = pickModel(CompanyNS);
const Subscription = pickModel(SubscriptionNS);
const Payment = pickModel(PaymentNS);
const User = pickModel(UserNS);
const asyncHandler =
  typeof asyncHandlerNS.default === 'function'
    ? asyncHandlerNS.default
    : asyncHandlerNS.asyncHandler;

// 💰 Plan catalog (₹/month) — kept local so this controller is self-contained
const PLAN_PRICE = { BASIC: 999, PRO: 2499, ENTERPRISE: 4999 };

// Payment "amount" may be stored in rupees (24,990) or paise (2,499,000)
// depending on which flow created it. Anything >= 60,000 is safely paise
// (max real rupee amount is ENTERPRISE yearly 49,990; min paise is 99,900).
const toRupees = (amount) => (Number(amount) >= 60000 ? Number(amount) / 100 : Number(amount));

const HEALTHY_PAYMENT = { $nin: ['FAILED', 'PENDING', 'CREATED', 'REFUNDED'] };
// The Crewly platform's own company is not a customer — always exclude it
const NOT_PLATFORM = { code: { $nin: ['crewly', 'CREWLY', 'Crewly'] } };

// ── GET /admin-api/overview ───────────────────────────────────────────────
const overview = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const companies = await Company.find(NOT_PLATFORM).select('_id status').lean();
  const ids = companies.map((c) => c._id);

  const subs = await Subscription.find({ company: { $in: ids } }).lean();
  const payments = await Payment.find({
    company: { $in: ids },
    status: HEALTHY_PAYMENT,
  })
    .sort({ createdAt: -1 })
    .lean();

  // Latest payment per company tells us the billing cycle
  const cycleOf = {};
  payments.forEach((p) => {
    const key = String(p.company);
    if (!cycleOf[key]) cycleOf[key] = String(p.billingCycle || '').toUpperCase();
  });

  let mrr = 0;
  let activePaid = 0;
  let trialing = 0;
  subs.forEach((s) => {
    if (s.status === 'EXPIRED') return;
    if (PLAN_PRICE[s.plan]) {
      activePaid += 1;
      // yearly = pay 10 months, so monthly-equivalent = price * 10 / 12
      mrr += cycleOf[String(s.company)] === 'YEARLY' ? (PLAN_PRICE[s.plan] * 10) / 12 : PLAN_PRICE[s.plan];
    } else {
      trialing += 1;
    }
  });

  // Data to frontend - response to frontend
  res.json({
    success: true,
    data: {
      totalCompanies: companies.length,
      trialing,
      activePaid,
      suspended: companies.filter((c) => c.status === 'SUSPENDED').length,
      mrr: Math.round(mrr),
    },
  });
});

// ── GET /admin-api/companies ──────────────────────────────────────────────
const companies = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const list = await Company.find(NOT_PLATFORM).sort({ createdAt: -1 }).lean();
  const ids = list.map((c) => c._id);

  const [subs, counts] = await Promise.all([
    Subscription.find({ company: { $in: ids } }).lean(),
    User.aggregate([
      { $match: { companyId: { $in: ids } } },
      { $group: { _id: '$companyId', n: { $sum: 1 } } },
    ]),
  ]);

  const subOf = Object.fromEntries(subs.map((s) => [String(s.company), s]));
  const empOf = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));

  const rows = list.map((c) => {
    const sub = subOf[String(c._id)];
    const daysLeft = sub?.endDate
      ? Math.ceil((new Date(sub.endDate).getTime() - Date.now()) / 86400000)
      : null;
    return {
      id: c._id,
      name: c.name,
      code: c.code,
      email: c.email,
      status: c.status,
      plan: sub?.plan || 'TRIAL',
      subStatus: sub?.status || '—',
      endDate: sub?.endDate || null,
      daysLeft,
      employees: empOf[String(c._id)] || 0,
    };
  });

  // Data to frontend - response to frontend
  res.json({ success: true, data: rows });
});

// ── GET /admin-api/revenue — last 12 months, zero-filled ──────────────────
const revenue = asyncHandler(async (req, res) => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  // DB Logic - DB logics
  const grouped = await Payment.aggregate([
    { $match: { createdAt: { $gte: start }, status: HEALTHY_PAYMENT } },
    {
      $group: {
        _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
        total: {
          // normalize paise → rupees per document while summing
          $sum: { $cond: [{ $gte: ['$amount', 60000] }, { $divide: ['$amount', 100] }, '$amount'] },
        },
      },
    },
  ]);

  const byKey = Object.fromEntries(grouped.map((g) => [`${g._id.y}-${g._id.m}`, g.total]));

  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    months.push({
      key,
      label: `${d.toLocaleString('en', { month: 'short' })} ${String(d.getFullYear()).slice(2)}`,
      total: Math.round(byKey[key] || 0),
    });
  }

  // Data to frontend - response to frontend
  res.json({ success: true, data: months });
});

// ── PATCH /admin-api/companies/:id/status — suspend / activate ────────────
const setCompanyStatus = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { status } = req.body;
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
    return res.status(400).json({ success: false, message: 'status must be ACTIVE or SUSPENDED' });
  }
  // DB Logic - DB logics
  const company = await Company.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!company) {
    return res.status(404).json({ success: false, message: 'Company not found' });
  }
  // Data to frontend - response to frontend
  res.json({
    success: true,
    message: `${company.name} is now ${status}`,
    data: { id: company._id, status: company.status },
  });
});

export { overview, companies, revenue, setCompanyStatus };
export default { overview, companies, revenue, setCompanyStatus };