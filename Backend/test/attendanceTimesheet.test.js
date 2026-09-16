// ─────────────────────────────────────────────────────────────
// Phase 31.10 — Attendance calendar & timesheets. Hermetic:
// every Mongo collaborator is an in-memory fake with a faithful
// query matcher, the clock is fixed, and no test touches the
// network, Redis, payroll, or the real database. Fake models
// throw on ANY write except the export-audit row (asserted once,
// safe metadata only) — the timesheet is a read surface.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TIMESHEET_EXCEPTION,
  TIMESHEET_OUTCOME,
  bucketDayOutcome,
  buildExportCsv,
  buildExportRow,
  csvCell,
  enumerateMonthDates,
  isValidMonth,
  monthBounds,
  summarizeMonth,
  summarizeTeamRow,
} from '../src/services/attendance/attendanceTimesheetRules.js';
import {
  exportTeamTimesheets,
  getEmployeeTimesheet,
  getMyTimesheet,
  getTeamTimesheets,
} from '../src/services/attendance/attendanceTimesheetService.js';
import { DAILY_OUTCOME, DAY_TYPE, dayKeyInZone } from '../src/services/attendance/attendancePolicyRules.js';
import { DAY_PORTION } from '../src/services/attendance/attendanceWorkModeRules.js';
import { LEAVE_TYPES } from '../src/utils/constants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

const TZ = 'Asia/Kolkata';
const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DEPT_ENG = 'd1d1d1d1d1d1d1d1d1d1d1d1';
const DEPT_SALES = 'd2d2d2d2d2d2d2d2d2d2d2d2';

const U_MGR = '100000000000000000000001';
const U_REP1 = '100000000000000000000002';
const U_REP2 = '100000000000000000000003';
const U_OUTSIDER = '100000000000000000000004';
const U_HR = '100000000000000000000005';
const U_B = '200000000000000000000001';

// Tue 2026-09-15 10:00 IST — the frozen "today".
const TUE_10AM = new Date('2026-09-15T04:30:00.000Z');
assert.equal(dayKeyInZone(TUE_10AM, TZ), '2026-09-15');

const actor = (id, role, name = 'Actor') => ({ _id: id, role, name });
const dt = (isoString) => new Date(`${isoString}.000Z`);

// ── Faithful in-memory query matcher ───────────────────────────
// Supports exactly the operators the timesheet service + batch
// preloader emit (equality incl. null-means-missing and Dates,
// $in, $ne, $gte/$lte/$gt/$lt, $exists, $or, $regex+$options).

const cmpVal = (a, b) => {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() - new Date(b).getTime();
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

const matchCond = (docVal, cond) => {
  if (cond instanceof RegExp) return cond.test(String(docVal ?? ''));
  if (Array.isArray(docVal) && (cond === null || typeof cond !== 'object' || cond instanceof Date)) {
    return docVal.some((entry) => matchCond(entry, cond));
  }
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    const keys = Object.keys(cond);
    if (keys.length === 0) return true;
    return keys.every((op) => {
      const want = cond[op];
      if (op === '$in') return Array.isArray(want) && want.some((v) => cmpVal(docVal, v) === 0);
      if (op === '$ne') return cmpVal(docVal, want) !== 0;
      if (op === '$gte') return cmpVal(docVal, want) >= 0;
      if (op === '$lte') return cmpVal(docVal, want) <= 0;
      if (op === '$gt') return cmpVal(docVal, want) > 0;
      if (op === '$lt') return cmpVal(docVal, want) < 0;
      if (op === '$exists') return want ? docVal !== undefined : docVal === undefined;
      if (op === '$regex') {
        const re = new RegExp(want, cond.$options || '');
        return re.test(String(docVal ?? ''));
      }
      if (op === '$options') return true;
      throw new Error(`unsupported operator ${op}`);
    });
  }
  if (cond === null) return docVal === null || docVal === undefined;
  return cmpVal(docVal, cond) === 0;
};

const matchDoc = (doc, filter = {}) => Object.entries(filter).every(([key, cond]) => {
  if (key === '$or') return Array.isArray(cond) && cond.some((branch) => matchDoc(doc, branch));
  if (key === '$and') return Array.isArray(cond) && cond.every((branch) => matchDoc(doc, branch));
  return matchCond(doc?.[key], cond);
});

const sortRows = (rows, spec = {}) => {
  const keys = Object.entries(spec);
  if (!keys.length) return rows;
  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      const cmp = cmpVal(a?.[key] ?? '', b?.[key] ?? '');
      if (cmp !== 0) return dir === -1 ? -cmp : cmp;
    }
    return 0;
  });
};

const chain = (rows) => {
  const q = {
    _rows: rows,
    select() { return q; },
    sort(spec) { q._rows = sortRows(q._rows, spec); return q; },
    skip(n) { q._rows = q._rows.slice(n); return q; },
    limit(n) { q._rows = q._rows.slice(0, n); return q; },
    lean: async () => q._rows,
  };
  return q;
};

const writeTrap = (model) => {
  const trap = () => { throw new Error(`${model} write forbidden in timesheet reads`); };
  return {
    create: trap, insertMany: trap, updateOne: trap, updateMany: trap,
    deleteOne: trap, deleteMany: trap, findOneAndUpdate: trap, bulkWrite: trap,
  };
};

const fakeModel = (rows, counter = null, name = 'model') => ({
  find: (filter = {}) => { counter?.(name, 'find', filter); return chain(rows.filter((r) => matchDoc(r, filter))); },
  findOne: (filter = {}) => {
    counter?.(name, 'findOne', filter);
    const hit = rows.find((r) => matchDoc(r, filter)) || null;
    return { select() { return this; }, lean: async () => hit };
  },
  countDocuments: async (filter = {}) => {
    counter?.(name, 'countDocuments', filter);
    return rows.filter((r) => matchDoc(r, filter)).length;
  },
  findById: (id) => {
    counter?.(name, 'findById', id);
    const hit = rows.find((r) => String(r._id) === String(id)) || null;
    return { select() { return this; }, lean: async () => hit };
  },
  ...writeTrap(name),
});

// ── Fixtures ───────────────────────────────────────────────────

const userDoc = (id, companyId, overrides = {}) => ({
  _id: id,
  companyId,
  status: 'ACTIVE',
  name: `User ${id.slice(-4)}`,
  employeeCode: `E${id.slice(-4)}`,
  avatarUrl: '',
  designation: 'Engineer',
  department: DEPT_ENG,
  branch: '',
  ...overrides,
});

const controlDoc = (user, date, overrides = {}) => ({
  _id: `c-${user.slice(-4)}-${date}`,
  companyId: COMPANY_A,
  user,
  date,
  punchIn: null,
  punchOut: null,
  workMinutes: 0,
  breakMinutes: 0,
  lateMinutes: 0,
  earlyMinutes: 0,
  status: 'PRESENT',
  liveState: null,
  workMode: 'OFFICE',
  policyExceptions: [],
  overtimeMinutes: 0,
  ...overrides,
});

const snapshotFor = (date, startIso, endIso) => ({
  shiftId: '500000000000000000000001',
  shiftName: 'General',
  shiftType: 'FIXED',
  scheduleId: null,
  scheduleName: 'General',
  source: 'SHIFT_DOC',
  startTime: startIso.slice(11, 16),
  endTime: endIso.slice(11, 16),
  scheduledStartAt: new Date(startIso),
  scheduledEndAt: new Date(endIso),
  scheduledMinutes: 540,
  breakMinutes: 60,
  minimumMinutes: 480,
  crossesMidnight: false,
  isWorkingDay: true,
  dayType: 'WORK_DAY',
  holiday: null,
  timezone: TZ,
  overtimeEligible: true,
  resolvedAt: new Date(startIso),
});

const eventDoc = (user, date, seq, type, atIso, overrides = {}) => ({
  _id: `e-${user.slice(-4)}-${date}-${seq}`,
  companyId: COMPANY_A,
  user,
  date,
  seq,
  type,
  at: new Date(atIso),
  workMode: 'OFFICE',
  ...overrides,
});

const buildDeps = ({
  users = [],
  controls = [],
  events = [],
  leaves = [],
  regs = [],
  ots = [],
  departments = [{ _id: DEPT_ENG, companyId: COMPANY_A, name: 'Engineering' }],
  assignments = [],
  shifts = [],
  schedules = [],
  holidays = [],
  subtree = [],
  auditImpl = null,
  counter = null,
} = {}) => {
  const auditCalls = [];
  return {
    deps: {
      UserModel: fakeModel(users, counter, 'User'),
      AttendanceModel: fakeModel(controls, counter, 'Attendance'),
      AttendanceEventModel: fakeModel(events, counter, 'Event'),
      LeaveModel: fakeModel(leaves, counter, 'Leave'),
      RegularizationModel: fakeModel(regs, counter, 'Reg'),
      OvertimeRequestModel: fakeModel(ots, counter, 'OT'),
      DepartmentModel: fakeModel(departments, counter, 'Department'),
      CompanyModel: fakeModel([], counter, 'Company'),
      ShiftAssignmentModel: fakeModel(assignments, counter, 'Assign'),
      ShiftModel: fakeModel(shifts, counter, 'Shift'),
      WorkScheduleModel: fakeModel(schedules, counter, 'Schedule'),
      HolidayModel: fakeModel(holidays, counter, 'Holiday'),
      AuditLogModel: {
        create: auditImpl || (async (doc) => { auditCalls.push(doc); return doc; }),
      },
      policyReader: async () => ({ policy: { timezone: TZ, grace: {} } }),
      subtreeReader: async () => subtree,
      now: () => TUE_10AM,
    },
    auditCalls,
  };
};

// September 2026 shape (frozen today = Tue 15th): workdays among
// 1–14 are 1,2,3,4,7,8,9,10,11,14 (10 days); weekends 5,6,12,13;
// future 16–30 (15 days); full-month workdays = 22.
const SEP = '2026-09';

// ── §1–2 pure month math ───────────────────────────────────────

test('31.10 month validation accepts YYYY-MM only', () => {
  assert.equal(isValidMonth('2026-09'), true);
  assert.equal(isValidMonth('2026-13'), false);
  assert.equal(isValidMonth('2026-9'), false);
  assert.equal(isValidMonth('2026-09-01'), false);
  assert.equal(isValidMonth(''), false);
  assert.equal(isValidMonth(null), false);
});

test('31.10 enumeration covers 28/29/30/31 incl. leap February', () => {
  const sep = enumerateMonthDates('2026-09');
  assert.equal(sep.length, 30);
  assert.equal(sep[0], '2026-09-01');
  assert.equal(sep[29], '2026-09-30');
  assert.equal(enumerateMonthDates('2023-02').length, 28);
  assert.equal(enumerateMonthDates('2024-02').length, 29);
  assert.equal(enumerateMonthDates('2026-01').length, 31);
  assert.throws(() => enumerateMonthDates('nope'), /YYYY-MM/);
});

test('31.10 monthBounds returns start/end/dates', () => {
  const { start, end, dates } = monthBounds('2026-09');
  assert.equal(start, '2026-09-01');
  assert.equal(end, '2026-09-30');
  assert.equal(dates.length, 30);
});

// ── §53 pure outcome buckets ───────────────────────────────────

test('31.10 buckets: future always wins, never absence', () => {
  assert.equal(
    bucketDayOutcome({ isFuture: true, outcome: DAILY_OUTCOME.ABSENT }),
    TIMESHEET_OUTCOME.FUTURE,
  );
});

test('31.10 buckets: leave dominates work facts', () => {
  assert.equal(
    bucketDayOutcome({ outcome: DAILY_OUTCOME.PRESENT, fractions: { worked: 0, leave: 1, absent: 0 } }),
    TIMESHEET_OUTCOME.LEAVE,
  );
  assert.equal(
    bucketDayOutcome({ outcome: DAILY_OUTCOME.HALF_DAY, fractions: { worked: 0.5, leave: 0.5, absent: 0 } }),
    TIMESHEET_OUTCOME.HALF_DAY,
  );
});

test('31.10 buckets: work outcomes map directly', () => {
  assert.equal(bucketDayOutcome({ outcome: DAILY_OUTCOME.PRESENT }), TIMESHEET_OUTCOME.PRESENT);
  assert.equal(bucketDayOutcome({ outcome: DAILY_OUTCOME.HALF_DAY }), TIMESHEET_OUTCOME.HALF_DAY);
});

test('31.10 buckets: non-working days split by calendar primary', () => {
  assert.equal(
    bucketDayOutcome({ outcome: DAILY_OUTCOME.NON_WORKING_DAY, calendarPrimary: DAY_TYPE.HOLIDAY }),
    TIMESHEET_OUTCOME.HOLIDAY,
  );
  assert.equal(
    bucketDayOutcome({ outcome: DAILY_OUTCOME.NON_WORKING_DAY, calendarPrimary: DAY_TYPE.WEEKLY_OFF }),
    TIMESHEET_OUTCOME.WEEKLY_OFF,
  );
});

test('31.10 buckets: absence needs a resolved expectation', () => {
  assert.equal(
    bucketDayOutcome({ outcome: DAILY_OUTCOME.ABSENT, scheduleResolved: true }),
    TIMESHEET_OUTCOME.ABSENT,
  );
  assert.equal(
    bucketDayOutcome({ outcome: DAILY_OUTCOME.ABSENT, scheduleResolved: false, hasControl: false }),
    TIMESHEET_OUTCOME.UNRESOLVED,
  );
  assert.equal(bucketDayOutcome({ outcome: null }), TIMESHEET_OUTCOME.UNRESOLVED);
});

// ── §42 pure summary ───────────────────────────────────────────

test('31.10 summary aggregates exclusive buckets + orthogonal dimensions', () => {
  const summary = summarizeMonth([
    { bucket: 'PRESENT', fractions: { worked: 1, leave: 0, absent: 0 }, workMode: 'OFFICE', workedMinutes: 480, breakMinutes: 30, exceptions: [], scheduledWorkingDay: true, calendarPrimary: 'WORK_DAY', hasSession: true },
    { bucket: 'HALF_DAY', fractions: { worked: 0.5, leave: 0, absent: 0.5 }, workMode: 'WFH', workedMinutes: 200, breakMinutes: 0, exceptions: ['LATE_ARRIVAL'], scheduledWorkingDay: true, calendarPrimary: 'WORK_DAY', hasSession: true },
    { bucket: 'HOLIDAY', fractions: { worked: 0, leave: 0, absent: 0 }, workMode: 'OFFICE', workedMinutes: 120, breakMinutes: 0, exceptions: [], scheduledWorkingDay: false, calendarPrimary: 'HOLIDAY', hasSession: true },
    { bucket: 'FUTURE', scheduledWorkingDay: true },
  ]);
  assert.deepEqual(summary.dayCounts, {
    present: 1, halfDay: 1, absent: 0, leave: 0, holiday: 1, weeklyOff: 0, unresolved: 0, future: 1,
  });
  assert.deepEqual(summary.equivalents, { worked: 1.5, leave: 0, absent: 0.5 });
  assert.equal(summary.modes.OFFICE, 2);
  assert.equal(summary.modes.WFH, 1);
  assert.equal(summary.workedMinutes, 800);
  assert.equal(summary.lateDays, 1);
  assert.equal(summary.workedOnHolidayDays, 1);
  assert.equal(summary.exceptionDays, 1);
  assert.equal(summary.scheduledWorkingDays, 3);
  assert.equal(summary.totalDays, 4);
});

test('31.10 summary counts OT minutes and comp-off days as facts', () => {
  const summary = summarizeMonth([
    { bucket: 'PRESENT', approvedOtMinutes: 90, compOffDays: 0, exceptions: [] },
    { bucket: 'WEEKLY_OFF', approvedOtMinutes: 0, compOffDays: 1, exceptions: [] },
  ]);
  assert.equal(summary.approvedOtMinutes, 90);
  assert.equal(summary.compOffEarnedDays, 1);
});

test('31.10 team row carries exactly the §14 columns', () => {
  const row = summarizeTeamRow({
    scheduledWorkingDays: 22,
    dayCounts: { present: 9, halfDay: 1, leave: 1, absent: 1 },
    lateDays: 2,
    workedMinutes: 4000,
    approvedOtMinutes: 60,
    exceptionDays: 3,
    unresolvedDays: 4,
  });
  assert.deepEqual(row, {
    scheduledWorkingDays: 22, present: 9, halfDay: 1, leave: 1, absent: 1,
    lateDays: 2, workedMinutes: 4000, approvedOtMinutes: 60,
    exceptionDays: 3, unresolvedDays: 4,
  });
});

// ── §22 pure CSV safety ────────────────────────────────────────

test('31.10 csvCell guards formulas and quotes cells', () => {
  assert.equal(csvCell('plain'), '"plain"');
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('+cmd'), '"\'+cmd"');
  assert.equal(csvCell('-2'), '"\'-2"');
  assert.equal(csvCell('@x'), '"\'@x"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
});

test('31.10 export document uses BOM + CRLF + the §20 header', () => {
  const csv = buildExportCsv([{
    employeeName: '=Evil', employeeCode: 'E1', departmentName: 'Eng', date: '2026-09-01',
    outcome: 'PRESENT', scheduledIn: '09:00', scheduledOut: '18:00',
    effectiveIn: '2026-09-01T03:30:00.000Z', effectiveOut: '2026-09-01T12:30:00.000Z',
    workedMinutes: 480, breakMinutes: 30, workMode: 'OFFICE', leaveLabel: '', calendar: 'WORK_DAY',
    holidayName: '', lateMinutes: 0, earlyMinutes: 0, approvedOtMinutes: 0, compOffDays: 0,
    exceptions: [], regularized: false,
  }]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /\r\n/);
  assert.match(csv, /"Employee","Employee code","Department","Date","Outcome"/);
  assert.match(csv, /"'=Evil"/);
  assert.equal(buildExportRow({}).length, 21);
});

// ── §18 self-service month ─────────────────────────────────────

test('31.10 mine returns the full September with safe identity', async () => {
  const { deps } = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)] });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  assert.equal(sheet.month, SEP);
  assert.equal(sheet.timezone, TZ);
  assert.equal(sheet.today, '2026-09-15');
  assert.equal(sheet.days.length, 30);
  assert.equal(sheet.employee.id, U_REP1);
  assert.deepEqual(Object.keys(sheet.employee).sort(), ['avatarUrl', 'department', 'designation', 'employeeCode', 'id', 'name']);
  assert.deepEqual(sheet.summary.dayCounts, {
    present: 0, halfDay: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 4, unresolved: 11, future: 15,
  });
  assert.equal(sheet.summary.scheduledWorkingDays, 22);
});

test('31.10 mine rejects bad month / missing context, 404s strangers', async () => {
  const { deps } = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)] });
  const me = actor(U_REP1, 'EMPLOYEE');
  await assert.rejects(
    getMyTimesheet({ companyId: COMPANY_A, actor: me, month: 'Sep', deps }),
    /YYYY-MM/,
  );
  await assert.rejects(getMyTimesheet({ actor: me, month: SEP, deps }), /Company context/);
  await assert.rejects(
    getMyTimesheet({ companyId: COMPANY_A, actor: {}, month: SEP, deps }),
    /Actor context/,
  );
  await assert.rejects(
    getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_OUTSIDER, 'EMPLOYEE'), month: SEP, deps }),
    /Employee not found/,
  );
});

test('31.10 mine is spoof-proof: identity comes from the actor only', async () => {
  const { deps } = buildDeps({ users: [userDoc(U_REP1, COMPANY_A), userDoc(U_OUTSIDER, COMPANY_A)] });
  const sheet = await getMyTimesheet({
    companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, employeeId: U_OUTSIDER, deps,
  });
  assert.equal(sheet.employee.id, U_REP1);
});

test('31.10 future month returns all-FUTURE days with a zero summary', async () => {
  const { deps } = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)] });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: '2026-10', deps });
  assert.equal(sheet.days.length, 31);
  assert.ok(sheet.days.every((day) => day.bucket === TIMESHEET_OUTCOME.FUTURE));
  assert.equal(sheet.summary.dayCounts.future, 31);
  assert.equal(sheet.summary.workedMinutes, 0);
});

// ── §4–6 day detail ────────────────────────────────────────────

const presentDayDeps = () => buildDeps({
  users: [userDoc(U_REP1, COMPANY_A)],
  controls: [controlDoc(U_REP1, '2026-09-14', {
    punchIn: dt('2026-09-14T03:35:00'), // 09:05 IST
    punchOut: dt('2026-09-14T12:35:00'), // 18:05 IST
    workMinutes: 480,
    breakMinutes: 30,
    workMode: 'OFFICE',
    scheduleStatus: 'RESOLVED',
    scheduleSnapshot: snapshotFor('2026-09-14', '2026-09-14T03:30:00', '2026-09-14T12:30:00'),
  })],
  events: [
    eventDoc(U_REP1, '2026-09-14', 2, 'CLOCK_OUT', '2026-09-14T12:35:00'),
    eventDoc(U_REP1, '2026-09-14', 1, 'CLOCK_IN', '2026-09-14T03:35:00', {
      locationVerification: { locationName: 'HQ', latitude: 12.9, longitude: 80.2 },
    }),
  ],
});

test('31.10 present day carries schedule + actual + ordered timeline', async () => {
  const { deps } = presentDayDeps();
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const day = sheet.days[13];
  assert.equal(day.date, '2026-09-14');
  assert.equal(day.bucket, TIMESHEET_OUTCOME.PRESENT);
  assert.equal(day.schedule.startTime, '03:30');
  assert.equal(day.schedule.scheduledStartAt, '2026-09-14T03:30:00.000Z');
  assert.equal(day.schedule.shiftName, 'General');
  assert.equal(day.scheduleUnresolved, false);
  assert.equal(day.actual.recordedIn, '2026-09-14T03:35:00.000Z');
  assert.equal(day.actual.effectiveOut, '2026-09-14T12:35:00.000Z');
  assert.equal(day.actual.workedMinutes, 480);
  assert.deepEqual(day.timeline.map((e) => e.type), ['CLOCK_IN', 'CLOCK_OUT']);
  assert.equal(day.timeline[0].locationName, 'HQ');
  assert.ok(!('latitude' in day.timeline[0]));
  assert.deepEqual(day.exceptions, []);
  assert.equal(sheet.summary.dayCounts.present, 1);
});

test('31.10 late/early/missing-punch flags derive from effective facts', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [
      controlDoc(U_REP1, '2026-09-11', {
        punchIn: dt('2026-09-11T04:00:00'), punchOut: dt('2026-09-11T12:30:00'),
        workMinutes: 450, lateMinutes: 30, earlyMinutes: 5, workMode: 'WFH',
      }),
      controlDoc(U_REP1, '2026-09-10', { punchIn: dt('2026-09-10T03:30:00'), workMinutes: 60 }),
    ],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const thu = sheet.days.find((day) => day.date === '2026-09-11');
  assert.ok(thu.exceptions.includes(TIMESHEET_EXCEPTION.LATE_ARRIVAL));
  assert.ok(thu.exceptions.includes(TIMESHEET_EXCEPTION.EARLY_EXIT));
  assert.equal(thu.workMode, 'WFH');
  const wed = sheet.days.find((day) => day.date === '2026-09-10');
  assert.ok(wed.exceptions.includes(TIMESHEET_EXCEPTION.MISSING_PUNCH));
  assert.equal(sheet.summary.lateDays, 1);
  assert.equal(sheet.summary.earlyExitDays, 1);
  assert.equal(sheet.summary.missingPunchDays, 1);
  assert.equal(sheet.summary.modes.WFH, 1);
});

test('31.10 in-progress today session is not a missing punch', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-15', {
      punchIn: dt('2026-09-15T03:30:00'), liveState: 'WORKING', workMinutes: 60,
    })],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const today = sheet.days.find((day) => day.date === '2026-09-15');
  assert.equal(today.isToday, true);
  assert.ok(!today.exceptions.includes(TIMESHEET_EXCEPTION.MISSING_PUNCH));
});

test('31.10 pending regularization flags the day; reasons never surface', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-10', { punchIn: dt('2026-09-10T03:30:00') })],
    regs: [{
      _id: 'r1', companyId: COMPANY_A, user: U_REP1, attendanceDate: '2026-09-10',
      type: 'CLOCK_OUT_TIME_CORRECTION', status: 'PENDING', reason: 'traffic jam on highway',
    }],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const day = sheet.days.find((d) => d.date === '2026-09-10');
  assert.ok(day.exceptions.includes(TIMESHEET_EXCEPTION.REGULARIZATION_PENDING));
  assert.equal(day.regularization.pending, true);
  assert.deepEqual(day.regularization.pendingTypes, ['CLOCK_OUT_TIME_CORRECTION']);
  assert.ok(!JSON.stringify(sheet).includes('traffic jam'));
  assert.ok(!JSON.stringify(sheet).includes('reason'));
});

test('31.10 approved overlay shows effective vs recorded without reasons', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-10', {
      punchIn: dt('2026-09-10T03:30:00'),
      punchOut: null,
      workMinutes: 480,
      regularization: {
        correctedIn: dt('2026-09-10T03:30:00'),
        correctedOut: dt('2026-09-10T12:30:00'),
        correctedBreakMinutes: null,
        correctedWorkMode: null,
        appliedAt: dt('2026-09-11T05:00:00'),
      },
    })],
    regs: [{
      _id: 'r2', companyId: COMPANY_A, user: U_REP1, attendanceDate: '2026-09-10',
      type: 'CLOCK_OUT_TIME_CORRECTION', status: 'APPROVED', reason: 'forgot to punch out',
    }],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const day = sheet.days.find((d) => d.date === '2026-09-10');
  assert.equal(day.regularized, true);
  assert.equal(day.regularization.applied, true);
  assert.equal(day.actual.recordedOut, null);
  assert.equal(day.actual.effectiveOut, '2026-09-10T12:30:00.000Z');
  assert.deepEqual(day.regularization.approvedTypes, ['CLOCK_OUT_TIME_CORRECTION']);
  assert.ok(!JSON.stringify(sheet).includes('forgot to punch'));
  assert.equal(sheet.summary.regularizedDays, 1);
});

// ── §53 stored-vs-live precedence ──────────────────────────────

test('31.10 stored 31.7 projection wins; minutes stay live', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-14', {
      punchIn: dt('2026-09-14T03:30:00'), punchOut: dt('2026-09-14T12:30:00'),
      workMinutes: 480,
      reconciliation: {
        outcome: DAILY_OUTCOME.ABSENT,
        calendar: { primary: DAY_TYPE.WORK_DAY, alsoWeeklyOff: false, holiday: {} },
        leave: { portion: 'NONE', leaveId: null, type: null, label: null },
        halves: {},
        fractions: { worked: 0, leave: 0, absent: 1 },
        conflicts: [],
        needsReview: false,
        resolvedAt: dt('2026-09-14T13:00:00'),
        resolvedBy: 'system',
      },
    })],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const day = sheet.days.find((d) => d.date === '2026-09-14');
  assert.equal(day.outcome, DAILY_OUTCOME.ABSENT);
  assert.equal(day.bucket, TIMESHEET_OUTCOME.ABSENT);
  assert.equal(day.actual.workedMinutes, 480);
});

test('31.10 no-control workday is ABSENT with resolved masters schedule', async () => {
  const shift = {
    _id: '500000000000000000000001', companyId: COMPANY_A, name: 'Day', type: 'FIXED',
    startTime: '09:00', endTime: '18:00', isActive: true,
  };
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    assignments: [{
      _id: '600000000000000000000001', companyId: COMPANY_A, user: U_REP1,
      shift: shift._id, effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null,
    }],
    shifts: [shift],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  assert.equal(sheet.summary.dayCounts.absent, 10);
  // Today stays UNRESOLVED (day still open); past workdays are ABSENT.
  assert.equal(sheet.summary.dayCounts.unresolved, 1);
  const day = sheet.days.find((d) => d.date === '2026-09-14');
  assert.equal(day.scheduleUnresolved, false);
  assert.equal(day.schedule.startTime, '09:00');
});

test('31.10 weekend resolves to WEEKLY_OFF by default pattern', async () => {
  const { deps } = buildDeps({ users: [userDoc(U_REP1, COMPANY_A)] });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const sat = sheet.days.find((d) => d.date === '2026-09-12');
  assert.equal(sat.bucket, TIMESHEET_OUTCOME.WEEKLY_OFF);
  assert.equal(sat.scheduleUnresolved, true);
});

// ── §5–6 leave / holiday / OT dimensions ───────────────────────

test('31.10 approved leave day shows label + charges the equivalent', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    leaves: [{
      _id: '700000000000000000000001', companyId: COMPANY_A, user: U_REP1,
      status: 'APPROVED', type: 'CASUAL', startDate: '2026-09-09', endDate: '2026-09-09',
    }],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const day = sheet.days.find((d) => d.date === '2026-09-09');
  assert.equal(day.bucket, TIMESHEET_OUTCOME.LEAVE);
  assert.equal(day.calendar.leave.portion, DAY_PORTION.FULL_DAY);
  assert.equal(day.calendar.leave.label, LEAVE_TYPES.CASUAL.label);
  assert.equal(day.calendar.leave.leaveId, '700000000000000000000001');
  assert.equal(sheet.summary.dayCounts.leave, 1);
  assert.equal(sheet.summary.equivalents.leave, 1);
});

test('31.10 session on full leave day raises ATTENDANCE_ON_LEAVE', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-09', {
      punchIn: dt('2026-09-09T03:30:00'), punchOut: dt('2026-09-09T12:30:00'), workMinutes: 480,
    })],
    leaves: [{
      _id: '700000000000000000000002', companyId: COMPANY_A, user: U_REP1,
      status: 'APPROVED', type: 'SICK', startDate: '2026-09-09', endDate: '2026-09-09',
    }],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const day = sheet.days.find((d) => d.date === '2026-09-09');
  assert.ok(day.exceptions.includes(TIMESHEET_EXCEPTION.ATTENDANCE_ON_LEAVE));
});

test('31.10 public holiday buckets + worked minutes stay factual', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-07', {
      punchIn: dt('2026-09-07T03:30:00'), punchOut: dt('2026-09-07T08:30:00'), workMinutes: 300,
    })],
    holidays: [{
      _id: '800000000000000000000001', companyId: COMPANY_A, name: 'Test Festival',
      type: 'PUBLIC', isActive: true,
      date: new Date('2026-09-07T00:00:00.000Z'), endDate: new Date('2026-09-07T00:00:00.000Z'),
    }],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const day = sheet.days.find((d) => d.date === '2026-09-07');
  assert.equal(day.bucket, TIMESHEET_OUTCOME.HOLIDAY);
  assert.equal(day.calendar.holiday.name, 'Test Festival');
  assert.equal(day.actual.workedMinutes, 300);
  assert.equal(sheet.summary.workedOnHolidayDays, 1);
  assert.equal(sheet.summary.workedMinutes, 300);
});

test('31.10 approved OT minutes publish; pending stays projected; no money', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-14', {
      punchIn: dt('2026-09-14T03:30:00'), punchOut: dt('2026-09-14T14:30:00'),
      workMinutes: 600, overtimeMinutes: 90,
    })],
    ots: [
      {
        _id: '900000000000000000000001', companyId: COMPANY_A, user: U_REP1,
        attendanceDate: '2026-09-14', type: 'OVERTIME', status: 'APPROVED',
        recordedMinutes: 120, eligibleMinutes: 90, requestedMinutes: 90, approvedMinutes: 90,
      },
      {
        _id: '900000000000000000000002', companyId: COMPANY_A, user: U_REP1,
        attendanceDate: '2026-09-13', type: 'COMP_OFF', status: 'APPROVED',
        recordedMinutes: 480, eligibleMinutes: 480, requestedMinutes: 480, compOffDays: 1,
      },
      {
        _id: '900000000000000000000003', companyId: COMPANY_A, user: U_REP1,
        attendanceDate: '2026-09-11', type: 'OVERTIME', status: 'PENDING',
        recordedMinutes: 60, eligibleMinutes: 60, requestedMinutes: 60,
      },
    ],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const approved = sheet.days.find((d) => d.date === '2026-09-14');
  assert.equal(approved.approvedOtMinutes, 90);
  assert.equal(approved.ot.status, 'APPROVED');
  const compOff = sheet.days.find((d) => d.date === '2026-09-13');
  assert.equal(compOff.compOffDays, 1);
  assert.equal(compOff.approvedOtMinutes, 0);
  const pending = sheet.days.find((d) => d.date === '2026-09-11');
  assert.equal(pending.approvedOtMinutes, 0);
  assert.equal(pending.ot.requestedMinutes, 60);
  assert.equal(sheet.summary.approvedOtMinutes, 90);
  assert.equal(sheet.summary.compOffEarnedDays, 1);
  const dumped = JSON.stringify(sheet).toLowerCase();
  for (const token of ['amount', 'netpay', 'grosspay', 'salary', 'lopamount', 'rateper']) {
    assert.ok(!dumped.includes(token), `money token leaked: ${token}`);
  }
});

// ── §54 overnight boundary ─────────────────────────────────────

test('31.10 overnight session anchors to its business date', async () => {
  const { deps } = buildDeps({
    users: [userDoc(U_REP1, COMPANY_A)],
    controls: [controlDoc(U_REP1, '2026-09-14', {
      punchIn: dt('2026-09-14T16:30:00'), // 22:00 IST Sep-14
      punchOut: dt('2026-09-15T01:30:00'), // 07:00 IST Sep-15
      workMinutes: 540,
    })],
  });
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  const night = sheet.days.find((d) => d.date === '2026-09-14');
  assert.equal(night.bucket, TIMESHEET_OUTCOME.PRESENT);
  assert.equal(night.actual.effectiveOut, '2026-09-15T01:30:00.000Z');
  assert.equal(sheet.summary.workedMinutes, 540);
});

// ── §19 scoped drill-down ──────────────────────────────────────

test('31.10 employee drill-down honors scope (HR wide, manager subtree)', async () => {
  const users = [
    userDoc(U_MGR, COMPANY_A), userDoc(U_REP1, COMPANY_A),
    userDoc(U_OUTSIDER, COMPANY_A), userDoc(U_HR, COMPANY_A),
  ];
  const mgrDeps = buildDeps({ users, subtree: [U_REP1, U_REP2] }).deps;
  const seen = await getEmployeeTimesheet({
    companyId: COMPANY_A, actor: actor(U_MGR, 'MANAGER'), employeeId: U_REP1, month: SEP, deps: mgrDeps,
  });
  assert.equal(seen.employee.id, U_REP1);
  assert.equal(seen.scope, 'TEAM');
  await assert.rejects(
    getEmployeeTimesheet({
      companyId: COMPANY_A, actor: actor(U_MGR, 'MANAGER'), employeeId: U_OUTSIDER, month: SEP, deps: mgrDeps,
    }),
    /outside your timesheet scope/,
  );
  const hrDeps = buildDeps({ users }).deps;
  const hrSeen = await getEmployeeTimesheet({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), employeeId: U_OUTSIDER, month: SEP, deps: hrDeps,
  });
  assert.equal(hrSeen.scope, 'COMPANY');
  await assert.rejects(
    getEmployeeTimesheet({
      companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), employeeId: 'nope', month: SEP, deps: hrDeps,
    }),
    /Invalid employee id/,
  );
});

// ── §10–14 team table ──────────────────────────────────────────

const teamFixtures = () => ({
  users: [
    userDoc(U_MGR, COMPANY_A, { name: 'Mara Manager', department: DEPT_ENG }),
    userDoc(U_REP1, COMPANY_A, { name: 'Rea One', department: DEPT_ENG }),
    userDoc(U_REP2, COMPANY_A, { name: 'Reb Two', department: DEPT_SALES }),
    userDoc(U_OUTSIDER, COMPANY_A, { name: 'Olive Out', department: DEPT_ENG }),
  ],
  controls: [controlDoc(U_REP1, '2026-09-11', {
    punchIn: dt('2026-09-11T04:00:00'), punchOut: dt('2026-09-11T12:30:00'),
    workMinutes: 450, lateMinutes: 30,
  })],
});

test('31.10 team table scopes rows (company vs subtree)', async () => {
  const { users, controls } = teamFixtures();
  const hr = await getTeamTimesheets({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'),
    query: { month: SEP }, deps: buildDeps({ users, controls }).deps,
  });
  assert.equal(hr.scope, 'COMPANY');
  assert.equal(hr.total, 4);
  assert.equal(hr.rows.length, 4);
  const flagged = hr.rows.find((row) => row.user.id === U_REP1);
  assert.equal(flagged.summary.lateDays, 1);
  assert.equal(flagged.summary.exceptionDays, 1);

  const mgr = await getTeamTimesheets({
    companyId: COMPANY_A, actor: actor(U_MGR, 'MANAGER'),
    query: { month: SEP }, deps: buildDeps({ users, controls, subtree: [U_REP1, U_REP2] }).deps,
  });
  assert.equal(mgr.scope, 'TEAM');
  assert.deepEqual(mgr.rows.map((row) => row.user.id).sort(), [U_MGR, U_REP1, U_REP2].sort());
});

test('31.10 team filters: search, department, exceptions, pagination', async () => {
  const { users, controls } = teamFixtures();
  const depsFor = () => buildDeps({ users, controls }).deps;
  const hr = actor(U_HR, 'HR_MANAGER');

  const searched = await getTeamTimesheets({
    companyId: COMPANY_A, actor: hr, query: { month: SEP, search: 'rea' }, deps: depsFor(),
  });
  assert.deepEqual(searched.rows.map((row) => row.user.id), [U_REP1]);

  const byDept = await getTeamTimesheets({
    companyId: COMPANY_A, actor: hr, query: { month: SEP, departmentId: DEPT_SALES }, deps: depsFor(),
  });
  assert.deepEqual(byDept.rows.map((row) => row.user.id), [U_REP2]);

  const flagged = await getTeamTimesheets({
    companyId: COMPANY_A, actor: hr, query: { month: SEP, hasExceptions: 'true' }, deps: depsFor(),
  });
  assert.deepEqual(flagged.rows.map((row) => row.user.id), [U_REP1]);
  assert.equal(flagged.total, 1);

  const page1 = await getTeamTimesheets({
    companyId: COMPANY_A, actor: hr, query: { month: SEP, page: '1', pageSize: '2' }, deps: depsFor(),
  });
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.total, 4);
  assert.equal(page1.totalPages, 2);
  const page2 = await getTeamTimesheets({
    companyId: COMPANY_A, actor: hr, query: { month: SEP, page: '2', pageSize: '2' }, deps: depsFor(),
  });
  assert.equal(page2.rows.length, 2);
  assert.notDeepEqual(
    page1.rows.map((row) => row.user.id).sort(),
    page2.rows.map((row) => row.user.id).sort(),
  );

  await assert.rejects(
    getTeamTimesheets({ companyId: COMPANY_A, actor: hr, query: { month: SEP, departmentId: 'bad' }, deps: depsFor() }),
    /Invalid department filter/,
  );
  await assert.rejects(
    getTeamTimesheets({ companyId: COMPANY_A, actor: hr, query: { month: 'bad' }, deps: depsFor() }),
    /YYYY-MM/,
  );
});

// ── §20–22 export ──────────────────────────────────────────────

test('31.10 export covers the filtered scope and audits once safely', async () => {
  const { users, controls } = teamFixtures();
  const { deps, auditCalls } = buildDeps({ users, controls });
  const file = await exportTeamTimesheets({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER', 'Hari Hr'),
    query: { month: SEP }, deps,
  });
  assert.equal(file.filename, 'crewly-timesheet-company-2026-09.csv');
  assert.equal(file.contentType, 'text/csv; charset=utf-8');
  assert.equal(file.rowCount, 4 * 30);
  assert.equal(file.employeeCount, 4);
  assert.equal(file.content.charCodeAt(0), 0xfeff);
  const lines = file.content.split('\r\n');
  assert.equal(lines.length, 4 * 30 + 1);
  assert.equal(auditCalls.length, 1);
  const entry = auditCalls[0];
  assert.equal(entry.action, 'ATTENDANCE_TIMESHEET_EXPORTED');
  assert.equal(entry.actorName, 'Hari Hr');
  assert.deepEqual(Object.keys(entry.metadata).sort(), ['employees', 'filename', 'format', 'month', 'rows', 'scope']);
  assert.equal(entry.metadata.rows, 120);
});

test('31.10 export respects team scope + filters and survives audit failure', async () => {
  const { users, controls } = teamFixtures();
  const scoped = buildDeps({ users, controls, subtree: [U_REP1] });
  const file = await exportTeamTimesheets({
    companyId: COMPANY_A, actor: actor(U_MGR, 'MANAGER'),
    query: { month: SEP, hasExceptions: 'true' }, deps: scoped.deps,
  });
  assert.equal(file.employeeCount, 2);
  assert.equal(file.rowCount, 30);
  assert.ok(!file.content.includes('Olive Out'));

  const failing = buildDeps({
    users, controls, auditImpl: async () => { throw new Error('audit down'); },
  });
  const survived = await exportTeamTimesheets({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query: { month: SEP }, deps: failing.deps,
  });
  assert.equal(survived.rowCount, 120);
});

test('31.10 export sanitizes hostile names (formula guard)', async () => {
  const { users } = teamFixtures();
  users[1] = userDoc(U_REP1, COMPANY_A, { name: '=cmd|evil' });
  const file = await exportTeamTimesheets({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'),
    query: { month: SEP, search: 'cmd' }, deps: buildDeps({ users }).deps,
  });
  assert.match(file.content, /"'=cmd\|evil"/);
});

// ── §36–37 tenancy ─────────────────────────────────────────────

test('31.10 tenant B rows never leak into tenant A reads', async () => {
  const users = [userDoc(U_REP1, COMPANY_A), userDoc(U_B, COMPANY_B, { name: 'Bee Other' })];
  const controls = [
    controlDoc(U_REP1, '2026-09-14', {
      punchIn: dt('2026-09-14T03:30:00'), punchOut: dt('2026-09-14T12:30:00'), workMinutes: 480,
    }),
    { ...controlDoc(U_B, '2026-09-14'), companyId: COMPANY_B, workMinutes: 999 },
  ];
  const { deps, auditCalls } = buildDeps({ users, controls });
  const hr = actor(U_HR, 'HR_MANAGER');
  const sheet = await getMyTimesheet({ companyId: COMPANY_A, actor: actor(U_REP1, 'EMPLOYEE'), month: SEP, deps });
  assert.equal(sheet.summary.workedMinutes, 480);
  const team = await getTeamTimesheets({ companyId: COMPANY_A, actor: hr, query: { month: SEP }, deps });
  assert.ok(team.rows.every((row) => row.user.id !== U_B));
  const file = await exportTeamTimesheets({ companyId: COMPANY_A, actor: hr, query: { month: SEP }, deps });
  assert.ok(!file.content.includes('Bee Other'));
  assert.ok(!file.content.includes('999'));
  assert.equal(auditCalls[0].companyId, COMPANY_A);
});

// ── §24 bounded reads ──────────────────────────────────────────

test('31.10 batch shape: one range read per collection at any team size', async () => {
  const run = async (userIds) => {
    const calls = [];
    const { deps } = buildDeps({
      users: userIds.map((id) => userDoc(id, COMPANY_A)),
      counter: (model, op) => calls.push(`${model}:${op}`),
    });
    await getTeamTimesheets({
      companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'),
      query: { month: SEP }, deps,
    });
    const count = (prefix) => calls.filter((c) => c.startsWith(prefix)).length;
    return {
      attendance: count('Attendance:find'),
      events: count('Event:find'),
      leaves: count('Leave:find'),
      regs: count('Reg:find'),
      ots: count('OT:find'),
      masters: count('Assign:find') + count('Shift:find') + count('Schedule:find') + count('Holiday:find'),
    };
  };
  const one = await run([U_REP1]);
  const three = await run([U_REP1, U_REP2, U_OUTSIDER]);
  assert.deepEqual(one, { attendance: 1, events: 1, leaves: 1, regs: 1, ots: 1, masters: 5 });
  assert.deepEqual(three, one);
});

// ── §56 hygiene ────────────────────────────────────────────────

test('31.10 source hygiene: no payroll/finalize/surveillance vocabulary', () => {
  const service = readSource('src/services/attendance/attendanceTimesheetService.js');
  const rules = readSource('src/services/attendance/attendanceTimesheetRules.js');
  const controller = readSource('src/controllers/attendanceTimesheetController.js');
  const blob = `${service}\n${rules}\n${controller}`;
  for (const token of [
    'finalize(', 'lockDay', 'lopAmount', 'netPay', 'grossPay', 'BullMQ', 'Queue(',
    'geofence', 'idleScore', 'trackEmployee', 'continuousGps', 'salary', 'payrollEngine',
  ]) {
    assert.ok(!blob.includes(token), `forbidden token present: ${token}`);
  }
  assert.match(service, /ATTENDANCE_TIMESHEET_EXPORTED/);
  assert.ok(!rules.includes('mongoose') && !rules.includes('req.'));
});

test('31.10 routes mount the four reads under the reused permissions', () => {
  const routes = readSource('src/routes/attendanceRoutes.js');
  assert.match(routes, /\/timesheets\/mine/);
  assert.match(routes, /\/timesheets\/team/);
  assert.match(routes, /\/timesheets\/export/);
  assert.match(routes, /\/timesheets\/employee\/:employeeId/);
  assert.match(routes, /ATTENDANCE_READ_SELF/);
});
