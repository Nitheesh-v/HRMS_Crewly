// ═══════════════════════════════════════════════════════════════════════════
// ATTENDANCE LEDGERS — Analytics · Team Timesheets · Operations · My Timesheet
//
// These four surfaces were re-cut against the Stitch exports in
// /stitch-attendance/v2 with one rule: a block may only render a figure the
// API actually returned, and an aggregate may only claim the rows it was
// computed from. The pins below hold that rule in place — they are cheap
// greps, but each one stands for a claim on screen:
//
//   · aggregates that are local sums say "these rows / this page";
//   · blocks with no endpoint print "Not configured" instead of a number;
//   · nothing prints money, a ranking, or an invented percentage;
//   · every page is on the st- token set, so the four read as one product.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const analytics = read('src/pages/attendance/AttendanceAnalyticsPage.jsx');
const teamSheets = read('src/pages/attendance/AttendanceTeamTimesheetsPage.jsx');
const operations = read('src/pages/attendance/AttendanceOperationsPage.jsx');
const mySheet = read('src/pages/attendance/AttendanceTimesheetPage.jsx');
const monthView = read('src/components/attendance/TimesheetMonthView.jsx');

const pages = [
  ['analytics', analytics],
  ['team timesheets', teamSheets],
  ['operations', operations],
  ['my timesheet', mySheet],
];

const has = (source, needle, why) =>
  assert.ok(source.includes(needle), `${why} — expected to find: ${needle}`);
const hasNot = (source, needle, why) =>
  assert.ok(!source.includes(needle), `${why} — must not contain: ${needle}`);

describe('attendance ledgers — live data only', () => {
  test('every page is on the Stitch token set, not the legacy card look', () => {
    for (const [name, source] of pages) {
      has(source, 'st-surface', `${name} sits inside the Warm Organic scope`);
      hasNot(source, 'bg-white/', `${name} has no dark-only white wash`);
      hasNot(source, 'border-white/', `${name} has no dark-only white hairline`);
      assert.equal(
        /className="card\b/.test(source),
        false,
        `${name} builds its own surfaces instead of the legacy .card`,
      );
    }
    assert.equal(/crewly-/.test(monthView), false, 'the shared month view is on st- tokens too');
  });

  test('no invented money, ranking or score anywhere on the four pages', () => {
    for (const [name, source] of pages) {
      hasNot(source, '₹', `${name} prints no currency`);
      assert.equal(/\bINR\b|\brupee/i.test(source), false, `${name} names no currency`);
      assert.equal(/productivityScore|performanceScore|score:\s/i.test(source), false, `${name} scores nobody`);
    }
  });

  test('team timesheets never lets a page-local sum speak for the scope', () => {
    has(teamSheets, 'const wholeScope = Boolean(table) && rows.length === total', 'the page knows whether it holds the scope');
    has(teamSheets, 'not all ${total} in scope', 'the footer names the difference when it does not');
    has(teamSheets, 'cover the full filtered scope', 'and says so plainly when it does');
    has(teamSheets, 'these rows only', 'the average names its denominator');
    has(teamSheets, 'Isolate rows needing attention', 'the exception filter is a real backend filter, not a client mask');
  });

  test('team timesheets reads the real finalization period, and only for HR', () => {
    has(teamSheets, 'attendanceService.finalizationStatus(month)', 'period status is the API’s, not a guess');
    has(teamSheets, 'canSeeFinalization', 'and it is gated by the permission that owns it');
    has(teamSheets, 'HR-only action', 'non-HR sees who owns the decision instead of a dead button');
  });

  test('my timesheet derives the day rail and never fakes a statement', () => {
    has(mySheet, 'const fallbackDate = useMemo', 'the selected day is derived, so a month change cannot strand it');
    has(mySheet, 'const expectedPct = scheduledMinutes > 0', 'the expected-hours figure has a visible denominator');
    has(mySheet, 'scheduled hours met', 'and is labelled as such');
    has(mySheet, 'A statement download is not wired yet', 'the missing PDF endpoint is stated, not faked');
    has(mySheet, 'Legacy punch audit log', 'the legacy archive block is kept');
    has(mySheet, 'Not configured', 'and marked unconfigured');
    has(mySheet, 'Request regularization / correction', 'the real correction workflow is one click away');
  });

  test('operations shows the same filtered response to both panes', () => {
    has(operations, 'const groupRows = useMemo', 'the matrix reads the response groups');
    has(operations, 'const attention = dash?.attention', 'and the rail reads the same response’s queue');
    has(operations, 'this page writes nothing', 'the footer states that the read is not a write');
  });

  test('operations marks the hardware blocks it cannot back', () => {
    has(operations, 'Capture telemetry', 'the terminal strip is kept');
    has(operations, 'Geofence &amp; device network', 'the device strip is kept');
    const configured = operations.match(/Not configured/g) || [];
    assert.ok(configured.length >= 2, 'both hardware strips say they are unconfigured');
    has(operations, 'shows presence, never coordinates', 'and the geofence claim stays honest');
  });

  test('analytics refuses the two figures the backend does not hold', () => {
    has(analytics, 'Hybrid compliance', 'the mock’s compliance chip is kept');
    has(analytics, 'No office-day minimum is set', 'and explained instead of filled in');
    has(analytics, 'PDF audit', 'the mock’s PDF button is kept');
    has(analytics, 'No PDF ledger report is published', 'with its reason on the title');
    assert.equal(
      /Exec(utive)? PDF Audit/.test(analytics),
      false,
      'the mock label that implied a file does not survive',
    );
  });

  test('analytics keeps every tab and its provenance', () => {
    for (const tab of ['overview', 'trends', 'employees', 'mine', 'reconciliation']) {
      has(analytics, `'${tab}'`, `the ${tab} tab still exists`);
    }
    has(analytics, 'SourceBanner', 'provenance is printed above the numbers');
    has(analytics, 'Finalized', 'a finalized month is named as such');
    has(analytics, 'Live projection', 'and an open month is never called final');
    has(analytics, 'never a ranking or a score', 'the employee table keeps its unranked stance');
  });

  test('every figure on the four pages still comes from a service call', () => {
    has(analytics, 'attendanceService.analyticsOverview', 'overview is the API');
    has(analytics, 'attendanceService.analyticsTrends', 'trends is the API');
    has(analytics, 'attendanceService.analyticsEmployees', 'employees is the API');
    has(analytics, 'attendanceService.analyticsMine', 'my summary is the API');
    has(analytics, 'attendanceService.analyticsReconciliation', 'reconciliation is the API');
    has(teamSheets, 'attendanceService.teamTimesheets', 'the matrix is the API');
    has(teamSheets, 'attendanceService.employeeTimesheet', 'the drill-down is the API');
    has(teamSheets, 'attendanceService.downloadTeamTimesheets', 'the export is the API');
    has(operations, 'attendanceService.operations', 'the command centre is the API');
    has(operations, 'attendanceService.employeeTimesheet', 'and its drill-down too');
    has(mySheet, 'attendanceService.myTimesheet', 'my timesheet is the API');
  });
});
