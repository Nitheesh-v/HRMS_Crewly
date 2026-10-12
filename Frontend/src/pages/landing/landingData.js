// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE — ONE SOURCE OF TRUTH FOR EVERY SECTION'S CONTENT.
//
// JSX-free on purpose: the test suite imports this file directly, so the page's
// claims can be CHECKED rather than trusted.
//
// WHAT IS PINNED BY TEST (Frontend/test/landingPage.test.js)
//   · every price here vs Backend/src/utils/platformPlans.js
//   · the "14-day" claim vs TRIAL_DAYS in Backend/src/utils/constants.js
//   · "2 months free" vs the arithmetic of monthly × 10 === yearly
//   · every anchor here vs a real section id, and every link vs a real route
//
// WHAT IS DELIBERATELY ABSENT
//   Customers, logos, testimonials, usage counts. None of that exists in the
//   repository, so none of it exists here. The page earns trust with what the
//   product genuinely does (see SECURITY_POINTS and MODULES), not with numbers
//   nobody can check.
// ═══════════════════════════════════════════════════════════════════════════

// Anchors used by the header nav, the footer and the page sections. One list,
// so a nav item can never point at a section that does not exist.
export const SECTION_IDS = {
  modules: 'modules',
  workflow: 'workflow',
  security: 'security',
  pricing: 'pricing',
  faq: 'faq',
};

export const NAV_LINKS = [
  { label: 'Modules', href: `#${SECTION_IDS.modules}` },
  { label: 'How it works', href: `#${SECTION_IDS.workflow}` },
  { label: 'Security', href: `#${SECTION_IDS.security}` },
  { label: 'Pricing', href: `#${SECTION_IDS.pricing}` },
  { label: 'FAQ', href: `#${SECTION_IDS.faq}` },
];

export const BRAND = {
  name: 'Crewly',
  tagline: 'HR, payroll and presence — one workspace.',
  trialDays: 14,
};

// Honest capability chips. Each one is a fact about the codebase, not a boast.
export const TRUST_CHIPS = [
  { icon: 'shield', label: 'One tenant per company' },
  { icon: 'lock', label: 'HttpOnly cookie sessions' },
  { icon: 'key', label: 'Role-based access' },
  { icon: 'scroll', label: 'Full audit trail' },
  { icon: 'rupee', label: 'INR billing' },
  { icon: 'calendar', label: '14-day trial, no card' },
];

// Grouped from the real module inventory (SidebarNav + permission registry).
export const MODULE_GROUPS = [
  {
    title: 'People',
    blurb: 'The employee record everything else hangs off.',
    items: [
      { icon: 'users', name: 'Core HR', copy: 'Profiles, departments, reporting lines and an org chart that updates itself.' },
      { icon: 'fileText', name: 'Documents', copy: 'Employee files, categories and expiry reminders, stored per company.' },
      { icon: 'lifecycle', name: 'Lifecycle & Exit', copy: 'Onboarding checklists through to resignations and approvals.' },
      { icon: 'profileChange', name: 'Profile change requests', copy: 'Sensitive edits are requested, reviewed and then applied — with the old value kept.' },
    ],
  },
  {
    title: 'Time',
    blurb: 'Attendance that survives real working conditions.',
    items: [
      { icon: 'calendarCheck', name: 'Attendance', copy: 'Policy-driven check-in, regularisation, overtime, timesheets and QR/kiosk capture.' },
      { icon: 'workMode', name: 'Work location', copy: 'Office, WFH and remote requests with a review queue for approvers.' },
      { icon: 'activity', name: 'Presence', copy: 'Who is online, away or offline — corrected automatically when a session dies.' },
      { icon: 'plane', name: 'Leave', copy: 'Balances, policies and an approval trail your team can see.' },
    ],
  },
  {
    title: 'Money',
    blurb: 'Payroll that reconciles, not a spreadsheet in disguise.',
    items: [
      { icon: 'creditCard', name: 'Payroll', copy: 'Salary structures, monthly inputs, review, payment and payslips.' },
      { icon: 'rupee', name: 'Statutory', copy: 'PF, ESI, professional tax and TDS handled in the run, with F&F on exit.' },
      { icon: 'receipt', name: 'Expenses', copy: 'Claims, receipts and approvals without leaving the workspace.' },
      { icon: 'monitor', name: 'Assets', copy: 'Issued, returned and tracked per employee.' },
    ],
  },
  {
    title: 'Hire & grow',
    blurb: 'From a job post to a productive teammate.',
    items: [
      { icon: 'userPlus', name: 'Recruitment', copy: 'Requisitions, approvals, job posts, candidate pipeline and interview feedback.' },
      { icon: 'shieldCheck', name: 'Background checks', copy: 'Vendor orders, verifier workbench and a candidate consent portal.' },
      { icon: 'send', name: 'Offers & onboarding', copy: 'Offer letters, pre-onboarding documents and day-one setup.' },
      { icon: 'barChart', name: 'Performance', copy: 'Goals, reviews and appraisal cycles.' },
    ],
  },
  {
    title: 'Work together',
    blurb: 'The parts people actually open every day.',
    items: [
      { icon: 'message', name: 'Chat Hub', copy: 'Conversations, threads, mentions, reactions, attachments and moderation.' },
      { icon: 'video', name: 'Meetings', copy: 'Calendar, recurring series, invites and cancellations that notify the room.' },
      { icon: 'megaphone', name: 'Announcements', copy: 'Company-wide communication with read visibility.' },
      { icon: 'sparkles', name: 'AI Assistant', copy: 'Ask about your own records; answers stay inside your permissions.' },
    ],
  },
];

// Three alternating deep-dives. Every bullet describes behaviour that exists in
// the code — nothing aspirational, nothing "coming soon".
export const WORKFLOW_BLOCKS = [
  {
    key: 'hire',
    eyebrow: 'Hire',
    title: 'A requisition becomes a teammate, in one thread',
    points: [
      'Managers raise a requisition; HR approves it and it becomes a public job page for that company.',
      'Applications move through a pipeline with interview rounds, feedback and offers attached to the candidate.',
      'Background verification, if you use it, runs as its own workflow with vendor orders and a verifier workbench.',
      'Pre-onboarding collects documents before day one, so the first week is work and not paperwork.',
    ],
    cta: { label: 'Start with a free trial', to: '/register' },
  },
  {
    key: 'time',
    eyebrow: 'Time',
    title: 'Attendance feeds payroll without a re-typing step',
    points: [
      'Check-in follows the policy you configure — geo-fence, work mode, shift and location aware.',
      'Regularisations, overtime and timesheets route to the right approver and keep a decision trail.',
      'Monthly inputs and the payroll run read the same attendance truth, so disputes are settled by data.',
      'Statutory deductions and final settlement are computed in the run, not bolted on afterwards.',
    ],
    cta: { label: 'See the modules', href: `#${SECTION_IDS.modules}` },
  },
  {
    key: 'team',
    eyebrow: 'Team',
    title: 'Everyone sees only what they should',
    points: [
      'Presence marks a stale session offline automatically, so the team list is not a wall of ghosts.',
      'Managers and team leads get a scoped view of their people; employees get their own records.',
      'Sensitive profile fields move through a review workflow instead of being edited silently.',
      'Nothing is broadcast company-wide unless the person has the permission to do it.',
    ],
    cta: { label: 'Read about security', href: `#${SECTION_IDS.security}` },
  },
];

// Every point here maps to something implemented (see plan §A8).
export const SECURITY_POINTS = [
  {
    icon: 'shield',
    title: 'Tenant isolation by default',
    copy: 'Every record carries the company it belongs to, and every query is scoped to it. A search that leaks across companies is a bug class we test for, not a setting.',
  },
  {
    icon: 'lock',
    title: 'Sessions you can revoke',
    copy: 'The customer session rides in an HttpOnly cookie, so no script on the page can read it. Active sessions are listed and can be ended by the owner.',
  },
  {
    icon: 'key',
    title: 'Roles and per-person permissions',
    copy: 'Company Admin, HR Manager, Manager, Team Lead and Employee ship with sensible defaults, and a permission catalogue supports per-user overrides when a role is not enough.',
  },
  {
    icon: 'scroll',
    title: 'An audit trail that survives review',
    copy: 'Approvals, payroll actions, permission changes and administrative edits are recorded with the actor and the time, and can be read back in the workspace.',
  },
  {
    icon: 'shieldCheck',
    title: 'Reviews where money moves',
    copy: 'Payroll has an explicit review step before payment, and background verification is an approval workflow with its own roles.',
  },
  {
    icon: 'database',
    title: 'Your data stays yours',
    copy: 'If a subscription lapses, the workspace goes read-only instead of disappearing: nothing is deleted while you decide.',
  },
];

// Pricing is mirrored from the platform catalogue and pinned by test. `yearly`
// is exactly ten months for every paid tier, which is where "2 months free"
// comes from — the number is derived, not asserted.
export const PLANS = [
  {
    code: 'FREE',
    name: 'Free',
    tagline: 'For a small team trying the basics.',
    monthly: 0,
    yearly: 0,
    highlights: ['Up to 5 employees', 'Attendance and leave', '1 administrator', 'Community support'],
    cta: { label: 'Create a workspace', to: '/register' },
  },
  {
    code: 'BASIC',
    name: 'Basic',
    tagline: 'Payroll and the core of an HR desk.',
    monthly: 999,
    yearly: 9990,
    highlights: ['Up to 25 employees', 'Payroll and payslips', 'Documents and projects', 'Email support'],
    cta: { label: 'Start free, upgrade later', to: '/register' },
    featured: false,
  },
  {
    code: 'PRO',
    name: 'Professional',
    tagline: 'Hiring, performance and reporting.',
    monthly: 2499,
    yearly: 24990,
    highlights: ['Up to 100 employees', 'Recruitment and interviews', 'Performance cycles', 'Reports and analytics'],
    cta: { label: 'Start free, upgrade later', to: '/register' },
    featured: true,
  },
  {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    tagline: 'Scale, controls and API access.',
    monthly: 4999,
    yearly: 49990,
    highlights: ['Unlimited scale with usage limits set per tenant', 'Advanced RBAC and overrides', 'API access and exports', 'Priority support'],
    cta: { label: 'Talk to us after signing up', to: '/register' },
  },
];

export const PRICING_NOTE =
  'Prices are in INR, per company. The 14-day trial starts when you register — no card, and no automatic charge when it ends.';

export const FAQS = [
  {
    q: 'How long is the trial, and does it need a card?',
    a: 'Fourteen days, starting the moment your company is registered. Registration asks for your company, your name, an email and a password — there is no payment step anywhere in signup.',
  },
  {
    q: 'What happens when the trial ends?',
    a: 'Your workspace becomes read-only on changes until a plan is chosen: you can still open and read everything, and nothing is deleted while you decide.',
  },
  {
    q: 'Can one login see another company\u2019s data?',
    a: 'No. Each company is its own tenant: records carry the company they belong to and every query is scoped to it. Roles and permissions decide what a person sees inside their own company.',
  },
  {
    q: 'Which roles can we assign?',
    a: 'Company Admin, HR Manager, Manager, Team Lead and Employee come prepared with sensible defaults. Where a role is not a precise fit, individual permissions can be overridden for that person.',
  },
  {
    q: 'Do we need to install anything?',
    a: 'No. Crewly runs in the browser, including attendance capture on phones through QR and kiosk check-in. There is no desktop install for your team to maintain.',
  },
  {
    q: 'Can we start small and add modules later?',
    a: 'Yes. Attendance, leave and documents work on the smallest plan; payroll, hiring, performance and reporting turn on as you grow.',
  },
];

export const FOOTER_COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Modules', href: `#${SECTION_IDS.modules}` },
      { label: 'How it works', href: `#${SECTION_IDS.workflow}` },
      { label: 'Security', href: `#${SECTION_IDS.security}` },
      { label: 'Pricing', href: `#${SECTION_IDS.pricing}` },
      { label: 'FAQ', href: `#${SECTION_IDS.faq}` },
    ],
  },
  {
    title: 'Modules',
    links: [
      { label: 'Attendance & leave', href: `#${SECTION_IDS.modules}` },
      { label: 'Payroll & statutory', href: `#${SECTION_IDS.modules}` },
      { label: 'Recruitment & onboarding', href: `#${SECTION_IDS.modules}` },
      { label: 'Chat, meetings & tasks', href: `#${SECTION_IDS.modules}` },
      { label: 'Reports & analytics', href: `#${SECTION_IDS.modules}` },
    ],
  },
  {
    title: 'Get started',
    links: [
      { label: 'Create a company', to: '/register' },
      { label: 'Sign in', to: '/login' },
      { label: 'Forgot password', to: '/forgot-password' },
    ],
  },
];

// The support column deliberately does not invent an email address or a phone
// number: support is a real screen inside every workspace.
export const FOOTER_SUPPORT = {
  title: 'Support',
  copy: 'Every workspace has a support desk built in: raise a ticket, follow the replies and keep the history inside your own company.',
  link: { label: 'Sign in to raise a ticket', to: '/login' },
};

export default {
  BRAND,
  SECTION_IDS,
  NAV_LINKS,
  TRUST_CHIPS,
  MODULE_GROUPS,
  WORKFLOW_BLOCKS,
  SECURITY_POINTS,
  PLANS,
  PRICING_NOTE,
  FAQS,
  FOOTER_COLUMNS,
  FOOTER_SUPPORT,
};
