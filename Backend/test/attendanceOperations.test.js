// ─────────────────────────────────────────────────────────────
// Phase 31.12 — HR attendance operations dashboard.
// Hermetic: 31.9's getTeamPresence runs for REAL (presence is
// never stubbed) with every Mongo collaborator an in-memory
// fake; the clock is fixed; no network, Redis, audit or payroll.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATTENTION_CATEGORY,
  ATTENTION_SEVERITY,
  SHORT_HOURS_TOLERANCE_MINUTES,
  classifyAttention,
  groupOperations,
  isApplicable,
  isExpected,
  isValidAttentionCategory,
  matchesOpsFilters,
  paginate,
  serializeAttentionItem,
  summarizeOperations,
} from '../src/services/attendance/attendanceOperationsRules.js';
import { getOperationsDashboard } from '../src/services/attendance/attendanceOperationsService.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

const TZ = 'Asia/Kolkata';
const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const U_HR = '100000000000000000000001';
const U_WFH = '100000000000000000000002';
const U_BREAK = '100000000000000000000003';
const U_DONE = '100000000000000000000004';
const U_EARLY = '100000000000000000000005';
const U_LATE_ARR = '100000000000000000000006';
const U_LATE_NOTIN = '100000000000000000000007';
const U_NOTIN = '100000000000000000000008';
const U_LEAVE = '100000000000000000000009';
const U_HOLIDAY = '100000000000000000000010';
const U_WEEKOFF = '100000000000000000000011';
const U_PREJOIN = '100000000000000000000012';
const U_EXITED = '100000000000000000000013';
const U_STALE = '100000000000000000000014';
const U_OT = '100000000000000000000015';
const U_REG = '100000000000000000000016';
const U_CONFLICT = '100000000000000000000017';
const U_SHORT = '100000000000000000000018';
const U_MGR = '100000000000000000000019';
const U_REP = '100000000000000000000020';
const U_OUTSIDE = '100000000000000000000021';
const U_B = '200000000000000000000001';

const D_ENG = '300000000000000000000001';
const D_SALES = '300000000000000000000002';
const D_B = '300000000000000000000003';
const S_MORNING = '400000000000000000000001';
const S_AFTERNOON = '400000000000000000000002';

// Wed 2026-09-16 10:00 IST — frozen now; today = 2026-09-16.
const WED_10AM = new Date('2026-09-16T04:30:00.000Z');
const TODAY = '2026-09-16';
const YESTERDAY = '2026-09-15';

const actor = (id, role) => ({ _id: id, role });
const dt = (isoString) => new Date(`${isoString}.000Z`);

// ── Faithful matcher ───────────────────────────────────────────

const cmpVal = (a, b) => {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() - new Date(b).getTime();
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
    return Object.keys(cond).every((op) => {
      const want = cond[op];
      if (op === '$in') return Array.isArray(want) && want.some((v) => cmpVal(docVal, v) === 0);
      if (op === '$ne') return cmpVal(docVal, want) !== 0;
      if (op === '$gte') return cmpVal(docVal, want) >= 0;
      if (op === '$lte') return cmpVal(docVal, want) <= 0;
      if (op === '$gt') return cmpVal(docVal, want) > 0;
      if (op === '$lt') return cmpVal(docVal, want) < 0;
      if (op === '$exists') return want ? docVal !== undefined : docVal === undefined;
      if (op === '$regex') return new RegExp(want, cond.$options || '').test(String(docVal ?? ''));
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

const fakeCollection = ({ rows = [], counter = null, name = 'model' } = {}) => {
  const store = rows;
  const findResult = (hits) => {
    const q = {
      _rows: hits,
      select() { return q; },
      sort(spec) { q._rows = sortRows(q._rows, spec); return q; },
      skip(n) { q._rows = q._rows.slice(n); return q; },
      limit(n) { q._rows = q._rows.slice(0, n); return q; },
      lean: async () => q._rows.map((row) => ({ ...row })),
    };
    return q;
  };
  return {
    _store: store,
    find: (filter = {}) => {
      if (counter) counter(name, 'find');
      return findResult(store.filter((row) => matchDoc(row, filter)));
    },
    findById: (id) => {
      if (counter) counter(name, 'findById');
      const hit = store.find((row) => cmpVal(row._id, id) === 0) || null;
      const q = {
        select() { return q; },
        lean: async () => (hit ? { ...hit } : null),
      };
      return q;
    },
    countDocuments: async (filter = {}) => {
      if (counter) counter(name, 'countDocuments');
      return store.filter((row) => matchDoc(row, filter)).length;
    },
  };
};

// ── Fixtures ───────────────────────────────────────────────────

const userDoc = (id, companyId, overrides = {}) => ({
  _id: id,
  companyId,
  status: 'ACTIVE',
  name: `User ${id.slice(-4)}`,
  employeeCode: `E${id.slice(-4)}`,
  designation: 'Engineer',
  department: D_ENG,
  dateOfJoining: null,
  reportingTo: null,
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
  ...overrides,
});

const clockInEvent = (user, date, locationName = 'Bengaluru HQ') => ({
  _id: `e-${user.slice(-4)}-${date}`,
  companyId: COMPANY_A,
  user,
  date,
  type: 'CLOCK_IN',
  locationVerification: { locationName },
});

const morningShiftUsers = [
  U_HR, U_WFH, U_BREAK, U_DONE, U_EARLY, U_LATE_ARR, U_LATE_NOTIN,
  U_LEAVE, U_HOLIDAY, U_WEEKOFF, U_STALE, U_OT, U_REG, U_CONFLICT, U_SHORT,
];

const buildWorld = ({ counter = null, subtree = null, extra = {} } = {}) => {
  const users = [
    userDoc(U_HR, COMPANY_A, { name: 'Hari HR' }),
    userDoc(U_WFH, COMPANY_A, { name: 'Wren Remote', department: D_SALES }),
    userDoc(U_BREAK, COMPANY_A, { name: 'Bina Break' }),
    userDoc(U_DONE, COMPANY_A, { name: 'Dev Done' }),
    userDoc(U_EARLY, COMPANY_A, { name: 'Eli Early' }),
    userDoc(U_LATE_ARR, COMPANY_A, { name: 'Lal Late' }),
    userDoc(U_LATE_NOTIN, COMPANY_A, { name: 'Nia Notin', department: D_SALES }),
    userDoc(U_NOTIN, COMPANY_A, { name: 'Ned Soon' }),
    userDoc(U_LEAVE, COMPANY_A, { name: 'Lev Out' }),
    userDoc(U_HOLIDAY, COMPANY_A, { name: 'Hol Day' }),
    userDoc(U_WEEKOFF, COMPANY_A, { name: 'Wes Off' }),
    userDoc(U_PREJOIN, COMPANY_A, { name: 'Pre Join', dateOfJoining: new Date('2026-09-20T00:00:00.000Z') }),
    userDoc(U_EXITED, COMPANY_A, { name: 'Ex Ited' }),
    userDoc(U_STALE, COMPANY_A, { name: 'Sal Stale' }),
    userDoc(U_OT, COMPANY_A, { name: 'Oti Time' }),
    userDoc(U_REG, COMPANY_A, { name: 'Reg Fix' }),
    userDoc(U_CONFLICT, COMPANY_A, { name: 'Con Flict' }),
    userDoc(U_SHORT, COMPANY_A, { name: 'Sho Rathi' }),
    userDoc(U_MGR, COMPANY_A, { name: 'Mira Manager' }),
    userDoc(U_REP, COMPANY_A, { name: 'Ria Report', reportingTo: U_MGR }),
    userDoc(U_OUTSIDE, COMPANY_A, { name: 'Oscar Outside' }),
    userDoc(U_B, COMPANY_B, { name: 'Bee Other', department: D_B }),
    ...(extra.users || []),
  ];
  const controls = [
    controlDoc(U_HR, TODAY, { punchIn: dt('2026-09-16T03:30:00'), liveState: 'WORKING', workMinutes: 60 }),
    controlDoc(U_WFH, TODAY, { punchIn: dt('2026-09-16T03:35:00'), liveState: 'WORKING', workMinutes: 55, workMode: 'WFH' }),
    controlDoc(U_BREAK, TODAY, { punchIn: dt('2026-09-16T03:30:00'), liveState: 'ON_BREAK', workMinutes: 45, lastEventAt: dt('2026-09-16T04:15:00') }),
    controlDoc(U_DONE, TODAY, { punchIn: dt('2026-09-16T03:30:00'), punchOut: dt('2026-09-16T04:20:00'), liveState: 'COMPLETED', workMinutes: 480 }),
    controlDoc(U_EARLY, TODAY, { punchIn: dt('2026-09-16T03:30:00'), punchOut: dt('2026-09-16T04:00:00'), liveState: 'COMPLETED', workMinutes: 500, earlyMinutes: 45 }),
    controlDoc(U_LATE_ARR, TODAY, { punchIn: dt('2026-09-16T04:10:00'), liveState: 'WORKING', workMinutes: 20, lateMinutes: 40 }),
    controlDoc(U_STALE, '2026-09-10', { punchIn: dt('2026-09-10T03:30:00'), liveState: 'WORKING', workMinutes: 60 }),
    controlDoc(U_OT, TODAY, { punchIn: dt('2026-09-16T03:30:00'), liveState: 'WORKING', workMinutes: 60 }),
    controlDoc(U_REG, TODAY, { punchIn: dt('2026-09-16T03:30:00'), liveState: 'WORKING', workMinutes: 60 }),
    controlDoc(U_CONFLICT, TODAY, { punchIn: dt('2026-09-16T03:30:00'), liveState: 'WORKING', workMinutes: 60 }),
    controlDoc(U_SHORT, TODAY, { punchIn: dt('2026-09-16T03:30:00'), punchOut: dt('2026-09-16T04:00:00'), liveState: 'COMPLETED', workMinutes: 240 }),
    controlDoc(U_MGR, TODAY, { punchIn: dt('2026-09-16T03:30:00'), liveState: 'WORKING', workMinutes: 60 }),
    controlDoc(U_REP, TODAY, { punchIn: dt('2026-09-16T03:30:00'), liveState: 'WORKING', workMinutes: 60 }),
    controlDoc(U_OUTSIDE, TODAY, { punchIn: dt('2026-09-16T03:30:00'), liveState: 'WORKING', workMinutes: 60 }),
    { ...controlDoc(U_B, TODAY, { punchIn: dt('2026-09-16T03:30:00'), liveState: 'WORKING', workMinutes: 999 }), companyId: COMPANY_B },
    ...(extra.controls || []),
  ];
  const events = [
    U_HR, U_BREAK, U_DONE, U_EARLY, U_LATE_ARR, U_OT, U_REG, U_CONFLICT, U_SHORT, U_MGR, U_REP, U_OUTSIDE,
  ].map((uid) => clockInEvent(uid, TODAY));
  const leaves = [
    { _id: 'l1', companyId: COMPANY_A, user: U_LEAVE, status: 'APPROVED', type: 'CASUAL', startDate: TODAY, endDate: TODAY },
    { _id: 'l2', companyId: COMPANY_A, user: U_CONFLICT, status: 'APPROVED', type: 'SICK', startDate: TODAY, endDate: TODAY },
    ...(extra.leaves || []),
  ];
  const regs = [
    { _id: 'r1', companyId: COMPANY_A, user: U_REG, attendanceDate: TODAY, type: 'MISSED_CLOCK_OUT', status: 'PENDING', reason: 'PRIVATE-REG-REASON', createdAt: dt('2026-09-16T02:00:00') },
    { _id: 'rB', companyId: COMPANY_B, user: U_B, attendanceDate: TODAY, type: 'MISSED_CLOCK_OUT', status: 'PENDING', reason: 'B-REASON', createdAt: dt('2026-09-16T02:00:00') },
    ...(extra.regs || []),
  ];
  const ots = [
    { _id: 'o1', companyId: COMPANY_A, user: U_OT, attendanceDate: TODAY, type: 'OVERTIME', status: 'PENDING', createdAt: dt('2026-09-16T01:00:00') },
    { _id: 'oB', companyId: COMPANY_B, user: U_B, attendanceDate: TODAY, type: 'OVERTIME', status: 'PENDING', createdAt: dt('2026-09-16T01:00:00') },
    ...(extra.ots || []),
  ];
  const shifts = [
    { _id: S_MORNING, companyId: COMPANY_A, name: 'Morning', isActive: true, employees: morningShiftUsers, startTime: '09:00', endTime: '18:00' },
    { _id: S_AFTERNOON, companyId: COMPANY_A, name: 'Afternoon', isActive: true, employees: [U_NOTIN], startTime: '14:00', endTime: '22:00' },
  ];
  const schedules = [
    { _id: '600000000000000000000002', companyId: COMPANY_A, name: 'General Roster', isActive: true, workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], createdAt: dt('2025-01-01T00:00:00') },
    { _id: '600000000000000000000001', companyId: COMPANY_A, name: 'Four day', isActive: true, employees: [U_WEEKOFF], workingDays: ['MON', 'TUE', 'THU', 'FRI'], createdAt: dt('2026-01-01T00:00:00') },
  ];
  const holidays = [
    { _id: '700000000000000000000001', companyId: COMPANY_A, name: 'Local Fest', type: 'CUSTOM', isActive: true, applicableEmployees: [U_HOLIDAY], date: new Date('2026-09-16T00:00:00.000Z'), endDate: new Date('2026-09-16T00:00:00.000Z') },
  ];
  const resignations = [
    { _id: 'res1', companyId: COMPANY_A, user: U_EXITED, status: 'APPROVED', lastWorkingDate: new Date('2026-09-10T00:00:00.000Z') },
  ];
  const departments = [
    { _id: D_ENG, companyId: COMPANY_A, name: 'Engineering' },
    { _id: D_SALES, companyId: COMPANY_A, name: 'Sales' },
    { _id: D_B, companyId: COMPANY_B, name: 'Bee Dept' },
  ];
  const deps = {
    UserModel: fakeCollection({ rows: users, counter, name: 'User' }),
    AttendanceModel: fakeCollection({ rows: controls, counter, name: 'Attendance' }),
    AttendanceEventModel: fakeCollection({ rows: events, counter, name: 'Event' }),
    LeaveModel: fakeCollection({ rows: leaves, counter, name: 'Leave' }),
    RegularizationModel: fakeCollection({ rows: regs, counter, name: 'Reg' }),
    OvertimeRequestModel: fakeCollection({ rows: ots, counter, name: 'OT' }),
    ResignationModel: fakeCollection({ rows: resignations, counter, name: 'Resignation' }),
    DepartmentModel: fakeCollection({ rows: departments, counter, name: 'Department' }),
    CompanyModel: fakeCollection({ rows: [], counter, name: 'Company' }),
    ShiftAssignmentModel: fakeCollection({ rows: [], counter, name: 'Assign' }),
    ShiftModel: fakeCollection({ rows: shifts, counter, name: 'Shift' }),
    WorkScheduleModel: fakeCollection({ rows: schedules, counter, name: 'Schedule' }),
    HolidayModel: fakeCollection({ rows: holidays, counter, name: 'Holiday' }),
    policyReader: async () => ({ policy: { timezone: TZ, grace: {} } }),
    subtreeReader: async () => subtree || [],
    now: () => WED_10AM,
  };
  return { deps, stores: { users, controls, regs, ots } };
};

// ── Pure: employment applicability ─────────────────────────────

test('31.12 applicable honors joining and exit dates, never invents them', () => {
  assert.equal(isApplicable({ businessDate: TODAY }), true);
  assert.equal(isApplicable({ dateOfJoining: '2026-09-16', businessDate: TODAY }), true);
  assert.equal(isApplicable({ dateOfJoining: '2026-09-20', businessDate: TODAY }), false);
  assert.equal(isApplicable({ lastWorkingDate: '2026-09-16', businessDate: TODAY }), true);
  assert.equal(isApplicable({ lastWorkingDate: '2026-09-10', businessDate: TODAY }), false);
  assert.equal(isApplicable({}), false);
});

test('31.12 expected excludes day-off presences and inapplicable staff', () => {
  assert.equal(isExpected({ row: { presence: 'WORKING' }, businessDate: TODAY }), true);
  assert.equal(isExpected({ row: { presence: 'NOT_IN' }, businessDate: TODAY }), true);
  assert.equal(isExpected({ row: { presence: 'UNRESOLVED' }, businessDate: TODAY }), true);
  assert.equal(isExpected({ row: { presence: 'ON_LEAVE' }, businessDate: TODAY }), false);
  assert.equal(isExpected({ row: { presence: 'HOLIDAY' }, businessDate: TODAY }), false);
  assert.equal(isExpected({ row: { presence: 'WEEKLY_OFF' }, businessDate: TODAY }), false);
  assert.equal(isExpected({
    row: { presence: 'WORKING' },
    employment: { dateOfJoining: '2026-09-20' },
    businessDate: TODAY,
  }), false);
  assert.equal(isExpected({ row: null, businessDate: TODAY }), false);
});

// ── Pure: attention classification ─────────────────────────────

const opsRow = (overrides = {}) => ({
  presence: 'WORKING',
  liveState: 'WORKING',
  businessDate: TODAY,
  workMode: 'OFFICE',
  locationName: null,
  clockInAt: '2026-09-16T03:30:00.000Z',
  clockOutAt: null,
  breakStartedAt: null,
  workedMinutes: 60,
  breakMinutes: 0,
  schedule: {
    startTime: '09:00',
    endTime: '18:00',
    shiftName: 'Morning',
    scheduleName: null,
    scheduledStartAt: '2026-09-16T03:30:00.000Z',
    scheduledEndAt: '2026-09-16T12:30:00.000Z',
    crossesMidnight: false,
  },
  scheduleUnresolved: false,
  late: { isLate: false, lateMinutes: 0 },
  calendar: { primary: 'WORK_DAY', alsoWeeklyOff: false, holidayName: null, leaveLabel: null },
  exceptions: [],
  needsReview: false,
  regularized: false,
  ot: { pending: false, approved: false, compOffApproved: false },
  user: { id: U_DONE, name: 'Dev Done', employeeCode: 'E0004', designation: '', department: null },
  lateMinutes: 0,
  earlyMinutes: 0,
  ...overrides,
});

test('31.12 clean row classifies to zero items', () => {
  assert.deepEqual(classifyAttention(opsRow()), []);
  assert.deepEqual(classifyAttention(null), []);
});

test('31.12 late-not-in carries schedule start + accrued minutes', () => {
  const items = classifyAttention(opsRow({
    presence: 'LATE_NOT_IN',
    liveState: 'NOT_IN',
    clockInAt: null,
    workMode: null,
    late: { isLate: true, lateMinutes: 60 },
  }));
  assert.equal(items.length, 1);
  assert.equal(items[0].category, ATTENTION_CATEGORY.LATE_NOT_IN);
  assert.equal(items[0].severity, ATTENTION_SEVERITY.WARNING);
  assert.equal(items[0].minutes, 60);
  assert.equal(items[0].scheduledStartAt, '2026-09-16T03:30:00.000Z');
  assert.equal(items[0].workflow, 'attendance');
});

test('31.12 late arrival prefers authoritative minutes, falls back to clocks', () => {
  const withFacts = classifyAttention(opsRow({
    exceptions: ['LATE_ARRIVAL'],
    clockInAt: '2026-09-16T04:10:00.000Z',
    lateMinutes: 40,
  }));
  assert.equal(withFacts[0].category, ATTENTION_CATEGORY.LATE_ARRIVAL);
  assert.equal(withFacts[0].minutes, 40);
  const fallback = classifyAttention(opsRow({
    exceptions: ['LATE_ARRIVAL'],
    clockInAt: '2026-09-16T04:10:00.000Z',
    lateMinutes: 0,
  }));
  assert.equal(fallback[0].minutes, 40);
  const noClocks = classifyAttention(opsRow({
    exceptions: ['LATE_ARRIVAL'],
    clockInAt: null,
    schedule: null,
    scheduleUnresolved: true,
  }));
  assert.equal(noClocks[0].minutes, 0);
});

test('31.12 missing punch and stale sessions are blockers', () => {
  const missing = classifyAttention(opsRow({ exceptions: ['MISSING_PUNCH'] }));
  assert.equal(missing[0].category, ATTENTION_CATEGORY.MISSING_PUNCH);
  assert.equal(missing[0].severity, ATTENTION_SEVERITY.BLOCKER);
  const staleWork = classifyAttention(opsRow({ exceptions: ['STALE_OPEN_SESSION'] }));
  assert.equal(staleWork[0].category, ATTENTION_CATEGORY.UNRESOLVED_SESSION);
  assert.equal(staleWork[0].severity, ATTENTION_SEVERITY.BLOCKER);
  const staleBreak = classifyAttention(opsRow({
    presence: 'ON_BREAK',
    liveState: 'ON_BREAK',
    exceptions: ['STALE_OPEN_SESSION'],
  }));
  assert.equal(staleBreak[0].category, ATTENTION_CATEGORY.INCOMPLETE_BREAK);
  assert.equal(staleBreak[0].severity, ATTENTION_SEVERITY.BLOCKER);
});

test('31.12 early exit minutes mirror the late-arrival rule', () => {
  const items = classifyAttention(opsRow({
    presence: 'COMPLETED',
    liveState: 'COMPLETED',
    exceptions: ['EARLY_EXIT'],
    clockOutAt: '2026-09-16T11:45:00.000Z',
    earlyMinutes: 45,
    workedMinutes: 500,
  }));
  assert.equal(items.length, 1);
  assert.equal(items[0].category, ATTENTION_CATEGORY.EARLY_EXIT);
  assert.equal(items[0].severity, ATTENTION_SEVERITY.WARNING);
  assert.equal(items[0].minutes, 45);
});

test('31.12 short hours fires only beyond tolerance on resolved schedules', () => {
  assert.equal(SHORT_HOURS_TOLERANCE_MINUTES, 60);
  const short = classifyAttention(opsRow({
    presence: 'COMPLETED',
    liveState: 'COMPLETED',
    clockOutAt: '2026-09-16T07:30:00.000Z',
    workedMinutes: 240,
  }));
  assert.equal(short.length, 1);
  assert.equal(short[0].category, ATTENTION_CATEGORY.SHORT_HOURS);
  assert.equal(short[0].minutes, 300);
  const normal = classifyAttention(opsRow({
    presence: 'COMPLETED',
    liveState: 'COMPLETED',
    clockOutAt: '2026-09-16T12:30:00.000Z',
    workedMinutes: 500,
  }));
  assert.deepEqual(normal, []);
  const unresolved = classifyAttention(opsRow({
    presence: 'COMPLETED',
    liveState: 'COMPLETED',
    schedule: null,
    scheduleUnresolved: true,
    workedMinutes: 10,
  }));
  assert.deepEqual(unresolved, []);
});

test('31.12 recon conflicts: leave overlap blocks, plain review warns', () => {
  const conflict = classifyAttention(opsRow({ exceptions: ['ATTENDANCE_ON_LEAVE'] }));
  assert.equal(conflict[0].category, ATTENTION_CATEGORY.RECON_CONFLICT);
  assert.equal(conflict[0].severity, ATTENTION_SEVERITY.BLOCKER);
  const review = classifyAttention(opsRow({ needsReview: true }));
  assert.equal(review[0].category, ATTENTION_CATEGORY.RECON_CONFLICT);
  assert.equal(review[0].severity, ATTENTION_SEVERITY.WARNING);
});

test('31.12 pending regularization and OT surface as warnings', () => {
  const reg = classifyAttention(opsRow({ exceptions: ['REGULARIZATION_PENDING'] }));
  assert.equal(reg[0].category, ATTENTION_CATEGORY.REG_PENDING);
  assert.equal(reg[0].workflow, 'regularizations');
  const ot = classifyAttention(opsRow({ ot: { pending: true, approved: false, compOffApproved: false } }));
  assert.equal(ot[0].category, ATTENTION_CATEGORY.OT_PENDING);
  assert.equal(ot[0].workflow, 'overtime');
  // Approved OT / comp-off is not attention.
  assert.deepEqual(classifyAttention(opsRow({
    ot: { pending: false, approved: true, compOffApproved: true },
  })), []);
});

test('31.12 worked day-off is information, never a blocker', () => {
  const holiday = classifyAttention(opsRow({
    calendar: { primary: 'HOLIDAY', alsoWeeklyOff: false, holidayName: 'Fest', leaveLabel: null },
  }));
  assert.equal(holiday[0].category, ATTENTION_CATEGORY.WORKED_DAY_OFF);
  assert.equal(holiday[0].severity, ATTENTION_SEVERITY.INFO);
  const weeklyOff = classifyAttention(opsRow({
    presence: 'COMPLETED',
    liveState: 'COMPLETED',
    clockOutAt: '2026-09-16T12:30:00.000Z',
    workedMinutes: 500,
    calendar: { primary: 'WEEKLY_OFF', alsoWeeklyOff: false, holidayName: null, leaveLabel: null },
  }));
  assert.equal(weeklyOff[0].severity, ATTENTION_SEVERITY.INFO);
  // No session on the day off → no worked-day-off item.
  assert.deepEqual(classifyAttention(opsRow({
    presence: 'HOLIDAY',
    liveState: 'NOT_IN',
    clockInAt: null,
    calendar: { primary: 'HOLIDAY', alsoWeeklyOff: false, holidayName: 'Fest', leaveLabel: null },
  })), []);
});

test('31.12 one row can carry several overlapping issues', () => {
  const items = classifyAttention(opsRow({
    exceptions: ['LATE_ARRIVAL', 'REGULARIZATION_PENDING'],
    clockInAt: '2026-09-16T04:10:00.000Z',
    lateMinutes: 40,
    ot: { pending: true, approved: false, compOffApproved: false },
  }));
  assert.deepEqual(
    items.map((item) => item.category),
    [ATTENTION_CATEGORY.LATE_ARRIVAL, ATTENTION_CATEGORY.REG_PENDING, ATTENTION_CATEGORY.OT_PENDING],
  );
});

test('31.12 attention vocabulary is stable and validated', () => {
  assert.equal(Object.keys(ATTENTION_CATEGORY).length, 11);
  assert.equal(isValidAttentionCategory('LATE_ARRIVAL'), true);
  assert.equal(isValidAttentionCategory('PRODUCTIVITY_SCORE'), false);
  assert.equal(isValidAttentionCategory(''), false);
});

// ── Pure: summary ──────────────────────────────────────────────

test('31.12 summary buckets reconcile across dimensions', () => {
  const rows = [
    opsRow({ presence: 'WORKING', workMode: 'OFFICE', user: { id: 'a' } }),
    opsRow({ presence: 'ON_BREAK', workMode: 'WFH', user: { id: 'b' } }),
    opsRow({ presence: 'COMPLETED', liveState: 'COMPLETED', workedMinutes: 500, clockOutAt: '2026-09-16T12:30:00.000Z', user: { id: 'c' } }),
    opsRow({ presence: 'NOT_IN', liveState: 'NOT_IN', clockInAt: null, workMode: null, user: { id: 'd' } }),
    opsRow({ presence: 'LATE_NOT_IN', liveState: 'NOT_IN', clockInAt: null, workMode: null, user: { id: 'e' } }),
    opsRow({ presence: 'ON_LEAVE', liveState: 'NOT_IN', clockInAt: null, workMode: null, user: { id: 'f' } }),
    opsRow({ presence: 'HOLIDAY', liveState: 'NOT_IN', clockInAt: null, workMode: null, user: { id: 'g' } }),
    opsRow({ presence: 'WEEKLY_OFF', liveState: 'NOT_IN', clockInAt: null, workMode: null, user: { id: 'h' } }),
    opsRow({ presence: 'UNRESOLVED', liveState: 'NOT_IN', clockInAt: null, workMode: null, schedule: null, scheduleUnresolved: true, user: { id: 'i' } }),
    opsRow({ presence: 'WORKING', user: { id: 'j' } }),
  ];
  const employmentByUser = new Map([
    ['j', { dateOfJoining: '2026-09-20', lastWorkingDate: null }],
  ]);
  const { summary, modes, attention } = summarizeOperations(rows, { employmentByUser, businessDate: TODAY });
  assert.equal(summary.scope, 10);
  assert.equal(summary.applicable, 9);
  assert.equal(summary.nonApplicable, 1);
  assert.equal(summary.scope, summary.applicable + summary.nonApplicable);
  assert.equal(summary.expected, 6);
  assert.equal(summary.nonWorking, 3);
  assert.equal(summary.applicable, summary.expected + summary.nonWorking);
  assert.deepEqual(
    [summary.working, summary.onBreak, summary.completed, summary.notIn, summary.lateNotIn,
      summary.onLeave, summary.holiday, summary.weeklyOff, summary.unresolved],
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
  );
  // Modes count working rows only — never summed with headcount.
  assert.equal(modes.OFFICE, 1);
  assert.equal(modes.WFH, 1);
  assert.equal(modes.FIELD, 0);
  assert.equal(attention.people, 1);
  assert.equal(attention.items, 1);
  assert.equal(attention.warnings, 1);
});

// ── Pure: groupings ────────────────────────────────────────────

test('31.12 groupings split departments, shifts and check-in locations', () => {
  const rows = [
    opsRow({ user: { id: 'a', department: { id: D_ENG, name: 'Engineering' } }, locationName: 'Bengaluru HQ' }),
    opsRow({
      presence: 'LATE_NOT_IN', liveState: 'NOT_IN', clockInAt: null, workMode: null,
      late: { isLate: true, lateMinutes: 10 },
      schedule: { shiftName: 'Afternoon', scheduledStartAt: '2026-09-16T03:30:00.000Z', scheduledEndAt: '2026-09-16T12:30:00.000Z' },
      user: { id: 'b', department: { id: D_SALES, name: 'Sales' } },
    }),
    opsRow({
      presence: 'ON_LEAVE', liveState: 'NOT_IN', clockInAt: null, workMode: null, schedule: null, scheduleUnresolved: true,
      user: { id: 'c', department: null },
    }),
  ];
  const groups = groupOperations(rows, { businessDate: TODAY });
  assert.equal(groups.departments.length, 3);
  const eng = groups.departments.find((group) => group.name === 'Engineering');
  assert.equal(eng.expected, 1);
  assert.equal(eng.working, 1);
  assert.equal(groups.shifts.find((group) => group.name === 'Morning').expected, 1);
  assert.equal(groups.shifts.find((group) => group.name === 'Afternoon').lateNotIn, 1);
  assert.equal(groups.shifts.find((group) => group.name === 'Unassigned').onLeave, 1);
  assert.equal(groups.locations.length, 1);
  assert.equal(groups.locations[0].checkedIn, 1);
  assert.equal(groups.locations[0].working, 1);
});

// ── Pure: filters + pagination + serializer ────────────────────

test('31.12 derived-side filters match scope rows exactly', () => {
  const row = opsRow({ user: { id: U_REP, department: { id: D_ENG, name: 'Engineering' } } });
  const items = [{ category: ATTENTION_CATEGORY.LATE_ARRIVAL }];
  const employment = { reportingTo: U_MGR };
  assert.equal(matchesOpsFilters(row, items, {}, employment), true);
  assert.equal(matchesOpsFilters(row, items, { presence: ['WORKING'] }, employment), true);
  assert.equal(matchesOpsFilters(row, items, { presence: ['COMPLETED'] }, employment), false);
  assert.equal(matchesOpsFilters(row, items, { workMode: ['OFFICE'] }, employment), true);
  assert.equal(matchesOpsFilters(row, items, { workMode: ['WFH'] }, employment), false);
  assert.equal(matchesOpsFilters(row, items, { categories: ['LATE_ARRIVAL'] }, employment), true);
  assert.equal(matchesOpsFilters(row, items, { categories: ['OT_PENDING'] }, employment), false);
  assert.equal(matchesOpsFilters(row, items, { managerId: U_MGR }, employment), true);
  assert.equal(matchesOpsFilters(row, items, { managerId: U_HR }, employment), false);
  assert.equal(matchesOpsFilters(row, items, { shift: 'Morning' }, employment), true);
  assert.equal(matchesOpsFilters(row, items, { shift: 'Night' }, employment), false);
  assert.equal(matchesOpsFilters(row, items, { location: 'Bengaluru HQ' }, { reportingTo: U_MGR }), false);
  assert.equal(matchesOpsFilters(null, items, {}, employment), false);
});

test('31.12 pagination clamps page and size', () => {
  const items = [1, 2, 3];
  assert.deepEqual(paginate(items, 1, 500), { items: [1, 2, 3], page: 1, pageSize: 100, total: 3, totalPages: 1 });
  assert.deepEqual(paginate(items, 9, 2).page, 2);
  assert.deepEqual(paginate(items, 0, 0).pageSize, 25);
});

test('31.12 attention serializer carries safe identity + issue facts', () => {
  const item = serializeAttentionItem({
    row: opsRow({
      clockOutAt: null,
      user: { id: U_DONE, name: 'Dev Done', employeeCode: 'E0004', designation: 'Eng', department: { id: D_ENG, name: 'Engineering' } },
      locationName: 'Bengaluru HQ',
    }),
    item: { category: 'LATE_ARRIVAL', severity: 'WARNING', label: 'Late arrival', workflow: 'attendance', minutes: 40, since: '2026-09-16T04:10:00.000Z', scheduledStartAt: '2026-09-16T03:30:00.000Z' },
  });
  assert.equal(item.employee.name, 'Dev Done');
  assert.equal(item.minutes, 40);
  assert.equal(item.shiftName, 'Morning');
  assert.ok(!('reason' in item));
  assert.ok(!JSON.stringify(item).includes('PRIVATE'));
});

// ── Service: full dashboard ────────────────────────────────────

test('31.12 HR dashboard aggregates the whole company day', async () => {
  const { deps } = buildWorld();
  const dash = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query: {}, deps,
  });
  assert.equal(dash.date, TODAY);
  assert.equal(dash.timezone, TZ);
  assert.equal(dash.scope.type, 'COMPANY');
  assert.equal(dash.scope.total, 21);
  assert.deepEqual(dash.summary, {
    scope: 21,
    applicable: 19,
    nonApplicable: 2,
    expected: 16,
    nonWorking: 3,
    working: 10,
    onBreak: 1,
    completed: 3,
    notIn: 1,
    lateNotIn: 1,
    unresolved: 0,
    onLeave: 1,
    holiday: 1,
    weeklyOff: 1,
  });
  assert.equal(dash.summary.scope, dash.summary.applicable + dash.summary.nonApplicable);
  assert.equal(dash.summary.applicable, dash.summary.expected + dash.summary.nonWorking);
  assert.equal(dash.modes.OFFICE, 10);
  assert.equal(dash.modes.WFH, 1);
  assert.equal(dash.modes.FIELD, 0);
  assert.deepEqual(dash.attentionCounts, { people: 8, items: 8, blockers: 2, warnings: 6, info: 0 });
  assert.equal(dash.attention.total, 8);
  assert.equal(dash.attention.items[0].category, ATTENTION_CATEGORY.UNRESOLVED_SESSION);
  assert.equal(dash.attention.items[1].category, ATTENTION_CATEGORY.RECON_CONFLICT);
  assert.ok(dash.attention.items.every((item) => item.employee && item.workflow && item.label));
  const lateArrival = dash.attention.items.find((item) => item.category === 'LATE_ARRIVAL');
  assert.equal(lateArrival.minutes, 40);
  assert.equal(lateArrival.employee.name, 'Lal Late');
  const short = dash.attention.items.find((item) => item.category === 'SHORT_HOURS');
  assert.equal(short.minutes, 300);
  assert.ok(dash.refreshedAt);
});

test('31.12 groupings reconcile with the summary', async () => {
  const { deps } = buildWorld();
  const dash = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query: {}, deps,
  });
  const eng = dash.departments.find((group) => group.name === 'Engineering');
  const sales = dash.departments.find((group) => group.name === 'Sales');
  assert.equal(eng.expected, 14);
  assert.equal(sales.expected, 2);
  assert.equal(sales.working, 1);
  assert.equal(sales.lateNotIn, 1);
  assert.equal(
    dash.departments.reduce((sum, group) => sum + group.expected, 0),
    dash.summary.expected,
  );
  assert.equal(dash.shifts.find((group) => group.name === 'Morning').expected, 12);
  assert.equal(dash.shifts.find((group) => group.name === 'Afternoon').expected, 1);
  assert.equal(dash.shifts.find((group) => group.name === 'Unassigned').expected, 3);
  assert.equal(dash.locations.length, 1);
  assert.deepEqual(dash.locations[0], {
    name: 'Bengaluru HQ', checkedIn: 12, working: 9, lateArrivals: 1,
  });
});

test('31.12 pending workflow workload links out, never leaks reasons', async () => {
  const { deps } = buildWorld();
  const dash = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query: {}, deps,
  });
  assert.equal(dash.workflows.regularizations.total, 1);
  assert.equal(dash.workflows.regularizations.items[0].type, 'MISSED_CLOCK_OUT');
  assert.equal(dash.workflows.regularizations.items[0].employeeName, 'Reg Fix');
  assert.equal(dash.workflows.overtime.total, 1);
  assert.equal(dash.workflows.overtime.items[0].type, 'OVERTIME');
  assert.ok(!JSON.stringify(dash.workflows).includes('PRIVATE-REG-REASON'));
});

test('31.12 workflow lists cap at ten with exact totals', async () => {
  const extras = Array.from({ length: 12 }, (_, index) => ({
    _id: `rx${index}`,
    companyId: COMPANY_A,
    user: U_REG,
    attendanceDate: TODAY,
    type: 'BREAK_CORRECTION',
    status: 'PENDING',
    createdAt: dt(`2026-09-16T0${index % 9}:00:00`),
  }));
  const { deps } = buildWorld({ extra: { regs: extras } });
  const dash = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query: {}, deps,
  });
  assert.equal(dash.workflows.regularizations.total, 13);
  assert.equal(dash.workflows.regularizations.items.length, 10);
});

// ── Service: scope & tenancy ───────────────────────────────────

test('31.12 manager actor stays inside the org subtree', async () => {
  const { deps } = buildWorld({ subtree: [U_REP] });
  const dash = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_MGR, 'MANAGER'), query: {}, deps,
  });
  assert.equal(dash.scope.type, 'TEAM');
  assert.equal(dash.scope.total, 2);
  assert.equal(dash.summary.scope, 2);
  assert.ok(!JSON.stringify(dash).includes('Oscar Outside'));
  assert.ok(!JSON.stringify(dash).includes('Bee Other'));
});

test('31.12 manager filter cannot expand scope', async () => {
  const { deps } = buildWorld({ subtree: [U_REP] });
  const scoped = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_MGR, 'MANAGER'), query: { managerId: U_MGR }, deps,
  });
  assert.equal(scoped.summary.scope, 1);
  const { deps: deps2 } = buildWorld({ subtree: [U_REP] });
  const none = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_MGR, 'MANAGER'), query: { managerId: U_OUTSIDE }, deps: deps2,
  });
  assert.equal(none.summary.scope, 0);
  assert.equal(none.attention.total, 0);
});

test('31.12 tenant B is invisible on every surface', async () => {
  const { deps } = buildWorld();
  const dash = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query: {}, deps,
  });
  const blob = JSON.stringify(dash);
  assert.ok(!blob.includes('Bee Other'));
  assert.ok(!blob.includes('999'));
  assert.ok(!blob.includes('B-REASON'));
  assert.ok(!blob.includes('Bee Dept'));
});

test('31.12 cross-tenant filter ids match nothing and leak nothing', async () => {
  const byDept = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'),
    query: { departmentId: D_B }, deps: buildWorld().deps,
  });
  assert.equal(byDept.summary.scope, 0);
  assert.deepEqual(byDept.departments, []);
  const bySearch = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'),
    query: { search: 'Bee' }, deps: buildWorld().deps,
  });
  assert.equal(bySearch.summary.scope, 0);
  assert.equal(bySearch.attention.total, 0);
});

// ── Service: filters ───────────────────────────────────────────

test('31.12 every filter narrows KPIs, groups and queue together', async () => {
  const run = (query) => getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query, deps: buildWorld().deps,
  });
  const dept = await run({ departmentId: D_SALES });
  assert.equal(dept.summary.scope, 2);
  assert.equal(dept.departments.length, 1);
  const presence = await run({ presence: 'COMPLETED' });
  assert.equal(presence.summary.scope, 3);
  assert.equal(presence.summary.completed, 3);
  const mode = await run({ workMode: 'WFH' });
  assert.equal(mode.summary.scope, 1);
  assert.equal(mode.modes.WFH, 1);
  const category = await run({ category: 'OT_PENDING' });
  assert.equal(category.attention.total, 1);
  assert.equal(category.summary.scope, 1);
  const shift = await run({ shift: 'Afternoon' });
  assert.equal(shift.summary.scope, 1);
  assert.equal(shift.summary.notIn, 1);
  const location = await run({ location: 'Bengaluru HQ' });
  assert.equal(location.summary.scope, 12);
  const search = await run({ search: 'lal late' });
  assert.equal(search.summary.scope, 1);
  assert.equal(search.attention.total, 1);
});

test('31.12 invalid filters fail loudly, pagination clamps', async () => {
  const run = (query) => getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query, deps: buildWorld().deps,
  });
  await assert.rejects(run({ presence: 'HACKED' }), /Invalid presence/);
  await assert.rejects(run({ workMode: 'REMOTE' }), /Invalid work-mode/);
  await assert.rejects(run({ category: 'PRODUCTIVITY_SCORE' }), /Invalid attention/);
  await assert.rejects(run({ departmentId: 'nope' }), /Invalid department/);
  await assert.rejects(run({ managerId: 'nope' }), /Invalid manager/);
  await assert.rejects(run({ date: '16-09-2026' }), /YYYY-MM-DD/);
  await assert.rejects(run({ date: '2026-01-01' }), /today or yesterday/);
  await assert.rejects(
    getOperationsDashboard({ companyId: null, actor: actor(U_HR, 'HR_MANAGER'), query: {}, deps: buildWorld().deps }),
    /Company context/,
  );
  const clamped = await run({ pageSize: 500 });
  assert.equal(clamped.attention.pageSize, 100);
  const jan = await run({ date: TODAY });
  assert.equal(jan.date, TODAY);
});

// ── Service: time ──────────────────────────────────────────────

test('31.12 yesterday review reuses derivation at end of day', async () => {
  const { deps } = buildWorld();
  const dash = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query: { date: YESTERDAY }, deps,
  });
  assert.equal(dash.date, YESTERDAY);
  assert.equal(dash.summary.scope, 21);
  const late = dash.attention.items.find((item) => item.employee.name === 'Nia Notin');
  assert.equal(late.category, ATTENTION_CATEGORY.LATE_NOT_IN);
  assert.ok(late.minutes > 60);
});

// ── Service: privacy + performance ─────────────────────────────

test('31.12 response carries no GPS, money or private text', async () => {
  const { deps } = buildWorld();
  const dash = await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query: {}, deps,
  });
  const blob = JSON.stringify(dash).toLowerCase();
  for (const token of [
    'latitude', 'longitude', 'distancemeters', 'accuracy', 'salary',
    'bank', '"pan"', '"uan"', 'private-reg-reason', 'attachments', 'password',
  ]) {
    assert.ok(!blob.includes(token), `leaked token: ${token}`);
  }
});

test('31.12 query budget stays bounded with zero N+1', async () => {
  const calls = [];
  const { deps } = buildWorld({ counter: (model, op) => calls.push(`${model}:${op}`) });
  await getOperationsDashboard({
    companyId: COMPANY_A, actor: actor(U_HR, 'HR_MANAGER'), query: {}, deps,
  });
  assert.ok(calls.length <= 20, `too many queries: ${calls.length}`);
  const byModel = {};
  for (const call of calls) {
    if (!call.endsWith(':find')) continue;
    const model = call.split(':')[0];
    byModel[model] = (byModel[model] || 0) + 1;
  }
  for (const [model, count] of Object.entries(byModel)) {
    assert.ok(count <= 3, `${model} queried ${count}x (N+1 smell)`);
  }
});

// ── Source hygiene ─────────────────────────────────────────────

test('31.12 source hygiene: reuse 31.9, no audit/GPS/money/queues', () => {
  const service = readSource('src/services/attendance/attendanceOperationsService.js');
  const rules = readSource('src/services/attendance/attendanceOperationsRules.js');
  const controller = readSource('src/controllers/attendance/attendanceOperationsController.js');
  assert.match(service, /getTeamPresence\(/);
  assert.ok(!service.includes('derivePresence'));
  for (const token of [
    'AuditLog', 'audit(', 'latitude', 'longitude', 'distance', 'salary',
    'bank', 'netPay', 'BullMQ', 'Queue(', 'startSession', 'productivity',
    'score', 'reason', 'setInterval', 'setTimeout',
  ]) {
    assert.ok(!service.includes(token), `service leaks: ${token}`);
    assert.ok(!rules.includes(token), `rules leak: ${token}`);
  }
  assert.ok(!rules.includes('mongoose') && !rules.includes('req.') && !rules.includes('redis'));
  assert.match(controller, /getOperationsDashboard\(/);
});

test('31.12 route + permission gate HR-only operations', () => {
  const routes = readSource('src/routes/attendance/attendanceRoutes.js');
  assert.match(routes, /'\/operations'/);
  assert.match(routes, /ATTENDANCE_OPERATIONS_READ/);
  const registry = readSource('src/utils/permissionRegistry.js');
  assert.match(registry, /ATTENDANCE_OPERATIONS", \["READ"\]/);
  assert.match(registry, /"ATTENDANCE_OPERATIONS_READ",/);
  const managerBlock = registry.slice(
    registry.indexOf('\n  MANAGER: permissions('),
    registry.indexOf('\n  TEAM_LEAD: permissions('),
  );
  assert.ok(!managerBlock.includes('ATTENDANCE_OPERATIONS'));
  const permService = readSource('src/utils/permissionService.js');
  assert.match(permService, /SYSTEM_PERMISSION_VERSION = 36/);
});


