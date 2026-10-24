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
//   that exists in the repository, so none of it exists here. The page earns
//   attention with what the product genuinely does — read the copy as a
//   description of the code, not as a promise about the market.
// ═══════════════════════════════════════════════════════════════════════════

// Anchors used by the header nav, the footer and the page sections. One list,
// so a nav item can never point at a section that does not exist.
export const SECTION_IDS = {
  platform: 'platform',
  modules: 'modules',
  ai: 'ai',
  workflow: 'workflow',
  roles: 'roles',
  security: 'security',
  pricing: 'pricing',
  faq: 'faq',
};

// The thin bar above the header. It announces something that is already live
// (the assistant, its language list and its usage metering all ship today).
export const ANNOUNCEMENT = {
  badge: 'New',
  text: 'Crewly AI answers HR questions in your team\u2019s own language — inside their permissions.',
  link: { label: 'See how it works', href: `#${SECTION_IDS.ai}` },
  dismissLabel: 'Dismiss announcement',
};

export const NAV_LINKS = [
  { label: 'Platform', href: `#${SECTION_IDS.platform}`, opensPlatformMenu: true },
  { label: 'AI', href: `#${SECTION_IDS.ai}` },
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

export const HERO = {
  eyebrow: 'AI assistant and presence, built in',
  titleLead: 'HR, payroll and attendance that finally',
  titleAccent: 'agree with each other',
  copy:
    'Crewly keeps the people record, the timesheet and the payslip on one data model — so payroll reconciles itself, approvals stop living in email, and every company stays a tenant of its own.',
  primaryCta: { label: 'Start your free trial', to: '/register' },
  secondaryCta: { label: 'See it in action', href: `#${SECTION_IDS.platform}` },
  assurances: ['No credit card', 'Nothing to install', 'Read-only if you stop — nothing deleted'],
  footnotes: ['Built for Indian payroll', 'INR billing', 'Multi-tenant by design'],
};

// Facts the hero can stand behind: each one is a shipped behaviour, not a
// capability we would like to have. Shown as a slow marquee under the fold.
export const WORKPLACE_FACTS = [
  { icon: 'monitor', label: 'Runs in the browser — no desktop install' },
  { icon: 'qr', label: 'QR check-in from a phone' },
  { icon: 'kiosk', label: 'Shared kiosk tablet with a PIN' },
  { icon: 'upload', label: 'CSV attendance import' },
  { icon: 'fileText', label: 'PDF payslips, offers and letters' },
  { icon: 'mail', label: 'Email delivery for invites and alerts' },
  { icon: 'message', label: 'Realtime chat, threads and presence' },
  { icon: 'sparkles', label: 'AI answers inside your permissions' },
];

// Honest capability chips. Each one is a fact about the codebase, not a boast.
export const TRUST_CHIPS = [
  { icon: 'shield', label: 'One tenant per company' },
  { icon: 'lock', label: 'HttpOnly cookie sessions' },
  { icon: 'key', label: 'Role-based access' },
  { icon: 'scroll', label: 'Full audit trail' },
  { icon: 'rupee', label: 'INR billing' },
  { icon: 'calendar', label: '14-day trial, no card' },
];

// ── The platform, in six areas (the tabbed deep-dive) ──────────────────────
// Every bullet describes behaviour that exists. `preview` names the product
// mock rendered beside it by PlatformSection.jsx.
export const PLATFORM_TABS = [
  {
    key: 'payroll',
    label: 'Payroll & statutory',
    short: 'Payroll',
    icon: 'creditCard',
    eyebrow: 'Payroll and compliance',
    title: 'Run payroll accurately, every single cycle',
    copy:
      'Salary components build into structures, structures attach to people, and monthly inputs land on top. Payroll then runs once, is reviewed by a human, and only then is paid.',
    points: [
      'Salary components, structures and per-employee payroll profiles.',
      'Monthly inputs for what changed — the run reads them, nobody re-types them.',
      'An explicit review step before any payment is marked as made.',
      'PF, ESI, professional tax and TDS computed in the run, with final settlement on exit.',
      'Payslips generated from the same numbers that were paid.',
    ],
    footnote: 'Payslips and reports can carry your company branding.',
    preview: 'payroll',
  },
  {
    key: 'people',
    label: 'Core HR & records',
    short: 'People',
    icon: 'users',
    eyebrow: 'The employee record',
    title: 'One record that every other module reads',
    copy:
      'Employee profiles, departments, reporting lines and documents live in one place. Change a reporting line and the org chart, the team views and the approval routing follow.',
    points: [
      'Profiles, departments, designations, reporting lines and an auto-built org chart.',
      'Employee documents with categories and expiry reminders.',
      'Sensitive profile edits move through a change request instead of a silent save.',
      'Lifecycle from onboarding checklists through to resignation and exit.',
      'Assets issued and returned, recorded against the person.',
    ],
    footnote: 'Every query is scoped to the company the record belongs to.',
    preview: 'people',
  },
  {
    key: 'hiring',
    label: 'Hiring & onboarding',
    short: 'Hiring',
    icon: 'userPlus',
    eyebrow: 'Recruitment and onboarding',
    title: 'From a requisition to a productive teammate',
    copy:
      'Managers raise a requisition, HR approves it, and it becomes a public job page for that company. Applications then move through one pipeline until the candidate becomes an employee.',
    points: [
      'Requisitions with approval, then a per-company career site and job pages.',
      'A candidate pipeline with interview rounds, feedback and scorecards.',
      'Offers with branding, sent through a token-secured candidate portal.',
      'Background verification as its own workflow, with vendor orders and a verifier workbench.',
      'Pre-onboarding collects documents before day one; conversion creates the employee.',
    ],
    footnote: 'Candidates never get an employee session — the portals are token-scoped.',
    preview: 'hiring',
  },
  {
    key: 'attendance',
    label: 'Time & attendance',
    short: 'Attendance',
    icon: 'calendarCheck',
    eyebrow: 'Attendance and leave',
    title: 'Attendance that survives real working conditions',
    copy:
      'Check-in follows the policy you configured, not a single hard-coded rule. Field teams, shifts, offices and work-from-home all land in the same month, ready for payroll.',
    points: [
      'Policy-driven check-in: geo-fence, location, work mode and shift aware.',
      'QR and kiosk capture for people who share a terminal, plus CSV imports for history.',
      'Regularisation, overtime and timesheet approvals with a decision trail.',
      'Leave policies, balances and an approval trail the whole team can see.',
      'Weekly hour targets and earned rest handled by the same rules engine.',
    ],
    footnote: 'Attendance analytics read the same records payroll does.',
    preview: 'attendance',
  },
  {
    key: 'performance',
    label: 'Performance & growth',
    short: 'Performance',
    icon: 'barChart',
    eyebrow: 'Goals and reviews',
    title: 'Goals, self reviews and ratings in one cycle',
    copy:
      'An appraisal moves through goal setting, the work period, a self review, then lead and manager review, and ends with a published rating — with the history kept.',
    points: [
      'Goals set by the employee and approved inside the cycle.',
      'Progress updated during the period, not reconstructed afterwards.',
      'Self review followed by team lead and manager review.',
      'Final rating published with the full history retained.',
      'HR controls the cycle and can enrol anyone who was missed.',
    ],
    footnote: 'The review board is scoped: a lead sees their team, HR sees the company.',
    preview: 'performance',
  },
  {
    key: 'collaboration',
    label: 'Projects, chat & meetings',
    short: 'Collaboration',
    icon: 'message',
    eyebrow: 'The daily surfaces',
    title: 'The parts people actually open every morning',
    copy:
      'Work does not stop at the HR record. Crewly carries projects and tasks, a chat hub with threads and reactions, meetings, announcements and referrals in the same workspace.',
    points: [
      'Projects and tasks with owners, due dates and status.',
      'Chat Hub with conversations, threads, mentions, reactions, attachments and moderation.',
      'Presence that corrects itself when a session dies, so the team list is honest.',
      'Meetings with recurring series, invites and cancellations that notify the room.',
      'Announcements, employee referrals and a support desk inside each company.',
    ],
    footnote: 'Realtime runs over the same origin as the app — no third-party widget.',
    preview: 'collaboration',
  },
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

// ── The AI layer ───────────────────────────────────────────────────────────
// Counted from Frontend/src/components/AIAssistant/chatLanguages.js by test, so
// "14 languages" cannot drift away from the language list the product ships.
// An unconfigured tenant offers five of them; an admin widens the set.
export const AI_LAYER = {
  eyebrow: 'Crewly AI',
  title: 'An assistant that answers from your records, not the internet',
  copy:
    'The assistant is configured per company: the provider, the languages it may speak and the usage limits are all tenant settings. It retrieves the HR context the asker is allowed to see, redacts personal data before anything leaves the platform, and meters every request.',
  languageCount: 14,
  defaultLanguageCount: 5,
  capabilities: [
    {
      icon: 'sparkles',
      tag: 'AI responds',
      title: 'Ask about your own records',
      copy:
        'Leave balance, attendance for the month, the last payslip, a policy question — answered from the same records the screens read, within the asker\u2019s permissions.',
    },
    {
      icon: 'languages',
      tag: 'AI in your language',
      title: 'Fourteen languages, five out of the box',
      copy:
        'English, Tamil, Tanglish, Hindi, Telugu, Kannada and more — including transliterated speech, because that is how teams actually type. A company admin picks the set.',
    },
    {
      icon: 'shieldCheck',
      tag: 'AI with guardrails',
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
      { label: 'Platform', href: `#${SECTION_IDS.platform}` },
      { label: 'All modules', href: `#${SECTION_IDS.modules}` },
      { label: 'Crewly AI', href: `#${SECTION_IDS.ai}` },
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
    title: 'Who it is for',
    links: [
      { label: 'Company admin', href: `#${SECTION_IDS.roles}` },
      { label: 'HR managers', href: `#${SECTION_IDS.roles}` },
      { label: 'Managers & team leads', href: `#${SECTION_IDS.roles}` },
      { label: 'Employees', href: `#${SECTION_IDS.roles}` },
      { label: 'How it works', href: `#${SECTION_IDS.workflow}` },
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
// plain text (the same honesty rule as above) instead of rendered as links that
// go nowhere.
export const LEGAL_NOTE = {
  label: 'Legal',
  text: 'Terms and Privacy pages are not published yet — this footer will not dress them up as links until they are.',
};

export default {
  BRAND,
  SECTION_IDS,
  ANNOUNCEMENT,
  NAV_LINKS,
  HERO,
  WORKPLACE_FACTS,
  TRUST_CHIPS,
  PLATFORM_TABS,
  MODULE_GROUPS,
  AI_LAYER,
  WORKFLOW_BLOCKS,
  ROLE_CARDS,
  SECURITY_POINTS,
  PLANS,
  PRICING_NOTE,
  FAQS,
  FOOTER_COLUMNS,
  FOOTER_SUPPORT,
  LEGAL_NOTE,
};
