// ─────────────────────────────────────────────────────────────
// SaaS plan catalog — prices, limits and feature bullets.
// Used by billing (companies) AND super admin (MRR math).
// ─────────────────────────────────────────────────────────────
export const PLAN_CATALOG = {
  TRIAL: {
    name: 'Trial', price: 0, days: 14,
    limits: { employees: 10, storageMB: 512 },
    features: ['10 employees', 'All core modules', '14 days free'],
  },
  BASIC: {
    name: 'Basic', price: 999, days: 30,
    limits: { employees: 25, storageMB: 1024 },
    features: ['25 employees', '1 GB storage', 'All core modules', 'Email support'],
  },
  PRO: {
    name: 'Pro', price: 2499, days: 30,
    limits: { employees: 100, storageMB: 5120 },
    features: ['100 employees', '5 GB storage', 'All modules + Analytics', 'Priority support'],
  },
  ENTERPRISE: {
    name: 'Enterprise', price: 4999, days: 30,
    limits: { employees: 500, storageMB: 20480 },
    features: ['500 employees', '20 GB storage', 'Everything + SLA', 'Dedicated manager'],
  },
};

// Yearly billing: pay 10 months, get 12 🎁
export const priceFor = (plan, months = 1) => {
  const p = PLAN_CATALOG[plan];
  if (!p) return 0;
  return months === 12 ? p.price * 10 : p.price;
};