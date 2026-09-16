// ─────────────────────────────────────────────────────────────
// Phase 31.15 — attendance analytics pure rules.
// Hermetic: no imports beyond the rules module itself (plus the
// real 31.10 outcome/exception enums and the real payroll FY
// helper it reuses). No DB, no Redis, no clock.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANALYTICS_PRESETS,
  EMPLOYEE_SORT_FIELDS,
  RECON_STATUS,
  absenceRate,
  aggregateDays,
  aggregateOt,
  aggregateRegularizations,
  aggregateSources,
  attendanceRate,
  averageWorkedMinutes,
  compareReconLine,
  dayUnits,
  isDayKey,
  isMonthKey,
  normalizeAnalyticsFilters,
  parseEmployeeSort,
  quarterMonthsOf,
  resolveAnalyticsRange,
  sortEmployeeRows,
  stableSerialize,
  toPct,
  toRatio,
} from '../src/services/attendance/attendanceAnalyticsRules.js';
import { TIMESHEET_EXCEPTION, TIMESHEET_OUTCOME } from '../src/services/attendance/attendanceTimesheetRules.js';

const presentDay = (overrides = {}) => ({
  date: '2026-08-03',
  bucket: TIMESHEET_OUTCOME.PRESENT,
  scheduledWorkingDay: true,
  fractions: { worked: 1, leave: 0, absent: 0 },
  workMode: 'OFFICE',
  workedMinutes: 480,
  breakMinutes: 30,
  hasSession: true,
  lateMinutes: 0,
  earlyMinutes: 0,
  exceptions: [],
  ...overrides,
});

// ── Range resolution ─────────────────────────────────────────

test('resolveAnalyticsRange: month anchors a full-month window', () => {
  const range = resolveAnalyticsRange({ month: '2026-08', todayKey: '2026-09-16' });
  assert.deepEqual(range.errors, []);
  assert.equal(range.from, '2026-08-01');
  assert.equal(range.to, '2026-08-31');
  assert.deepEqual(range.months, ['2026-08']);
});

test('resolveAnalyticsRange: bare call errors (the service defaults it to the current month)', () => {
  const range = resolveAnalyticsRange({ todayKey: '2026-09-16' });
  assert.deepEqual(range.errors, ['from and to must be YYYY-MM-DD']);
});

test('resolveAnalyticsRange: custom from/to spans months', () => {
  const range = resolveAnalyticsRange({ from: '2026-07-30', to: '2026-08-02', todayKey: '2026-09-16' });
  assert.deepEqual(range.errors, []);
  assert.deepEqual(range.months, ['2026-07', '2026-08']);
});

test('resolveAnalyticsRange: future-start rejected; open months keep full span (FUTURE bucket filters downstream)', () => {
  const future = resolveAnalyticsRange({ from: '2026-09-20', to: '2026-09-30', todayKey: '2026-09-16' });
  assert.deepEqual(future.errors, ['range starts in the future']);
  const open = resolveAnalyticsRange({ month: '2026-09', todayKey: '2026-09-16' });
  assert.deepEqual(open.errors, []);
  assert.equal(open.to, '2026-09-30');
});

test('resolveAnalyticsRange: quarter preset needs an anchor month', () => {
  const bad = resolveAnalyticsRange({ preset: 'quarter', todayKey: '2026-09-16' });
  assert.ok(bad.errors.length > 0);
  const good = resolveAnalyticsRange({ preset: 'quarter', month: '2026-08', todayKey: '2026-09-16' });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.months, quarterMonthsOf('2026-08'));
  assert.equal(good.months.length, 3);
});

test('resolveAnalyticsRange: fy preset spans twelve months', () => {
  assert.deepEqual([...ANALYTICS_PRESETS], ['quarter', 'fy']);
  const range = resolveAnalyticsRange({ preset: 'fy', month: '2026-08', todayKey: '2026-09-16', maxDays: 400 });
  assert.deepEqual(range.errors, []);
  assert.equal(range.months.length, 12);
  assert.equal(range.months[0], '2026-04');
});

test('resolveAnalyticsRange: reversed and over-long windows error', () => {
  const reversed = resolveAnalyticsRange({ from: '2026-08-05', to: '2026-08-01', todayKey: '2026-09-16' });
  assert.ok(reversed.errors.length > 0);
  const long = resolveAnalyticsRange({ from: '2026-01-01', to: '2026-09-16', todayKey: '2026-09-16' });
  assert.ok(long.errors.length > 0);
});

test('key guards accept only real calendar keys', () => {
  assert.equal(isMonthKey('2026-09'), true);
  assert.equal(isMonthKey('2026-13'), false);
  assert.equal(isDayKey('2026-09-16'), true);
  assert.equal(isDayKey('2026-02-30'), false);
});

// ── Ratios and day units ─────────────────────────────────────

test('toRatio/toPct return null on zero denominator', () => {
  assert.equal(toRatio(5, 0), null);
  assert.equal(toPct(5, 0), null);
  assert.equal(toRatio(1, 2), 0.5);
  assert.equal(toPct(1, 2), 50);
});

test('dayUnits: leave shrinks the scheduled denominator', () => {
  assert.deepEqual(dayUnits(presentDay()), { scheduled: 1, worked: 1, leave: 0, absent: 0 });
  assert.deepEqual(
    dayUnits(presentDay({ bucket: TIMESHEET_OUTCOME.LEAVE, fractions: { worked: 0, leave: 1, absent: 0 } })),
    { scheduled: 0, worked: 0, leave: 1, absent: 0 }
  );
  assert.deepEqual(
    dayUnits(presentDay({ bucket: TIMESHEET_OUTCOME.HALF_DAY, fractions: { worked: 0.5, leave: 0.5, absent: 0 } })),
    { scheduled: 0.5, worked: 0.5, leave: 0.5, absent: 0 }
  );
  assert.deepEqual(dayUnits(presentDay({ scheduledWorkingDay: false })), { scheduled: 0, worked: 1, leave: 0, absent: 0 });
  assert.deepEqual(dayUnits({ bucket: TIMESHEET_OUTCOME.FUTURE }), { scheduled: 0, worked: 0, leave: 0, absent: 0 });
});

// ── Aggregation ──────────────────────────────────────────────

test('aggregateDays: one pass feeds every KPI numerator', () => {
  const totals = aggregateDays([
    presentDay(),
    presentDay({ date: '2026-08-04', workMode: 'WFH', lateMinutes: 15 }),
    presentDay({ date: '2026-08-05', bucket: TIMESHEET_OUTCOME.ABSENT, fractions: { worked: 0, leave: 0, absent: 1 }, workedMinutes: 0, hasSession: false, workMode: null }),
    presentDay({ date: '2026-08-06', bucket: TIMESHEET_OUTCOME.LEAVE, fractions: { worked: 0, leave: 1, absent: 0 }, workedMinutes: 0, hasSession: false, workMode: null }),
    presentDay({ date: '2026-08-07', bucket: TIMESHEET_OUTCOME.HOLIDAY, scheduledWorkingDay: false, fractions: { worked: 0, leave: 0, absent: 0 }, workedMinutes: 0, hasSession: false, workMode: null }),
  ]);
  assert.equal(totals.scheduledUnits, 3);
  assert.equal(totals.workedUnits, 2);
  assert.equal(totals.leaveUnits, 1);
  assert.equal(totals.absentUnits, 1);
  assert.equal(totals.workedMinutes, 960);
  assert.equal(totals.sessionDays, 2);
  assert.equal(totals.lateOccurrences, 1);
  assert.equal(totals.lateMinutes, 15);
  // Outcomes and modes are orthogonal dimensions — the WFH present
  // day increments BOTH the present count and the WFH count.
  assert.equal(totals.dayCounts.present, 2);
  assert.equal(totals.modes.OFFICE, 1);
  assert.equal(totals.modes.WFH, 1);
});

test('aggregateDays: exceptions and holiday work fold in', () => {
  const totals = aggregateDays([
    presentDay({ exceptions: [TIMESHEET_EXCEPTION.MISSING_PUNCH] }),
    presentDay({ date: '2026-08-04', calendarPrimary: 'HOLIDAY', approvedOtMinutes: 60 }),
    presentDay({ date: '2026-08-05', bucket: TIMESHEET_OUTCOME.FUTURE }),
  ]);
  assert.equal(totals.missingPunchDays, 1);
  assert.equal(totals.workedHolidayDays, 1);
  assert.equal(totals.approvedOtMinutes, 60);
  assert.equal(totals.dayCounts.future, 1);
  assert.equal(totals.scheduledUnits, 2);
});

test('rates: documented formulas, null on empty denominators', () => {
  assert.deepEqual(attendanceRate({ workedUnits: 19.5, scheduledUnits: 22 }), { ratio: 0.8864, pct: 88.6 });
  assert.deepEqual(attendanceRate({ workedUnits: 0, scheduledUnits: 0 }), { ratio: null, pct: null });
  assert.deepEqual(absenceRate({ absentUnits: 2, scheduledUnits: 22 }), { ratio: 0.0909, pct: 9.1 });
  assert.equal(averageWorkedMinutes({ workedMinutes: 960, sessionDays: 2 }), 480);
  assert.equal(averageWorkedMinutes({ workedMinutes: 0, sessionDays: 0 }), null);
});

// ── Sources, OT, regularizations ─────────────────────────────

test('aggregateSources: shares sum from counts', () => {
  const sources = aggregateSources({ WEB: 8, KIOSK: 2 });
  assert.equal(sources.total, 10);
  assert.equal(sources.pcts.WEB, 80);
  assert.equal(sources.pcts.KIOSK, 20);
});

test('aggregateOt: TIME-only minutes, comp-off days separate', () => {
  const ot = aggregateOt([
    { status: 'APPROVED', requestedMinutes: 120, approvedMinutes: 90, compOffDays: 0 },
    { status: 'PENDING', requestedMinutes: 60, approvedMinutes: 0, compOffDays: 0 },
    { status: 'APPROVED', requestedMinutes: 0, approvedMinutes: 0, compOffDays: 1 },
  ]);
  assert.equal(ot.approved, 2);
  assert.equal(ot.pending, 1);
  assert.equal(ot.approvedMinutes, 90);
});

test('aggregateRegularizations: funnel counts', () => {
  const regs = aggregateRegularizations([
    { status: 'PENDING' },
    { status: 'APPROVED' },
    { status: 'REJECTED' },
    { status: 'CANCELLED' },
  ]);
  assert.equal(regs.submitted, 4);
  assert.equal(regs.pending, 1);
  assert.equal(regs.approved, 1);
  assert.equal(regs.rejected, 1);
});

// ── Reconciliation compare ───────────────────────────────────

test('compareReconLine: the four verdicts', () => {
  assert.equal(compareReconLine({ expected: null }).status, RECON_STATUS.NOT_FINALIZED);
  assert.equal(
    compareReconLine({ expected: { workingDays: 22 }, actual: null, currentVersion: 3 }).status,
    RECON_STATUS.NOT_SYNCED
  );
  const expected = { workingDays: 22, presentDays: 20, leaveBreakdown: { CASUAL: 1 } };
  const actual = { ...expected, attendanceSource: { version: 3 } };
  assert.equal(compareReconLine({ expected, actual, currentVersion: 3 }).status, RECON_STATUS.MATCH);
  const stale = { ...expected, attendanceSource: { version: 2 } };
  const staleResult = compareReconLine({ expected, actual: stale, currentVersion: 3 });
  assert.equal(staleResult.status, RECON_STATUS.MISMATCH);
  assert.equal(staleResult.diffs[0].field, 'attendanceSource.version');
  const drifted = { ...expected, presentDays: 19, attendanceSource: { version: 3 } };
  const driftResult = compareReconLine({ expected, actual: drifted, currentVersion: 3 });
  assert.equal(driftResult.status, RECON_STATUS.MISMATCH);
  assert.equal(driftResult.diffs[0].field, 'presentDays');
});

// ── Sorting and cache normalization ──────────────────────────

test('sortEmployeeRows: allowlisted fields, neutral default', () => {
  assert.ok(EMPLOYEE_SORT_FIELDS.includes('attendanceRate'));
  const rows = [{ name: 'Zed' }, { name: 'Amy' }];
  assert.deepEqual(sortEmployeeRows(rows).map((row) => row.name), ['Amy', 'Zed']);
  assert.deepEqual(parseEmployeeSort('-attendanceRate'), { field: 'attendanceRate', dir: -1 });
  assert.deepEqual(parseEmployeeSort('hackerField'), { field: 'name', dir: 1 });
});

test('normalizeAnalyticsFilters + stableSerialize are deterministic', () => {
  const first = normalizeAnalyticsFilters({ scope: 'COMPANY', actorId: 'a1', from: '2026-08-01', to: '2026-08-31', report: 'overview' });
  const second = normalizeAnalyticsFilters({ report: 'overview', to: '2026-08-31', from: '2026-08-01', actorId: 'a1', scope: 'COMPANY' });
  assert.equal(stableSerialize(first), stableSerialize(second));
  assert.match(stableSerialize(first), /"report":"overview"/);
});
