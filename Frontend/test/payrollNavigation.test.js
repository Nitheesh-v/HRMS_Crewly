// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL NAVIGATION — three areas, one tab strip each.
//
// Payroll used to be fifteen sidebar rows in one section. It is now three:
// Payroll · Salary architecture · Payslips, with the pages inside each area
// presented as the Settings-style tab strip (the reference the owner sent).
//
// The risk in a change like this is silent loss: a page that still has a route
// but no longer has a door. These pins make that impossible —
//
//   · every tab in config/payrollNav.js must be a real route in AppRoutes.jsx;
//   · every payroll route must be reachable: a tab, or a detail view of one;
//   · every tab needs a breadcrumb title, because the menu no longer holds it;
//   · the sidebar rows and the strip must come from the same config.
//
// The permissions on the tabs are the ones the old rows carried verbatim, so
// nobody gained or lost a door in the move.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PAYROLL_AREAS,
  PAYROLL_PAGE_TITLES,
  canSeePayrollArea,
  payrollAreaForPath,
  visiblePayrollTabs,
} from '../src/config/payrollNav.js';
import { menuItemForPath, sectionForPath } from '../src/utils/breadcrumb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const routes = read('src/routes/AppRoutes.jsx');
const layout = read('src/layout/AppLayout.jsx');
const sidebar = read('src/layout/SidebarNav.jsx');
const strip = read('src/components/payroll/PayrollSectionTabs.jsx');
const breadcrumb = read('src/utils/breadcrumb.js');

const allTabs = PAYROLL_AREAS.flatMap((area) => area.tabs.map((tab) => ({ area, ...tab })));

/** `/app/payroll/run` is declared in AppRoutes as path="payroll/run" under /app. */
const routeExists = (to) => routes.includes(`path="${to.replace('/app/', '')}"`);

describe('payroll navigation — areas and tabs', () => {
  test('three areas, and each one lands somewhere real', () => {
    assert.equal(PAYROLL_AREAS.length, 3, 'payroll must read as a few areas, not fifteen rows');
    for (const area of PAYROLL_AREAS) {
      assert.ok(area.home?.startsWith('/app/payroll'), `${area.id} needs a payroll home`);
      assert.ok(area.label && area.description, `${area.id} needs a label and a one-line description`);
      assert.ok(routeExists(area.home), `${area.id}: ${area.home} is not a route in AppRoutes.jsx`);
      assert.ok(
        area.tabs.some((tab) => tab.to === area.home),
        `${area.id}: the sidebar row must land on one of its own tabs`,
      );
      assert.ok(area.tabs.length >= 2, `${area.id} needs at least two tabs to be worth a strip`);
    }
  });

  test('every tab is a real route, and no route is orphaned', () => {
    for (const tab of allTabs) {
      assert.ok(routeExists(tab.to), `tab "${tab.label}" points at ${tab.to}, which AppRoutes.jsx does not declare`);
      assert.ok(
        tab.to.startsWith('/app/payroll'),
        `tab "${tab.label}" (${tab.to}) is outside payroll, so its strip would never show`,
      );
    }

    // Every declared payroll page route must be reachable: either it is a tab,
    // or it is a detail view owned by one (an employee's result, a sub-report).
    const declared = [...routes.matchAll(/path="(payroll[^"]*)"/g)].map((m) => `/app/${m[1]}`);
    for (const route of declared) {
      const reachable = allTabs.some((tab) => route === tab.to || route.startsWith(`${tab.to}/`));
      assert.ok(reachable, `${route} has a route but no door — add it to a tab or a detail title`);
    }
  });

  test('the tab strip and the sidebar read one config', () => {
    assert.ok(
      layout.includes('PAYROLL_AREAS') && layout.includes('visiblePayrollTabs'),
      'AppLayout must derive the payroll sidebar rows from config/payrollNav.js',
    );
    assert.ok(
      layout.includes('tabs[0].to'),
      'a sidebar row must land on a tab the person can open, not on the area home',
    );
    assert.ok(
      strip.includes('visiblePayrollTabs') && strip.includes('payrollAreaForPath'),
      'the tab strip must derive its tabs from config/payrollNav.js',
    );

    // The fifteen-row menu must not creep back in, and the role menus must not
    // re-add a second "Payroll" row beside the area rows config already gives.
    assert.equal(
      (layout.match(/["'`]\/app\/payroll/g) || []).length,
      0,
      'AppLayout must not hard-code payroll paths again — they live in payrollNav.js',
    );
    assert.equal(
      (layout.match(/["'`]\/app\/payslips/g) || []).length,
      0,
      'the legacy /app/payslips row must not sit beside the Payslips area row',
    );
  });

  test('the legacy /app/payslips URL forwards to the tab that replaced it', () => {
    assert.ok(
      /path="payslips"\s+element=\{<Navigate to="\/app\/payroll\/my-payslips"/.test(routes),
      '/app/payslips must redirect to Payslips › My payslips rather than keep a second list',
    );
    assert.ok(
      routes.includes('/app/payroll/my-payslips'),
      'the redirect target must be a real payroll route',
    );
  });

  test('the strip is hidden while permissions load', () => {
    assert.ok(strip.includes('loading'), 'the strip must wait for permissions before painting');
    assert.ok(strip.includes('return null'), 'the strip must render nothing outside payroll');
  });

  test('every payroll route has a breadcrumb title', () => {
    for (const tab of allTabs) {
      assert.equal(
        PAYROLL_PAGE_TITLES[tab.to],
        tab.label,
        `${tab.to} must be named the same in the breadcrumb and the tab`,
      );
      assert.equal(sectionForPath(tab.to), 'Payroll', `${tab.to} must read as the Payroll section`);
      const item = menuItemForPath([{ to: '/app/payroll', label: 'Payroll' }], tab.to);
      assert.ok(item?.title, `${tab.to} loses its breadcrumb once leaves leave the menu`);
    }

    // Detail views, which have no tab of their own.
    for (const detail of ['/app/payroll/employees/abc', '/app/payroll/analytics/variance']) {
      const item = menuItemForPath([{ to: '/app/payroll', label: 'Payroll' }], detail);
      assert.ok(item?.title && item.title !== 'Payroll', `${detail} must keep its own page name`);
    }
    assert.ok(
      breadcrumb.includes('PAYROLL_PAGE_TITLES'),
      'breadcrumb.js must consult the payroll titles, or payroll pages lose their name',
    );
  });

  test('permissions still decide who sees an area and which tabs', () => {
    const none = () => false;
    const all = () => true;

    assert.equal(canSeePayrollArea(PAYROLL_AREAS[0], none), false, 'no permission → no sidebar row');
    assert.equal(visiblePayrollTabs(PAYROLL_AREAS[0], none).length, 0, 'no permission → no tabs');

    for (const area of PAYROLL_AREAS) {
      assert.equal(canSeePayrollArea(area, all), true, `${area.id} must be visible to a fully-permitted admin`);
      assert.equal(visiblePayrollTabs(area, all).length, area.tabs.length);
    }

    // A tab opens on the permission it names, not on the area's label.
    const payslips = PAYROLL_AREAS.find((area) => area.id === 'payslips');
    const onlySelf = (wanted) => (required) => required.includes(wanted);
    assert.deepEqual(
      visiblePayrollTabs(payslips, onlySelf('PAYSLIP_READ_SELF')).map((tab) => tab.to),
      ['/app/payroll/my-payslips'],
      'a self-service permission must open only the self tab',
    );

    // Every gated tab must name at least one permission; a gate with no
    // permission on it is an open door nobody decided to open.
    for (const tab of allTabs) {
      assert.ok(tab.permissions?.length, `tab "${tab.label}" has no permission gate`);
    }
  });

  test('a payroll path resolves to exactly one area', () => {
    for (const tab of allTabs) {
      assert.equal(payrollAreaForPath(tab.to)?.id, tab.area.id, `${tab.to} resolved to the wrong area`);
    }
    assert.equal(payrollAreaForPath('/app/payroll/analytics/variance')?.id, 'run');
    assert.equal(payrollAreaForPath('/app/payroll/employees/abc')?.id, 'run');
    assert.equal(payrollAreaForPath('/app/users'), null, 'non-payroll paths must not get a payroll strip');
  });

  test('the payroll group in the sidebar still matches the breadcrumb section', () => {
    assert.ok(sidebar.includes('id: "payroll"'), 'the payroll nav group must still exist');
    assert.ok(sidebar.includes('"/app/payroll/payslips"'), 'the payslips area needs its sidebar icon');
  });
});
