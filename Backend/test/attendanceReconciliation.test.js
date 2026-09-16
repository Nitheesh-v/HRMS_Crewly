// ─────────────────────────────────────────────────────────────
// Phase 31.7 — leave / holiday / weekly-off reconciliation.
// Hermetic: in-memory fakes, fixed clock, no payroll, no network.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATTENDANCE_PRESENCE,
  RECONCILIATION_CONFLICT,
  deriveCalendarContext,
  halfDayMidpoint,
  isLeaveCountedDay,
  leaveCoversDate,
  resolveDailyAttendance,
  weekdayKey,
} from '../src/services/attendance/attendanceReconciliationRules.js';
import {
  attendanceFactsFromControl,
  refreshDayProjection,
  refreshRangeForLeave,
  resolveDay,
  resolveHolidayForDay,
  resolveLeaveForDay,
  resolveWeeklyOff,
} from '../src/services/attendance/attendanceReconciliationService.js';

const COMPANY_A = 'cA';
const COMPANY_B = 'cB';
const USER_A = 'uA';
// 2026-09-14 Mon, 2026-09-13 Sun, 2026-09-12 Sat.
const MONDAY = '2026-09-14';
const SUNDAY = '2026-09-13';
const SATURDAY = '2026-09-12';

const ist = (date, time) => new Date(`${date}T${time}:00+05:30`);

const daySchedule = (overrides = {}) => ({
  status: 'RESOLVED',
  scheduledStartAt: ist(MONDAY, '09:00'),
  scheduledEndAt: ist(MONDAY, '18:00'),
  scheduledMinutes: 480,
  isWorkingDay: true,
  startTime: '09:00',
  endTime: '18:00',
  shiftName: 'Day shift',
  scheduleName: null,
  ...overrides,
});

const fullFacts = (overrides = {}) => ({
  presence: ATTENDANCE_PRESENCE.FULL,
  workedMinutes: 480,
  breakMinutes: 60,
  lateMinutes: 0,
  earlyMinutes: 0,
  outcomeBand: 'PRESENT',
  exceptions: [],
  effectiveIn: ist(MONDAY, '09:00'),
  effectiveOut: ist(MONDAY, '18:00'),
  expectedMinutes: 240,
  ...overrides,
});

const approvedLeave = (overrides = {}) => ({
  _id: 'lv1',
  companyId: COMPANY_A,
  user: USER_A,
  type: 'CASUAL',
  status: 'APPROVED',
  startDate: MONDAY,
  endDate: MONDAY,
  days: 1,
  ...overrides,
});

// ── generic fakes ────────────────────────────────────────────

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((clause) => matches(row, clause));
    if (value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp)) {
      const actual = row[key];
      if (value.$lte !== undefined) {
        if (actual === null || actual === undefined) return false;
        return actual instanceof Date || value.$lte instanceof Date
          ? actual.getTime() <= new Date(value.$lte).getTime()
          : actual <= value.$lte;
      }
      if (value.$gte !== undefined) {
        if (actual === null || actual === undefined) return false;
        return actual instanceof Date || value.$gte instanceof Date
          ? actual.getTime() >= new Date(value.$gte).getTime()
          : actual >= value.$gte;
      }
      return false;
    }
    if (value instanceof RegExp) return typeof row[key] === 'string' && value.test(row[key]);
    if (value === null || value === undefined) return row[key] === null || row[key] === undefined;
    return String(row[key]) === String(value);
  });

const makeFindModel = (rows = []) => ({
  rows,
  find: (filter) => ({ lean: async () => rows.filter((row) => matches(row, filter)) }),
  findOne: async (filter) => rows.find((row) => matches(row, filter)) || null,
  findById: (id) => ({ lean: async () => rows.find((row) => String(row._id) === String(id)) || null }),
  findOneAndUpdate: async (filter, update) => {
    const row = rows.find((entry) => matches(entry, filter));
    if (!row) return null;
    if (update.$set) Object.assign(row, update.$set);
    return row;
  },
});

// ── A. PURE CALENDAR / LEAVE PRIMITIVES ──────────────────────

test('rules: weekday keys and Leave-counting parity (weekends never charged)', () => {
  assert.equal(weekdayKey(MONDAY), 'MON');
  assert.equal(weekdayKey(SUNDAY), 'SUN');
  assert.equal(weekdayKey('nope'), null);
  assert.equal(isLeaveCountedDay(MONDAY), true);
  assert.equal(isLeaveCountedDay(SATURDAY), false);
  assert.equal(isLeaveCountedDay(SUNDAY), false);
});

test('rules: leave covers approved in-range counted days only', () => {
  const leave = approvedLeave({ startDate: SATURDAY, endDate: MONDAY, days: 1 });
  assert.equal(leaveCoversDate({ leave, date: MONDAY }), true);
  // Saturday sits inside the range but Leave charges nothing for
  // it — reconciliation must not call it leave either.
  assert.equal(leaveCoversDate({ leave, date: SATURDAY }), false);
  assert.equal(leaveCoversDate({ leave, date: SUNDAY }), false);
  assert.equal(leaveCoversDate({ leave: { ...leave, status: 'PENDING' }, date: MONDAY }), false);
  assert.equal(leaveCoversDate({ leave: { ...leave, status: 'REJECTED' }, date: MONDAY }), false);
  assert.equal(leaveCoversDate({ leave: { ...leave, status: 'CANCELLED' }, date: MONDAY }), false);
  assert.equal(leaveCoversDate({ leave, date: '2026-09-15' }), false);
  assert.equal(leaveCoversDate({ leave: null, date: MONDAY }), false);
});

test('rules: calendar keeps holiday primary and the weekly-off fact beside it', () => {
  assert.deepEqual(deriveCalendarContext({ holiday: null, weeklyOff: false }), {
    primary: 'WORK_DAY', alsoWeeklyOff: false, holiday: null,
  });
  assert.equal(deriveCalendarContext({ holiday: null, weeklyOff: true }).primary, 'WEEKLY_OFF');
  const both = deriveCalendarContext({ holiday: { name: 'Diwali', type: 'COMPANY' }, weeklyOff: true });
  assert.equal(both.primary, 'HOLIDAY');
  assert.equal(both.alsoWeeklyOff, true);
  assert.equal(both.holiday.name, 'Diwali');
});

test('rules: half-day midpoint is the scheduled window split, never noon', () => {
  const mid = halfDayMidpoint({ scheduledStartAt: ist(MONDAY, '09:00'), scheduledEndAt: ist(MONDAY, '18:00') });
  assert.equal(mid.toISOString(), ist(MONDAY, '13:30').toISOString());
  const night = halfDayMidpoint({ scheduledStartAt: ist(SUNDAY, '22:00'), scheduledEndAt: ist(MONDAY, '06:00') });
  assert.equal(night.toISOString(), ist(MONDAY, '02:00').toISOString());
  assert.equal(halfDayMidpoint({ scheduledStartAt: null, scheduledEndAt: null }), null);
  assert.equal(halfDayMidpoint({}), null);
});

// ── B. NORMAL WORKDAY ────────────────────────────────────────

test('rules: ordinary day — full work present, short absent, none absent, partial unresolved', () => {
  const base = { attendanceDate: MONDAY, schedule: daySchedule(), leave: null, holiday: null, weeklyOff: false };
  const present = resolveDailyAttendance({ ...base, attendance: fullFacts() });
  assert.equal(present.outcome, 'PRESENT');
  assert.deepEqual(present.fractions, { worked: 1, leave: 0, absent: 0 });
  assert.equal(present.calendar.primary, 'WORK_DAY');

  const half = resolveDailyAttendance({ ...base, attendance: fullFacts({ outcomeBand: 'HALF_DAY', workedMinutes: 240 }) });
  assert.equal(half.outcome, 'HALF_DAY');
  assert.deepEqual(half.fractions, { worked: 0.5, leave: 0, absent: 0 });

  const short = resolveDailyAttendance({ ...base, attendance: fullFacts({ outcomeBand: 'ABSENT', workedMinutes: 60 }) });
  assert.equal(short.outcome, 'ABSENT');
  assert.deepEqual(short.fractions, { worked: 0, leave: 0, absent: 1 });
  // The minutes stay on the record even though the day counts absent.
  assert.equal(short.workedMinutes, 60);

  const none = resolveDailyAttendance({
    ...base, attendance: { ...fullFacts(), presence: ATTENDANCE_PRESENCE.NONE, workedMinutes: 0, outcomeBand: 'ABSENT', effectiveIn: null, effectiveOut: null },
  });
  assert.equal(none.outcome, 'ABSENT');
  assert.deepEqual(none.fractions, { worked: 0, leave: 0, absent: 1 });

  const partial = resolveDailyAttendance({
    ...base, attendance: { ...fullFacts(), presence: ATTENDANCE_PRESENCE.PARTIAL, outcomeBand: 'UNRESOLVED', effectiveOut: null },
  });
  assert.equal(partial.outcome, 'UNRESOLVED');
  assert.equal(partial.unresolved, true);
  assert.deepEqual(partial.fractions, { worked: 0, leave: 0, absent: 0 });
});

// ── C. FULL-DAY LEAVE ────────────────────────────────────────

test('rules: approved full-day leave with no work is leave — never absent, never present', () => {
  const leave = { portion: 'FULL_DAY', leaveId: 'lv1', type: 'CASUAL', label: 'Casual Leave' };
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: { ...fullFacts(), presence: ATTENDANCE_PRESENCE.NONE, workedMinutes: 0, outcomeBand: 'ABSENT', effectiveIn: null, effectiveOut: null },
    schedule: daySchedule(),
    leave,
    holiday: null,
    weeklyOff: false,
  });
  assert.equal(res.outcome, 'NON_WORKING_DAY');
  assert.deepEqual(res.fractions, { worked: 0, leave: 1, absent: 0 });
  assert.deepEqual(res.leave, leave);
  assert.deepEqual(res.conflicts, []);
  assert.equal(res.needsReview, false);
});

test('rules: punches under approved full-day leave preserve both facts and flag conflict', () => {
  const leave = { portion: 'FULL_DAY', leaveId: 'lv1', type: 'CASUAL', label: 'Casual Leave' };
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: fullFacts({ workedMinutes: 360 }),
    schedule: daySchedule(),
    leave,
    holiday: null,
    weeklyOff: false,
  });
  assert.equal(res.outcome, 'PRESENT');
  assert.equal(res.workedMinutes, 360);
  assert.deepEqual(res.leave, leave);
  assert.deepEqual(res.conflicts, [RECONCILIATION_CONFLICT.ATTENDANCE_ON_APPROVED_LEAVE]);
  assert.equal(res.needsReview, true);
  // Per-dimension claims: the approved day AND the worked day coexist.
  assert.deepEqual(res.fractions, { worked: 1, leave: 1, absent: 0 });
});

test('rules: in-only session under approved leave is unresolved conflict, not a guess', () => {
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: { ...fullFacts(), presence: ATTENDANCE_PRESENCE.PARTIAL, outcomeBand: 'UNRESOLVED', effectiveOut: null, workedMinutes: 0 },
    schedule: daySchedule(),
    leave: { portion: 'FULL_DAY', leaveId: 'lv1', type: 'CASUAL', label: 'Casual Leave' },
    holiday: null,
    weeklyOff: false,
  });
  assert.equal(res.outcome, 'UNRESOLVED');
  assert.deepEqual(res.conflicts, [RECONCILIATION_CONFLICT.ATTENDANCE_ON_APPROVED_LEAVE]);
  assert.equal(res.needsReview, true);
});

// ── D. HALF-DAY LEAVE (injected portions) ────────────────────

test('rules: first-half leave + second-half work resolves half + half', () => {
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: fullFacts({ effectiveIn: ist(MONDAY, '13:30'), effectiveOut: ist(MONDAY, '18:00'), workedMinutes: 240 }),
    schedule: daySchedule(),
    leave: { portion: 'FIRST_HALF', leaveId: 'lv1', type: 'CASUAL', label: 'Casual Leave' },
    holiday: null,
    weeklyOff: false,
  });
  assert.equal(res.outcome, 'HALF_DAY');
  assert.deepEqual(res.fractions, { worked: 0.5, leave: 0.5, absent: 0 });
  assert.equal(res.halves.first, 'LEAVE');
  assert.equal(res.halves.second, 'WORKED');
  assert.deepEqual(res.conflicts, []);
});

test('rules: second-half leave + first-half work resolves half + half', () => {
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: fullFacts({ effectiveIn: ist(MONDAY, '09:00'), effectiveOut: ist(MONDAY, '13:30'), workedMinutes: 240 }),
    schedule: daySchedule(),
    leave: { portion: 'SECOND_HALF', leaveId: 'lv1', type: 'SICK', label: 'Sick Leave' },
    holiday: null,
    weeklyOff: false,
  });
  assert.equal(res.outcome, 'HALF_DAY');
  assert.equal(res.halves.first, 'WORKED');
  assert.equal(res.halves.second, 'LEAVE');
});

test('rules: half-day leave with no work excuses only half — the rest is absence', () => {
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: { ...fullFacts(), presence: ATTENDANCE_PRESENCE.NONE, workedMinutes: 0, outcomeBand: 'ABSENT', effectiveIn: null, effectiveOut: null },
    schedule: daySchedule(),
    leave: { portion: 'FIRST_HALF', leaveId: 'lv1', type: 'CASUAL', label: 'Casual Leave' },
    holiday: null,
    weeklyOff: false,
  });
  assert.equal(res.outcome, 'ABSENT');
  assert.deepEqual(res.fractions, { worked: 0, leave: 0.5, absent: 0.5 });
  assert.equal(res.halves.first, 'LEAVE');
  assert.equal(res.halves.second, 'ABSENT');
});

test('rules: short work on a half-leave day leaves the working half absent', () => {
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: fullFacts({ effectiveIn: ist(MONDAY, '13:30'), effectiveOut: ist(MONDAY, '15:00'), workedMinutes: 90, outcomeBand: 'ABSENT' }),
    schedule: daySchedule(),
    leave: { portion: 'FIRST_HALF', leaveId: 'lv1', type: 'CASUAL', label: 'Casual Leave' },
    holiday: null,
    weeklyOff: false,
  });
  assert.equal(res.outcome, 'ABSENT');
  assert.deepEqual(res.fractions, { worked: 0, leave: 0.5, absent: 0.5 });
  assert.ok(res.exceptions.includes('SHORT_HOURS'));
});

test('rules: work inside the leave half is a mismatch conflict — leave never moves', () => {
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: fullFacts({ effectiveIn: ist(MONDAY, '09:00'), effectiveOut: ist(MONDAY, '12:00'), workedMinutes: 180 }),
    schedule: daySchedule(),
    leave: { portion: 'FIRST_HALF', leaveId: 'lv1', type: 'CASUAL', label: 'Casual Leave' },
    holiday: null,
    weeklyOff: false,
  });
  assert.deepEqual(res.conflicts, [RECONCILIATION_CONFLICT.LEAVE_HALF_MISMATCH]);
  assert.equal(res.needsReview, true);
  assert.equal(res.leave.portion, 'FIRST_HALF');
  assert.equal(res.workedMinutes, 180);
});

test('rules: half-day leave without a schedule stays unresolved (no noon split)', () => {
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: fullFacts(),
    schedule: null,
    leave: { portion: 'FIRST_HALF', leaveId: 'lv1', type: 'CASUAL', label: 'Casual Leave' },
    holiday: null,
    weeklyOff: false,
  });
  assert.equal(res.outcome, 'UNRESOLVED');
  assert.equal(res.halves.first, 'LEAVE');
  assert.equal(res.halves.second, 'UNRESOLVED');
  assert.equal(res.halves.midpoint, null);
});

// ── E. WEEKLY OFF / HOLIDAY ──────────────────────────────────

test('rules: weekly off and holiday without work are non-working — never absent', () => {
  const none = { ...fullFacts(), presence: ATTENDANCE_PRESENCE.NONE, workedMinutes: 0, outcomeBand: 'ABSENT', effectiveIn: null, effectiveOut: null };
  const off = resolveDailyAttendance({
    attendanceDate: SUNDAY, attendance: none, schedule: daySchedule({ isWorkingDay: false }),
    leave: null, holiday: null, weeklyOff: true,
  });
  assert.equal(off.outcome, 'NON_WORKING_DAY');
  assert.equal(off.calendar.primary, 'WEEKLY_OFF');
  assert.deepEqual(off.fractions, { worked: 0, leave: 0, absent: 0 });

  const hol = resolveDailyAttendance({
    attendanceDate: MONDAY, attendance: none, schedule: daySchedule(),
    leave: null, holiday: { name: 'Diwali', type: 'NATIONAL' }, weeklyOff: false,
  });
  assert.equal(hol.outcome, 'NON_WORKING_DAY');
  assert.equal(hol.calendar.primary, 'HOLIDAY');
  assert.deepEqual(hol.fractions, { worked: 0, leave: 0, absent: 0 });
});

test('rules: work on weekly off / holiday keeps every fact and flags the flags', () => {
  const off = resolveDailyAttendance({
    attendanceDate: SUNDAY,
    attendance: { ...fullFacts(), effectiveIn: ist(SUNDAY, '10:00'), effectiveOut: ist(SUNDAY, '16:00'), workedMinutes: 330 },
    schedule: daySchedule({ isWorkingDay: false }),
    leave: null, holiday: null, weeklyOff: true,
  });
  assert.equal(off.outcome, 'NON_WORKING_DAY');
  assert.equal(off.calendar.primary, 'WEEKLY_OFF');
  assert.equal(off.nonWorkingDayWorked, true);
  assert.equal(off.weeklyOffWorked, true);
  assert.equal(off.holidayWorked, false);
  assert.equal(off.workedMinutes, 330);

  const hol = resolveDailyAttendance({
    attendanceDate: MONDAY, attendance: fullFacts(),
    schedule: daySchedule(), leave: null,
    holiday: { name: 'Diwali', type: 'NATIONAL' }, weeklyOff: false,
  });
  assert.equal(hol.calendar.primary, 'HOLIDAY');
  assert.equal(hol.nonWorkingDayWorked, true);
  assert.equal(hol.holidayWorked, true);
  assert.equal(hol.weeklyOffWorked, false);
});

test('rules: holiday on a weekly off keeps both — primary holiday, off retained', () => {
  const res = resolveDailyAttendance({
    attendanceDate: SUNDAY, attendance: fullFacts(),
    schedule: daySchedule({ isWorkingDay: false }), leave: null,
    holiday: { name: 'Diwali', type: 'NATIONAL' }, weeklyOff: true,
  });
  assert.equal(res.calendar.primary, 'HOLIDAY');
  assert.equal(res.calendar.alsoWeeklyOff, true);
  assert.equal(res.holidayWorked, true);
  assert.equal(res.weeklyOffWorked, true);
});

test('rules: leave over a holiday keeps both facts (Leave charges holidays)', () => {
  const res = resolveDailyAttendance({
    attendanceDate: MONDAY,
    attendance: { ...fullFacts(), presence: ATTENDANCE_PRESENCE.NONE, workedMinutes: 0, outcomeBand: 'ABSENT', effectiveIn: null, effectiveOut: null },
    schedule: daySchedule(),
    leave: { portion: 'FULL_DAY', leaveId: 'lv1', type: 'EARNED', label: 'Earned Leave' },
    holiday: { name: 'Pongal', type: 'COMPANY' },
    weeklyOff: false,
  });
  assert.equal(res.calendar.primary, 'HOLIDAY');
  assert.equal(res.leave.portion, 'FULL_DAY');
  assert.deepEqual(res.fractions, { worked: 0, leave: 1, absent: 0 });
});

// ── F. SERVICE: CONTEXT RESOLUTION ───────────────────────────

test('service: approved leave resolves with label; others never apply', async () => {
  const LeaveModel = makeFindModel([
    approvedLeave({ _id: 'lvA' }),
    approvedLeave({ _id: 'lvP', status: 'PENDING' }),
    approvedLeave({ _id: 'lvR', status: 'REJECTED' }),
    approvedLeave({ _id: 'lvC', status: 'CANCELLED' }),
    approvedLeave({ _id: 'lvB', companyId: COMPANY_B }),
  ]);
  const hit = await resolveLeaveForDay({ LeaveModel, companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY });
  assert.deepEqual(hit, { portion: 'FULL_DAY', leaveId: 'lvA', type: 'CASUAL', label: 'Casual Leave' });
  assert.equal(await resolveLeaveForDay({ LeaveModel, companyId: COMPANY_A, userId: USER_A, attendanceDate: SATURDAY }), null);
  assert.equal(await resolveLeaveForDay({ LeaveModel: null, companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY }), null);
});

test('service: holiday and weekly-off degrade cleanly without sources', async () => {
  const engine = {
    holidayOnDate: async () => ({ name: 'Diwali', type: 'NATIONAL' }),
    getWorkingDaysForUser: async () => ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  };
  const hol = await resolveHolidayForDay({ engine, companyId: COMPANY_A, user: { _id: USER_A }, attendanceDate: MONDAY });
  assert.deepEqual(hol, { name: 'Diwali', type: 'NATIONAL' });
  assert.equal(await resolveHolidayForDay({ engine: null, companyId: COMPANY_A, user: null, attendanceDate: MONDAY }), null);

  assert.equal(await resolveWeeklyOff({ schedule: daySchedule(), attendanceDate: MONDAY }), false);
  assert.equal(await resolveWeeklyOff({ schedule: daySchedule({ isWorkingDay: false }), attendanceDate: SUNDAY }), true);
  assert.equal(await resolveWeeklyOff({ schedule: null, engine, companyId: COMPANY_A, user: null, attendanceDate: SUNDAY }), true);
  assert.equal(await resolveWeeklyOff({ schedule: null, engine, companyId: COMPANY_A, user: null, attendanceDate: MONDAY }), false);
  assert.equal(await resolveWeeklyOff({ schedule: null, engine: null, attendanceDate: SUNDAY }), false);
});

test('service: control facts reuse the verdict band and the corrected overlay', () => {
  const control = {
    punchIn: ist(MONDAY, '09:05'), punchOut: ist(MONDAY, '18:00'),
    status: 'LATE', workMinutes: 475, breakMinutes: 60, lateMinutes: 5, earlyMinutes: 0,
    policyExceptions: ['LATE_IN'],
  };
  const facts = attendanceFactsFromControl(control);
  assert.equal(facts.presence, 'FULL');
  assert.equal(facts.outcomeBand, 'PRESENT');
  assert.deepEqual(facts.exceptions, ['LATE_IN']);

  const corrected = attendanceFactsFromControl({
    punchIn: null, punchOut: null, status: 'PRESENT', workMinutes: 480,
    regularization: { correctedIn: ist(MONDAY, '09:00'), correctedOut: ist(MONDAY, '18:00') },
  });
  assert.equal(corrected.presence, 'FULL');
  assert.equal(corrected.effectiveIn.toISOString(), ist(MONDAY, '09:00').toISOString());

  const open = attendanceFactsFromControl({ punchIn: ist(MONDAY, '09:00'), punchOut: null, status: 'PRESENT' });
  assert.equal(open.presence, 'PARTIAL');
  assert.equal(open.outcomeBand, 'UNRESOLVED');
  assert.equal(attendanceFactsFromControl(null).presence, 'NONE');
});

// ── G. SERVICE: END-TO-END DAY ───────────────────────────────

const dayDeps = ({ leaves = [], holidays = [], workingDays = ['MON', 'TUE', 'WED', 'THU', 'FRI'] } = {}) => ({
  LeaveModel: makeFindModel(leaves),
  engine: {
    holidayOnDate: async (companyId, user, date) => holidays.find((h) => h.date === date) || null,
    getWorkingDaysForUser: async () => workingDays,
  },
});

test('service: leave day, conflict day, and off-worked day resolve end to end', async () => {
  const deps = dayDeps({ leaves: [approvedLeave()], holidays: [{ date: SUNDAY, name: 'Sunday Fest', type: 'COMPANY' }] });

  const onLeave = await resolveDay({
    companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY,
    schedule: daySchedule(), ...deps,
  });
  assert.equal(onLeave.outcome, 'NON_WORKING_DAY');
  assert.equal(onLeave.leave.type, 'CASUAL');
  assert.deepEqual(onLeave.fractions, { worked: 0, leave: 1, absent: 0 });

  const conflict = await resolveDay({
    companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY,
    attendance: fullFacts({ workedMinutes: 360 }),
    schedule: daySchedule(), ...deps,
  });
  assert.deepEqual(conflict.conflicts, ['ATTENDANCE_ON_APPROVED_LEAVE']);
  assert.equal(conflict.needsReview, true);

  const offWorked = await resolveDay({
    companyId: COMPANY_A, userId: USER_A, attendanceDate: SUNDAY,
    attendance: { ...fullFacts(), effectiveIn: ist(SUNDAY, '10:00'), effectiveOut: ist(SUNDAY, '14:00'), workedMinutes: 240 },
    schedule: daySchedule({ isWorkingDay: false }), ...deps,
  });
  assert.equal(offWorked.calendar.primary, 'HOLIDAY');
  assert.equal(offWorked.calendar.alsoWeeklyOff, true);
  assert.equal(offWorked.nonWorkingDayWorked, true);
});

test('service: overnight schedule anchors the resolution to the start date', async () => {
  const night = {
    status: 'RESOLVED',
    scheduledStartAt: ist(SUNDAY, '22:00'),
    scheduledEndAt: ist(MONDAY, '06:00'),
    scheduledMinutes: 420,
    isWorkingDay: true,
    startTime: '22:00',
    endTime: '06:00',
    shiftName: 'Night shift',
    scheduleName: null,
  };
  const res = await resolveDay({
    companyId: COMPANY_A, userId: USER_A, attendanceDate: SUNDAY,
    attendance: fullFacts({ effectiveIn: ist(SUNDAY, '22:05'), effectiveOut: ist(MONDAY, '05:30'), workedMinutes: 385 }),
    schedule: night,
    ...dayDeps(),
  });
  assert.equal(res.attendanceDate, SUNDAY);
  assert.equal(res.outcome, 'PRESENT');
  assert.equal(res.schedule.shiftName, 'Night shift');
});

test('service: tenancy is enforced on every read', async () => {
  const deps = dayDeps({ leaves: [approvedLeave({ companyId: COMPANY_B })] });
  const res = await resolveDay({
    companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY,
    schedule: daySchedule(), ...deps,
  });
  // Company B's approval is invisible to Company A: plain absence.
  assert.equal(res.leave.portion, 'NONE');
  assert.equal(res.outcome, 'ABSENT');
});

// ── H. PROJECTION REFRESH ────────────────────────────────────

test('service: refresh persists onto the control; control-less days resolve only', async () => {
  const AttendanceModel = makeFindModel([{
    _id: 'att1', companyId: COMPANY_A, user: USER_A, date: MONDAY,
    punchIn: ist(MONDAY, '09:00'), punchOut: ist(MONDAY, '18:00'),
    status: 'PRESENT', workMinutes: 480,
  }]);
  const { resolved, persisted } = await refreshDayProjection({
    AttendanceModel,
    companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY,
    schedule: daySchedule(),
    ...dayDeps({ leaves: [approvedLeave()] }),
    now: ist(MONDAY, '18:01'),
  });
  assert.equal(persisted, true);
  assert.deepEqual(resolved.conflicts, ['ATTENDANCE_ON_APPROVED_LEAVE']);
  assert.equal(AttendanceModel.rows[0].reconciliation.needsReview, true);
  assert.equal(AttendanceModel.rows[0].reconciliation.resolvedBy, 'SYSTEM');

  const bare = await refreshDayProjection({
    AttendanceModel: makeFindModel([]),
    companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY,
    schedule: daySchedule(), ...dayDeps(),
  });
  // No control row is fabricated for the empty day.
  assert.equal(bare.persisted, false);
  assert.equal(bare.resolved.outcome, 'ABSENT');
});

test('service: leave-range refresh is bounded, idempotent, and never throws', async () => {
  const AttendanceModel = makeFindModel([
    { _id: 'a1', companyId: COMPANY_A, user: USER_A, date: MONDAY, punchIn: ist(MONDAY, '09:00'), punchOut: ist(MONDAY, '18:00'), status: 'PRESENT', workMinutes: 480 },
    { _id: 'a2', companyId: COMPANY_A, user: USER_A, date: '2026-09-15', punchIn: ist('2026-09-15', '09:00'), punchOut: ist('2026-09-15', '18:00'), status: 'PRESENT', workMinutes: 480 },
  ]);
  const leave = approvedLeave({ startDate: MONDAY, endDate: '2026-09-16' });
  const LeaveModel = makeFindModel([leave]);
  const first = await refreshRangeForLeave({
    leave, AttendanceModel, LeaveModel, UserModel: makeFindModel([]), engine: dayDeps().engine,
  });
  assert.equal(first.dates, 3);
  assert.equal(first.refreshed, 2);
  assert.equal(first.skipped, 1);
  assert.equal(AttendanceModel.rows[0].reconciliation.leave.portion, 'FULL_DAY');
  const second = await refreshRangeForLeave({
    leave, AttendanceModel, LeaveModel, UserModel: makeFindModel([]), engine: dayDeps().engine,
  });
  assert.deepEqual(second, first);

  // Garbage in, summary out — never a throw.
  assert.deepEqual(await refreshRangeForLeave({ leave: null }), { refreshed: 0, skipped: 0, dates: 0 });
  assert.deepEqual(await refreshRangeForLeave({ leave: {} }), { refreshed: 0, skipped: 0, dates: 0 });
  const broken = await refreshRangeForLeave({
    leave,
    AttendanceModel: { findOne: async () => { throw new Error('db down'); } },
    LeaveModel, engine: dayDeps().engine,
  });
  assert.equal(broken.refreshed, 0);
  assert.equal(broken.skipped, 3);
});

// ── I. STATIC GUARDS ─────────────────────────────────────────

test('static: 31.7 modules never touch payroll, money, or comp-off/OT workflows', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'attendance');
  for (const file of ['attendanceReconciliationRules.js', 'attendanceReconciliationService.js']) {
    const raw = readFileSync(join(root, file), 'utf8');
    const content = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.ok(!/payroll/i.test(content), `${file} must not reference payroll`);
    assert.ok(!/salary|wage|amount|rupee|deduction/i.test(content), `${file} must not do money math`);
    assert.ok(!/comp[-_ ]?off/i.test(content), `${file} must not touch comp-off (31.8)`);
    assert.ok(!/approve.*overtime|overtime.*approv/i.test(content), `${file} must not approve OT (31.8)`);
  }
});

test('static: the rules module is pure — no models, no mongoose, no clock, no leave writes', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'attendance');
  const content = readFileSync(join(root, 'attendanceReconciliationRules.js'), 'utf8');
  assert.ok(!/from '\.\.\/\.\.\/models\//.test(content), 'rules must not import models');
  assert.ok(!/mongoose/i.test(content), 'rules must not touch mongoose');
  assert.ok(!/new Date\(\)/.test(content), 'rules must not read the wall clock');
  const svc = readFileSync(join(root, 'attendanceReconciliationService.js'), 'utf8');
  const svcCode = svc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.ok(!/LeaveModel\.(create|findOneAndUpdate|updateOne|updateMany|save|deleteOne)/.test(svcCode), 'service must never write leave');
});
