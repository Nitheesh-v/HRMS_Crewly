// ═══════════════════════════════════════════════════════════════════════════
// TIME & LEAVE NAVIGATION — six areas, one tab strip each.
//
// Same problem payroll had, one module over: Time & Leave grew to nineteen
// sidebar rows (attendance, reports, timesheets, team boards, policy, work
// modes, regularizations, overtime, kiosks, QR, imports, analytics, leaves,
// approvals, holidays, shifts, schedules…). The rail turned into a scroll.
//
// So it now uses the same shape as payroll: the sidebar lists an AREA, and the
// pages inside that area are a horizontal tab strip at the top of the page.
// The Settings screen is the visual reference for the strip; this file is the
// single source both readers use —
//
//   · layout/AppLayout.jsx               → which sidebar rows exist
//   · components/time/TimeSectionTabs.jsx → which tabs render
//
// A tab is drawn when BOTH gates pass:
//   `roles`       — the audience the route itself admits, when the page has a
//                   role gate and no permission of its own to read (schedules)
//   `permissions` — the permission the page's API actually enforces
//
// `permissions: []` means "every signed-in employee": My attendance, My
// leaves, Holidays and Shifts are personal surfaces, and they were ungated
// rows in the old menu too.
// ═══════════════════════════════════════════════════════════════════════════

import { ROLES } from '../utils/roles.js';

const HR_ONLY = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

export const TIME_AREAS = [
  {
    id: 'attendance',
    label: 'Attendance',
    home: '/app/attendance',
    description: 'Your own day-to-day attendance, and the reports that read it back.',
    tabs: [
      {
        to: '/app/attendance',
        label: 'My attendance',
        permissions: [],
      },
      {
        to: '/app/attendance/timesheet',
        label: 'My timesheet',
        permissions: ['ATTENDANCE_READ_SELF', 'ATTENDANCE_READ'],
      },
      {
        to: '/app/attendance/report',
        label: 'Attendance reports',
        permissions: ['ATTENDANCE_READ'],
      },
      {
        to: '/app/attendance/analytics',
        label: 'Analytics',
        permissions: ['ATTENDANCE_ANALYTICS_READ', 'ATTENDANCE_READ_SELF'],
      },
    ],
  },

  {
    id: 'leave',
    label: 'Leave & holidays',
    home: '/app/leaves',
    description: 'Time off: what you have, what you asked for, and the days the company is closed.',
    tabs: [
      {
        to: '/app/leaves',
        label: 'My leaves',
        permissions: [],
      },
      {
        to: '/app/leaves/approvals',
        label: 'Leave approvals',
        permissions: ['LEAVE_APPROVE'],
      },
      {
        to: '/app/holidays',
        label: 'Holiday calendar',
        permissions: [],
      },
    ],
  },

  {
    id: 'requests',
    label: 'Requests',
    home: '/app/attendance/regularizations',
    description: 'The three ways a day gets corrected after the fact.',
    tabs: [
      {
        to: '/app/attendance/regularizations',
        label: 'Regularizations',
        permissions: ['ATTENDANCE_REGULARIZATION_REQUEST', 'ATTENDANCE_REGULARIZATION_REVIEW'],
      },
      {
        to: '/app/attendance/work-modes',
        label: 'Work modes',
        permissions: ['ATTENDANCE_WORK_MODE_REQUEST', 'ATTENDANCE_WORK_MODE_REVIEW'],
      },
      {
        to: '/app/attendance/overtime',
        label: 'Overtime & comp-off',
        permissions: ['ATTENDANCE_OVERTIME_REQUEST', 'ATTENDANCE_OVERTIME_REVIEW'],
      },
    ],
  },

  {
    id: 'team',
    label: 'Team & presence',
    home: '/app/attendance/team',
    description: 'Who is in today, where they are working from, and how their month is filling up.',
    tabs: [
      {
        to: '/app/attendance/team',
        label: "Who's working",
        permissions: ['ATTENDANCE_READ'],
      },
      {
        to: '/app/team/availability',
        label: 'Team availability',
        permissions: ['ATTENDANCE_READ'],
      },
      {
        to: '/app/attendance/team-timesheets',
        label: 'Team timesheets',
        permissions: ['ATTENDANCE_READ'],
      },
    ],
  },

  {
    id: 'schedule',
    label: 'Shifts & schedules',
    home: '/app/shifts',
    description: 'When work is expected: shift patterns, the rota and who is on which schedule.',
    tabs: [
      {
        to: '/app/shifts',
        label: 'Shifts & rosters',
        permissions: [],
      },
      {
        // /app/schedules is gated by role in AppRoutes (HR builds the
        // schedules) and there is no scheduling permission in the catalogue,
        // so the strip honours the same audience rather than inventing one.
        to: '/app/schedules',
        label: 'Work schedules',
        permissions: [],
        roles: HR_ONLY,
      },
    ],
  },

  {
    id: 'setup',
    label: 'Attendance setup',
    home: '/app/attendance/policy',
    description: 'The rules the day is measured against, and the terminals that record it.',
    tabs: [
      {
        to: '/app/attendance/policy',
        label: 'Policy',
        permissions: ['ATTENDANCE_POLICY_READ', 'ATTENDANCE_POLICY_MANAGE', 'ATTENDANCE_POLICY_ACTIVATE'],
      },
      {
        to: '/app/attendance/operations',
        label: 'Operations',
        permissions: ['ATTENDANCE_OPERATIONS_READ'],
      },
      {
        to: '/app/attendance/kiosks',
        label: 'Kiosks',
        permissions: ['ATTENDANCE_CAPTURE_MANAGE'],
      },
      {
        to: '/app/attendance/qr',
        label: 'QR challenges',
        permissions: ['ATTENDANCE_CAPTURE_MANAGE'],
      },
      {
        to: '/app/attendance/imports',
        label: 'Import',
        permissions: ['ATTENDANCE_CAPTURE_MANAGE'],
      },
    ],
  },
];

const TAB_INDEX = TIME_AREAS.flatMap((area) =>
  area.tabs.map((tab) => ({ area, tab })),
);

/** The area that owns a pathname, or null when the path is not Time & Leave. */
export const timeAreaForPath = (pathname = '') => {
  const path = String(pathname || '');
  const match = TAB_INDEX.map((entry) => entry)
    .filter(({ tab }) => path === tab.to || path.startsWith(`${tab.to}/`))
    .sort((a, b) => b.tab.to.length - a.tab.to.length)[0];

  return match?.area || null;
};

/**
 * The tabs a person may open in an area, in config order.
 *
 * `hasAny` is the permission predicate from `usePermission`, `role` the signed
 * in role. When permissions are still loading `hasAny` returns false, which is
 * why callers keep the strip hidden until the hook reports it has loaded.
 */
export const visibleTimeTabs = (area, hasAny = () => true, role = null) =>
  (area?.tabs || []).filter((tab) => {
    if (tab.roles && !tab.roles.includes(role)) return false;
    if (tab.permissions?.length && !hasAny(tab.permissions)) return false;
    return true;
  });

/** Whether a person has at least one tab in an area — i.e. whether the rail shows it. */
export const canSeeTimeArea = (area, hasAny, role) =>
  visibleTimeTabs(area, hasAny, role).length > 0;

/**
 * The page name the header breadcrumb shows for a Time & Leave route.
 *
 * The sidebar no longer lists every page, so the breadcrumb cannot take the
 * leaf label from the menu. These are the same words the tabs use.
 */
export const TIME_PAGE_TITLES = TIME_AREAS.flatMap((area) =>
  area.tabs.map((tab) => [tab.to, tab.label]),
).reduce((map, [to, label]) => ({ ...map, [to]: label }), {
  // Routes that are steps inside a tab rather than tabs themselves.
  '/app/attendance/imports/validation': 'Import validation',
});

export default TIME_AREAS;
