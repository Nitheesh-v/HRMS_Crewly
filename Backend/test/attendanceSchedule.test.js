// ─────────────────────────────────────────────────────────────
// Phase 31.6 — shift/roster intelligence. Hermetic: every Mongo
// collaborator is an in-memory fake, the clock is fixed, and no
// test touches payroll, leave, or the network.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NEUTRAL_VERDICT,
  SCHEDULE_STATUS,
  addDays,
  businessDateForInstant,
  dayKeyInZone,
  deriveScheduledMinutes,
  deriveScheduleVerdict,
  shiftIntervalForDate,
  summarizeSchedule,
  zonedTimeToUtc,
} from '../src/services/attendance/attendanceScheduleRules.js';
import {
  buildScheduleSnapshot,
  deriveAttendanceVerdict,
  resolveEmployeeSchedule,
  resolveStoredSchedule,
  summarizeForToday,
  verdictInputsFromRule,
} from '../src/services/attendance/attendanceScheduleService.js';
import {
  getLiveAttendance,
  recordEvent,
} from '../src/services/attendance/attendanceEventService.js';
import { rebuildDayProjection } from '../src/services/attendance/attendanceRegularizationService.js';
import { dayKey } from '../src/utils/scheduleEngine.js';

const TZ = 'Asia/Kolkata';
const COMPANY_A = 'cA';
const COMPANY_B = 'cB';
const USER_A = 'uA';
const USER_B = 'uB';
// 2026-09-14 is a Monday; 2026-09-13 a Sunday.
const MONDAY = '2026-09-14';
const SUNDAY = '2026-09-13';
const TUESDAY = '2026-09-15';

const ist = (date, time) => new Date(`${date}T${time}:00+05:30`);

// ── Generic matcher (equality, $or, $lte/$gte/$ne, RegExp, null,
// array-contains for employees[]/departments[]) ────────────────
const toTime = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((clause) => matches(row, clause));
    if (value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp)) {
      const actual = row[key];
      if (value.$lte !== undefined) {
        if (actual === null || actual === undefined) return false;
        return actual instanceof Date || value.$lte instanceof Date
          ? toTime(actual) <= toTime(value.$lte)
          : actual <= value.$lte;
      }
      if (value.$gte !== undefined) {
        if (actual === null || actual === undefined) return false;
        return actual instanceof Date || value.$gte instanceof Date
          ? toTime(actual) >= toTime(value.$gte)
          : actual >= value.$gte;
      }
      if (value.$ne !== undefined) return String(actual ?? null) !== String(value.$ne);
      if (value.$in !== undefined) return value.$in.map(String).includes(String(actual ?? null));
      if (value.$exists !== undefined) return (actual !== undefined) === Boolean(value.$exists);
      return false;
    }
    if (value instanceof RegExp) return typeof row[key] === 'string' && value.test(row[key]);
    if (value === null || value === undefined) return row[key] === null || row[key] === undefined;
    const actual = row[key];
    if (Array.isArray(actual)) return actual.map(String).includes(String(value));
    if (actual instanceof Date || value instanceof Date) return toTime(actual) === toTime(value);
    return String(actual) === String(value);
  });

const applySort = (rows, spec) => {
  const [field, dir] = typeof spec === 'string'
    ? [spec.startsWith('-') ? spec.slice(1) : spec, spec.startsWith('-') ? -1 : 1]
    : [Object.keys(spec)[0], Object.values(spec)[0]];
  return [...rows].sort((a, b) => {
    const av = a[field] instanceof Date ? a[field].getTime() : a[field];
    const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av < bv ? -1 : 1) * dir;
  });
};

const makeFindModel = (rows = []) => ({
  rows,
  findOne: (filter) => ({
    sort: (spec) => ({ lean: async () => applySort(rows.filter((row) => matches(row, filter)), spec)[0] || null }),
    lean: async () => rows.find((row) => matches(row, filter)) || null,
  }),
  findById: (id) => ({ lean: async () => rows.find((row) => String(row._id) === String(id)) || null }),
  find: (filter) => ({
    sort: () => ({ lean: async () => rows.filter((row) => matches(row, filter)) }),
    lean: async () => rows.filter((row) => matches(row, filter)),
  }),
});

let seq = 1;
const makeAttendanceModel = (rows = []) => ({
  rows,
  // Thenable + chainable: production awaits it bare AND via .sort().
  findOne: (filter) => {
    const run = (spec) => {
      const list = rows.filter((row) => matches(row, filter));
      return (spec ? applySort(list, spec) : list)[0] || null;
    };
    return {
      sort: (spec) => Promise.resolve(run(spec)),
      lean: () => Promise.resolve(run()),
      then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
    };
  },
  create: async (doc) => {
    const created = { _id: `att${seq++}`, ...doc };
    rows.push(created);
    return created;
  },
  findOneAndUpdate: async (filter, update, options = {}) => {
    const row = rows.find((entry) => matches(entry, filter));
    if (!row) return null;
    if (update.$set) Object.assign(row, update.$set);
    if (update.$inc) for (const [key, delta] of Object.entries(update.$inc)) row[key] = (row[key] || 0) + delta;
    return options.new ? row : row;
  },
});

const makeEventModel = (rows = []) => ({
  rows,
  find: (filter) => ({
    sort: () => ({ lean: async () => rows.filter((row) => matches(row, filter)) }),
    lean: async () => rows.filter((row) => matches(row, filter)),
  }),
  findOne: async (filter) => rows.find((row) => matches(row, filter)) || null,
  create: async (doc) => {
    const created = { _id: `ev${seq++}`, ...doc };
    rows.push(created);
    return created;
  },
});

const policy = (overrides = {}) => ({
  version: 3,
  timezone: TZ,
  thresholds: { fullDayMinutes: 480, halfDayMinutes: 240 },
  grace: { lateInMinutes: 0, earlyOutMinutes: 0 },
  breaks: { enabled: true, includeInWorkedTime: false, dailyLimitMinutes: null },
  missingPunch: { keepUnresolved: true, allowRegularization: true, regularizationWindowDays: 7 },
  overtime: { trackingEnabled: true, minimumExtraMinutes: 30, approvalRequired: true, weekendEligible: true, holidayEligible: false },
  weekendHoliday: { allowWorkOnWeeklyOff: true, allowWorkOnHoliday: true },
  workModes: { office: true, wfh: true, field: true, clientSite: true, businessTravel: true },
  ...overrides,
});

const dayShift = (overrides = {}) => ({
  _id: 'sDay',
  companyId: COMPANY_A,
  name: 'Day shift',
  type: 'FIXED',
  startTime: '09:00',
  endTime: '18:00',
  breakMinutes: 60,
  minWorkingHours: 8,
  isActive: true,
  employees: [],
  departments: [],
  ...overrides,
});

const nightShift = (overrides = {}) => ({
  _id: 'sNight',
  companyId: COMPANY_A,
  name: 'Night shift',
  type: 'FIXED',
  startTime: '22:00',
  endTime: '06:00',
  breakMinutes: 60,
  minWorkingHours: 8,
  isActive: true,
  employees: [],
  departments: [],
  ...overrides,
});

const empAssignment = (userId, shiftId, from, to = null, extra = {}) => ({
  _id: `asg-${userId}-${shiftId}-${from}`,
  companyId: COMPANY_A,
  user: userId,
  department: null,
  shift: shiftId,
  effectiveFrom: new Date(`${from}T00:00:00Z`),
  effectiveTo: to ? new Date(`${to}T00:00:00Z`) : null,
  ...extra,
});

const scheduleEngine = () => ({
  getWorkingDaysForUser: async () => ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  dayKey,
  holidayOnDate: async () => null,
});

// ── A. PURE RULES ────────────────────────────────────────────

test('rules: zoned time converts through Intl (IST + DST-aware New York)', () => {
  assert.equal(zonedTimeToUtc(MONDAY, '09:00', TZ).toISOString(), '2026-09-14T03:30:00.000Z');
  // July New York is EDT (UTC-4), January is EST (UTC-5): a fixed
  // offset would fail one of these; Intl passes both.
  assert.equal(zonedTimeToUtc('2026-07-14', '09:00', 'America/New_York').toISOString(), '2026-07-14T13:00:00.000Z');
  assert.equal(zonedTimeToUtc('2026-01-14', '09:00', 'America/New_York').toISOString(), '2026-01-14T14:00:00.000Z');
  assert.equal(zonedTimeToUtc(MONDAY, '9am', TZ), null);
  assert.equal(zonedTimeToUtc('not-a-date', '09:00', TZ), null);
  assert.equal(dayKeyInZone(ist(MONDAY, '00:30'), TZ), MONDAY);
});

test('rules: day and overnight intervals frame on the shift START date', () => {
  const day = shiftIntervalForDate({ date: MONDAY, startTime: '09:00', endTime: '18:00', timezone: TZ });
  assert.equal(day.crossesMidnight, false);
  assert.equal(day.startAt.toISOString(), '2026-09-14T03:30:00.000Z');
  assert.equal(day.endAt.toISOString(), '2026-09-14T12:30:00.000Z');
  assert.equal(day.spanMinutes, 540);

  const night = shiftIntervalForDate({ date: SUNDAY, startTime: '22:00', endTime: '06:00', timezone: TZ });
  assert.equal(night.crossesMidnight, true);
  assert.equal(night.startAt.toISOString(), '2026-09-13T16:30:00.000Z');
  assert.equal(night.endAt.toISOString(), '2026-09-14T00:30:00.000Z');
  assert.equal(night.spanMinutes, 480);

  // Engine parity: end == start reads as a 24-hour overnight span.
  const full = shiftIntervalForDate({ date: MONDAY, startTime: '09:00', endTime: '09:00', timezone: TZ });
  assert.equal(full.crossesMidnight, true);
  assert.equal(full.spanMinutes, 1440);
  assert.equal(shiftIntervalForDate({ date: MONDAY, startTime: '09:00', endTime: '9am', timezone: TZ }), null);
  assert.equal(deriveScheduledMinutes({ startAt: day.startAt, endAt: day.endAt, breakMinutes: 60 }), 480);
  assert.equal(addDays(MONDAY, -1), SUNDAY);
});

test('rules: business date anchors post-midnight arrivals to yesterday (inclusive)', () => {
  const night = shiftIntervalForDate({ date: SUNDAY, startTime: '22:00', endTime: '06:00', timezone: TZ });
  const yesterdayInterval = { startAt: night.startAt, endAt: night.endAt };
  assert.equal(businessDateForInstant({ now: ist(MONDAY, '00:30'), timezone: TZ, yesterdayInterval }), SUNDAY);
  assert.equal(businessDateForInstant({ now: ist(MONDAY, '07:00'), timezone: TZ, yesterdayInterval }), MONDAY);
  // Window edges belong to the window (strict inclusive, no grace).
  assert.equal(businessDateForInstant({ now: ist(MONDAY, '06:00'), timezone: TZ, yesterdayInterval }), SUNDAY);
  assert.equal(businessDateForInstant({ now: ist(MONDAY, '00:00'), timezone: TZ, yesterdayInterval }), SUNDAY);
  // Saturday's window never claims Sunday evening: the caller always
  // passes the window of the calendar yesterday.
  const saturday = shiftIntervalForDate({ date: '2026-09-12', startTime: '22:00', endTime: '06:00', timezone: TZ });
  assert.equal(businessDateForInstant({ now: ist(SUNDAY, '22:00'), timezone: TZ, yesterdayInterval: { startAt: saturday.startAt, endAt: saturday.endAt } }), SUNDAY);
  assert.equal(businessDateForInstant({ now: ist(MONDAY, '00:30'), timezone: TZ, yesterdayInterval: null }), MONDAY);
});

test('rules: verdict stores the full delay, flags only what exceeds grace', () => {
  const day = shiftIntervalForDate({ date: MONDAY, startTime: '09:00', endTime: '18:00', timezone: TZ });
  const strict = policy({ grace: { lateInMinutes: 0, earlyOutMinutes: 0 } });

  const onTime = deriveScheduleVerdict({
    scheduledStartAt: day.startAt, scheduledEndAt: day.endAt,
    effectiveIn: ist(MONDAY, '09:00'), effectiveOut: ist(MONDAY, '18:00'),
    workedMinutes: 480, minimumMinutes: 480, policy: strict,
  });
  assert.deepEqual(
    { status: onTime.status, late: onTime.lateMinutes, early: onTime.earlyMinutes, ot: onTime.overtimeMinutes },
    { status: 'PRESENT', late: 0, early: 0, ot: 0 },
  );

  const late = deriveScheduleVerdict({
    scheduledStartAt: day.startAt, scheduledEndAt: day.endAt,
    effectiveIn: ist(MONDAY, '09:05'), effectiveOut: ist(MONDAY, '18:00'),
    workedMinutes: 475, minimumMinutes: 240, policy: strict,
  });
  assert.equal(late.status, 'LATE');
  assert.equal(late.lateMinutes, 5);
  assert.equal(late.lateBeyondGrace, 5);

  // Within grace: on-time verdict, but the factual delay is kept.
  const graced = deriveScheduleVerdict({
    scheduledStartAt: day.startAt, scheduledEndAt: day.endAt,
    effectiveIn: ist(MONDAY, '09:05'), effectiveOut: null,
    workedMinutes: 0, minimumMinutes: 480,
    policy: policy({ grace: { lateInMinutes: 15, earlyOutMinutes: 15 } }),
  });
  assert.equal(graced.status, 'PRESENT');
  assert.equal(graced.lateMinutes, 5);
  assert.equal(graced.lateBeyondGrace, 0);
});

test('rules: early-out and overtime candidates follow the 31.1 line', () => {
  const day = shiftIntervalForDate({ date: MONDAY, startTime: '09:00', endTime: '18:00', timezone: TZ });
  const strict = policy({ grace: { lateInMinutes: 0, earlyOutMinutes: 0 } });
  const base = {
    scheduledStartAt: day.startAt, scheduledEndAt: day.endAt,
    effectiveIn: ist(MONDAY, '09:00'), workedMinutes: 480, minimumMinutes: 480, policy: strict,
  };
  const early = deriveScheduleVerdict({ ...base, effectiveOut: ist(MONDAY, '17:00') });
  assert.equal(early.earlyMinutes, 60);
  assert.equal(early.isEarlyOut, true);
  assert.equal(early.overtimeMinutes, 0);

  const ot = deriveScheduleVerdict({ ...base, effectiveOut: ist(MONDAY, '19:00'), workedMinutes: 540 });
  assert.equal(ot.extraMinutes, 60);
  assert.equal(ot.overtimeMinutes, 60);
  assert.equal(ot.status, 'PRESENT');

  const belowMinimum = deriveScheduleVerdict({ ...base, effectiveOut: ist(MONDAY, '18:20'), workedMinutes: 500 });
  assert.equal(belowMinimum.extraMinutes, 20);
  assert.equal(belowMinimum.overtimeMinutes, 0);

  const untracked = deriveScheduleVerdict({
    ...base, effectiveOut: ist(MONDAY, '19:00'), workedMinutes: 540,
    policy: policy({ overtime: { trackingEnabled: false } }),
  });
  assert.equal(untracked.overtimeMinutes, 0);

  const weeklyOff = deriveScheduleVerdict({
    ...base, effectiveOut: ist(MONDAY, '19:00'), workedMinutes: 540, dayType: 'WEEKLY_OFF',
    policy: policy({ overtime: { trackingEnabled: true, minimumExtraMinutes: 0, weekendEligible: false } }),
  });
  assert.equal(weeklyOff.overtimeMinutes, 0);
});

test('rules: short days read HALF_DAY; open days never do', () => {
  const day = shiftIntervalForDate({ date: MONDAY, startTime: '09:00', endTime: '18:00', timezone: TZ });
  const strict = policy({ grace: { lateInMinutes: 0, earlyOutMinutes: 0 } });
  const short = deriveScheduleVerdict({
    scheduledStartAt: day.startAt, scheduledEndAt: day.endAt,
    effectiveIn: ist(MONDAY, '09:00'), effectiveOut: ist(MONDAY, '13:00'),
    workedMinutes: 200, minimumMinutes: 480, policy: strict,
  });
  assert.equal(short.status, 'HALF_DAY');
  const open = deriveScheduleVerdict({
    scheduledStartAt: day.startAt, scheduledEndAt: day.endAt,
    effectiveIn: ist(MONDAY, '09:00'), effectiveOut: null,
    workedMinutes: 0, minimumMinutes: 480, policy: strict,
  });
  assert.equal(open.status, 'PRESENT');
});

test('rules: no policy or no interval stays neutral (never guessed)', () => {
  const day = shiftIntervalForDate({ date: MONDAY, startTime: '09:00', endTime: '18:00', timezone: TZ });
  assert.deepEqual(deriveScheduleVerdict({
    scheduledStartAt: day.startAt, scheduledEndAt: day.endAt,
    effectiveIn: ist(MONDAY, '09:05'), effectiveOut: ist(MONDAY, '18:00'),
    workedMinutes: 475, minimumMinutes: 480, policy: null,
  }), NEUTRAL_VERDICT);
  assert.deepEqual(deriveScheduleVerdict({
    scheduledStartAt: null, scheduledEndAt: null,
    effectiveIn: ist(MONDAY, '09:05'), effectiveOut: null,
    workedMinutes: 0, policy: policy(),
  }), NEUTRAL_VERDICT);
});

test('rules: summary labels day and overnight windows; unresolved summarizes to null', () => {
  const dayCtx = {
    status: 'RESOLVED', startTime: '09:00', endTime: '18:00', crossesMidnight: false,
    scheduledStartAt: ist(MONDAY, '09:00'), scheduledEndAt: ist(MONDAY, '18:00'),
    scheduledMinutes: 480, isWorkingDay: true, dayType: 'WORK_DAY',
    shift: { name: 'Day shift' }, schedule: null, holiday: null,
  };
  const day = summarizeSchedule(dayCtx, { now: ist(MONDAY, '10:00') });
  assert.equal(day.windowLabel, '09:00 – 18:00');
  assert.equal(day.phase, 'IN_WINDOW');
  assert.equal(summarizeSchedule(dayCtx, { now: ist(MONDAY, '08:00') }).phase, 'UPCOMING');
  assert.equal(summarizeSchedule(dayCtx, { now: ist(MONDAY, '19:00') }).phase, 'ENDED');
  const night = summarizeSchedule({
    ...dayCtx, startTime: '22:00', endTime: '06:00', crossesMidnight: true,
    scheduledStartAt: ist(SUNDAY, '22:00'), scheduledEndAt: ist(MONDAY, '06:00'),
  });
  assert.equal(night.windowLabel, '22:00 – 06:00 (+1 day)');
  assert.equal(summarizeSchedule({ status: 'UNRESOLVED' }), null);
  assert.equal(summarizeSchedule(null), null);
});

// ── B. RESOLVER ──────────────────────────────────────────────

test('resolve: the dated chain beats recency — each date gets its own shift', async () => {
  const oldShift = dayShift({ _id: 'sOld', name: 'Old 8-5', startTime: '08:00', endTime: '17:00' });
  const newShift = dayShift({ _id: 'sNew', name: 'New 9-6', startTime: '09:00', endTime: '18:00' });
  const models = {
    ShiftAssignmentModel: makeFindModel([
      empAssignment(USER_A, 'sOld', '2026-01-01', '2026-08-31'),
      empAssignment(USER_A, 'sNew', '2026-09-01', null),
    ]),
    ShiftModel: makeFindModel([oldShift, newShift]),
    WorkScheduleModel: makeFindModel([]),
    UserModel: makeFindModel([{ _id: USER_A, companyId: COMPANY_A, department: null, branch: '' }]),
  };
  const engine = scheduleEngine();
  const sept = await resolveEmployeeSchedule({ companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY, timezone: TZ, ...models, engine });
  assert.equal(sept.status, SCHEDULE_STATUS.RESOLVED);
  assert.equal(sept.source, 'EMPLOYEE_OVERRIDE');
  assert.equal(sept.shift.name, 'New 9-6');
  assert.equal(sept.startTime, '09:00');
  const aug = await resolveEmployeeSchedule({ companyId: COMPANY_A, userId: USER_A, attendanceDate: '2026-08-20', timezone: TZ, ...models, engine });
  assert.equal(aug.shift.name, 'Old 8-5');
  assert.equal(aug.startTime, '08:00');
  // Before any assignment: honest UNRESOLVED, never the nearest row.
  const before = await resolveEmployeeSchedule({ companyId: COMPANY_A, userId: USER_A, attendanceDate: '2025-12-01', timezone: TZ, ...models, engine });
  assert.equal(before.status, SCHEDULE_STATUS.UNRESOLVED);
});

test('resolve: department assignment, then shift-doc, then schedule chain', async () => {
  const deptShift = dayShift({ _id: 'sDept', name: 'Dept shift' });
  const directShift = dayShift({ _id: 'sDirect', name: 'Direct shift', employees: [USER_B] });
  const general = {
    _id: 'wGeneral', companyId: COMPANY_A, name: 'General', isActive: true,
    employees: [], departments: [], branch: '', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    startTime: '09:30', endTime: '18:30', breakMinutes: 30,
  };
  const models = {
    ShiftAssignmentModel: makeFindModel([{
      _id: 'asg-dept', companyId: COMPANY_A, user: null, department: 'dEng',
      shift: 'sDept', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null,
    }]),
    ShiftModel: makeFindModel([deptShift, directShift]),
    WorkScheduleModel: makeFindModel([general]),
    UserModel: makeFindModel([]),
  };
  const engine = scheduleEngine();
  const viaDept = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user: { _id: USER_A, department: 'dEng' }, attendanceDate: MONDAY, timezone: TZ, ...models, engine,
  });
  assert.equal(viaDept.source, 'DEPARTMENT_DEFAULT');
  assert.equal(viaDept.shift.name, 'Dept shift');

  const viaDoc = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user: { _id: USER_B, department: 'dSales' }, attendanceDate: MONDAY, timezone: TZ, ...models, engine,
  });
  assert.equal(viaDoc.source, 'SHIFT_DOC');
  assert.equal(viaDoc.shift.name, 'Direct shift');

  const viaSchedule = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user: { _id: 'uC', department: 'dSales' }, attendanceDate: MONDAY, timezone: TZ, ...models, engine,
  });
  assert.equal(viaSchedule.source, 'WORK_SCHEDULE');
  assert.equal(viaSchedule.schedule.name, 'General');
  assert.equal(viaSchedule.startTime, '09:30');
});

test('resolve: empty world resolves UNRESOLVED; foreign-tenant rows never leak', async () => {
  const foreign = dayShift({ _id: 'sForeign', companyId: COMPANY_B, employees: [USER_A] });
  const models = {
    ShiftAssignmentModel: makeFindModel([empAssignment(USER_A, 'sForeign', '2026-01-01', null, { companyId: COMPANY_B })]),
    ShiftModel: makeFindModel([foreign]),
    WorkScheduleModel: makeFindModel([]),
    UserModel: makeFindModel([]),
  };
  const ctx = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user: { _id: USER_A }, attendanceDate: MONDAY, timezone: TZ, ...models, engine: scheduleEngine(),
  });
  assert.equal(ctx.status, SCHEDULE_STATUS.UNRESOLVED);

  const empty = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user: { _id: USER_A }, attendanceDate: MONDAY, timezone: TZ,
    ShiftAssignmentModel: makeFindModel([]), ShiftModel: makeFindModel([]),
    WorkScheduleModel: makeFindModel([]), UserModel: makeFindModel([]), engine: scheduleEngine(),
  });
  assert.equal(empty.status, SCHEDULE_STATUS.UNRESOLVED);
});

test('resolve: dead pointers fall through — inactive and foreign shifts are skipped', async () => {
  const dead = dayShift({ _id: 'sDead', name: 'Dead shift', isActive: false });
  const live = dayShift({ _id: 'sLive', name: 'Live shift' });
  const models = {
    ShiftAssignmentModel: makeFindModel([empAssignment(USER_A, 'sDead', '2026-01-01')]),
    ShiftModel: makeFindModel([dead, live]),
    WorkScheduleModel: makeFindModel([{
      _id: 'wAny', companyId: COMPANY_A, name: 'Any', isActive: true, employees: [], departments: [],
      branch: '', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], startTime: '09:00', endTime: '18:00',
    }]),
    UserModel: makeFindModel([]),
  };
  const ctx = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user: { _id: USER_A }, attendanceDate: MONDAY, timezone: TZ, ...models, engine: scheduleEngine(),
  });
  // The assignment's shift is inactive, so the chain keeps walking
  // instead of resolving the corpse.
  assert.equal(ctx.source, 'WORK_SCHEDULE');
});

test('resolve: overnight windows span dates; weekly-off and holidays ride along', async () => {
  const models = {
    ShiftAssignmentModel: makeFindModel([empAssignment(USER_A, 'sNight', '2026-09-01')]),
    ShiftModel: makeFindModel([nightShift()]),
    WorkScheduleModel: makeFindModel([]),
    UserModel: makeFindModel([]),
  };
  const night = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user: { _id: USER_A }, attendanceDate: SUNDAY, timezone: TZ, ...models, engine: scheduleEngine(),
  });
  assert.equal(night.status, SCHEDULE_STATUS.RESOLVED);
  assert.equal(night.crossesMidnight, true);
  assert.equal(new Date(night.scheduledStartAt).toISOString(), '2026-09-13T16:30:00.000Z');
  assert.equal(new Date(night.scheduledEndAt).toISOString(), '2026-09-14T00:30:00.000Z');

  // Sunday is outside the default MON–FRI working days.
  assert.equal(night.isWorkingDay, false);
  assert.equal(night.dayType, 'WEEKLY_OFF');

  const holidayEngine = { ...scheduleEngine(), holidayOnDate: async () => ({ name: 'Diwali', type: 'NATIONAL' }) };
  const dayModels = {
    ShiftAssignmentModel: makeFindModel([empAssignment(USER_A, 'sDay', '2026-09-01')]),
    ShiftModel: makeFindModel([dayShift()]),
    WorkScheduleModel: makeFindModel([]),
    UserModel: makeFindModel([]),
  };
  const festive = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user: { _id: USER_A }, attendanceDate: MONDAY, timezone: TZ, ...dayModels, engine: holidayEngine,
  });
  assert.equal(festive.isWorkingDay, true);
  assert.equal(festive.dayType, 'HOLIDAY');
  assert.equal(festive.holiday.name, 'Diwali');
});

test('resolve: userId-only callers load the person; snapshots round-trip exactly', async () => {
  const models = {
    ShiftAssignmentModel: makeFindModel([empAssignment(USER_A, 'sDay', '2026-09-01')]),
    ShiftModel: makeFindModel([dayShift()]),
    WorkScheduleModel: makeFindModel([]),
    UserModel: makeFindModel([{ _id: USER_A, companyId: COMPANY_A, department: null, branch: '' }]),
  };
  const ctx = await resolveEmployeeSchedule({
    companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY, timezone: TZ, ...models, engine: scheduleEngine(),
  });
  assert.equal(ctx.status, SCHEDULE_STATUS.RESOLVED);

  const snapshot = buildScheduleSnapshot({ ctx, rule: ctx.rule });
  assert.equal(snapshot.startTime, '09:00');
  assert.equal(snapshot.shiftName, 'Day shift');
  assert.equal(snapshot.minimumMinutes, 480);
  assert.ok(snapshot.scheduledStartAt instanceof Date);

  const stored = resolveStoredSchedule({ control: { date: MONDAY, scheduleSnapshot: snapshot } });
  assert.equal(stored.fromSnapshot, true);
  assert.equal(stored.scheduledStartAt.toISOString(), new Date(ctx.scheduledStartAt).toISOString());
  assert.equal(stored.scheduledEndAt.toISOString(), new Date(ctx.scheduledEndAt).toISOString());

  // Legacy and corrupt controls re-resolve instead of crashing.
  assert.equal(resolveStoredSchedule({ control: { date: MONDAY, shift: 'sDay' } }), null);
  assert.equal(resolveStoredSchedule({ control: { date: MONDAY, scheduleSnapshot: { startTime: '09:00' } } }), null);
  assert.equal(resolveStoredSchedule({}), null);
});

test('verdict: the shared fn serves contexts, legacy rules, and the unresolved', () => {
  const day = shiftIntervalForDate({ date: MONDAY, startTime: '09:00', endTime: '18:00', timezone: TZ });
  const strict = policy({ grace: { lateInMinutes: 0, earlyOutMinutes: 0 } });
  const ctx = {
    status: 'RESOLVED', scheduledStartAt: day.startAt, scheduledEndAt: day.endAt,
    minimumMinutes: 480, dayType: 'WORK_DAY',
  };
  const fromCtx = deriveAttendanceVerdict({
    resolved: { scheduleCtx: ctx }, attendanceDate: MONDAY, timezone: TZ, policy: strict,
    effectiveIn: ist(MONDAY, '09:05'), effectiveOut: ist(MONDAY, '18:05'), workedMinutes: 480,
  });
  assert.equal(fromCtx.status, 'LATE');
  assert.equal(fromCtx.lateMinutes, 5);

  // Legacy-injected rules (no context) frame on the business date.
  const inputs = verdictInputsFromRule({ rule: dayShift(), attendanceDate: MONDAY, timezone: TZ });
  assert.equal(inputs.minimumMinutes, 480);
  const fromRule = deriveAttendanceVerdict({
    resolved: { rule: dayShift() }, attendanceDate: MONDAY, timezone: TZ, policy: strict,
    effectiveIn: ist(MONDAY, '09:05'), effectiveOut: ist(MONDAY, '18:05'), workedMinutes: 480,
  });
  assert.equal(fromRule.status, 'LATE');
  assert.equal(fromRule.lateMinutes, 5);

  // Nothing resolved: honest neutral, never a guess.
  assert.deepEqual(deriveAttendanceVerdict({
    resolved: { rule: null, scheduleCtx: null }, attendanceDate: MONDAY, timezone: TZ, policy: strict,
    effectiveIn: ist(MONDAY, '09:05'), effectiveOut: null, workedMinutes: 0,
  }), NEUTRAL_VERDICT);
  assert.deepEqual(deriveAttendanceVerdict({
    resolved: null, attendanceDate: MONDAY, timezone: TZ, policy: strict,
    effectiveIn: ist(MONDAY, '09:05'), effectiveOut: null, workedMinutes: 0,
  }), NEUTRAL_VERDICT);

  const summary = summarizeForToday({
    ctx: {
      ...ctx, startTime: '09:00', endTime: '18:00', crossesMidnight: false,
      scheduledMinutes: 480, isWorkingDay: true, shift: { name: 'Day shift' }, schedule: null, holiday: null,
    },
    now: ist(MONDAY, '10:00'),
  });
  assert.equal(summary.windowLabel, '09:00 – 18:00');
  assert.equal(summary.phase, 'IN_WINDOW');
});

// ── C. LIVE INTEGRATION ──────────────────────────────────────

const liveDeps = ({ at, assignments, shifts, schedules = [], users = [], requests = [], activePolicy = null } = {}) => {
  const AttendanceModel = makeAttendanceModel([]);
  const AttendanceEventModel = makeEventModel([]);
  const deps = {
    AttendanceModel,
    AttendanceEventModel,
    CompanyModel: makeFindModel([{ _id: COMPANY_A, timezone: TZ }]),
    WorkModeRequestModel: makeFindModel(requests),
    ShiftAssignmentModel: makeFindModel(assignments),
    ShiftModel: makeFindModel(shifts),
    WorkScheduleModel: makeFindModel(schedules),
    UserModel: makeFindModel(users),
    engine: scheduleEngine(),
    policyReader: async () => ({ policy: activePolicy || policy(), configured: true, hasActive: true }),
    now: () => new Date(at),
  };
  return { deps, AttendanceModel, AttendanceEventModel };
};

test('live: clock-in on a day shift verdicts, snapshots, and carries context', async () => {
  const { deps, AttendanceModel } = liveDeps({
    at: ist(MONDAY, '09:05'),
    assignments: [empAssignment(USER_A, 'sDay', '2026-09-01')],
    shifts: [dayShift()],
  });
  const res = await recordEvent({ companyId: COMPANY_A, userId: USER_A, action: 'CLOCK_IN', workMode: 'OFFICE', deps });
  assert.equal(res.replayed, false);
  const control = AttendanceModel.rows[0];
  assert.equal(control.date, MONDAY);
  assert.equal(control.status, 'LATE');
  assert.equal(control.lateMinutes, 5);
  assert.equal(control.scheduleStatus, 'RESOLVED');
  assert.equal(control.scheduleSnapshot.startTime, '09:00');
  assert.equal(control.scheduleSnapshot.shiftName, 'Day shift');
  assert.equal(res.snapshot.schedule.source, 'EMPLOYEE_OVERRIDE');
  assert.equal(res.snapshot.schedule.windowLabel, '09:00 – 18:00');
  assert.equal(res.snapshot.schedule.crossesMidnight, false);
});

test('live: a 00:30 arrival anchors to yesterday — the shift START date', async () => {
  const { deps, AttendanceModel, AttendanceEventModel } = liveDeps({
    at: ist(TUESDAY, '00:30'),
    assignments: [empAssignment(USER_B, 'sNight', '2026-09-01')],
    shifts: [nightShift()],
  });
  const res = await recordEvent({ companyId: COMPANY_A, userId: USER_B, action: 'CLOCK_IN', workMode: 'OFFICE', deps });
  const control = AttendanceModel.rows[0];
  assert.equal(control.date, MONDAY);
  assert.equal(AttendanceEventModel.rows[0].date, MONDAY);
  assert.equal(control.scheduleStatus, 'RESOLVED');
  assert.equal(control.scheduleSnapshot.crossesMidnight, true);
  assert.equal(res.snapshot.schedule.windowLabel, '22:00 – 06:00 (+1 day)');
  // The arrival is genuinely 150 minutes after the 22:00 start.
  assert.equal(control.status, 'LATE');
  assert.equal(control.lateMinutes, 150);
});

test('live: an on-shift night arrival lands on its own start date', async () => {
  const { deps, AttendanceModel } = liveDeps({
    at: ist(MONDAY, '22:20'),
    assignments: [empAssignment(USER_A, 'sNight', '2026-09-01')],
    shifts: [nightShift()],
  });
  const res = await recordEvent({ companyId: COMPANY_A, userId: USER_A, action: 'CLOCK_IN', workMode: 'OFFICE', deps });
  assert.equal(AttendanceModel.rows[0].date, MONDAY);
  assert.equal(AttendanceModel.rows[0].lateMinutes, 20);
  assert.equal(res.snapshot.schedule.crossesMidnight, true);
});

test('live: clock-out evaluates the stored snapshot, not the edited shift', async () => {
  const shifts = makeFindModel([dayShift()]);
  const { deps, AttendanceModel } = liveDeps({
    at: ist(MONDAY, '09:05'),
    assignments: [empAssignment(USER_A, 'sDay', '2026-09-01')],
    shifts: shifts.rows,
  });
  // Point the live models at the SAME shift rows so the test can
  // rewrite them mid-day like an HR edit would.
  deps.ShiftModel = shifts;
  await recordEvent({ companyId: COMPANY_A, userId: USER_A, action: 'CLOCK_IN', workMode: 'OFFICE', deps });
  assert.equal(AttendanceModel.rows[0].scheduleSnapshot.startTime, '09:00');

  // HR moves the shift to 10:00 AFTER the employee clocked in.
  shifts.rows[0] = { ...shifts.rows[0], startTime: '10:00', endTime: '19:00' };
  deps.now = () => new Date(ist(MONDAY, '18:00'));
  await recordEvent({ companyId: COMPANY_A, userId: USER_A, action: 'CLOCK_OUT', deps });
  const control = AttendanceModel.rows[0];
  // Against the snapshot the 09:05 arrival is 5 late; against the
  // edited shift it would read on-time. The snapshot wins.
  assert.equal(control.lateMinutes, 5);
  assert.equal(control.earlyMinutes, 0);
  assert.equal(control.status, 'LATE');
  assert.equal(control.scheduleSnapshot.startTime, '09:00');
});

test('live: the today card at 01:00 shows yesterday\u2019s overnight window', async () => {
  const { deps } = liveDeps({
    at: ist(TUESDAY, '01:00'),
    assignments: [empAssignment(USER_A, 'sNight', '2026-09-01')],
    shifts: [nightShift()],
  });
  const live = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps });
  assert.equal(live.schedule.windowLabel, '22:00 – 06:00 (+1 day)');
  assert.equal(live.schedule.crossesMidnight, true);
  assert.equal(live.schedule.scheduledStartAt, ist(MONDAY, '22:00').toISOString());
  assert.equal(live.schedule.scheduledEndAt, ist(TUESDAY, '06:00').toISOString());
});

test('live: unresolved schedules stay neutral — PRESENT, zeros, no snapshot', async () => {
  const { deps, AttendanceModel } = liveDeps({ at: ist(MONDAY, '09:05'), assignments: [], shifts: [] });
  const res = await recordEvent({ companyId: COMPANY_A, userId: USER_A, action: 'CLOCK_IN', workMode: 'OFFICE', deps });
  const control = AttendanceModel.rows[0];
  assert.equal(control.status, 'PRESENT');
  assert.equal(control.lateMinutes, 0);
  assert.equal(control.scheduleStatus, 'UNRESOLVED');
  assert.equal(control.scheduleSnapshot ?? null, null);
  assert.equal(res.snapshot.schedule, null);
});

test('live: overnight cover is checked against the business date', async () => {
  const wfhPolicy = policy({ workModeApproval: { wfh: true } });
  const night = { assignments: [empAssignment(USER_A, 'sNight', '2026-09-01')], shifts: [nightShift()] };

  // Single-day approval naming the SHIFT date covers the 01:00 punch.
  const covered = liveDeps({
    at: ist(TUESDAY, '01:00'),
    ...night,
    requests: [{ _id: 'r1', companyId: COMPANY_A, user: USER_A, mode: 'WFH', status: 'APPROVED', startDate: MONDAY, endDate: MONDAY }],
    activePolicy: wfhPolicy,
  });
  const ok = await recordEvent({ companyId: COMPANY_A, userId: USER_A, action: 'CLOCK_IN', workMode: 'WFH', deps: covered.deps });
  assert.equal(ok.replayed, false);
  assert.equal(covered.AttendanceModel.rows[0].date, MONDAY);

  // Approval for the calendar day only does NOT cover yesterday's shift.
  const bare = liveDeps({
    at: ist(TUESDAY, '01:00'),
    ...night,
    requests: [{ _id: 'r2', companyId: COMPANY_A, user: USER_A, mode: 'WFH', status: 'APPROVED', startDate: TUESDAY, endDate: TUESDAY }],
    activePolicy: wfhPolicy,
  });
  await assert.rejects(
    () => recordEvent({ companyId: COMPANY_A, userId: USER_A, action: 'CLOCK_IN', workMode: 'WFH', deps: bare.deps }),
    /required for 2026-09-14/,
  );
});

// ── D. 31.5 REBUILD INTERPLAY ────────────────────────────────

const rebuildCtx = ({ control, requests, assignments, shifts }) => ({
  companyId: COMPANY_A,
  userId: USER_A,
  attendanceDate: MONDAY,
  policy: policy(),
  AttendanceModel: makeAttendanceModel(control ? [{ _id: 'attLegacy', ...control }] : []),
  AttendanceEventModel: makeEventModel([]),
  RequestModel: makeFindModel(requests),
  engine: scheduleEngine(),
  models: {
    ShiftAssignmentModel: makeFindModel(assignments),
    ShiftModel: makeFindModel(shifts),
    WorkScheduleModel: makeFindModel([]),
    UserModel: makeFindModel([]),
  },
});

test('rebuild: the first 31.6 evaluation versions a legacy control', async () => {
  const ctx = rebuildCtx({
    control: {
      companyId: COMPANY_A, user: USER_A, date: MONDAY,
      punchIn: ist(MONDAY, '09:05'), punchOut: null, liveState: 'WORKING',
    },
    requests: [{
      _id: 'rg1', companyId: COMPANY_A, user: USER_A, attendanceDate: MONDAY,
      type: 'MISSED_CLOCK_OUT', status: 'APPROVED',
      proposal: { correctedOut: ist(MONDAY, '18:00') },
    }],
    assignments: [empAssignment(USER_A, 'sDay', '2026-09-01')],
    shifts: [dayShift()],
  });
  const { control } = await rebuildDayProjection(ctx);
  assert.equal(control.status, 'LATE');
  assert.equal(control.lateMinutes, 5);
  assert.equal(control.earlyMinutes, 0);
  assert.equal(control.scheduleStatus, 'RESOLVED');
  assert.equal(control.scheduleSnapshot.startTime, '09:00');
});

test('rebuild: a stored snapshot beats the current roster', async () => {
  const stored = {
    shiftId: 'sDay', shiftName: 'Day shift', shiftType: 'FIXED',
    scheduleId: null, scheduleName: null, source: 'EMPLOYEE_OVERRIDE',
    startTime: '09:00', endTime: '18:00',
    scheduledStartAt: ist(MONDAY, '09:00'), scheduledEndAt: ist(MONDAY, '18:00'),
    scheduledMinutes: 480, breakMinutes: 60, minimumMinutes: 480,
    crossesMidnight: false, isWorkingDay: true, dayType: 'WORK_DAY',
    holiday: null, timezone: TZ, overtimeEligible: true, resolvedAt: ist(MONDAY, '09:05'),
  };
  const ctx = rebuildCtx({
    control: {
      companyId: COMPANY_A, user: USER_A, date: MONDAY,
      punchIn: ist(MONDAY, '09:05'), punchOut: null, liveState: 'WORKING',
      scheduleStatus: 'RESOLVED', scheduleSnapshot: stored,
    },
    requests: [{
      _id: 'rg1', companyId: COMPANY_A, user: USER_A, attendanceDate: MONDAY,
      type: 'MISSED_CLOCK_OUT', status: 'APPROVED',
      proposal: { correctedOut: ist(MONDAY, '18:00') },
    }],
    // The roster has since moved to 10:00 — the rebuild must not care.
    assignments: [empAssignment(USER_A, 'sLate', '2026-09-01')],
    shifts: [dayShift({ _id: 'sLate', name: 'Late shift', startTime: '10:00', endTime: '19:00' })],
  });
  const { control } = await rebuildDayProjection(ctx);
  assert.equal(control.lateMinutes, 5);
  assert.equal(control.status, 'LATE');
  assert.equal(control.scheduleSnapshot.startTime, '09:00');
});

// ── E. STATIC GUARDS ─────────────────────────────────────────

test('static: 31.6 schedule modules never touch payroll or money math', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'attendance');
  for (const file of ['attendanceScheduleRules.js', 'attendanceScheduleService.js']) {
    const raw = readFileSync(join(root, file), 'utf8');
    const content = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.ok(!/payroll/i.test(content), `${file} must not reference payroll`);
    assert.ok(!/salary|wage|amount|rupee/i.test(content), `${file} must not do money math`);
  }
});

test('static: the rules module is pure — no models, no mongoose, no clock', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'attendance');
  const content = readFileSync(join(root, 'attendanceScheduleRules.js'), 'utf8');
  assert.ok(!/from '\.\.\/\.\.\/models\//.test(content), 'rules must not import models');
  assert.ok(!/mongoose/i.test(content), 'rules must not touch mongoose');
  assert.ok(!/new Date\(\)/.test(content), 'rules must not read the wall clock');
});
