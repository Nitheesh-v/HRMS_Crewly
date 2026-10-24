// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE (`/`) — ONE SOURCE OF TRUTH FOR EVERY SECTION.
//
// JSX-free on purpose: the test suite imports this file directly, so the page's
// claims can be CHECKED rather than trusted.
//
// WHAT IS PINNED BY TEST (Frontend/test/landingPage.test.js)
//   · every price here          vs Backend/src/utils/platformPlans.js
//   · the "14-day" claim        vs TRIAL_DAYS in Backend/src/utils/constants.js
//   · "2 months free"           vs the arithmetic of monthly × 10 === yearly
//   · the role names            vs ROLE_LABELS in permissionRegistry.js
//   · the AI language count     vs PLATFORM_CHAT_LANGUAGES in chatLanguages.js
//   · every anchor              vs a section id that is actually rendered
//   · every link                vs a route that exists in AppRoutes.jsx
//
// WHAT IS DELIBERATELY ABSENT
//   Customers, logos, testimonials, usage counts, compliance badges. None of
//   that exists in the repository, so none of it exists here. The page is loud
//   about what the product genuinely does — read the copy as a description of
//   the code, not as a promise about the market.
// ═══════════════════════════════════════════════════════════════════════════

// Anchors used by the header nav, the footer and the page sections. One list,
// so a nav item can never point at a section that does not exist.
export const SECTION_IDS = {
  product: 'product',
  capabilities: 'capabilities',
  ai: 'ai',
  roles: 'roles',
  security: 'security',
  pricing: 'pricing',
  faq: 'faq',
};

export const NAV_LINKS = [
  { label: 'Product', href: `#${SECTION_IDS.product}` },
  { label: 'Capabilities', href: `#${SECTION_IDS.capabilities}` },
  { label: 'AI', href: `#${SECTION_IDS.ai}` },
  { label: 'Security', href: `#${SECTION_IDS.security}` },
  { label: 'Pricing', href: `#${SECTION_IDS.pricing}` },
];

export const BRAND = {
  name: 'Crewly',
  tagline: 'HR, payroll and presence — one workspace.',
  trialDays: 14,
};

export const HERO = {
  badge: 'Built for Indian payroll',
  badgeNote: 'INR billing · 14-day trial',
  titleLead: 'The HRMS that stops',
  titleAccent: 'arguing with itself',
  copy:
    'Attendance, leave, timesheets and payslips read one employee record — so the month closes once, the numbers agree, and nobody chases an approval through email again.',
  primaryCta: { label: 'Start free — no card', to: '/register' },
  secondaryCta: { label: 'See it in action', href: `#${SECTION_IDS.product}` },
  assurances: ['No card at signup', 'Live in minutes', 'Read-only if you stop — nothing deleted'],
};

// Facts the page can stand behind. Each one is a shipped behaviour, not a
// capability we would like to have. Looped under the hero.
export const WORKPLACE_FACTS = [
  { icon: 'monitor', label: 'Runs in the browser — no install' },
  { icon: 'qr', label: 'QR check-in from a phone' },
  { icon: 'kiosk', label: 'Shared kiosk tablet with a PIN' },
  { icon: 'upload', label: 'CSV attendance import' },
  { icon: 'fileText', label: 'PDF payslips, offers and letters' },
  { icon: 'mail', label: 'Email delivery for invites and alerts' },
  { icon: 'message', label: 'Realtime chat, threads and presence' },
  { icon: 'sparkles', label: 'AI answers inside your permissions' },
];

// The product moment: three callouts pinned around the big dashboard.
export const PRODUCT_MOMENT = {
  eyebrow: 'The whole company, one screen',
  title: 'Open it once. Know where the month stands.',
  copy:
    'Present, on leave, joining, payroll due — the same numbers the payroll run will read. No export, no reconciliation sheet, no “let me check with HR”.',
  callouts: [
    { icon: 'calendarCheck', title: 'Attendance you can defend', copy: 'Geo-fence, shift and work-mode aware, with a decision trail on every regularisation.' },
    { icon: 'creditCard', title: 'Payroll you can review', copy: 'Inputs lock, the run computes PF, ESI, PT and TDS, a human approves, then it pays.' },
    { icon: 'sparkles', title: 'AI that cites the record', copy: 'Ask about a balance or a payslip and the answer stays inside your permissions.' },
  ],
};

// Six capability cards. Every bullet is a shipped screen, not a roadmap item.
export const CAPABILITIES = [
  {
    key: 'payroll',
    icon: 'creditCard',
    name: 'Payroll & statutory',
    line: 'The month closes with a review, not a spreadsheet.',
    points: [
      'Components → structures → per-employee profiles.',
      'PF, ESI, professional tax and TDS computed in the run.',
      'Final settlement and payslips from the numbers that were paid.',
    ],
    accent: 'emerald',
  },
  {
    key: 'attendance',
    icon: 'calendarCheck',
    name: 'Time & attendance',
    line: 'Attendance that survives real working conditions.',
    points: [
      'Geo-fence, location, work mode and shift aware check-in.',
      'QR and kiosk capture for shared terminals, plus CSV import.',
      'Regularisation, overtime and timesheets with approvals.',
    ],
    accent: 'emerald',
  },
  {
    key: 'hiring',
    icon: 'userPlus',
    name: 'Hiring & onboarding',
    line: 'From a requisition to a productive teammate.',
    points: [
      'Requisitions, approvals and a per-company career site.',
      'Pipeline, interview rounds, scorecards and offers.',
      'Background checks, pre-onboarding and conversion to employee.',
    ],
    accent: 'emerald',
  },
  {
    key: 'people',
    icon: 'users',
    name: 'People & records',
    line: 'One record every other module reads.',
    points: [
      'Profiles, departments, reporting lines and an auto-built org chart.',
      'Documents with categories and expiry reminders.',
      'Profile change requests — requested, reviewed, then applied.',
    ],
    accent: 'emerald',
  },
  {
    key: 'performance',
    icon: 'barChart',
    name: 'Performance',
    line: 'Goals, self reviews and ratings in one cycle.',
    points: [
      'Goals set and approved inside the cycle.',
      'Self review, then team-lead and manager review.',
      'Final rating published with the history kept.',
    ],
    accent: 'violet',
  },
  {
    key: 'work',
    icon: 'message',
    name: 'Work together',
    line: 'The parts people actually open every morning.',
    points: [
      'Chat with threads, mentions, reactions and moderation.',
      'Meetings, announcements, referrals and a support desk.',
      'Presence that corrects itself when a session dies.',
    ],
    accent: 'violet',
  },
];

// Grouped from the real module inventory (SidebarNav + permission registry).
// The page shows six capabilities above and uses these as the honest "and the
// rest of it" strip, so nothing is claimed that the product does not ship.
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

// ── The AI layer ───────────────────────────────────────────────────────────
// Counted from Frontend/src/components/AIAssistant/chatLanguages.js by test, so
// "14 languages" cannot drift away from the language list the product ships.
// An unconfigured tenant offers five of them; an admin widens the set.
export const AI_LAYER = {
  eyebrow: 'Crewly AI',
  title: 'It answers from your records. Not the internet.',
  copy:
    'The assistant is a tenant setting: the provider, the languages and the usage limits belong to your company. It reads only the HR context the asker may see, redacts personal data before anything leaves the platform, and meters every request.',
  languageCount: 14,
  defaultLanguageCount: 5,
  capabilities: [
    {
      icon: 'sparkles',
      tag: 'It responds',
      title: 'Ask about your own records',
      copy:
        'Leave balance, attendance for the month, the last payslip, a policy question — answered from the same records the screens read, inside the asker\u2019s permissions.',
    },
    {
      icon: 'languages',
      tag: 'It speaks your language',
      title: 'Fourteen languages, five out of the box',
      copy:
        'English, Tamil, Tanglish, Hindi, Telugu, Kannada and more — including transliterated speech, because that is how teams actually type. A company admin picks the set.',
    },
    {
      icon: 'shieldCheck',
      tag: 'It stays in bounds',
      title: 'Redacted context, metered usage',
      copy:
        'Personal data is redacted on the way out, answers are scoped to what the person may read, and every company sees its own AI usage without seeing anyone else\u2019s.',
    },
  ],
  demo: {
    title: 'Crewly AI',
    subtitle: 'Answers from your records',
    question: 'How many leave days do I have left this year?',
    answer:
      'You have 9 casual leave days left of 12. Two days are pending approval for 4 November.',
    citation: 'Source: your leave balance · FY 2026',
    chips: ['Attendance this month', 'My last payslip', 'Apply for leave'],
    note: 'Illustrative conversation — no live company data is used on this page.',
  },
};

// The five shipped roles and what each one is for. Names are pinned by test
// against ROLE_LABELS in Backend/src/utils/permissionRegistry.js.
export const ROLE_CARDS = [
  {
    code: 'COMPANY_ADMIN',
    name: 'Company Admin',
    copy: 'Owns the workspace: people, payroll, roles and the settings nobody else should touch.',
    sees: ['Roles & permissions', 'Billing & subscription', 'Audit logs', 'AI settings & usage'],
    icon: 'key',
    featured: true,
  },
  {
    code: 'HR_MANAGER',
    name: 'HR Manager',
    copy: 'Runs the HR desk day to day — hiring, attendance, payroll runs, documents and exit.',
    sees: ['Recruitment', 'Attendance & leave', 'Payroll', 'Documents'],
    icon: 'users',
  },
  {
    code: 'MANAGER',
    name: 'Manager',
    copy: 'Approves for their team and sees their people, never the whole company.',
    sees: ['Team approvals', 'Team attendance', 'Reviews', 'Reports for the team'],
    icon: 'briefcase',
  },
  {
    code: 'TEAM_LEAD',
    name: 'Team Lead',
    copy: 'Keeps the day honest: timesheets, availability and the first approval in the chain.',
    sees: ['Team timesheets', 'Availability', 'Regularisation review', 'Goals'],
    icon: 'users',
  },
  {
    code: 'EMPLOYEE',
    name: 'Employee',
    copy: 'Self-service without the HR email thread: punch, apply, download, ask.',
    sees: ['My attendance', 'Leave & payslips', 'My documents', 'Chat, tickets & AI'],
    icon: 'userCircle',
  },
];

// Every point here maps to something implemented.
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
    cta: { label: 'Start free, then talk', to: '/register' },
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
    q: 'Which languages does the AI assistant speak?',
    a: 'Fourteen, including English, Tamil, Tanglish, Hindi, Telugu and Kannada. English, Tamil, Tanglish, Hindi and Telugu are available by default; a company admin adds the rest in AI settings.',
  },
  {
    q: 'Can we bring our existing attendance data across?',
    a: 'Yes — attendance has a CSV import that is reviewed before it lands, so history does not have to start from zero on day one. Employee records, departments and salary structures are set up per company.',
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
      { label: 'The product', href: `#${SECTION_IDS.product}` },
      { label: 'Capabilities', href: `#${SECTION_IDS.capabilities}` },
      { label: 'Crewly AI', href: `#${SECTION_IDS.ai}` },
      { label: 'Security', href: `#${SECTION_IDS.security}` },
      { label: 'Pricing', href: `#${SECTION_IDS.pricing}` },
      { label: 'FAQ', href: `#${SECTION_IDS.faq}` },
    ],
  },
  {
    title: 'Modules',
    links: [
      { label: 'Attendance & leave', href: `#${SECTION_IDS.capabilities}` },
      { label: 'Payroll & statutory', href: `#${SECTION_IDS.capabilities}` },
      { label: 'Recruitment & onboarding', href: `#${SECTION_IDS.capabilities}` },
      { label: 'Chat, meetings & tasks', href: `#${SECTION_IDS.capabilities}` },
      { label: 'Reports & analytics', href: `#${SECTION_IDS.capabilities}` },
    ],
  },
  {
    title: 'Who it is for',
    links: [
      { label: 'Company admin', href: `#${SECTION_IDS.roles}` },
      { label: 'HR managers', href: `#${SECTION_IDS.roles}` },
      { label: 'Managers & team leads', href: `#${SECTION_IDS.roles}` },
      { label: 'Employees', href: `#${SECTION_IDS.roles}` },
      { label: 'How it works', href: `#${SECTION_IDS.product}` },
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

// The footer's bottom bar. Legal pages do not exist yet, so they are stated as
// plain text (the same honesty rule as above) instead of rendered as links.
export const LEGAL_NOTE = {
  label: 'Legal',
  text: 'Terms and Privacy pages are not published yet — this footer will not dress them up as links until they are.',
};

// The bar that follows the reader down the page. It is the same promise the
// hero makes, repeated once it has scrolled out of sight — nothing new, no
// countdown, no urgency it cannot back up.
export const STICKY_CTA = {
  label: 'Start free',
  note: 'No card · 14-day trial',
  href: '/register',
};

export default {
  BRAND,
  SECTION_IDS,
  NAV_LINKS,
  HERO,
  WORKPLACE_FACTS,
  PRODUCT_MOMENT,
  CAPABILITIES,
  MODULE_GROUPS,
  AI_LAYER,
  ROLE_CARDS,
  SECURITY_POINTS,
  PLANS,
  PRICING_NOTE,
  FAQS,
  FOOTER_COLUMNS,
  FOOTER_SUPPORT,
  LEGAL_NOTE,
  STICKY_CTA,
};
