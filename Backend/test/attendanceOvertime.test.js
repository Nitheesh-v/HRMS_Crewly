// ─────────────────────────────────────────────────────────────
// Phase 31.8 — overtime / comp-off hermetic tests.
//
// No Mongo, no Redis, no network: injectable fakes stand in for
// the models, the schedule resolver, and the holiday/working-days
// engine. The REAL 31.1 threshold gate, 31.7 resolveDay, and 31.8
// rules/service run underneath.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveOTEligibleMinutes } from '../src/services/attendance/attendancePolicyRules.js';
import {
  DAY_TYPE,
  OT_BENEFIT,
  OVERTIME_STATUS,
  OVERTIME_TYPE,
  blockingConflicts,
  compOffDaysFor,
  compOffMinutesPerDay,
  deriveEligibleMinutes,
  isValidDayString,
  monthOf,
  recordedExtraMinutes,
  resolveBenefit,
  transitionError,
  validateApprovedMinutes,
  validateDayRange,
  validateRequestedMinutes,
} from '../src/services/attendance/attendanceOvertimeRules.js';
import {
  approveOvertimeRequest,
  cancelOvertimeRequest,
  computeDayEligibility,
  earnedCompOffDays,
  getOvertimeRequest,
  listMyEligibility,
  listPendingOvertimeRequests,
  rejectOvertimeRequest,
  republishApprovedOtMinutes,
  submitOvertimeRequest,
} from '../src/services/attendance/attendanceOvertimeService.js';
import * as OvertimeRequestReal from '../src/models/AttendanceOvertimeRequest.js';

const COMPANY_A = 'companyA';
const COMPANY_B = 'companyB';
const EMP = 'emp1';
const MGR = 'mgr1';
const OUTSIDER = 'outsider1';

// Monday 2026-09-14 / Tuesday 2026-09-15 / Sunday 2026-09-13.
const MON = '2026-09-14';
const TUE = '2026-09-15';
const SUN = '2026-09-13';

// ── Fake query surface (Mongoose-like chaining) ─────────────

const q = (result) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  sort() {
    return this;
  },
  lean: async () => result,
});

const matches = (row, filter = {}) =>
  Object.entries(filter || {}).every(([key, value]) => {
    if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      if (value.$in) return value.$in.map(String).includes(String(row[key]));
      if (value.$lte !== undefined) return row[key] <= value.$lte;
      if (value.$gte !== undefined) return row[key] >= value.$gte;
      return true;
    }
    if (key === '_id' || key === 'id') return String(row._id || row.id) === String(value);
    return String(row[key]) === String(value);
  });

const makeFakeAttendanceModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  return {
    rows,
    findOne: (filter) => q(rows.find((row) => matches(row, filter)) || null),
    findOneAndUpdate: (filter, update, options = {}) => {
      const row = rows.find((r) => matches(r, filter));
      if (!row) return q(null);
      Object.assign(row, update.$set || {});
      return q(options.new ? { ...row } : { ...row });
    },
  };
};

// Enforces the partial unique index: one PENDING/APPROVED row per
// company + user + day (concurrent losers get 11000).
const makeFakeRequestModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  let seq = 100;
  const live = (row) => row.status === 'PENDING' || row.status === 'APPROVED';
  return {
    rows,
    findOne: (filter) => q(rows.find((row) => matches(row, filter)) || null),
    find: (filter) => q(rows.filter((row) => matches(row, filter))),
    create: async (doc) => {
      const clash = rows.find(
        (row) =>
          live(row) &&
          String(row.companyId) === String(doc.companyId) &&
          String(row.user) === String(doc.user) &&
          String(row.attendanceDate) === String(doc.attendanceDate),
      );
      if (clash) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      const row = { ...doc, _id: `ot${seq}`, id: `ot${seq}`, createdAt: new Date() };
      seq += 1;
      rows.push(row);
      return row;
    },
    findOneAndUpdate: (filter, update, options = {}) => {
      const row = rows.find((r) => matches(r, filter));
      if (!row) return q(null);
      Object.assign(row, update.$set || {});
      return q({ ...row });
    },
  };
};

const makeFakeLeaveModel = (rows = []) => ({
  rows,
  created: [],
  find: () => q(rows),
  create: async (doc) => {
    rows.created.push(doc);
    return doc;
  },
});

const makeFakePeriodModel = (period = null) => ({
  findOne: () => q(period ? { ...period } : null),
});

const makeFakeUserModel = () => ({
  find: () => q([]),
});

const baseOvertime = (overrides = {}) => ({
  trackingEnabled: true,
  minimumExtraMinutes: 30,
  approvalRequired: true,
  weekendEligible: true,
  holidayEligible: true,
  normalDayBenefit: 'OVERTIME',
  weeklyOffBenefit: 'OVERTIME',
  holidayBenefit: 'OVERTIME',
  compOffMinutesPerDay: 480,
  ...overrides,
});

const basePolicy = (overtime = {}) => ({
  _id: 'pol1',
  version: 3,
  timezone: 'Asia/Kolkata',
  overtime: baseOvertime(overtime),
});

const baseControl = (overrides = {}) => ({
  _id: 'att1',
  id: 'att1',
  companyId: COMPANY_A,
  user: EMP,
  date: MON,
  punchIn: new Date('2026-09-14T09:00:00+05:30'),
  punchOut: new Date('2026-09-14T18:00:00+05:30'),
  workMinutes: 480,
  breakMinutes: 0,
  lateMinutes: 0,
  earlyMinutes: 0,
  overtimeMinutes: 0,
  status: 'PRESENT',
  policyExceptions: [],
  regularization: null,
  scheduleSnapshot: {
    scheduledStartAt: new Date('2026-09-14T09:00:00+05:30'),
    scheduledEndAt: new Date('2026-09-14T18:00:00+05:30'),
    scheduledMinutes: 480,
    shiftName: 'General',
    scheduleName: '5-day week',
  },
  ...overrides,
});

const weekdayEngine = (overrides = {}) => ({
  getWorkingDaysForUser: async () => ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  holidayOnDate: async () => null,
  ...overrides,
});

const makeCtx = ({
  controls = [baseControl()],
  requests = [],
  leaves = [],
  period = null,
  policy = basePolicy(),
  engine = null,
  resolveSchedule = async () => ({ status: 'UNRESOLVED' }),
  scopeIds = [EMP, MGR],
} = {}) => {
  const notifications = [];
  const audits = [];
  return {
    notifications,
    audits,
    AttendanceModel: makeFakeAttendanceModel(controls),
    RequestModel: makeFakeRequestModel(requests),
    LeaveModel: makeFakeLeaveModel(leaves),
    PayrollPeriodModel: makeFakePeriodModel(period),
    UserModel: makeFakeUserModel(),
    policy,
    engine: engine || weekdayEngine(),
    resolveSchedule,
    resolveScopeIds: async () => [...scopeIds],
    notify: async (userId, payload) => {
      notifications.push({ userId: String(userId), payload });
    },
    audit: async (entry) => {
      audits.push(entry);
    },
  };
};

const depsOf = (ctx) => ({
  AttendanceModel: ctx.AttendanceModel,
  RequestModel: ctx.RequestModel,
  LeaveModel: ctx.LeaveModel,
  PayrollPeriodModel: ctx.PayrollPeriodModel,
  UserModel: ctx.UserModel,
  policy: ctx.policy,
  engine: ctx.engine,
  resolveSchedule: ctx.resolveSchedule,
  resolveScopeIds: ctx.resolveScopeIds,
  notify: ctx.notify,
  audit: ctx.audit,
});

const requester = (overrides = {}) => ({ _id: EMP, name: 'Asha', reportingTo: MGR, ...overrides });
const manager = (overrides = {}) => ({ _id: MGR, name: 'Ravi', ...overrides });

// ── PURE RULES ─────────────────────────────────────────────

test('rules: 31.1 threshold semantics are a minimum gate (75 extra / 30 min => 75 eligible)', () => {
  const overtime = baseOvertime();
  assert.equal(
    deriveOTEligibleMinutes({ extraMinutes: 75, overtime, dayType: DAY_TYPE.WORK_DAY }).eligibleMinutes,
    75,
  );
  assert.equal(
    deriveEligibleMinutes({ recordedExtra: 75, calendarPrimary: DAY_TYPE.WORK_DAY, overtime }).eligibleMinutes,
    75,
  );
});

test('rules: threshold boundaries — below zeroed, exact passes whole', () => {
  const overtime = baseOvertime();
  assert.equal(
    deriveEligibleMinutes({ recordedExtra: 29, calendarPrimary: DAY_TYPE.WORK_DAY, overtime }).eligibleMinutes,
    0,
  );
  assert.equal(
    deriveEligibleMinutes({ recordedExtra: 30, calendarPrimary: DAY_TYPE.WORK_DAY, overtime }).eligibleMinutes,
    30,
  );
  assert.equal(
    deriveEligibleMinutes({ recordedExtra: 0, calendarPrimary: DAY_TYPE.WORK_DAY, overtime }).eligibleMinutes,
    0,
  );
});

test('rules: tracking disabled zeroes every calendar context', () => {
  const overtime = baseOvertime({ trackingEnabled: false });
  for (const primary of [DAY_TYPE.WORK_DAY, DAY_TYPE.WEEKLY_OFF, DAY_TYPE.HOLIDAY]) {
    assert.equal(deriveEligibleMinutes({ recordedExtra: 300, calendarPrimary: primary, overtime }).eligibleMinutes, 0);
    assert.equal(resolveBenefit({ calendarPrimary: primary, overtime }), OT_BENEFIT.NONE);
  }
});

test('rules: weekly-off/holiday enable flags still gate eligibility', () => {
  assert.equal(
    deriveEligibleMinutes({
      recordedExtra: 300,
      calendarPrimary: DAY_TYPE.WEEKLY_OFF,
      overtime: baseOvertime({ weekendEligible: false }),
    }).eligibleMinutes,
    0,
  );
  assert.equal(
    deriveEligibleMinutes({
      recordedExtra: 300,
      calendarPrimary: DAY_TYPE.HOLIDAY,
      overtime: baseOvertime({ holidayEligible: false }),
    }).eligibleMinutes,
    300 - 300 + 0,
  );
  assert.equal(
    deriveEligibleMinutes({
      recordedExtra: 300,
      calendarPrimary: DAY_TYPE.HOLIDAY,
      overtime: baseOvertime(),
    }).eligibleMinutes,
    300,
  );
});

test('rules: recorded extra is worked-relative on work days, whole-day on off days', () => {
  assert.deepEqual(
    recordedExtraMinutes({ calendarPrimary: DAY_TYPE.WORK_DAY, workedMinutes: 555, scheduledMinutes: 480 }),
    { extraMinutes: 75, scheduleResolved: true },
  );
  assert.deepEqual(
    recordedExtraMinutes({ calendarPrimary: DAY_TYPE.WORK_DAY, workedMinutes: 400, scheduledMinutes: 480 }),
    { extraMinutes: 0, scheduleResolved: true },
  );
  assert.deepEqual(
    recordedExtraMinutes({ calendarPrimary: DAY_TYPE.WEEKLY_OFF, workedMinutes: 360, scheduledMinutes: null }),
    { extraMinutes: 360, scheduleResolved: true },
  );
  assert.deepEqual(
    recordedExtraMinutes({ calendarPrimary: DAY_TYPE.HOLIDAY, workedMinutes: 120, scheduledMinutes: null }),
    { extraMinutes: 120, scheduleResolved: true },
  );
});

test('rules: work day without a resolved schedule never guesses', () => {
  assert.deepEqual(
    recordedExtraMinutes({ calendarPrimary: DAY_TYPE.WORK_DAY, workedMinutes: 900, scheduledMinutes: null }),
    { extraMinutes: 0, scheduleResolved: false },
  );
  assert.deepEqual(
    recordedExtraMinutes({ calendarPrimary: 'BOGUS', workedMinutes: 900, scheduledMinutes: 480 }),
    { extraMinutes: 0, scheduleResolved: false },
  );
});

test('rules: benefit resolution across contexts', () => {
  const overtime = baseOvertime({ weeklyOffBenefit: 'COMP_OFF', holidayBenefit: 'NONE' });
  assert.equal(resolveBenefit({ calendarPrimary: DAY_TYPE.WORK_DAY, overtime }), 'OVERTIME');
  assert.equal(resolveBenefit({ calendarPrimary: DAY_TYPE.WEEKLY_OFF, overtime }), 'COMP_OFF');
  assert.equal(resolveBenefit({ calendarPrimary: DAY_TYPE.HOLIDAY, overtime }), 'NONE');
  assert.equal(
    resolveBenefit({ calendarPrimary: DAY_TYPE.WORK_DAY, overtime: baseOvertime({ normalDayBenefit: 'NONE' }) }),
    'NONE',
  );
  assert.equal(resolveBenefit({ calendarPrimary: 'BOGUS', overtime }), 'NONE');
});

test('rules: old policy documents default safely (31.1 meaning preserved)', () => {
  const legacy = { trackingEnabled: true, minimumExtraMinutes: 30, weekendEligible: true, holidayEligible: false };
  assert.equal(resolveBenefit({ calendarPrimary: DAY_TYPE.WORK_DAY, overtime: legacy }), 'OVERTIME');
  assert.equal(resolveBenefit({ calendarPrimary: DAY_TYPE.WEEKLY_OFF, overtime: legacy }), 'OVERTIME');
  assert.equal(resolveBenefit({ calendarPrimary: DAY_TYPE.HOLIDAY, overtime: legacy }), 'NONE');
  assert.equal(compOffMinutesPerDay(legacy), 480);
  assert.equal(compOffMinutesPerDay({ compOffMinutesPerDay: 0 }), 480);
  assert.equal(compOffMinutesPerDay({ compOffMinutesPerDay: 9999 }), 480);
  assert.equal(compOffMinutesPerDay({ compOffMinutesPerDay: 240 }), 240);
});

test('rules: comp-off conversion is whole days (floor)', () => {
  const overtime = baseOvertime();
  assert.equal(compOffDaysFor({ approvedMinutes: 500, overtime }), 1);
  assert.equal(compOffDaysFor({ approvedMinutes: 960, overtime }), 2);
  assert.equal(compOffDaysFor({ approvedMinutes: 479, overtime }), 0);
  assert.equal(compOffDaysFor({ approvedMinutes: 500, overtime: baseOvertime({ compOffMinutesPerDay: 240 }) }), 2);
});

test('rules: both conflict codes block, unknown codes fail closed', () => {
  assert.deepEqual(blockingConflicts(['ATTENDANCE_ON_APPROVED_LEAVE']), ['ATTENDANCE_ON_APPROVED_LEAVE']);
  assert.deepEqual(blockingConflicts(['LEAVE_HALF_MISMATCH']), ['LEAVE_HALF_MISMATCH']);
  assert.deepEqual(blockingConflicts(['SOME_FUTURE_CODE']), ['SOME_FUTURE_CODE']);
  assert.deepEqual(blockingConflicts([]), []);
  assert.deepEqual(blockingConflicts(null), []);
});

test('rules: state machine — only PENDING decides', () => {
  assert.equal(transitionError('PENDING', 'APPROVE'), null);
  assert.equal(transitionError('PENDING', 'REJECT'), null);
  assert.equal(transitionError('PENDING', 'CANCEL'), null);
  assert.match(transitionError('APPROVED', 'APPROVE'), /already approved/);
  assert.match(transitionError('REJECTED', 'REJECT'), /already rejected/);
  assert.match(transitionError('CANCELLED', 'CANCEL'), /already cancelled/);
  assert.match(transitionError('PENDING', 'DELETE'), /Unknown decision/);
});

test('rules: requested minutes validated against eligible', () => {
  const overtime = baseOvertime();
  assert.equal(validateRequestedMinutes({ requestedMinutes: 90, eligibleMinutes: 90, type: 'OVERTIME', overtime }), null);
  assert.equal(validateRequestedMinutes({ requestedMinutes: 60, eligibleMinutes: 90, type: 'OVERTIME', overtime }), null);
  assert.match(
    validateRequestedMinutes({ requestedMinutes: 600, eligibleMinutes: 90, type: 'OVERTIME', overtime }),
    /at most 90/,
  );
  assert.match(
    validateRequestedMinutes({ requestedMinutes: 0, eligibleMinutes: 90, type: 'OVERTIME', overtime }),
    /at least 1/,
  );
  assert.match(
    validateRequestedMinutes({ requestedMinutes: -5, eligibleMinutes: 90, type: 'OVERTIME', overtime }),
    /at least 1/,
  );
  assert.match(
    validateRequestedMinutes({ requestedMinutes: 300, eligibleMinutes: 500, type: 'COMP_OFF', overtime }),
    /at least 480/,
  );
  assert.equal(
    validateRequestedMinutes({ requestedMinutes: 500, eligibleMinutes: 500, type: 'COMP_OFF', overtime }),
    null,
  );
});

test('rules: approved minutes — partial ok, above requested/eligible refused', () => {
  const overtime = baseOvertime();
  assert.equal(
    validateApprovedMinutes({ approvedMinutes: 60, requestedMinutes: 90, eligibleMinutes: 90, type: 'OVERTIME', overtime }),
    null,
  );
  assert.match(
    validateApprovedMinutes({ approvedMinutes: 120, requestedMinutes: 90, eligibleMinutes: 90, type: 'OVERTIME', overtime }),
    /at most the requested 90/,
  );
  assert.match(
    validateApprovedMinutes({ approvedMinutes: 80, requestedMinutes: 90, eligibleMinutes: 60, type: 'OVERTIME', overtime }),
    /resubmission/,
  );
  assert.match(
    validateApprovedMinutes({ approvedMinutes: 400, requestedMinutes: 500, eligibleMinutes: 500, type: 'COMP_OFF', overtime }),
    /at least 480/,
  );
});

test('rules: day range + month helpers', () => {
  assert.deepEqual(validateDayRange({ from: MON, to: TUE }), { from: MON, to: TUE });
  assert.match(validateDayRange({ from: TUE, to: MON }).error, /cannot be after/);
  assert.match(validateDayRange({ from: MON, to: '2026-12-31' }).error, /cannot exceed 93/);
  assert.match(validateDayRange({ from: 'nope', to: TUE }).error, /YYYY-MM-DD/);
  assert.equal(monthOf(MON), '2026-09');
  assert.equal(monthOf('nope'), null);
  assert.equal(isValidDayString(MON), true);
  assert.equal(isValidDayString('2026-13-99'), false);
});

// ── ELIGIBILITY ────────────────────────────────────────────

test('eligibility: normal day — no extra time, no candidate', async () => {
  const ctx = makeCtx();
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: MON, ...depsOf(ctx) });
  assert.equal(day.requestable, false);
  assert.equal(day.type, null);
  assert.equal(day.blockers[0].code, 'BELOW_THRESHOLD');
  assert.equal(day.calendarPrimary, 'WORK_DAY');
  assert.equal(day.eligibleMinutes, 0);
});

test('eligibility: normal day — below threshold vs exact vs above', async () => {
  const run = async (workMinutes) => {
    const ctx = makeCtx({ controls: [baseControl({ workMinutes })] });
    return computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: MON, ...depsOf(ctx) });
  };
  const below = await run(500);
  assert.equal(below.requestable, false);
  assert.equal(below.blockers[0].code, 'BELOW_THRESHOLD');
  const exact = await run(510);
  assert.equal(exact.requestable, true);
  assert.equal(exact.type, 'OVERTIME');
  assert.equal(exact.recordedMinutes, 30);
  assert.equal(exact.eligibleMinutes, 30);
  const above = await run(555);
  assert.equal(above.requestable, true);
  assert.equal(above.recordedMinutes, 75);
  assert.equal(above.eligibleMinutes, 75);
});

test('eligibility: excluded break time never inflates OT (worked-time, not span)', async () => {
  // Span is 09:00–19:15 (615m); 60m excluded breaks => 555m worked.
  // Span math would claim 135m extra; worked math claims 75m.
  const ctx = makeCtx({
    controls: [
      baseControl({
        punchOut: new Date('2026-09-14T19:15:00+05:30'),
        workMinutes: 555,
        breakMinutes: 60,
      }),
    ],
  });
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: MON, ...depsOf(ctx) });
  assert.equal(day.requestable, true);
  assert.equal(day.eligibleMinutes, 75);
});

test('eligibility: approved correction (post-rebuild facts) changes eligibility', async () => {
  const corrected = baseControl({
    workMinutes: 600,
    regularization: {
      correctedIn: new Date('2026-09-14T09:00:00+05:30'),
      correctedOut: new Date('2026-09-14T20:00:00+05:30'),
    },
  });
  const ctx = makeCtx({ controls: [corrected] });
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: MON, ...depsOf(ctx) });
  assert.equal(day.requestable, true);
  assert.equal(day.eligibleMinutes, 120);
  assert.equal(new Date(day.effectiveOut).toISOString(), '2026-09-14T14:30:00.000Z');
});

test('eligibility: pending correction (rebuild not run) does not alter eligibility', async () => {
  // The persisted workMinutes still say 480: only an APPROVED
  // correction's rebuild can move eligibility. The service never
  // reads regularization rows (pinned by the static guard below).
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 480 })] });
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: MON, ...depsOf(ctx) });
  assert.equal(day.requestable, false);
  assert.equal(day.blockers[0].code, 'BELOW_THRESHOLD');
});

test('eligibility: weekly off without work has no candidate', async () => {
  const ctx = makeCtx({ controls: [] });
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: SUN, ...depsOf(ctx) });
  assert.equal(day.requestable, false);
  assert.equal(day.blockers[0].code, 'NO_CONTROL');
});

test('eligibility: worked weekly off under OT policy', async () => {
  const ctx = makeCtx({ controls: [baseControl({ date: SUN, workMinutes: 360 })] });
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: SUN, ...depsOf(ctx) });
  assert.equal(day.calendarPrimary, 'WEEKLY_OFF');
  assert.equal(day.requestable, true);
  assert.equal(day.type, 'OVERTIME');
  assert.equal(day.recordedMinutes, 360);
  assert.equal(day.eligibleMinutes, 360);
});

test('eligibility: weekly-off benefit NONE / COMP_OFF', async () => {
  const run = async (weeklyOffBenefit, workMinutes = 500) => {
    const ctx = makeCtx({
      controls: [baseControl({ date: SUN, workMinutes })],
      policy: basePolicy({ weeklyOffBenefit }),
    });
    return computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: SUN, ...depsOf(ctx) });
  };
  const none = await run('NONE');
  assert.equal(none.requestable, false);
  assert.equal(none.blockers[0].code, 'BENEFIT_NONE');
  const comp = await run('COMP_OFF');
  assert.equal(comp.requestable, true);
  assert.equal(comp.type, 'COMP_OFF');
  assert.equal(comp.compOffDaysAtEligible, 1);
  const short = await run('COMP_OFF', 360);
  assert.equal(short.requestable, false);
  assert.equal(short.blockers[0].code, 'COMP_OFF_BELOW_ONE_DAY');
});

test('eligibility: holiday without work vs worked holiday (OT + comp-off)', async () => {
  const holidayEngine = weekdayEngine({ holidayOnDate: async () => ({ name: 'Test Holiday', type: 'NATIONAL' }) });
  const idle = makeCtx({ controls: [], engine: holidayEngine });
  const noWork = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: TUE, ...depsOf(idle) });
  assert.equal(noWork.requestable, false);

  const otCtx = makeCtx({ controls: [baseControl({ date: TUE, workMinutes: 300 })], engine: holidayEngine });
  const ot = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: TUE, ...depsOf(otCtx) });
  assert.equal(ot.calendarPrimary, 'HOLIDAY');
  assert.equal(ot.type, 'OVERTIME');
  assert.equal(ot.eligibleMinutes, 300);

  const compCtx = makeCtx({
    controls: [baseControl({ date: TUE, workMinutes: 500 })],
    engine: holidayEngine,
    policy: basePolicy({ holidayBenefit: 'COMP_OFF' }),
  });
  const comp = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: TUE, ...depsOf(compCtx) });
  assert.equal(comp.type, 'COMP_OFF');
  assert.equal(comp.compOffDaysAtEligible, 1);
});

test('eligibility: tracking disabled refuses everything', async () => {
  const ctx = makeCtx({
    controls: [baseControl({ workMinutes: 900 })],
    policy: basePolicy({ trackingEnabled: false }),
  });
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: MON, ...depsOf(ctx) });
  assert.equal(day.requestable, false);
  assert.equal(day.blockers[0].code, 'TRACKING_DISABLED');
});

test('eligibility: unresolved day (missing punch) blocks', async () => {
  const ctx = makeCtx({
    controls: [baseControl({ punchOut: null, workMinutes: 200, status: 'PRESENT' })],
  });
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: MON, ...depsOf(ctx) });
  assert.equal(day.requestable, false);
  assert.equal(day.blockers[0].code, 'UNRESOLVED_DAY');
});

test('eligibility: attendance on approved leave blocks', async () => {
  const ctx = makeCtx({
    controls: [baseControl({ date: TUE, workMinutes: 600 })],
    leaves: [{ _id: 'leave1', type: 'CASUAL', status: 'APPROVED', startDate: TUE, endDate: TUE }],
  });
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: TUE, ...depsOf(ctx) });
  assert.equal(day.requestable, false);
  assert.equal(day.blockers[0].code, 'CONFLICT');
  assert.ok(day.conflicts.includes('ATTENDANCE_ON_APPROVED_LEAVE'));
});

test('eligibility: unresolved schedule blocks normal days, never off days', async () => {
  const noSnapshot = baseControl();
  delete noSnapshot.scheduleSnapshot;
  const ctx = makeCtx({ controls: [noSnapshot] });
  const day = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: MON, ...depsOf(ctx) });
  assert.equal(day.requestable, false);
  assert.equal(day.blockers[0].code, 'SCHEDULE_UNRESOLVED');

  const offCtx = makeCtx({ controls: [baseControl({ date: SUN, workMinutes: 360, scheduleSnapshot: null })] });
  const off = await computeDayEligibility({ companyId: COMPANY_A, user: requester(), attendanceDate: SUN, ...depsOf(offCtx) });
  assert.equal(off.requestable, true);
});

test('eligibility: range listing mixes states and stays read-only', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const before = JSON.stringify(ctx.AttendanceModel.rows);
  const result = await listMyEligibility({ companyId: COMPANY_A, user: requester(), from: SUN, to: TUE, ...depsOf(ctx) });
  assert.equal(result.days.length, 3);
  assert.deepEqual(result.days.map((day) => day.requestable), [false, true, false]);
  assert.equal(JSON.stringify(ctx.AttendanceModel.rows), before);
  assert.equal(ctx.RequestModel.rows.length, 0);
  await assert.rejects(
    listMyEligibility({ companyId: COMPANY_A, user: requester(), from: TUE, to: MON, ...depsOf(ctx) }),
    /cannot be after/,
  );
});

// ── SUBMIT ─────────────────────────────────────────────────

const submitHappy = async (ctx, overrides = {}) =>
  submitOvertimeRequest({
    companyId: COMPANY_A,
    requester: requester(),
    type: 'OVERTIME',
    attendanceDate: MON,
    requestedMinutes: 75,
    reason: 'Month-end deployment support',
    ...depsOf(ctx),
    ...overrides,
  });

test('submit: happy path snapshots backend-computed facts', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  assert.equal(created.status, 'PENDING');
  assert.equal(created.requestedMinutes, 75);
  assert.equal(created.eligibleMinutes, 75);
  assert.equal(created.recordedMinutes, 75);
  assert.equal(created.calendar.primary, 'WORK_DAY');
  assert.equal(created.schedule.scheduledMinutes, 480);
  assert.equal(ctx.audits.length, 1);
  assert.equal(ctx.audits[0].action, 'ATTENDANCE_OVERTIME_REQUESTED');
  assert.deepEqual(Object.keys(ctx.audits[0].newValue || {}).sort(), [
    'attendanceDate',
    'calendarPrimary',
    'eligibleMinutes',
    'requestedMinutes',
    'type',
  ]);
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].userId, MGR);
});

test('submit: requested above eligible is refused', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  await assert.rejects(submitHappy(ctx, { requestedMinutes: 600 }), /at most 75/);
  assert.equal(ctx.RequestModel.rows.length, 0);
});

test('submit: zero/negative minutes refused', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  await assert.rejects(submitHappy(ctx, { requestedMinutes: 0 }), /at least 1/);
  await assert.rejects(submitHappy(ctx, { requestedMinutes: -10 }), /at least 1/);
});

test('submit: disabled tracking refused', async () => {
  const ctx = makeCtx({
    controls: [baseControl({ workMinutes: 900 })],
    policy: basePolicy({ trackingEnabled: false }),
  });
  await assert.rejects(submitHappy(ctx), /not enabled/);
});

test('submit: wrong benefit type for the day refused', async () => {
  const ctx = makeCtx({
    controls: [baseControl({ date: SUN, workMinutes: 500 })],
    policy: basePolicy({ weeklyOffBenefit: 'COMP_OFF' }),
  });
  await assert.rejects(
    submitOvertimeRequest({
      companyId: COMPANY_A,
      requester: requester(),
      type: 'OVERTIME',
      attendanceDate: SUN,
      requestedMinutes: 500,
      reason: 'Sunday release',
      ...depsOf(ctx),
    }),
    /Only comp-off requests are allowed/,
  );
});

test('submit: sequential double-submit is refused (live request exists)', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  await submitHappy(ctx);
  await assert.rejects(submitHappy(ctx), /already exists for this day/);
  assert.equal(ctx.RequestModel.rows.length, 1);
});

test('submit: concurrent double-submit race loses on the unique index (11000 mapped)', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  await submitHappy(ctx);
  // Simulate the check-then-act race window: the loser's
  // eligibility check runs before the winner's row is visible.
  const racedDeps = { ...depsOf(ctx), RequestModel: { ...ctx.RequestModel, findOne: () => q(null) } };
  await assert.rejects(
    submitOvertimeRequest({
      companyId: COMPANY_A,
      requester: requester(),
      type: 'OVERTIME',
      attendanceDate: MON,
      requestedMinutes: 75,
      reason: 'racing submit',
      ...racedDeps,
    }),
    /live request already exists/,
  );
  assert.equal(ctx.RequestModel.rows.length, 1);
});

test('submit: rejected requests free the day for a fresh request', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const first = await submitHappy(ctx);
  await rejectOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: first.id, ...depsOf(ctx) });
  const second = await submitHappy(ctx);
  assert.equal(second.status, 'PENDING');
  assert.notEqual(second.id, first.id);
});

test('submit: overtime on a locked payroll month is refused, comp-off is not', async () => {
  const locked = { month: '2026-09', status: 'LOCKED' };
  const otCtx = makeCtx({ controls: [baseControl({ workMinutes: 555 })], period: locked });
  await assert.rejects(submitHappy(otCtx), /already locked/);

  const compCtx = makeCtx({
    controls: [baseControl({ date: SUN, workMinutes: 500 })],
    policy: basePolicy({ weeklyOffBenefit: 'COMP_OFF' }),
    period: locked,
  });
  const created = await submitOvertimeRequest({
    companyId: COMPANY_A,
    requester: requester(),
    type: 'COMP_OFF',
    attendanceDate: SUN,
    requestedMinutes: 500,
    reason: 'Sunday release',
    ...depsOf(compCtx),
  });
  assert.equal(created.status, 'PENDING');
});

test('submit: nothing is auto-approved and the record is untouched', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  await submitHappy(ctx);
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 0);
  assert.equal(ctx.RequestModel.rows[0].status, 'PENDING');
});

// ── APPROVE / REJECT / CANCEL ──────────────────────────────

test('approve: PENDING -> APPROVED republishes the payroll seam', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  const decided = await approveOvertimeRequest({
    companyId: COMPANY_A,
    viewer: manager(),
    requestId: created.id,
    approvedMinutes: 75,
    ...depsOf(ctx),
  });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.approvedMinutes, 75);
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 75);
  assert.ok(ctx.audits.some((entry) => entry.action === 'ATTENDANCE_OVERTIME_APPROVED'));
  assert.ok(ctx.notifications.some((note) => note.userId === EMP));
});

test('approve: partial approval writes only the approved minutes', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  await approveOvertimeRequest({
    companyId: COMPANY_A,
    viewer: manager(),
    requestId: created.id,
    approvedMinutes: 60,
    reviewReason: 'Capped per shift policy',
    ...depsOf(ctx),
  });
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 60);
});

test('approve: above requested or eligible is refused', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 90, ...depsOf(ctx) }),
    /at most the requested 75/,
  );
  assert.equal(ctx.RequestModel.rows[0].status, 'PENDING');
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 0);
});

test('approve: changed attendance is revalidated (stale approval refused)', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  // A 31.5 correction lands after submit and shrinks the day.
  ctx.AttendanceModel.rows[0].workMinutes = 510;
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 75, ...depsOf(ctx) }),
    /resubmission/,
  );
  assert.equal(ctx.RequestModel.rows[0].status, 'PENDING');
  // The reviewer CAN approve the fresh eligible figure.
  const decided = await approveOvertimeRequest({
    companyId: COMPANY_A,
    viewer: manager(),
    requestId: created.id,
    approvedMinutes: 30,
    ...depsOf(ctx),
  });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 30);
});

test('approve: duplicate approval does not double-credit', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  await approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 75, ...depsOf(ctx) });
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 75, ...depsOf(ctx) }),
    /already approved/,
  );
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 75);
});

test('approve: self-review is forbidden', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: requester(), requestId: created.id, approvedMinutes: 75, ...depsOf(ctx) }),
    /cannot review your own/,
  );
});

test('approve: locked month at decision time refuses overtime', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })], period: { month: '2026-09', status: 'SENT_TO_PAYROLL' } });
  // Submitted while open (period injected only for the decision).
  const openCtx = makeCtx({ controls: ctx.AttendanceModel.rows });
  openCtx.RequestModel.rows.push(...ctx.RequestModel.rows);
  const created = await submitHappy(openCtx);
  ctx.RequestModel.rows.push(...openCtx.RequestModel.rows);
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 75, ...depsOf(ctx) }),
    /frozen/,
  );
  assert.equal(ctx.RequestModel.rows[0].status, 'PENDING');
});

test('reject: PENDING -> REJECTED with reason, notify, no seam write', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  const decided = await rejectOvertimeRequest({
    companyId: COMPANY_A,
    viewer: manager(),
    requestId: created.id,
    reviewReason: 'Pre-approval was not taken',
    ...depsOf(ctx),
  });
  assert.equal(decided.status, 'REJECTED');
  assert.equal(decided.reviewReason, 'Pre-approval was not taken');
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 0);
  assert.ok(ctx.audits.some((entry) => entry.action === 'ATTENDANCE_OVERTIME_REJECTED'));
});

test('cancel: owner cancels pending; decided rows cannot cancel', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  const cancelled = await cancelOvertimeRequest({
    companyId: COMPANY_A,
    viewer: requester(),
    requestId: created.id,
    ...depsOf(ctx),
  });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(ctx.audits.some((entry) => entry.action === 'ATTENDANCE_OVERTIME_CANCELLED'));
  await assert.rejects(
    cancelOvertimeRequest({ companyId: COMPANY_A, viewer: requester(), requestId: created.id, ...depsOf(ctx) }),
    /already cancelled/,
  );
});

test('cancel: non-owner without a review grant is refused', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  await assert.rejects(
    cancelOvertimeRequest({
      companyId: COMPANY_A,
      viewer: { _id: OUTSIDER, name: 'Out' },
      requestId: created.id,
      ...depsOf(ctx),
    }),
    /only cancel your own/,
  );
});

// ── COMP-OFF ───────────────────────────────────────────────

const submitCompOff = async (ctx, overrides = {}) =>
  submitOvertimeRequest({
    companyId: COMPANY_A,
    requester: requester(),
    type: 'COMP_OFF',
    attendanceDate: SUN,
    requestedMinutes: 500,
    reason: 'Sunday production release',
    ...depsOf(ctx),
    ...overrides,
  });

const compCtx = (overrides = {}) =>
  makeCtx({
    controls: [baseControl({ date: SUN, workMinutes: 500 })],
    policy: basePolicy({ weeklyOffBenefit: 'COMP_OFF' }),
    ...overrides,
  });

test('comp-off: approval credits exactly one entitlement, no payroll seam write', async () => {
  const ctx = compCtx();
  const created = await submitCompOff(ctx);
  const decided = await approveOvertimeRequest({
    companyId: COMPANY_A,
    viewer: manager(),
    requestId: created.id,
    approvedMinutes: 500,
    ...depsOf(ctx),
  });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.compOffDays, 1);
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 0);
  assert.equal(await earnedCompOffDays({ companyId: COMPANY_A, userId: EMP, RequestModel: ctx.RequestModel }), 1);
  assert.ok(ctx.audits.some((entry) => entry.action === 'COMP_OFF_ENTITLEMENT_CREATED'));
  const credit = ctx.notifications.find((note) => note.payload.title === 'Comp-off credited');
  assert.ok(credit);
  assert.equal(credit.payload.link, '/app/leaves');
});

test('comp-off: retry never double-credits', async () => {
  const ctx = compCtx();
  const created = await submitCompOff(ctx);
  await approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 500, ...depsOf(ctx) });
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 500, ...depsOf(ctx) }),
    /already approved/,
  );
  assert.equal(await earnedCompOffDays({ companyId: COMPANY_A, userId: EMP, RequestModel: ctx.RequestModel }), 1);
});

test('comp-off: employee cannot self-credit an entitlement', async () => {
  const ctx = compCtx();
  const created = await submitCompOff(ctx);
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: requester(), requestId: created.id, approvedMinutes: 500, ...depsOf(ctx) }),
    /cannot review your own/,
  );
  assert.equal(await earnedCompOffDays({ companyId: COMPANY_A, userId: EMP, RequestModel: ctx.RequestModel }), 0);
});

test('comp-off: approval never auto-creates a future leave', async () => {
  const ctx = compCtx();
  const created = await submitCompOff(ctx);
  await approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 500, ...depsOf(ctx) });
  assert.equal(ctx.LeaveModel.created.length, 0);
  assert.equal(ctx.LeaveModel.rows.length, 0);
});

test('comp-off: sub-day approvals are refused (whole days only)', async () => {
  const ctx = compCtx();
  const created = await submitCompOff(ctx);
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 400, ...depsOf(ctx) }),
    /at least 480/,
  );
  assert.equal(ctx.RequestModel.rows[0].status, 'PENDING');
});

// ── TENANCY + ORG SCOPE ────────────────────────────────────

test('tenancy: company A cannot claim company B attendance', async () => {
  const ctx = makeCtx({ controls: [baseControl({ companyId: COMPANY_B, workMinutes: 900 })] });
  await assert.rejects(submitHappy(ctx), /No attendance was recorded/);
});

test('tenancy: company A cannot read or decide company B requests', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  ctx.RequestModel.rows[0].companyId = COMPANY_B;
  await assert.rejects(
    getOvertimeRequest({ companyId: COMPANY_A, viewer: requester(), requestId: created.id, ...depsOf(ctx) }),
    /not found/,
  );
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: manager(), requestId: created.id, approvedMinutes: 75, ...depsOf(ctx) }),
    /not found/,
  );
  const mine = await listPendingOvertimeRequests({ companyId: COMPANY_A, viewer: manager(), ...depsOf(ctx) });
  assert.equal(mine.length, 0);
});

test('scope: team manager reviews, unrelated manager cannot', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  const pending = await listPendingOvertimeRequests({ companyId: COMPANY_A, viewer: manager(), ...depsOf(ctx) });
  assert.equal(pending.length, 1);

  const outsiderCtx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  outsiderCtx.RequestModel.rows.push(...ctx.RequestModel.rows);
  const outsiderDeps = { ...depsOf(outsiderCtx), resolveScopeIds: async () => [OUTSIDER] };
  const none = await listPendingOvertimeRequests({ companyId: COMPANY_A, viewer: { _id: OUTSIDER }, ...outsiderDeps });
  assert.equal(none.length, 0);
  await assert.rejects(
    approveOvertimeRequest({ companyId: COMPANY_A, viewer: { _id: OUTSIDER }, requestId: created.id, approvedMinutes: 75, ...outsiderDeps }),
    /not in your team/,
  );
});

test('scope: reviewer reads in-scope requests through the owner route', async () => {
  const ctx = makeCtx({ controls: [baseControl({ workMinutes: 555 })] });
  const created = await submitHappy(ctx);
  const viaOwnerRoute = await getOvertimeRequest({
    companyId: COMPANY_A,
    viewer: manager(),
    requestId: created.id,
    asReviewer: false,
    ...depsOf(ctx),
  }).catch(() => null);
  assert.equal(viaOwnerRoute, null);
  const viaReview = await getOvertimeRequest({
    companyId: COMPANY_A,
    viewer: manager(),
    requestId: created.id,
    asReviewer: true,
    ...depsOf(ctx),
  });
  assert.equal(viaReview.id, created.id);
  assert.equal(viaReview.canCancel, true);
});

// ── PAYROLL SEAM ───────────────────────────────────────────

test('payroll seam: republish sums approved OT rows (idempotent)', async () => {
  const ctx = makeCtx({
    controls: [baseControl({ workMinutes: 555 })],
    requests: [
      { _id: 'ot1', companyId: COMPANY_A, user: EMP, attendanceDate: MON, type: 'OVERTIME', status: 'APPROVED', approvedMinutes: 75 },
    ],
  });
  const total = await republishApprovedOtMinutes({ companyId: COMPANY_A, userId: EMP, attendanceDate: MON, ...depsOf(ctx) });
  assert.equal(total, 75);
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 75);
  const again = await republishApprovedOtMinutes({ companyId: COMPANY_A, userId: EMP, attendanceDate: MON, ...depsOf(ctx) });
  assert.equal(again, 75);
});

test('payroll seam: comp-off and non-approved rows never publish', async () => {
  const ctx = makeCtx({
    controls: [baseControl({ date: SUN, workMinutes: 500 })],
    requests: [
      { _id: 'ot1', companyId: COMPANY_A, user: EMP, attendanceDate: SUN, type: 'COMP_OFF', status: 'APPROVED', approvedMinutes: 500, compOffDays: 1 },
      { _id: 'ot2', companyId: COMPANY_A, user: EMP, attendanceDate: SUN, type: 'OVERTIME', status: 'PENDING', approvedMinutes: null },
    ],
  });
  const total = await republishApprovedOtMinutes({ companyId: COMPANY_A, userId: EMP, attendanceDate: SUN, ...depsOf(ctx) });
  assert.equal(total, 0);
  assert.equal(ctx.AttendanceModel.rows[0].overtimeMinutes, 0);
});

// ── MODEL CONTRACT ─────────────────────────────────────────

test('model: AttendanceOvertimeRequest contract (fields, enums, double-claim index)', () => {
  const schema = OvertimeRequestReal.default.schema;
  for (const field of [
    'companyId', 'user', 'attendance', 'attendanceDate', 'type', 'status',
    'recordedMinutes', 'eligibleMinutes', 'requestedMinutes', 'approvedMinutes',
    'compOffDays', 'calendar', 'schedule', 'reason', 'reviewReason', 'reviewedBy', 'reviewedAt',
  ]) {
    assert.ok(schema.paths[field], `AttendanceOvertimeRequest.${field} still exists`);
  }
  assert.deepEqual([...schema.paths.type.enumValues], ['OVERTIME', 'COMP_OFF']);
  assert.deepEqual([...schema.paths.status.enumValues], ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
  const partialUnique = schema.indexes().find(([, options]) => options?.unique && options?.partialFilterExpression);
  assert.ok(partialUnique, 'partial unique index (one live request per day) exists');
  assert.deepEqual(partialUnique[1].partialFilterExpression, { status: { $in: ['PENDING', 'APPROVED'] } });
});

// ── STATIC GUARDS ──────────────────────────────────────────

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const codeOf = (file) => {
  const raw = readFileSync(join(SRC, file), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
};

const OT_FILES = [
  'models/AttendanceOvertimeRequest.js',
  'services/attendance/attendanceOvertimeRules.js',
  'services/attendance/attendanceOvertimeService.js',
  'validators/attendance/attendanceOvertimeValidator.js',
  'controllers/attendance/attendanceOvertimeController.js',
  'routes/attendance/attendanceOvertimeRoutes.js',
];

test('static: 31.8 never touches payroll computation, leave, periods, or events', () => {
  for (const file of OT_FILES) {
    const content = codeOf(file);
    assert.ok(
      !/PayrollResult|payrollEngine|salaryComponent|payslip|fnf/i.test(content),
      `${file} must not touch payroll computation`,
    );
    assert.ok(
      !/PayrollPeriodModel\.(create|findOneAndUpdate|updateOne|updateMany|save|deleteOne)/.test(content),
      `${file} must never write payroll periods`,
    );
    assert.ok(
      !/LeaveModel\.(create|findOneAndUpdate|updateOne|updateMany|save|deleteOne)/.test(content),
      `${file} must never write leave`,
    );
    assert.ok(!/AttendanceEvent/i.test(content), `${file} must never reference attendance events`);
    assert.ok(
      !/AttendanceRegularization/i.test(content),
      `${file} must never read regularization rows (only post-rebuild facts)`,
    );
  }
});

test('static: 31.8 computes no money anywhere', () => {
  for (const file of OT_FILES) {
    const content = codeOf(file);
    assert.ok(
      !/₹|rupee|netPay|grossSalary|basicSalary|calculateSalary|providentFund|professionalTax|gratuity|overtimeRate|ratePerHour|perHour|hourlyRate|multiplier/i.test(
        content,
      ),
      `${file} must not compute or name money`,
    );
  }
});

test('static: recorded attendance facts are read-only except the approved-OT republish', () => {
  const content = codeOf('services/attendance/attendanceOvertimeService.js');
  assert.ok(!/\bpunch(In|Out)\s*:/.test(content), 'punches must never be set by 31.8');
  assert.ok(!/\.punch(In|Out)\s*=/.test(content), 'recorded punches must never be assigned');
  // The request rows carry their own lifecycle; the Attendance
  // record itself is written exactly once (approved-OT republish).
  const recordWrites = content.match(/AttendanceModel\.(findOneAndUpdate|updateOne|updateMany|create|save)/g) || [];
  assert.equal(recordWrites.length, 1);
  assert.ok(/\$set:\s*{\s*overtimeMinutes:\s*total\s*}/.test(content), 'the only record write sets approved overtimeMinutes');
});

test('static: controller keeps the repo comment convention', () => {
  const content = readFileSync(join(SRC, 'controllers/attendance/attendanceOvertimeController.js'), 'utf8');
  assert.ok(content.includes('// Data from frontend'), 'controller must mark frontend inputs');
  assert.ok(content.includes('// DB Logic'), 'controller must mark DB logic');
  assert.ok(content.includes('// Data to frontend'), 'controller must mark frontend outputs');
});

test('static: rules stay pure (no Mongo, no HTTP, no process)', () => {
  const content = codeOf('services/attendance/attendanceOvertimeRules.js');
  assert.ok(!/mongoose|express|process\.env|console\.|setTimeout|Date\.now|new Date\(\)/.test(content));
});
