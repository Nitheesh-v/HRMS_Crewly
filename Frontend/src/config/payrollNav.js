// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL NAVIGATION — three areas, one tab strip each.
//
// Payroll grew to seventeen routes: a fifteen-row sidebar section that pushed
// every other module below the fold and made "Salary Components" look like a
// different product from "Salary Structures". The Settings pattern fixes that:
// the sidebar lists an AREA, and the area's pages are a horizontal tab strip at
// the top of the page (the way Company Details / Password & Security / Team
// read on the Settings screen).
//
// ONE definition, consumed twice:
//   · layout/AppLayout.jsx        → which sidebar rows exist
//   · components/payroll/PayrollSectionTabs.jsx → which tabs render
//
// so a page can never be reachable one way and invisible the other. Both sides
// filter on the same permission arrays, and `test/payrollNavigation.test.js`
// pins that every route here is a real route in AppRoutes.jsx.
// ═══════════════════════════════════════════════════════════════════════════

export const PAYROLL_AREAS = [
  {
    id: 'run',
    label: 'Payroll',
    // Sidebar icon + the breadcrumb's page name for an area landing.
    icon: 'wallet',
    home: '/app/payroll',
    description: 'The monthly cycle: inputs, calculation, review and the transfer file.',
    tabs: [
      {
        to: '/app/payroll',
        label: 'Payroll center',
        permissions: ['PAYROLL_RUN_READ', 'PAYROLL_RUN_PREPARE', 'PAYROLL_RUN_EXECUTE'],
      },
      {
        to: '/app/payroll/inputs',
        label: 'Monthly inputs',
        permissions: ['PAYROLL_INPUT_READ', 'PAYROLL_INPUT_MANAGE', 'PAYROLL_INPUT_LOCK'],
      },
      {
        to: '/app/payroll/run',
        label: 'Run payroll',
        permissions: [
          'PAYROLL_RUN_READ',
          'PAYROLL_RUN_PREPARE',
          'PAYROLL_RUN_EXECUTE',
          'PAYROLL_RUN_RECALCULATE',
        ],
      },
      {
        to: '/app/payroll/review',
        label: 'Review & approval',
        permissions: [
          'PAYROLL_RUN_READ',
          'PAYROLL_RUN_PREPARE',
          'PAYROLL_RUN_REVIEW',
          'PAYROLL_RUN_LOCK',
          'PAYROLL_RUN_REOPEN',
          'PAYROLL_RUN_APPROVE',
          'PAYROLL_RUN_REJECT',
        ],
      },
      {
        to: '/app/payroll/salary-payment',
        label: 'Salary payment',
        permissions: [
          'PAYROLL_PAYMENT_READ',
          'PAYROLL_PAYMENT_GENERATE',
          'PAYROLL_PAYMENT_CONFIRM',
          'PAYROLL_PAYMENT_MARK_PAID',
        ],
      },
      {
        to: '/app/payroll/analytics',
        label: 'Analytics & reports',
        permissions: [
          'PAYROLL_REPORT_READ',
          'PAYROLL_REPORT_EXPORT',
          'PAYROLL_ANALYTICS_FINANCIAL',
          'PAYROLL_ANALYTICS_SCHEDULE',
        ],
      },
    ],
  },

  {
    id: 'architecture',
    label: 'Salary architecture',
    icon: 'layers',
    home: '/app/payroll/components',
    description: 'Components, structures and the statutory setup they are priced against.',
    tabs: [
      {
        to: '/app/payroll/components',
        label: 'Components & rules',
        permissions: [
          'SALARY_COMPONENT_READ',
          'SALARY_COMPONENT_MANAGE',
          'SALARY_COMPONENT_ACTIVATE',
        ],
      },
      {
        to: '/app/payroll/structures',
        label: 'Structures',
        permissions: [
          'SALARY_STRUCTURE_READ',
          'SALARY_STRUCTURE_MANAGE',
          'SALARY_STRUCTURE_ACTIVATE',
        ],
      },
      {
        to: '/app/payroll/statutory',
        label: 'Statutory & compliance',
        permissions: [
          'PAYROLL_STATUTORY_READ',
          'PAYROLL_STATUTORY_GENERATE',
          'PAYROLL_STATUTORY_MANAGE',
          'PAYROLL_STATUTORY_FILING',
        ],
      },
      {
        to: '/app/payroll/setup',
        label: 'Company setup',
        permissions: ['PAYROLL_SETUP_READ', 'PAYROLL_SETUP_UPDATE', 'PAYROLL_SETUP_ACTIVATE'],
      },
    ],
  },

  {
    id: 'payslips',
    label: 'Payslips',
    icon: 'receipt',
    home: '/app/payroll/payslips',
    description: 'Released statements for the company, and the ones addressed to you.',
    tabs: [
      {
        to: '/app/payroll/payslips',
        label: 'Payslip workspace',
        permissions: ['PAYSLIP_READ', 'PAYSLIP_GENERATE', 'PAYSLIP_RELEASE', 'PAYSLIP_RERELEASE'],
      },
      {
        to: '/app/payroll/final-settlement',
        label: 'Final settlement',
        permissions: [
          'FINAL_SETTLEMENT_READ',
          'FINAL_SETTLEMENT_CALCULATE',
          'FINAL_SETTLEMENT_REVIEW',
          'FINAL_SETTLEMENT_APPROVE',
          'FINAL_SETTLEMENT_PAY',
          'FINAL_SETTLEMENT_CLOSE',
          'FINAL_SETTLEMENT_REOPEN',
        ],
      },
      {
        to: '/app/payroll/my-payslips',
        label: 'My payslips',
        selfOnly: true,
        permissions: ['PAYSLIP_READ_SELF'],
      },
      {
        to: '/app/payroll/my-final-settlement',
        label: 'My settlement',
        selfOnly: true,
        permissions: ['FINAL_SETTLEMENT_READ_SELF'],
      },
    ],
  },
];

/** The area that owns a pathname, or null when the path is not payroll. */
export const payrollAreaForPath = (pathname = '') => {
  const path = String(pathname || '');
  if (!(path === '/app/payroll' || path.startsWith('/app/payroll/'))) return null;

  const tab = PAYROLL_AREAS.flatMap((area) => area.tabs.map((entry) => ({ area, ...entry })))
    .filter((entry) => path === entry.to || path.startsWith(`${entry.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0];

  return tab?.area || PAYROLL_AREAS[0];
};

/**
 * The tabs a person may open in an area, in config order. `hasAny` is the
 * permission predicate from `usePermission`; when it is missing (permissions
 * still loading) only the non-gated entries would render, which is why callers
 * keep the strip hidden until permissions have loaded.
 */
export const visiblePayrollTabs = (area, hasAny = () => true) =>
  (area?.tabs || []).filter(
    (tab) => !tab.permissions?.length || hasAny(tab.permissions),
  );

/** Whether a person has at least one tab in an area — i.e. whether the sidebar shows it. */
export const canSeePayrollArea = (area, hasAny = () => true) =>
  visiblePayrollTabs(area, hasAny).length > 0;

/**
 * The page name the header breadcrumb shows for a payroll route.
 *
 * The sidebar no longer lists every page, so the breadcrumb cannot take the
 * leaf label from the menu any more. These are the same words the tab strip
 * uses, so the two can never disagree.
 */
export const PAYROLL_PAGE_TITLES = PAYROLL_AREAS.flatMap((area) =>
  area.tabs.map((tab) => [tab.to, tab.label]),
).reduce((map, [to, label]) => ({ ...map, [to]: label }), {
  // Routes that are detail views of a tab rather than tabs themselves.
  '/app/payroll/employees': 'Employee payroll',
  '/app/payroll/analytics/overview': 'Payroll overview',
  '/app/payroll/analytics/department': 'Department analytics',
  '/app/payroll/analytics/salary-distribution': 'Salary distribution',
  '/app/payroll/analytics/trends': 'Payroll trends',
  '/app/payroll/analytics/bonus': 'Bonus report',
  '/app/payroll/analytics/overtime': 'Overtime report',
  '/app/payroll/analytics/statutory': 'Statutory summary',
  '/app/payroll/analytics/earnings': 'Earnings report',
  '/app/payroll/analytics/deductions': 'Deductions report',
  '/app/payroll/analytics/employer': 'Employer contributions',
  '/app/payroll/analytics/reimbursement': 'Reimbursements',
  '/app/payroll/analytics/fnf': 'F&F analytics',
  '/app/payroll/analytics/variance': 'Payroll variance',
  '/app/payroll/analytics/register': 'Payroll register',
  '/app/payroll/analytics/scheduled': 'Scheduled reports',
});

export default PAYROLL_AREAS;
