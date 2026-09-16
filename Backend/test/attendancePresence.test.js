// ─────────────────────────────────────────────────────────────
// Phase 31.9 — Who's Working / team presence. Hermetic: every
// Mongo collaborator is an in-memory fake with a faithful query
// matcher, the clock is fixed, and no test touches the network,
// Redis, payroll, or the real database. Fake models throw on ANY
// write — the board is a read surface and the tests prove it.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRESENCE_STATE,
  PRESENCE_EXCEPTION,
  derivePresence,
  effectiveClockInOf,
  effectiveClockOutOf,
  isLateNotIn,
  liveStateOf,
  matchesPresenceFilter,
  matchesWorkModeFilter,
  summarizePresence,
} from '../src/services/attendance/attendancePresenceRules.js';
import { getTeamPresence } from '../src/services/attendance/attendancePresenceService.js';
import {
  SCHEDULE_STATUS,
  dayKeyInZone,
} from '../src/services/attendance/attendanceScheduleRules.js';
import {
  holidayOnDateFromMasters,
  preloadScheduleMasters,
  resolveEmployeeSchedule,
  resolveEmployeeScheduleFromMasters,
} from '../src/services/attendance/attendanceScheduleService.js';
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

// Tue 2026-09-15 10:00 IST (past 09:00 + 15m grace → late gate open).
const TUE_10AM = new Date('2026-09-15T04:30:00.000Z');
// Tue 2026-09-15 08:00 IST (before shift → NOT_IN).
const TUE_8AM = new Date('2026-09-15T02:30:00.000Z');
// Tue 2026-09-15 01:00 IST (inside Mon night window → overnight).
const TUE_1AM = new Date('2026-09-14T19:30:00.000Z');
// Sun 2026-09-13 10:00 IST (weekly off by default pattern).
const SUN_10AM = new Date('2026-09-13T04:30:00.000Z');

assert.equal(dayKeyInZone(TUE_10AM, TZ), '2026-09-15');
assert.equal(dayKeyInZone(TUE_1AM, TZ), '2026-09-15');
assert.equal(dayKeyInZone(SUN_10AM, TZ), '2026-09-13');

// ── Faithful in-memory query matcher ───────────────────────────
// Supports exactly the operators the presence service + batch
// preloader emit (equality incl. null-means-missing, $in, $ne,
// $gte/$lte/$gt/$lt, $exists, $or, $and, $regex+$options).

const cmpVal = (a, b) => {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() - new Date(b).getTime();
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

const matchCond = (docVal, cond) => {
  // Native RegExp conditions (the /general/i schedule fallback).
  if (cond instanceof RegExp) return cond.test(String(docVal ?? ''));
  // Mongo matches a scalar condition against ANY array element.
  if (Array.isArray(docVal) && (cond === null || typeof cond !== 'object' || cond instanceof Date)) {
    return docVal.some((entry) => matchCond(entry, cond));
  }
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    const keys = Object.keys(cond);
    if (keys.includes('$regex')) {
      return new RegExp(cond.$regex, cond.$options || '').test(String(docVal ?? ''));
    }
    return keys.every((op) => {
      const operand = cond[op];
      switch (op) {
        case '$in': return (operand || []).some((o) => cmpVal(docVal, o) === 0);
        case '$ne': return operand === null ? docVal !== null : cmpVal(docVal, operand) !== 0;
        case '$gte': return docVal !== undefined && docVal !== null && cmpVal(docVal, operand) >= 0;
        case '$lte': return docVal !== undefined && docVal !== null && cmpVal(docVal, operand) <= 0;
        case '$gt': return docVal !== undefined && docVal !== null && cmpVal(docVal, operand) > 0;
        case '$lt': return docVal !== undefined && docVal !== null && cmpVal(docVal, operand) < 0;
        case '$exists': return operand ? docVal !== undefined : docVal === undefined;
        default: throw new Error(`fake matcher: unsupported operator ${op}`);
      }
    });
  }
  if (cond === null) return docVal === null || docVal === undefined;
  return cmpVal(docVal, cond) === 0;
};

const matchDoc = (doc, filter) => Object.entries(filter || {}).every(([key, cond]) => {
  if (key === '$or') return cond.some((sub) => matchDoc(doc, sub));
  if (key === '$and') return cond.every((sub) => matchDoc(doc, sub));
  return matchCond(doc[key], cond);
});

const applySort = (rows, spec) => {
  const entries = typeof spec === 'string'
    ? [[spec.replace(/^-/, ''), spec.startsWith('-') ? -1 : 1]]
    : Object.entries(spec || {}).map(([k, v]) => [k, v === -1 ? -1 : 1]);
  return [...rows].sort((a, b) => {
    for (const [key, dir] of entries) {
      const d = cmpVal(a[key] ?? '', b[key] ?? '');
      if (d !== 0) return d * dir;
    }
    return 0;
  });
};

const forbiddenWrite = (op) => () => {
  throw new Error(`presence board must never write (attempted ${op})`);
};

// Fake model: chainable find/findOne/findById + countDocuments,
// call counters for the N+1 guards, writes refused loudly.
const fakeModel = (rows, counters = null, label = 'model') => {
  const count = (op) => {
    if (counters) counters[`${label}.${op}`] = (counters[`${label}.${op}`] || 0) + 1;
  };
  const oneChain = (filtered) => ({
    select: () => oneChain(filtered),
    sort: (spec) => oneChain(applySort(filtered, spec)),
    populate: () => oneChain(filtered),
    lean: async () => (filtered[0] ? { ...filtered[0] } : null),
  });
  const manyChain = (filtered) => ({
    select: () => manyChain(filtered),
    sort: (spec) => manyChain(applySort(filtered, spec)),
    populate: () => manyChain(filtered),
    lean: async () => filtered.map((row) => ({ ...row })),
  });
  return {
    find: (filter) => {
      count('find');
      return manyChain(rows.filter((row) => matchDoc(row, filter)));
    },
    findOne: (filter) => {
      count('findOne');
      return oneChain(rows.filter((row) => matchDoc(row, filter)));
    },
    findById: (id) => {
      count('findById');
      return oneChain(rows.filter((row) => matchDoc(row, { _id: id })));
    },
    countDocuments: async (filter) => {
      count('countDocuments');
      return rows.filter((row) => matchDoc(row, filter)).length;
    },
    create: forbiddenWrite('create'),
    updateOne: forbiddenWrite('updateOne'),
    updateMany: forbiddenWrite('updateMany'),
    findOneAndUpdate: forbiddenWrite('findOneAndUpdate'),
    deleteOne: forbiddenWrite('deleteOne'),
    deleteMany: forbiddenWrite('deleteMany'),
  };
};

// ── Fixture builders ───────────────────────────────────────────

const person = (over = {}) => ({
  _id: U_REP1,
  companyId: COMPANY_A,
  name: 'Aarav Mehta',
  email: 'aarav@secret.test',
  phone: '+91-0000000000',
  password: 'hashed-secret',
  employeeCode: 'EMP-001',
  avatarUrl: 'https://cdn.test/a.png',
  avatarPublicId: 'secret-public-id',
  designation: 'Engineer',
  department: DEPT_ENG,
  reportingTo: null,
  status: 'ACTIVE',
  pan: 'SECRET-PAN',
  uan: 'SECRET-UAN',
  bankAccount: 'SECRET-ACCOUNT',
  ifsc: 'SECRET-IFSC',
  address: { line: 'home address', city: 'X', state: 'Y', pincode: '000000' },
  ...over,
});

const control = (over = {}) => ({
  _id: 'c00000000000000000000001',
  companyId: COMPANY_A,
  user: U_REP1,
  date: '2026-09-15',
  punchIn: null,
  punchOut: null,
  workMinutes: 0,
  breakMinutes: 0,
  status: 'PRESENT',
  lateMinutes: 0,
  earlyMinutes: 0,
  overtimeMinutes: 0,
  liveState: null,
  workMode: null,
  eventSeq: 0,
  policyExceptions: [],
  lastEventAt: null,
  regularized: false,
  regularization: {},
  scheduleSnapshot: null,
  reconciliation: null,
  ...over,
});

const generalSchedule = (over = {}) => ({
  _id: '500000000000000000000001',
  companyId: COMPANY_A,
  name: 'General',
  workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  startTime: '09:00',
  endTime: '18:00',
  breakMinutes: 60,
  graceMinutes: 10,
  minWorkingHours: 8,
  halfDayHours: 4,
  overtimeEligible: false,
  departments: [],
  employees: [],
  branch: '',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const nightShift = (over = {}) => ({
  _id: '500000000000000000000009',
  companyId: COMPANY_A,
  name: 'Night Ops',
  type: 'NIGHT',
  startTime: '22:00',
  endTime: '06:00',
  breakMinutes: 45,
  graceMinutes: 10,
  overtimeEligible: false,
  departments: [],
  employees: [],
  branch: '',
  isActive: true,
  createdAt: new Date('2026-01-02T00:00:00Z'),
  ...over,
});

const assignment = (over = {}) => ({
  _id: '600000000000000000000001',
  companyId: COMPANY_A,
  shift: '500000000000000000000009',
  schedule: null,
  scope: 'EMPLOYEE',
  user: U_REP1,
  department: null,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  ...over,
});

const holiday = (over = {}) => ({
  _id: '700000000000000000000001',
  companyId: COMPANY_A,
  name: 'Test Festival',
  type: 'COMPANY',
  date: new Date('2026-09-15T00:00:00Z'),
  endDate: new Date('2026-09-15T00:00:00Z'),
  description: '',
  branch: '',
  departments: [],
  applicableEmployees: [],
  isOptional: false,
  optionalPicks: [],
  recurringYearly: false,
  isActive: true,
  ...over,
});

const leaveRow = (over = {}) => ({
  _id: '800000000000000000000001',
  companyId: COMPANY_A,
  user: U_REP1,
  type: 'CASUAL',
  startDate: '2026-09-15',
  endDate: '2026-09-15',
  days: 1,
  reason: 'private reason text',
  status: 'APPROVED',
  approver: null,
  approverNote: 'private approver note',
  ...over,
});

// BFS subtree over fixture users (orgHelpers parity).
const subtreeReaderFor = (users) => async (companyId, managerId) => {
  const scoped = users.filter((u) => String(u.companyId) === String(companyId) && u.status === 'ACTIVE');
  const children = {};
  scoped.forEach((u) => {
    const parent = String(u.reportingTo || '');
    (children[parent] ||= []).push(String(u._id));
  });
  const result = [];
  const queue = [String(managerId)];
  while (queue.length) {
    const cur = queue.pop();
    (children[cur] || []).forEach((id) => {
      result.push(id);
      queue.push(id);
    });
  }
  return result;
};

const baseDeps = ({
  users = [],
  controls = [],
  events = [],
  leaves = [],
  regs = [],
  ots = [],
  assignments = [],
  shifts = [],
  schedules = [],
  holidays = [],
  departments = [{ _id: DEPT_ENG, companyId: COMPANY_A, name: 'Engineering' }],
  company = { _id: COMPANY_A, timezone: TZ },
  policy = { timezone: null, grace: { lateInMinutes: 15, earlyOutMinutes: 15 } },
  now = TUE_10AM,
  counters = null,
} = {}) => ({
  UserModel: fakeModel(users, counters, 'User'),
  AttendanceModel: fakeModel(controls, counters, 'Attendance'),
  AttendanceEventModel: fakeModel(events, counters, 'Event'),
  LeaveModel: fakeModel(leaves, counters, 'Leave'),
  RegularizationModel: fakeModel(regs, counters, 'Reg'),
  OvertimeRequestModel: fakeModel(ots, counters, 'OT'),
  DepartmentModel: fakeModel(departments, counters, 'Dept'),
  CompanyModel: fakeModel(company ? [company] : [], counters, 'Company'),
  ShiftAssignmentModel: fakeModel(assignments, counters, 'Assign'),
  ShiftModel: fakeModel(shifts, counters, 'Shift'),
  WorkScheduleModel: fakeModel(schedules, counters, 'Schedule'),
  HolidayModel: fakeModel(holidays, counters, 'Holiday'),
  policyReader: async () => ({ policy }),
  subtreeReader: subtreeReaderFor(users),
  now: () => now,
});

const runBoard = (deps, { actor, query } = {}) => getTeamPresence({
  companyId: COMPANY_A,
  actor: actor || { _id: U_HR, role: 'HR_MANAGER' },
  query: query || {},
  deps,
});

const rowByName = (result, name) => result.rows.find((row) => row.user.name === name);

// ═════════════════════════════════════════════════════════════
// PURE RULES
// ═════════════════════════════════════════════════════════════

test('rules: open session → WORKING (live state preserved, never mutated)', () => {
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: control({ liveState: 'WORKING', workMode: 'OFFICE', punchIn: TUE_8AM }),
    liveState: 'WORKING',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
  });
  assert.equal(derived.presence, PRESENCE_STATE.WORKING);
  assert.equal(derived.liveState, 'WORKING');
  assert.equal(derived.workMode, 'OFFICE');
  assert.equal(derived.clockInAt, TUE_8AM.toISOString());
  assert.equal(derived.breakStartedAt, null);
});

test('rules: active break → ON_BREAK with break start from lastEventAt', () => {
  const breakAt = new Date('2026-09-15T07:00:00Z');
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: control({ liveState: 'ON_BREAK', workMode: 'WFH', punchIn: TUE_8AM, lastEventAt: breakAt }),
    liveState: 'ON_BREAK',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
  });
  assert.equal(derived.presence, PRESENCE_STATE.ON_BREAK);
  assert.equal(derived.liveState, 'ON_BREAK');
  assert.equal(derived.workMode, 'WFH');
  assert.equal(derived.breakStartedAt, breakAt.toISOString());
});

test('rules: completed session → COMPLETED', () => {
  const out = new Date('2026-09-15T12:30:00Z');
  const derived = derivePresence({
    now: new Date('2026-09-15T14:00:00Z'),
    businessDate: '2026-09-15',
    control: control({ liveState: 'COMPLETED', workMode: 'OFFICE', punchIn: TUE_8AM, punchOut: out, workMinutes: 480 }),
    liveState: 'COMPLETED',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
  });
  assert.equal(derived.presence, PRESENCE_STATE.COMPLETED);
  assert.equal(derived.clockOutAt, out.toISOString());
  assert.equal(derived.workedMinutes, 480);
});

test('rules: approved leave + no session → ON_LEAVE (leave keeps its label)', () => {
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: null,
    liveState: 'NOT_IN',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
    leave: { label: 'Casual Leave' },
  });
  assert.equal(derived.presence, PRESENCE_STATE.ON_LEAVE);
  assert.equal(derived.calendar.leaveLabel, 'Casual Leave');
});

test('rules: holiday + no session → HOLIDAY with holiday name', () => {
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: null,
    liveState: 'NOT_IN',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
    holiday: { name: 'Test Festival' },
  });
  assert.equal(derived.presence, PRESENCE_STATE.HOLIDAY);
  assert.equal(derived.calendar.primary, 'HOLIDAY');
  assert.equal(derived.calendar.holidayName, 'Test Festival');
});

test('rules: weekly off + no session → WEEKLY_OFF', () => {
  const derived = derivePresence({
    now: SUN_10AM,
    businessDate: '2026-09-13',
    control: null,
    liveState: 'NOT_IN',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-13T03:30:00Z') },
    weeklyOff: true,
  });
  assert.equal(derived.presence, PRESENCE_STATE.WEEKLY_OFF);
  assert.equal(derived.calendar.primary, 'WEEKLY_OFF');
});

test('rules: holiday + weekly off → HOLIDAY primary, pattern retained (31.7 parity)', () => {
  const derived = derivePresence({
    now: SUN_10AM,
    businessDate: '2026-09-13',
    control: null,
    liveState: 'NOT_IN',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-13T03:30:00Z') },
    holiday: { name: 'Sunday Festival' },
    weeklyOff: true,
  });
  assert.equal(derived.presence, PRESENCE_STATE.HOLIDAY);
  assert.equal(derived.calendar.primary, 'HOLIDAY');
  assert.equal(derived.calendar.alsoWeeklyOff, true);
});

test('rules: unresolved schedule → UNRESOLVED (never an invented 09:00)', () => {
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: null,
    liveState: 'NOT_IN',
    schedule: { status: SCHEDULE_STATUS.UNRESOLVED },
  });
  assert.equal(derived.presence, PRESENCE_STATE.UNRESOLVED);
  assert.equal(derived.schedule, null);
  assert.equal(derived.scheduleUnresolved, true);
  assert.deepEqual(derived.late, { isLate: false, lateMinutes: 0 });
});

test('rules: before shift start → NOT_IN (never prematurely absent)', () => {
  const derived = derivePresence({
    now: TUE_8AM,
    businessDate: '2026-09-15',
    control: null,
    liveState: 'NOT_IN',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
    lateGraceMinutes: 15,
  });
  assert.equal(derived.presence, PRESENCE_STATE.NOT_IN);
  assert.equal(derived.late.isLate, false);
});

test('rules: beyond start + grace → LATE_NOT_IN with minutes', () => {
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: null,
    liveState: 'NOT_IN',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
    lateGraceMinutes: 15,
  });
  assert.equal(derived.presence, PRESENCE_STATE.LATE_NOT_IN);
  assert.equal(derived.late.isLate, true);
  assert.equal(derived.late.lateMinutes, 60);
});

test('rules: late gate is strict — exactly at start+grace is NOT late', () => {
  const start = new Date('2026-09-15T03:30:00Z');
  assert.equal(
    isLateNotIn({ now: new Date(start.getTime() + 15 * 60000), scheduledStartAt: start, lateGraceMinutes: 15 }),
    false,
  );
  assert.equal(
    isLateNotIn({ now: new Date(start.getTime() + 15 * 60000 + 1), scheduledStartAt: start, lateGraceMinutes: 15 }),
    true,
  );
  assert.equal(isLateNotIn({ now: TUE_10AM, scheduledStartAt: null }), false);
  assert.equal(isLateNotIn({ now: null, scheduledStartAt: start }), false);
});

test('rules: attendance on approved leave keeps WORKING + conflict flag (never hidden)', () => {
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: control({
      liveState: 'WORKING',
      workMode: 'OFFICE',
      punchIn: TUE_8AM,
      reconciliation: {
        calendar: { primary: 'WORK_DAY', alsoWeeklyOff: false, holiday: {} },
        leave: { portion: 'FULL_DAY', label: 'Casual Leave' },
        conflicts: ['ATTENDANCE_ON_APPROVED_LEAVE'],
        needsReview: true,
      },
    }),
    liveState: 'WORKING',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
    leave: { label: 'Casual Leave' },
  });
  assert.equal(derived.presence, PRESENCE_STATE.WORKING);
  assert.ok(derived.exceptions.includes(PRESENCE_EXCEPTION.ATTENDANCE_ON_LEAVE));
  assert.equal(derived.needsReview, true);
  assert.equal(derived.calendar.leaveLabel, 'Casual Leave');
});

test('rules: stored 31.7 calendar wins over live contexts (frozen meaning)', () => {
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: control({
      liveState: 'COMPLETED',
      punchIn: TUE_8AM,
      punchOut: new Date('2026-09-15T12:30:00Z'),
      reconciliation: {
        calendar: { primary: 'HOLIDAY', alsoWeeklyOff: false, holiday: { name: 'Stored Festival' } },
        leave: { portion: 'NONE' },
        conflicts: [],
        needsReview: false,
      },
    }),
    liveState: 'COMPLETED',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
    holiday: { name: 'Renamed Festival' },
  });
  assert.equal(derived.presence, PRESENCE_STATE.COMPLETED);
  assert.equal(derived.calendar.primary, 'HOLIDAY');
  assert.equal(derived.calendar.holidayName, 'Stored Festival');
});

test('rules: approved correction wins for times and mode', () => {
  const recorded = TUE_8AM;
  const corrected = new Date('2026-09-15T03:00:00Z');
  const correctedOut = new Date('2026-09-15T13:00:00Z');
  const c = control({
    punchIn: recorded,
    punchOut: new Date('2026-09-15T12:00:00Z'),
    workMode: 'OFFICE',
    regularization: { correctedIn: corrected, correctedOut, correctedWorkMode: 'WFH' },
  });
  assert.equal(effectiveClockInOf(c).getTime(), corrected.getTime());
  assert.equal(effectiveClockOutOf(c).getTime(), correctedOut.getTime());
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: c,
    liveState: 'WORKING',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
  });
  assert.equal(derived.workMode, 'WFH');
  assert.equal(derived.clockInAt, corrected.toISOString());
  assert.equal(derived.clockOutAt, correctedOut.toISOString());
});

test('rules: legacy controls derive live state from punches (31.2 parity)', () => {
  assert.equal(liveStateOf(null), 'NOT_IN');
  assert.equal(liveStateOf(control({ liveState: null })), 'NOT_IN');
  assert.equal(liveStateOf(control({ liveState: null, punchIn: TUE_8AM })), 'WORKING');
  assert.equal(
    liveStateOf(control({ liveState: null, punchIn: TUE_8AM, punchOut: new Date() })),
    'COMPLETED',
  );
  assert.equal(liveStateOf(control({ liveState: 'ON_BREAK' })), 'ON_BREAK');
});

test('rules: exception flags derive from authoritative facts only', () => {
  const derived = derivePresence({
    now: new Date('2026-09-15T14:00:00Z'),
    businessDate: '2026-09-15',
    control: control({
      liveState: 'COMPLETED',
      punchIn: TUE_8AM,
      punchOut: new Date('2026-09-15T11:00:00Z'),
      lateMinutes: 12,
      earlyMinutes: 30,
      regularized: true,
    }),
    liveState: 'COMPLETED',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
    pendingRegularization: true,
    staleOpen: true,
  });
  assert.ok(derived.exceptions.includes(PRESENCE_EXCEPTION.LATE_ARRIVAL));
  assert.ok(derived.exceptions.includes(PRESENCE_EXCEPTION.EARLY_EXIT));
  assert.ok(derived.exceptions.includes(PRESENCE_EXCEPTION.REGULARIZATION_PENDING));
  assert.ok(derived.exceptions.includes(PRESENCE_EXCEPTION.STALE_OPEN_SESSION));
  assert.equal(derived.regularized, true);
});

test('rules: open session without any clock-in → MISSING_PUNCH', () => {
  const derived = derivePresence({
    now: TUE_10AM,
    businessDate: '2026-09-15',
    control: control({ liveState: 'WORKING', punchIn: null, regularization: {} }),
    liveState: 'WORKING',
    schedule: { status: SCHEDULE_STATUS.RESOLVED, scheduledStartAt: new Date('2026-09-15T03:30:00Z') },
  });
  assert.ok(derived.exceptions.includes(PRESENCE_EXCEPTION.MISSING_PUNCH));
});

test('rules: summarizePresence buckets are exclusive; modes break down working rows only', () => {
  const summary = summarizePresence([
    { presence: 'WORKING', workMode: 'OFFICE', exceptions: [] },
    { presence: 'WORKING', workMode: 'WFH', exceptions: ['LATE_ARRIVAL'] },
    { presence: 'ON_BREAK', workMode: null, exceptions: [] },
    { presence: 'COMPLETED', workMode: 'OFFICE', exceptions: [] },
    { presence: 'NOT_IN', workMode: null, exceptions: [] },
    { presence: 'LATE_NOT_IN', workMode: null, exceptions: [] },
    { presence: 'ON_LEAVE', workMode: null, exceptions: [] },
    { presence: 'HOLIDAY', workMode: null, exceptions: [] },
    { presence: 'WEEKLY_OFF', workMode: null, exceptions: [] },
    { presence: 'UNRESOLVED', workMode: null, exceptions: [] },
    { presence: 'BOGUS', workMode: 'OFFICE', exceptions: [] },
  ]);
  assert.equal(summary.total, 10);
  assert.equal(summary.working, 2);
  assert.equal(summary.onBreak, 1);
  assert.equal(summary.completed, 1);
  assert.equal(summary.exceptions, 1);
  // Modes count WORKING + ON_BREAK rows only (3), never completed/not-in.
  assert.deepEqual(summary.modes, {
    OFFICE: 1,
    WFH: 1,
    FIELD: 0,
    CLIENT_SITE: 0,
    BUSINESS_TRAVEL: 0,
    NONE: 1,
  });
});

test('rules: derived-side filter matchers are allowlisted and empty-open', () => {
  assert.equal(matchesPresenceFilter({ presence: 'WORKING' }, []), true);
  assert.equal(matchesPresenceFilter({ presence: 'WORKING' }, ['WORKING', 'ON_BREAK']), true);
  assert.equal(matchesPresenceFilter({ presence: 'NOT_IN' }, ['WORKING']), false);
  assert.equal(matchesWorkModeFilter({ workMode: null }, []), true);
  assert.equal(matchesWorkModeFilter({ workMode: null }, ['NONE']), true);
  assert.equal(matchesWorkModeFilter({ workMode: 'WFH' }, ['WFH']), true);
  assert.equal(matchesWorkModeFilter({ workMode: 'WFH' }, ['OFFICE']), false);
});

// ═════════════════════════════════════════════════════════════
// SERVICE — CORE DERIVATION
// ═════════════════════════════════════════════════════════════

const hrActor = { _id: U_HR, role: 'HR_MANAGER' };

test('service: working employee shows WORKING + OFFICE + verified office name', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1, reportingTo: null })],
    schedules: [generalSchedule()],
    controls: [control({ liveState: 'WORKING', workMode: 'OFFICE', punchIn: TUE_8AM, eventSeq: 1 })],
    events: [{
      _id: 'e1',
      companyId: COMPANY_A,
      user: U_REP1,
      date: '2026-09-15',
      seq: 1,
      type: 'CLOCK_IN',
      at: TUE_8AM,
      workMode: 'OFFICE',
      locationVerification: {
        locationName: 'Bengaluru HQ',
        distanceMeters: 12,
        accuracyMeters: 5,
        result: 'VERIFIED',
      },
    }],
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.date, '2026-09-15');
  assert.equal(result.timezone, TZ);
  assert.equal(result.scope.type, 'COMPANY');
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.presence, 'WORKING');
  assert.equal(row.liveState, 'WORKING');
  assert.equal(row.workMode, 'OFFICE');
  assert.equal(row.locationName, 'Bengaluru HQ');
  assert.equal(row.clockInAt, TUE_8AM.toISOString());
  assert.equal(row.businessDate, '2026-09-15');
  assert.equal(row.schedule.startTime, '09:00');
  assert.equal(row.schedule.endTime, '18:00');
  assert.equal(row.user.name, 'Aarav Mehta');
  assert.equal(row.user.department.name, 'Engineering');
  assert.deepEqual(result.counts, {
    total: 1,
    working: 1,
    onBreak: 0,
    completed: 0,
    notIn: 0,
    lateNotIn: 0,
    onLeave: 0,
    holiday: 0,
    weeklyOff: 0,
    unresolved: 0,
    exceptions: 0,
    modes: { OFFICE: 1, WFH: 0, FIELD: 0, CLIENT_SITE: 0, BUSINESS_TRAVEL: 0, NONE: 0 },
  });
});

test('service: WFH shows mode only — verified office name is never attached', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    controls: [control({ liveState: 'WORKING', workMode: 'WFH', punchIn: TUE_8AM, eventSeq: 1 })],
    events: [{
      _id: 'e1',
      companyId: COMPANY_A,
      user: U_REP1,
      date: '2026-09-15',
      seq: 1,
      type: 'CLOCK_IN',
      at: TUE_8AM,
      workMode: 'WFH',
      locationVerification: { locationName: 'Stale Office', distanceMeters: 99 },
    }],
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.rows[0].presence, 'WORKING');
  assert.equal(result.rows[0].workMode, 'WFH');
  assert.equal(result.rows[0].locationName, null);
  assert.ok(!JSON.stringify(result).includes('Stale Office'));
  assert.ok(!JSON.stringify(result).includes('distanceMeters'));
});

test('service: on-break employee shows ON_BREAK since lastEventAt', async () => {
  const breakAt = new Date('2026-09-15T07:00:00Z');
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    controls: [control({
      liveState: 'ON_BREAK',
      workMode: 'OFFICE',
      punchIn: TUE_8AM,
      lastEventAt: breakAt,
      eventSeq: 2,
    })],
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.rows[0].presence, 'ON_BREAK');
  assert.equal(result.rows[0].breakStartedAt, breakAt.toISOString());
  assert.equal(result.counts.onBreak, 1);
});

test('service: completed employee shows COMPLETED + worked minutes + late flag', async () => {
  const out = new Date('2026-09-15T12:30:00Z');
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    controls: [control({
      liveState: 'COMPLETED',
      workMode: 'FIELD',
      punchIn: TUE_8AM,
      punchOut: out,
      workMinutes: 510,
      lateMinutes: 9,
    })],
  });
  const result = await runBoard(deps, { actor: hrActor });
  const row = result.rows[0];
  assert.equal(row.presence, 'COMPLETED');
  assert.equal(row.workMode, 'FIELD');
  assert.equal(row.clockOutAt, out.toISOString());
  assert.equal(row.workedMinutes, 510);
  assert.ok(row.exceptions.includes('LATE_ARRIVAL'));
});

test('service: no session before shift → NOT_IN; beyond grace → LATE_NOT_IN', async () => {
  const users = [person({ _id: U_REP1 })];
  const schedules = [generalSchedule()];
  const early = await runBoard(baseDeps({ users, schedules, now: TUE_8AM }), { actor: hrActor });
  assert.equal(early.rows[0].presence, 'NOT_IN');
  const late = await runBoard(baseDeps({ users, schedules, now: TUE_10AM }), { actor: hrActor });
  assert.equal(late.rows[0].presence, 'LATE_NOT_IN');
  assert.equal(late.rows[0].late.isLate, true);
  assert.equal(late.rows[0].late.lateMinutes, 60);
});

test('service: no resolvable schedule → UNRESOLVED (no fake 09:00–18:00)', async () => {
  const deps = baseDeps({ users: [person({ _id: U_REP1 })], schedules: [], shifts: [] });
  const result = await runBoard(deps, { actor: hrActor });
  const row = result.rows[0];
  assert.equal(row.presence, 'UNRESOLVED');
  assert.equal(row.schedule, null);
  assert.equal(row.scheduleUnresolved, true);
});

test('service: approved leave + no session → ON_LEAVE with type label only', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    leaves: [leaveRow({ type: 'EARNED' })],
  });
  const result = await runBoard(deps, { actor: hrActor });
  const row = result.rows[0];
  assert.equal(row.presence, 'ON_LEAVE');
  assert.equal(row.calendar.leaveLabel, LEAVE_TYPES.EARNED.label);
  const json = JSON.stringify(result);
  assert.ok(!json.includes('private reason text'));
  assert.ok(!json.includes('private approver note'));
});

test('service: weekend leave does not cover (Leave-counting parity) → WEEKLY_OFF', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    leaves: [leaveRow({ startDate: '2026-09-13', endDate: '2026-09-13' })],
    now: SUN_10AM,
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.rows[0].presence, 'WEEKLY_OFF');
});

test('service: holiday + no session → HOLIDAY; work on holiday keeps both facts', async () => {
  const users = [
    person({ _id: U_REP1, name: 'Aarav Mehta', employeeCode: 'EMP-001' }),
    person({ _id: U_REP2, name: 'Zoya Khan', employeeCode: 'EMP-002', reportingTo: null }),
  ];
  const deps = baseDeps({
    users,
    schedules: [generalSchedule()],
    holidays: [holiday()],
    controls: [control({ user: U_REP2, liveState: 'WORKING', workMode: 'OFFICE', punchIn: TUE_8AM, eventSeq: 1 })],
  });
  const result = await runBoard(deps, { actor: hrActor });
  const off = rowByName(result, 'Aarav Mehta');
  assert.equal(off.presence, 'HOLIDAY');
  assert.equal(off.calendar.holidayName, 'Test Festival');
  const worked = rowByName(result, 'Zoya Khan');
  assert.equal(worked.presence, 'WORKING');
  assert.equal(worked.calendar.primary, 'HOLIDAY');
  assert.equal(worked.calendar.holidayName, 'Test Festival');
});

test('service: weekly off + no session → WEEKLY_OFF', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    now: SUN_10AM,
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.rows[0].presence, 'WEEKLY_OFF');
  assert.equal(result.rows[0].calendar.primary, 'WEEKLY_OFF');
});

test('service: overnight worker at 01:00 stays WORKING on yesterday business date', async () => {
  const inAt = new Date('2026-09-14T16:35:00Z'); // Mon 22:05 IST
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    shifts: [nightShift()],
    assignments: [assignment({ user: U_REP1, shift: nightShift()._id })],
    controls: [control({
      date: '2026-09-14',
      liveState: 'WORKING',
      workMode: 'OFFICE',
      punchIn: inAt,
      eventSeq: 1,
    })],
    now: TUE_1AM,
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.date, '2026-09-15');
  const row = result.rows[0];
  assert.equal(row.businessDate, '2026-09-14');
  assert.equal(row.presence, 'WORKING');
  assert.equal(row.schedule.startTime, '22:00');
  assert.equal(row.schedule.endTime, '06:00');
  assert.equal(row.schedule.crossesMidnight, true);
  assert.ok(!row.exceptions.includes('STALE_OPEN_SESSION'));
});

test('service: overnight break at 01:00 → ON_BREAK (not NOT_IN)', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    shifts: [nightShift()],
    assignments: [assignment({ user: U_REP1, shift: nightShift()._id })],
    controls: [control({
      date: '2026-09-14',
      liveState: 'ON_BREAK',
      workMode: 'OFFICE',
      punchIn: new Date('2026-09-14T16:35:00Z'),
      lastEventAt: new Date('2026-09-14T19:00:00Z'),
      eventSeq: 2,
    })],
    now: TUE_1AM,
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.rows[0].presence, 'ON_BREAK');
  assert.equal(result.rows[0].businessDate, '2026-09-14');
});

test('service: forgotten clock-out surfaces as WORKING + STALE_OPEN_SESSION with old date', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    controls: [control({
      _id: 'c000000000000000000000099',
      date: '2026-09-10',
      liveState: 'WORKING',
      workMode: 'OFFICE',
      punchIn: new Date('2026-09-10T03:35:00Z'),
      eventSeq: 1,
    })],
  });
  const result = await runBoard(deps, { actor: hrActor });
  const row = result.rows[0];
  assert.equal(row.presence, 'WORKING');
  assert.ok(row.exceptions.includes('STALE_OPEN_SESSION'));
  assert.equal(row.businessDate, '2026-09-15');
  assert.equal(result.counts.exceptions, 1);
});

test('service: completed today + older open session keeps COMPLETED + stale flag', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    controls: [
      control({
        _id: 'c000000000000000000000099',
        date: '2026-09-10',
        liveState: 'WORKING',
        punchIn: new Date('2026-09-10T03:35:00Z'),
        eventSeq: 1,
      }),
      control({
        liveState: 'COMPLETED',
        workMode: 'OFFICE',
        punchIn: TUE_8AM,
        punchOut: new Date('2026-09-15T12:30:00Z'),
        workMinutes: 480,
      }),
    ],
  });
  const result = await runBoard(deps, { actor: hrActor });
  const row = result.rows[0];
  assert.equal(row.presence, 'COMPLETED');
  assert.ok(row.exceptions.includes('STALE_OPEN_SESSION'));
});

test('service: pending regularization raises a flag without reason text', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    controls: [control({ liveState: 'WORKING', workMode: 'OFFICE', punchIn: TUE_8AM, eventSeq: 1 })],
    regs: [{
      _id: 'r1',
      companyId: COMPANY_A,
      user: U_REP1,
      attendanceDate: '2026-09-15',
      type: 'LATE_EXPLANATION',
      status: 'PENDING',
      reason: 'traffic jam details',
    }],
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.ok(result.rows[0].exceptions.includes('REGULARIZATION_PENDING'));
  assert.ok(!JSON.stringify(result).includes('traffic jam details'));
});

test('service: OT state is flags only — no minutes, no reason, no money', async () => {
  const users = [
    person({ _id: U_REP1, name: 'Aarav Mehta', employeeCode: 'EMP-001' }),
    person({ _id: U_REP2, name: 'Zoya Khan', employeeCode: 'EMP-002', reportingTo: null }),
  ];
  const deps = baseDeps({
    users,
    schedules: [generalSchedule()],
    controls: [
      control({ user: U_REP1, liveState: 'WORKING', workMode: 'OFFICE', punchIn: TUE_8AM, eventSeq: 1 }),
      control({ user: U_REP2, liveState: 'WORKING', workMode: 'OFFICE', punchIn: TUE_8AM, eventSeq: 1 }),
    ],
    ots: [
      {
        _id: 'o1', companyId: COMPANY_A, user: U_REP1, attendanceDate: '2026-09-15',
        type: 'OVERTIME', status: 'PENDING', requestedMinutes: 90, reason: 'deploy overrun',
      },
      {
        _id: 'o2', companyId: COMPANY_A, user: U_REP2, attendanceDate: '2026-09-15',
        type: 'COMP_OFF', status: 'APPROVED', requestedMinutes: 300, approvedMinutes: 300,
        compOffDays: 1, reason: 'weekend release',
      },
    ],
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.deepEqual(rowByName(result, 'Aarav Mehta').ot, { pending: true, approved: false, compOffApproved: false });
  assert.deepEqual(rowByName(result, 'Zoya Khan').ot, { pending: false, approved: false, compOffApproved: true });
  const json = JSON.stringify(result);
  assert.ok(!json.includes('requestedMinutes'));
  assert.ok(!json.includes('approvedMinutes'));
  assert.ok(!json.includes('deploy overrun'));
  assert.ok(!json.includes('weekend release'));
});

test('service: stored schedule snapshot wins over re-resolution (31.6 law)', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule({ startTime: '10:00', endTime: '19:00' })],
    controls: [control({
      liveState: 'WORKING',
      workMode: 'OFFICE',
      punchIn: TUE_8AM,
      eventSeq: 1,
      scheduleSnapshot: {
        shiftId: null,
        shiftName: null,
        scheduleId: generalSchedule()._id,
        scheduleName: 'General',
        source: 'WORK_SCHEDULE',
        startTime: '09:00',
        endTime: '18:00',
        scheduledStartAt: new Date('2026-09-15T03:30:00Z'),
        scheduledEndAt: new Date('2026-09-15T12:30:00Z'),
        scheduledMinutes: 480,
        breakMinutes: 60,
        minimumMinutes: 480,
        crossesMidnight: false,
        isWorkingDay: true,
        dayType: 'WORK_DAY',
        holiday: null,
        timezone: TZ,
      },
    })],
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.rows[0].schedule.startTime, '09:00');
  assert.equal(result.rows[0].schedule.endTime, '18:00');
});

test('service: policy timezone wins over company; company wins over default', async () => {
  const users = [person({ _id: U_REP1 })];
  const withPolicyTz = await runBoard(
    baseDeps({ users, schedules: [], policy: { timezone: 'America/New_York', grace: {} }, company: { _id: COMPANY_A, timezone: TZ } }),
    { actor: hrActor },
  );
  assert.equal(withPolicyTz.timezone, 'America/New_York');
  const withCompanyTz = await runBoard(
    baseDeps({ users, schedules: [], policy: { timezone: null, grace: {} }, company: { _id: COMPANY_A, timezone: 'Europe/London' } }),
    { actor: hrActor },
  );
  assert.equal(withCompanyTz.timezone, 'Europe/London');
  const withDefault = await runBoard(
    baseDeps({ users, schedules: [], policy: { timezone: null, grace: {} }, company: null }),
    { actor: hrActor },
  );
  assert.equal(withDefault.timezone, 'Asia/Kolkata');
});

// ═════════════════════════════════════════════════════════════
// SERVICE — SCOPE / TENANCY / FILTERS / PAGINATION
// ═════════════════════════════════════════════════════════════

const orgUsers = () => [
  person({ _id: U_MGR, name: 'Mira Manager', employeeCode: 'EMP-000', reportingTo: null, designation: 'Manager' }),
  person({ _id: U_REP1, name: 'Aarav Mehta', employeeCode: 'EMP-001', reportingTo: U_MGR }),
  person({ _id: U_REP2, name: 'Zoya Khan', employeeCode: 'EMP-002', reportingTo: U_REP1 }),
  person({ _id: U_OUTSIDER, name: 'Out Sider', employeeCode: 'EMP-009', reportingTo: null, department: DEPT_SALES }),
  person({ _id: U_HR, name: 'Hari HR', employeeCode: 'EMP-100', reportingTo: null, designation: 'HR' }),
];

test('service: manager sees self + authorized subtree only', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  const result = await runBoard(deps, { actor: { _id: U_MGR, role: 'MANAGER' } });
  assert.equal(result.scope.type, 'TEAM');
  const names = result.rows.map((row) => row.user.name).sort();
  assert.deepEqual(names, ['Aarav Mehta', 'Mira Manager', 'Zoya Khan']);
  assert.equal(result.counts.total, 3);
  assert.equal(result.scope.total, 3);
});

test('service: HR sees the whole company', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.scope.type, 'COMPANY');
  assert.equal(result.rows.length, 5);
  assert.equal(result.scope.total, 5);
});

test('service: employee actor is confined to self (route permission gates the rest)', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  const result = await runBoard(deps, { actor: { _id: U_REP1, role: 'EMPLOYEE' } });
  const names = result.rows.map((row) => row.user.name).sort();
  assert.deepEqual(names, ['Aarav Mehta', 'Zoya Khan']);
});

test('service: Company A board can never include Company B rows or counts', async () => {
  const users = [
    ...orgUsers(),
    person({ _id: U_B, companyId: COMPANY_B, name: 'Bee Foreign', employeeCode: 'B-001', reportingTo: null }),
  ];
  const deps = baseDeps({
    users,
    schedules: [generalSchedule()],
    controls: [control({ user: U_B, companyId: COMPANY_B, liveState: 'WORKING', workMode: 'OFFICE', punchIn: TUE_8AM, eventSeq: 1 })],
  });
  const result = await runBoard(deps, { actor: hrActor });
  assert.ok(!result.rows.some((row) => row.user.name === 'Bee Foreign'));
  assert.equal(result.scope.total, 5);
  assert.equal(result.counts.total, 5);
  assert.equal(result.counts.working, 0);
});

test('service: foreign department filter narrows to empty — never leaks', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  const result = await runBoard(deps, {
    actor: hrActor,
    query: { departmentId: 'ffffffffffffffffffffffff' },
  });
  assert.equal(result.rows.length, 0);
  assert.equal(result.total, 0);
  assert.equal(result.counts.total, 0);
  assert.equal(result.scope.total, 5);
});

test('service: malformed department filter is refused', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  await assert.rejects(
    runBoard(deps, { actor: hrActor, query: { departmentId: 'not-an-id' } }),
    /Invalid department filter/,
  );
});

test('service: department filter narrows rows and counts together', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  const result = await runBoard(deps, { actor: hrActor, query: { departmentId: DEPT_SALES } });
  assert.deepEqual(result.rows.map((row) => row.user.name), ['Out Sider']);
  assert.equal(result.counts.total, 1);
});

test('service: search matches name, code and designation (case-insensitive, bounded)', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  const byName = await runBoard(deps, { actor: hrActor, query: { search: 'aarav' } });
  assert.deepEqual(byName.rows.map((row) => row.user.name), ['Aarav Mehta']);
  const byCode = await runBoard(deps, { actor: hrActor, query: { search: 'EMP-002' } });
  assert.deepEqual(byCode.rows.map((row) => row.user.name), ['Zoya Khan']);
  const byRole = await runBoard(deps, { actor: hrActor, query: { search: 'manager' } });
  assert.deepEqual(byRole.rows.map((row) => row.user.name), ['Mira Manager']);
});

test('service: search metacharacters are escaped — never a regex injection', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  const result = await runBoard(deps, { actor: hrActor, query: { search: '.*' } });
  assert.equal(result.rows.length, 0);
  const result2 = await runBoard(deps, { actor: hrActor, query: { search: '(Aarav' } });
  assert.equal(result2.rows.length, 0);
});

test('service: presence + work-mode filters apply to the derived rows', async () => {
  const users = [
    person({ _id: U_REP1, name: 'Aarav Mehta', employeeCode: 'EMP-001' }),
    person({ _id: U_REP2, name: 'Zoya Khan', employeeCode: 'EMP-002', reportingTo: null }),
    person({ _id: U_MGR, name: 'Mira Manager', employeeCode: 'EMP-000', reportingTo: null }),
  ];
  const deps = baseDeps({
    users,
    schedules: [generalSchedule()],
    controls: [
      control({ user: U_REP1, liveState: 'WORKING', workMode: 'WFH', punchIn: TUE_8AM, eventSeq: 1 }),
      control({ user: U_REP2, liveState: 'ON_BREAK', workMode: 'OFFICE', punchIn: TUE_8AM, lastEventAt: TUE_10AM, eventSeq: 2 }),
    ],
  });
  const working = await runBoard(deps, { actor: hrActor, query: { presence: 'WORKING' } });
  assert.deepEqual(working.rows.map((row) => row.user.name), ['Aarav Mehta']);
  assert.equal(working.counts.total, 1);
  const multi = await runBoard(deps, { actor: hrActor, query: { presence: ['WORKING', 'ON_BREAK'] } });
  assert.equal(multi.rows.length, 2);
  const wfh = await runBoard(deps, { actor: hrActor, query: { workMode: 'WFH' } });
  assert.deepEqual(wfh.rows.map((row) => row.user.name), ['Aarav Mehta']);
  const none = await runBoard(deps, { actor: hrActor, query: { workMode: 'NONE' } });
  assert.deepEqual(none.rows.map((row) => row.user.name), ['Mira Manager']);
});

test('service: invalid presence / work-mode filters are refused', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  await assert.rejects(
    runBoard(deps, { actor: hrActor, query: { presence: 'PRODUCTIVE' } }),
    /Invalid presence filter/,
  );
  await assert.rejects(
    runBoard(deps, { actor: hrActor, query: { workMode: 'YACHT' } }),
    /Invalid work-mode filter/,
  );
});

test('service: pagination is stable and clamps to the last page', async () => {
  const deps = baseDeps({ users: orgUsers(), schedules: [generalSchedule()] });
  const p1 = await runBoard(deps, { actor: hrActor, query: { pageSize: 2, page: 1 } });
  assert.equal(p1.rows.length, 2);
  assert.equal(p1.total, 5);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.page, 1);
  const p2 = await runBoard(deps, { actor: hrActor, query: { pageSize: 2, page: 2 } });
  assert.equal(p2.rows.length, 2);
  const names1 = p1.rows.map((row) => row.user.id);
  const names2 = p2.rows.map((row) => row.user.id);
  assert.ok(names1.every((id) => !names2.includes(id)));
  const beyond = await runBoard(deps, { actor: hrActor, query: { pageSize: 2, page: 99 } });
  assert.equal(beyond.page, 3);
  assert.equal(beyond.rows.length, 1);
  const huge = await runBoard(deps, { actor: hrActor, query: { pageSize: 5000 } });
  assert.equal(huge.pageSize, 100);
});

test('service: empty scope returns an empty board (never nulls, never throws)', async () => {
  const deps = baseDeps({ users: [], schedules: [] });
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.rows.length, 0);
  assert.equal(result.total, 0);
  assert.equal(result.counts.total, 0);
  assert.equal(result.scope.total, 0);
});

test('service: missing company or actor context is refused', async () => {
  const deps = baseDeps({ users: [], schedules: [] });
  await assert.rejects(getTeamPresence({ companyId: null, actor: hrActor, query: {}, deps }), /Company context/);
  await assert.rejects(getTeamPresence({ companyId: COMPANY_A, actor: null, query: {}, deps }), /Actor context/);
});

// ═════════════════════════════════════════════════════════════
// SERVICE — PRIVACY / N+1 / SOURCE HYGIENE
// ═════════════════════════════════════════════════════════════

test('service: serialized board leaks no sensitive field', async () => {
  const deps = baseDeps({
    users: [person({ _id: U_REP1 })],
    schedules: [generalSchedule()],
    controls: [control({
      liveState: 'WORKING',
      workMode: 'OFFICE',
      punchIn: TUE_8AM,
      eventSeq: 1,
      regularized: true,
      regularization: { correctedIn: TUE_8AM },
      reconciliation: {
        calendar: { primary: 'WORK_DAY', alsoWeeklyOff: false, holiday: {} },
        leave: { portion: 'NONE' },
        conflicts: [],
        needsReview: false,
      },
    })],
    events: [{
      _id: 'e1',
      companyId: COMPANY_A,
      user: U_REP1,
      date: '2026-09-15',
      seq: 1,
      type: 'CLOCK_IN',
      at: TUE_8AM,
      workMode: 'OFFICE',
      locationVerification: {
        locationName: 'Bengaluru HQ',
        radiusMeters: 150,
        distanceMeters: 12,
        accuracyMeters: 5,
        result: 'VERIFIED',
      },
      authorization: { requestId: 'req1', mode: 'OFFICE' },
    }],
    regs: [{
      _id: 'r1', companyId: COMPANY_A, user: U_REP1, attendanceDate: '2026-09-15',
      type: 'LATE_EXPLANATION', status: 'PENDING', reason: 'secret-reg-reason',
      proposal: { correctedIn: TUE_8AM },
    }],
    ots: [{
      _id: 'o1', companyId: COMPANY_A, user: U_REP1, attendanceDate: '2026-09-15',
      type: 'OVERTIME', status: 'PENDING', requestedMinutes: 60, eligibleMinutes: 60,
      recordedMinutes: 90, reason: 'secret-ot-reason',
    }],
    leaves: [leaveRow({})],
  });
  const result = await runBoard(deps, { actor: hrActor });
  const json = JSON.stringify(result);
  for (const forbidden of [
    'aarav@secret.test',
    'password',
    'phone',
    'SECRET-PAN',
    'SECRET-UAN',
    'SECRET-ACCOUNT',
    'SECRET-IFSC',
    'home address',
    'secret-public-id',
    'locationVerification',
    'distanceMeters',
    'accuracyMeters',
    'radiusMeters',
    'secret-reg-reason',
    'secret-ot-reason',
    'private reason text',
    'requestedMinutes',
    'eligibleMinutes',
    'recordedMinutes',
    'proposal',
    'approverNote',
    'overtimeMinutes',
    'salary',
    'amount',
  ]) {
    assert.ok(!json.includes(forbidden), `board must not leak: ${forbidden}`);
  }
  // …while the safe facts survive.
  assert.equal(result.rows[0].user.employeeCode, 'EMP-001');
  assert.equal(result.rows[0].locationName, 'Bengaluru HQ');
});

test('service: query budget is bounded — identical call counts at 3 and 9 users (no N+1)', async () => {
  const makeUsers = (n) => Array.from({ length: n }, (_, i) => person({
    _id: `1000000000000000000000${String(i + 10).padStart(2, '0')}`.slice(0, 24),
    name: `Employee ${i}`,
    employeeCode: `EMP-${i}`,
    reportingTo: null,
  }));
  const runWith = async (n) => {
    const counters = {};
    const deps = baseDeps({
      users: makeUsers(n),
      schedules: [generalSchedule()],
      counters,
    });
    await runBoard(deps, { actor: hrActor });
    return counters;
  };
  const three = await runWith(3);
  const nine = await runWith(9);
  assert.deepEqual(nine, three);
  assert.deepEqual(three, {
    'User.find': 2, // scope ids + the (filtered) user page query
    'User.countDocuments': 1,
    'Assign.find': 1,
    'Shift.find': 1,
    'Schedule.find': 1,
    'Holiday.find': 2,
    'Dept.find': 1,
    'Attendance.find': 1,
    'Event.find': 1,
    'Leave.find': 1,
    'Reg.find': 1,
    'OT.find': 1,
    'Company.findById': 1,
  });
});

test('service: board performs zero writes (fakes throw on any mutation)', async () => {
  const deps = baseDeps({
    users: orgUsers(),
    schedules: [generalSchedule()],
    controls: [control({ liveState: 'WORKING', workMode: 'OFFICE', punchIn: TUE_8AM, eventSeq: 1 })],
  });
  // Any create/update/delete inside the read path throws via the fakes.
  const result = await runBoard(deps, { actor: hrActor });
  assert.equal(result.rows.length, 5);
});

test('source hygiene: presence code touches no payroll, no mongoose, no network', () => {
  for (const rel of [
    'src/services/attendance/attendancePresenceRules.js',
    'src/services/attendance/attendancePresenceService.js',
    'src/controllers/attendancePresenceController.js',
  ]) {
    const source = readSource(rel);
    assert.ok(!source.includes('Payroll'), `${rel} must not reference payroll`);
    assert.ok(!source.includes('mongoose'), `${rel} must not import mongoose`);
    assert.ok(!source.includes('axios'), `${rel} must not use the network`);
    assert.ok(!source.includes('Salary'), `${rel} must not reference salary`);
  }
  const rules = readSource('src/services/attendance/attendancePresenceRules.js');
  assert.ok(!rules.includes('../models/'), 'pure rules must not import models');
  const controller = readSource('src/controllers/attendancePresenceController.js');
  assert.ok(controller.includes('// Data from frontend'), 'house comment: frontend input');
  assert.ok(controller.includes('// DB Logic'), 'house comment: DB logic');
  assert.ok(controller.includes('// Data to frontend'), 'house comment: frontend output');
  const routes = readSource('src/routes/attendanceRoutes.js');
  assert.ok(routes.includes("'/presence'"), 'presence route registered');
  assert.ok(routes.includes("'ATTENDANCE_READ'"), 'presence gated by existing permission');
});

// ═════════════════════════════════════════════════════════════
// BATCH SCHEDULE PARITY (31.6 single resolver vs 31.9 batch)
// ═════════════════════════════════════════════════════════════

const parityModels = (fixtures) => ({
  ShiftAssignmentModel: fakeModel(fixtures.assignments || []),
  ShiftModel: fakeModel(fixtures.shifts || []),
  WorkScheduleModel: fakeModel(fixtures.schedules || []),
  UserModel: fakeModel([]),
});

test('batch parity: employee assignment tier matches the single resolver', async () => {
  const user = person({ _id: U_REP1 });
  const fixtures = {
    assignments: [assignment({ user: U_REP1, shift: nightShift()._id })],
    shifts: [nightShift()],
    schedules: [generalSchedule()],
    holidays: [],
  };
  const engine = { holidayOnDate: async () => null };
  const single = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user, attendanceDate: '2026-09-15', timezone: TZ,
    ...parityModels(fixtures), engine,
  });
  const masters = await preloadScheduleMasters({
    companyId: COMPANY_A, fromDate: '2026-09-14', toDate: '2026-09-15',
    ...parityModels(fixtures), HolidayModel: fakeModel([]),
  });
  const batch = resolveEmployeeScheduleFromMasters({
    masters, user, attendanceDate: '2026-09-15', timezone: TZ,
  });
  assert.equal(batch.status, SCHEDULE_STATUS.RESOLVED);
  assert.deepEqual(JSON.parse(JSON.stringify(batch)), JSON.parse(JSON.stringify(single)));
  assert.equal(batch.source, 'EMPLOYEE_OVERRIDE');
  assert.equal(batch.crossesMidnight, true);
});

test('batch parity: department assignment tier matches', async () => {
  const user = person({ _id: U_REP1, department: DEPT_ENG });
  const fixtures = {
    assignments: [assignment({
      _id: '600000000000000000000002', scope: 'DEPARTMENT', user: null,
      department: DEPT_ENG, shift: nightShift()._id,
    })],
    shifts: [nightShift()],
    schedules: [generalSchedule()],
    holidays: [],
  };
  const engine = { holidayOnDate: async () => null };
  const single = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user, attendanceDate: '2026-09-15', timezone: TZ,
    ...parityModels(fixtures), engine,
  });
  const masters = await preloadScheduleMasters({
    companyId: COMPANY_A, fromDate: '2026-09-14', toDate: '2026-09-15',
    ...parityModels(fixtures), HolidayModel: fakeModel([]),
  });
  const batch = resolveEmployeeScheduleFromMasters({
    masters, user, attendanceDate: '2026-09-15', timezone: TZ,
  });
  assert.equal(batch.source, 'DEPARTMENT_DEFAULT');
  assert.deepEqual(JSON.parse(JSON.stringify(batch)), JSON.parse(JSON.stringify(single)));
});

test('batch parity: shift-doc + schedule-chain + unresolved all match', async () => {
  const engine = { holidayOnDate: async () => null };
  const check = async (user, fixtures) => {
    const single = await resolveEmployeeSchedule({
      companyId: COMPANY_A, user, attendanceDate: '2026-09-15', timezone: TZ,
      ...parityModels(fixtures), engine,
    });
    const masters = await preloadScheduleMasters({
      companyId: COMPANY_A, fromDate: '2026-09-15', toDate: '2026-09-15',
      ...parityModels(fixtures), HolidayModel: fakeModel([]),
    });
    const batch = resolveEmployeeScheduleFromMasters({
      masters, user, attendanceDate: '2026-09-15', timezone: TZ,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(batch)), JSON.parse(JSON.stringify(single)));
    return batch;
  };
  // Shift doc directly listing the employee.
  const direct = await check(person({ _id: U_REP1 }), {
    shifts: [nightShift({ employees: [U_REP1] })],
    schedules: [generalSchedule()],
  });
  assert.equal(direct.source, 'SHIFT_DOC');
  // Employee-linked work schedule.
  const byEmp = await check(person({ _id: U_REP1 }), {
    schedules: [generalSchedule(), generalSchedule({
      _id: '500000000000000000000002', name: 'Custom', employees: [U_REP1],
      startTime: '10:00', endTime: '19:00', createdAt: new Date('2026-02-01T00:00:00Z'),
    })],
  });
  assert.equal(byEmp.schedule.name, 'Custom');
  assert.equal(byEmp.startTime, '10:00');
  // Nothing configured → UNRESOLVED on both paths.
  const unresolved = await check(person({ _id: U_REP1 }), {});
  assert.equal(unresolved.status, SCHEDULE_STATUS.UNRESOLVED);
});

test('batch parity: invalid pointers and closed windows fall through identically', async () => {
  const engine = { holidayOnDate: async () => null };
  const user = person({ _id: U_REP1 });
  const fixtures = {
    assignments: [
      assignment({ user: U_REP1, shift: 'dead00000000000000000001' }),
      assignment({
        _id: '600000000000000000000003', user: U_REP1, shift: nightShift()._id,
        effectiveFrom: new Date('2025-01-01T00:00:00Z'),
        effectiveTo: new Date('2025-12-31T00:00:00Z'),
      }),
    ],
    shifts: [nightShift({ _id: 'dead00000000000000000001', isActive: false })],
    schedules: [generalSchedule()],
    holidays: [],
  };
  const single = await resolveEmployeeSchedule({
    companyId: COMPANY_A, user, attendanceDate: '2026-09-15', timezone: TZ,
    ...parityModels(fixtures), engine,
  });
  const masters = await preloadScheduleMasters({
    companyId: COMPANY_A, fromDate: '2026-09-15', toDate: '2026-09-15',
    ...parityModels(fixtures), HolidayModel: fakeModel([]),
  });
  const batch = resolveEmployeeScheduleFromMasters({
    masters, user, attendanceDate: '2026-09-15', timezone: TZ,
  });
  assert.equal(batch.source, 'WORK_SCHEDULE');
  assert.deepEqual(JSON.parse(JSON.stringify(batch)), JSON.parse(JSON.stringify(single)));
});

test('batch holidays: scope, optional-picked, and recurring parity with the engine', async () => {
  const user = person({ _id: U_REP1, department: DEPT_ENG });
  const masters = {
    holidays: [
      holiday({ name: 'Dept Fest', type: 'DEPARTMENT', departments: [DEPT_SALES] }),
      holiday({
        _id: '700000000000000000000002', name: 'Opt Day', type: 'OPTIONAL',
        isOptional: true, optionalPicks: [],
      }),
      holiday({
        _id: '700000000000000000000003', name: 'Picked Optional', type: 'OPTIONAL',
        isOptional: true, optionalPicks: [U_REP1],
      }),
      holiday({
        _id: '700000000000000000000004', name: 'Yearly Puja', type: 'COMPANY',
        date: new Date('2020-09-15T00:00:00Z'), endDate: new Date('2020-09-15T00:00:00Z'),
        recurringYearly: true,
      }),
    ],
  };
  // Other-department holiday is out of scope; unpicked optional is
  // excluded; the picked optional wins by _id order over recurring.
  const hit = holidayOnDateFromMasters(masters, user, '2026-09-15');
  assert.deepEqual(hit, { name: 'Picked Optional', type: 'OPTIONAL' });
  // Without the pick, the recurring projection still applies.
  const masters2 = { holidays: masters.holidays.filter((h) => h.name !== 'Picked Optional') };
  const hit2 = holidayOnDateFromMasters(masters2, user, '2026-09-15');
  assert.deepEqual(hit2, { name: 'Yearly Puja', type: 'COMPANY' });
  // Explicit-employee scoping works regardless of type.
  const masters3 = {
    holidays: [holiday({ name: 'Personal Holiday', type: 'BRANCH', branch: 'Nowhere', applicableEmployees: [U_REP1] })],
  };
  const hit3 = holidayOnDateFromMasters(masters3, user, '2026-09-15');
  assert.deepEqual(hit3, { name: 'Personal Holiday', type: 'BRANCH' });
  // Nothing applicable → null (weekly-off logic, not a crash).
  assert.equal(holidayOnDateFromMasters({ holidays: [] }, user, '2026-09-15'), null);
});
