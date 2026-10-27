// ═══════════════════════════════════════════════════════════════════════════
// WHICH SECTION OF THE APP AM I IN?
//
// The header breadcrumb reads "People › Organization Structure". The page half
// comes from the same `menu` the sidebar renders, so a route can never be
// labelled two different things. The section half comes from here, because the
// sidebar's groups are a rendering concern of SidebarNav and are not exported.
//
// That means the group labels below have to agree with `NAV_GROUPS` in
// layout/SidebarNav.jsx. `test/orgChart.test.js` reads that file and fails if a
// label here stops existing there — a rename in one place is a broken
// breadcrumb, not a silent one.
//
// Longest prefix wins, so /app/attendance/overtime is "Time & Leave" and
// /app/profile/change-requests is "People" (it is a reviewers' queue), not "Me".
//
// PAYROLL is the one section whose pages are NOT in the menu any more: the
// sidebar shows three areas and each area's pages are an in-page tab strip
// (config/payrollNav.js). So the page half comes from that same config — which
// is also what names the tabs — instead of from a sidebar row that no longer
// exists. Without this, every payroll page would lose its breadcrumb.
// ═══════════════════════════════════════════════════════════════════════════

import { PAYROLL_PAGE_TITLES } from '../config/payrollNav.js';

const SECTIONS = [
  { label: 'Me', prefixes: ['/app/profile', '/app/notifications', '/app/notification-settings'] },
  {
    label: 'People',
    prefixes: [
      '/app/users',
      '/app/departments',
      '/app/org-chart',
      '/app/employee-files',
      '/app/lifecycle',
      '/app/performance',
      '/app/documents',
      '/app/assets',
    ],
  },
  {
    label: 'Time & Leave',
    prefixes: ['/app/attendance', '/app/leaves', '/app/shifts', '/app/schedules', '/app/holidays'],
  },
  { label: 'Payroll', prefixes: ['/app/payroll', '/app/payslips'] },
  { label: 'Recruitment', prefixes: ['/app/recruitment', '/app/referrals'] },
  {
    label: 'Work',
    prefixes: ['/app/tasks', '/app/projects', '/app/meetings', '/app/announcements'],
  },
  { label: 'Insights', prefixes: ['/app/analytics', '/app/reports'] },
  { label: 'AI', prefixes: ['/app/settings/ai-settings', '/app/settings/ai-usage'] },
  { label: 'Finance', prefixes: ['/app/expenses', '/app/billing', '/app/subscription'] },
  {
    label: 'Administration',
    prefixes: [
      '/app/company',
      '/app/governance',
      '/app/roles-permissions',
      '/app/support',
      '/app/exit',
      '/app/security',
      '/app/audit-logs',
      '/app/settings/presence',
    ],
  },
];

const matches = (pathname, prefix) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** The nav group a path belongs to, or null when it is not a section at all. */
export const sectionForPath = (pathname = '') =>
  SECTIONS.flatMap((section) => section.prefixes.map((prefix) => ({ prefix, label: section.label })))
    .filter((entry) => matches(pathname, entry.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.label || null;

/**
 * Menu entries whose sidebar label is deliberately shorter than the page's own
 * headline. The nav row has to stay one word wide ("Organization"), while the
 * page says what it actually is and the breadcrumb names it the same way.
 */
const PAGE_TITLES = {
  '/app/org-chart': 'Organization Structure',
};

/** The most specific menu entry that owns this path — the page's own name. */
export const menuItemForPath = (menu = [], pathname = '') => {
  const item = menu
    .filter((entry) => entry.to && matches(pathname, entry.to))
    .sort((a, b) => b.to.length - a.to.length)[0];

  // Longest payroll path wins, including detail views (/app/payroll/employees,
  // /app/payroll/analytics/*), so "Review & approval" does not collapse to the
  // area name the sidebar row happens to use.
  const payrollTitle = Object.keys(PAYROLL_PAGE_TITLES)
    .filter((to) => matches(pathname, to))
    .sort((a, b) => b.length - a.length)
    .map((to) => PAYROLL_PAGE_TITLES[to])[0];

  if (payrollTitle) return { to: pathname, label: payrollTitle, title: payrollTitle };
  if (!item) return null;

  return { ...item, title: PAGE_TITLES[item.to] || item.label };
};

export const SECTION_LABELS = SECTIONS.map((section) => section.label);
