// ═══════════════════════════════════════════════════════════════════════════
// TIME & LEAVE NAVIGATION — six areas, one tab strip each.
//
// Same change as payroll, one section over. Time & Leave had nineteen sidebar
// rows: attendance, reports, timesheets, the team boards, policy, work modes,
// regularizations, overtime, kiosks, QR, imports, analytics, leaves, approvals,
// holidays, shifts and schedules. It is now six areas with the pages inside
// each area presented as the Settings-style tab strip.
//
// The risk in a change like this is silent loss — a page that still has a
// route but no longer has a door — so these pins hold:
//
//   · every tab in config/timeNav.js is a real route in AppRoutes.jsx;
//   · every Time & Leave route is reachable: a tab, or a step inside one;
//   · every tab is wrapped in the strip, and every tab has a breadcrumb title;
//   · the rail rows and the strip come from the same config;
//   · the permissions are the ones the old rows carried, verbatim.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TIME_AREAS,
  TIME_PAGE_TITLES,
  canSeeTimeArea,
  timeAreaForPath,
  visibleTimeTabs,
} from '../src/config/timeNav.js';
import { ROLES } from '../src/utils/roles.js';
import { menuItemForPath, sectionForPath } from '../src/utils/breadcrumb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const routes = read('src/routes/AppRoutes.jsx');
const layout = read('src/layout/AppLayout.jsx');
const sidebar = read('src/layout/SidebarNav.jsx');
const strip = read('src/components/time/TimeSectionTabs.jsx');
const breadcrumb = read('src/utils/breadcrumb.js');

const allTabs = TIME_AREAS.flatMap((area) => area.tabs.map((tab) => ({ area, ...tab })));

/** `/app/attendance/report` is declared in AppRoutes as path="attendance/report". */
const routeExists = (to) => routes.includes(`path="${to.replace('/app/', '')}"`);

describe('time & leave navigation — areas and tabs', () => {
  test('six areas, each landing on one of its own tabs', () => {
    assert.equal(TIME_AREAS.length, 6, 'Time & Leave must read as a few areas, not nineteen rows');
    for (const area of TIME_AREAS) {
      assert.ok(area.label && area.description, `${area.id} needs a label and a one-line description`);
      assert.ok(routeExists(area.home), `${area.id}: ${area.home} is not a route in AppRoutes.jsx`);
      assert.ok(area.tabs.length >= 2, `${area.id} needs at least two tabs to be worth a strip`);
      assert.ok(
        area.tabs.some((tab) => tab.to === area.home),
        `${area.id}: the rail row must land on one of its own tabs`,
      );
    }
  });

  test('every tab is a real route, and no route is orphaned', () => {
    for (const tab of allTabs) {
      assert.ok(routeExists(tab.to), `tab "${tab.label}" points at ${tab.to}, which AppRoutes.jsx does not declare`);
      assert.ok(
        tab.to.startsWith('/app/'),
        `tab "${tab.label}" (${tab.to}) is not an app route, so its strip would never show`,
      );
    }

    // Every declared Time & Leave route must be reachable: a tab, or a step
    // inside one (a staged import batch), or a redirect.
    const declared = [...routes.matchAll(/path="(attendance[^"]*|leaves[^"]*|holidays|shifts|schedules|team[^"]*)"/g)]
      .map((m) => `/app/${m[1]}`);

    for (const route of declared) {
      const reachable = allTabs.some((tab) => route === tab.to || route.startsWith(`${tab.to}/`));
      const redirect = new RegExp(`path="${route.replace('/app/', '')}"[\\s\\S]{0,220}?<Navigate`).test(routes);
      const isPunchScreen = route === '/app/attendance/qr/:token'; // the employee's punch page, not a nav destination
      assert.ok(
        reachable || redirect || isPunchScreen,
        `${route} has a route but no door — add it to a tab, a step title, or make it a redirect`,
      );
    }
  });

  test('every tab page is wrapped in the shared strip', () => {
    // The strip is rendered by TimeSection, which AppRoutes applies per route.
    // A tab whose page is not wrapped would be reachable from the rail but
    // show no strip, i.e. no way back to its siblings.
    for (const tab of allTabs) {
      const path = tab.to.replace('/app/', '');
      const at = routes.indexOf(`path="${path}"`);
      assert.ok(at !== -1, `${path} missing`);
      const snippet = routes.slice(at, at + 320);
      assert.ok(
        snippet.includes('inTime('),
        `${tab.to} must be wrapped in inTime(...) so it shows the ${tab.area.label} strip`,
      );
    }
  });

  test('the strip and the rail read one config', () => {
    assert.ok(
      layout.includes('TIME_AREAS') && layout.includes('visibleTimeTabs'),
      'AppLayout must derive the Time & Leave rows from config/timeNav.js',
    );
    assert.ok(
      strip.includes('visibleTimeTabs') && strip.includes('timeAreaForPath'),
      'the strip must derive its tabs from config/timeNav.js',
    );
    assert.ok(
      layout.includes('tabs[0].to'),
      'a rail row must land on a tab the person can open, not on the area home',
    );

    // The nineteen-row menu must not creep back in.
    assert.equal(
      (layout.match(/["'`]\/app\/(attendance|leaves|holidays|shifts|schedules|team)/g) || []).length,
      0,
      'AppLayout must not hard-code Time & Leave paths again — they live in timeNav.js',
    );
  });

  test('the strip is hidden while permissions load, and on a lone tab', () => {
    assert.ok(strip.includes('loading'), 'the strip must wait for permissions before painting');
    assert.ok(strip.includes('tabs.length < 2'), 'a single-tab area gets no strip');
    assert.ok(strip.includes('return null'), 'the strip must render nothing outside Time & Leave');
  });

  test('every tab has a breadcrumb title in the right section', () => {
    for (const tab of allTabs) {
      assert.equal(
        TIME_PAGE_TITLES[tab.to],
        tab.label,
        `${tab.to} must be named the same in the breadcrumb and the tab`,
      );
      assert.equal(sectionForPath(tab.to), 'Time & Leave', `${tab.to} must read as the Time & Leave section`);
      const item = menuItemForPath([], tab.to);
      assert.ok(item?.title, `${tab.to} loses its breadcrumb once the leaves leave the menu`);
    }

    // A step inside a tab has no tab of its own but still needs a name.
    const step = menuItemForPath([], '/app/attendance/imports/validation');
    assert.equal(step?.title, 'Import validation');

    assert.ok(
      breadcrumb.includes('TIME_PAGE_TITLES'),
      'breadcrumb.js must consult the Time & Leave titles, or those pages lose their name',
    );
  });

  test('permissions still decide who sees an area and which tabs', () => {
    const none = () => false;
    const all = () => true;
    const admin = ROLES.COMPANY_ADMIN;

    for (const area of TIME_AREAS) {
      assert.equal(canSeeTimeArea(area, all, admin), true, `${area.id} must be visible to a fully-permitted admin`);
      assert.equal(visibleTimeTabs(area, all, admin).length, area.tabs.length);
    }

    // An employee keeps the personal surfaces and loses the management ones.
    const employee = ROLES.EMPLOYEE;
    const held = new Set([
      'ATTENDANCE_READ_SELF',
      'ATTENDANCE_CREATE_SELF',
      'LEAVE_READ_SELF',
      'LEAVE_CREATE_SELF',
      'HOLIDAY_READ',
      'SHIFT_READ',
      'PAYSLIP_READ_SELF',
    ]);
    const hasAny = (wanted) => wanted.some((permission) => held.has(permission));

    const labels = TIME_AREAS.flatMap((area) =>
      visibleTimeTabs(area, hasAny, employee).map((tab) => tab.label),
    );
    // Analytics is gated on ATTENDANCE_ANALYTICS_READ | ATTENDANCE_READ_SELF
    // because the page carries an employee's own monthly summary alongside the
    // manager views — the page decides which of those to show. The row was
    // gated the same way before the move.
    assert.deepEqual(
      labels,
      ['My attendance', 'My timesheet', 'Analytics', 'My leaves', 'Holiday calendar', 'Shifts & rosters'],
      'an employee must keep exactly the personal surfaces and nothing else',
    );
    // Management surfaces must not leak to them.
    for (const hidden of ['Attendance reports', 'Who\'s working', 'Team timesheets', 'Policy', 'Kiosks', 'Regularizations']) {
      assert.ok(!labels.includes(hidden), `an employee must not be given the "${hidden}" tab`);
    }

    // The manager audience the routes admit.
    const managerHeld = new Set([...held, 'ATTENDANCE_READ', 'LEAVE_APPROVE']);
    const managerHas = (wanted) => wanted.some((permission) => managerHeld.has(permission));
    const team = TIME_AREAS.find((area) => area.id === 'team');
    assert.deepEqual(
      visibleTimeTabs(team, managerHas, ROLES.MANAGER).map((tab) => tab.to),
      ['/app/attendance/team', '/app/team/availability', '/app/attendance/team-timesheets'],
      'a manager keeps the whole team area',
    );

    // …but scheduling is HR's, by the same role gate the route applies.
    const schedule = TIME_AREAS.find((area) => area.id === 'schedule');
    assert.deepEqual(
      visibleTimeTabs(schedule, all, ROLES.MANAGER).map((tab) => tab.to),
      ['/app/shifts'],
      'work schedules must stay HR-only, as RequireRole already makes it',
    );
    assert.equal(
      visibleTimeTabs(schedule, all, ROLES.HR_MANAGER).length,
      2,
      'HR sees both scheduling tabs',
    );

    // A tab with no permission and no role audience is an open door — that is
    // allowed only for the personal surfaces, and never for a management page.
    for (const tab of allTabs) {
      if (tab.permissions?.length || tab.roles?.length) continue;
      assert.ok(
        ['My attendance', 'My leaves', 'Holiday calendar', 'Shifts & rosters'].includes(tab.label),
        `tab "${tab.label}" has no gate; only personal surfaces may be ungated`,
      );
    }
  });

  test('a path resolves to exactly one area', () => {
    for (const tab of allTabs) {
      assert.equal(timeAreaForPath(tab.to)?.id, tab.area.id, `${tab.to} resolved to the wrong area`);
    }
    assert.equal(timeAreaForPath('/app/attendance/imports/validation')?.id, 'setup');
    assert.equal(timeAreaForPath('/app/payroll'), null, 'payroll must not get a Time & Leave strip');
    assert.equal(timeAreaForPath('/app/users'), null);
  });

  test('the section group and the breadcrumb label still agree', () => {
    // test/orgChart.test.js pins the labels themselves; this pins that the
    // group still exists after its rows were replaced by area rows.
    assert.ok(sidebar.includes('label: "Time & Leave"'), 'the Time & Leave nav group must still exist');
    assert.ok(
      sidebar.includes('"/app/attendance"') && sidebar.includes('"/app/shifts"'),
      'the rail needs icons for the area destinations',
    );
  });
});
