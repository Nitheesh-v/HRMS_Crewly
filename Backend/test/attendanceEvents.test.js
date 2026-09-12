// Phase 31.2 — Advanced Punching & Live Attendance (hermetic suite).
//
// No MongoDB, no Redis, no network: models/engine/clock are injected
// fakes. The real 31.1 policy vocabulary + real scheduleEngine pure
// helpers (evaluatePunch/dayKey — zero-import modules) keep parity honest.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const USER_B = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const USER_C = 'ccccccccccccccccccccccc3';

const [eventRules, eventService, policyRules, sched, AttendanceReal] = await Promise.all([
  import('../src/services/attendance/attendanceEventRules.js'),
  import('../src/services/attendance/attendanceEventService.js'),
  import('../src/services/attendance/attendancePolicyRules.js'),
  import('../src/utils/scheduleEngine.js'),
  import('../src/models/Attendance.js'),
]);

const { EVENT_TYPE, LIVE_STATE, WORK_MODE, EVENT_SOURCE } = policyRules;
const {
  transition,
  allowedActions,
  deriveLiveState,
  orderEvents,
  buildTimeline,
  deriveClosedDurations,
  deriveLiveDurations,
  enabledWorkModes,
  isWorkModeAllowed,
  isSessionOpen,
} = eventRules;
const { getLiveAttendance, recordEvent } = eventService;

// ── fixtures ───────────────────────────────────────────────────

const policyAllModes = () => ({
  version: 3,
  timezone: 'Asia/Kolkata',
  thresholds: { fullDayMinutes: 480, halfDayMinutes: 240 },
  grace: { lateInMinutes: 15, earlyOutMinutes: 15 },
  breaks: { enabled: true, includeInWorkedTime: false, dailyLimitMinutes: null },
  missingPunch: { keepUnresolved: true, allowRegularization: true, regularizationWindowDays: 7 },
  overtime: { trackingEnabled: true, minimumExtraMinutes: 30, approvalRequired: true, weekendEligible: true, holidayEligible: false },
  weekendHoliday: { allowWorkOnWeeklyOff: true, allowWorkOnHoliday: true },
  workModes: { office: true, wfh: true, field: true, clientSite: true, businessTravel: true },
});

const policyOfficeOnly = () => ({
  ...policyAllModes(),
  workModes: { office: true, wfh: false, field: false, clientSite: false, businessTravel: false },
});

const policyBreaksIncluded = () => ({
  ...policyAllModes(),
  breaks: { enabled: true, includeInWorkedTime: true, dailyLimitMinutes: null },
});

const ruleDoc = (overrides = {}) => ({
  name: 'Morning shift',
  startTime: '09:00',
  endTime: '18:00',
  breakMinutes: 30,
  graceMinutes: 10,
  minWorkingHours: 8,
  halfDayHours: 4,
  overtimeEligible: true,
  ...overrides,
});

const fakeEngine = (overrides = {}) => ({
  resolveShiftForUser: async () => ({ shift: null, schedule: null, source: 'DEFAULT' }),
  resolveScheduleForUser: async () => null,
  getWorkingDaysForUser: async () => ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  getHolidaysForUser: async () => [],
  holidayOnDate: async () => null,
  evaluatePunch: sched.evaluatePunch,
  dayKey: sched.dayKey,
  ...overrides,
});

// In-memory Attendance fake: findOne/findOneAndUpdate/create + unique gate.
const makeFakeAttendanceModel = ({ failCasTimes = 0 } = {}) => {
  const rows = [];
  let seq = 1;
  let casFailuresLeft = failCasTimes;

  const matches = (row, filter = {}) =>
    Object.entries(filter).every(([key, value]) => {
      if (key === '$or') return value.some((clause) => matches(row, clause));
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        if (value.$in) return value.$in.map(String).includes(String(row[key]));
        if (value.$ne !== undefined) {
          if (Array.isArray(value.$ne)) return true;
          return String(row[key] ?? '') !== String(value.$ne ?? '');
        }
        if (value.$exists !== undefined) {
          const exists = row[key] !== undefined;
          return value.$exists ? exists : !exists;
        }
        return true;
      }
      return String(row[key] ?? '') === String(value ?? '');
    });

  const chain = (resolve) => {
    const self = {
      sort: () => self,
      lean: () => self,
      select: () => self,
      then: (resolvePromise, rejectPromise) =>
        Promise.resolve().then(resolve).then(resolvePromise, rejectPromise),
    };
    return self;
  };

  return {
    rows,
    findOne: (filter) => chain(() => rows.find((row) => matches(row, filter)) || null),
    findOneAndUpdate: async (filter, update, opts = {}) => {
      if (casFailuresLeft > 0) {
        casFailuresLeft -= 1;
        return null; // simulated lost race
      }
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, update.$set || {});
      if (update.$inc) {
        for (const [key, delta] of Object.entries(update.$inc)) {
          row[key] = Number(row[key] || 0) + delta;
        }
      }
      row.updatedAt = new Date();
      return opts.new ? row : { ...row };
    },
    create: async (doc) => {
      const dup = rows.find(
        (row) => String(row.user) === String(doc.user) && String(row.date) === String(doc.date),
      );
      if (dup) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      const row = { ...doc, _id: `att${seq}`, id: `att${seq}`, createdAt: new Date(), updatedAt: new Date() };
      seq += 1;
      rows.push(row);
      return row;
    },
  };
};

// In-memory AttendanceEvent fake with both unique gates.
const makeFakeEventModel = () => {
  const rows = [];
  let seq = 1;

  const chain = (resolve) => {
    const self = {
      sort: () => self,
      lean: () => self,
      then: (resolvePromise, rejectPromise) =>
        Promise.resolve().then(resolve).then(resolvePromise, rejectPromise),
    };
    return self;
  };

  return {
    rows,
    findOne: (filter) =>
      chain(() => {
        const found = rows.find((row) =>
          Object.entries(filter).every(([key, value]) => String(row[key] ?? '') === String(value ?? '')),
        );
        return found ? { ...found } : null;
      }),
    find: (filter) =>
      chain(() =>
        rows
          .filter((row) =>
            Object.entries(filter).every(([key, value]) => String(row[key] ?? '') === String(value ?? '')),
          )
          .sort((a, b) => a.seq - b.seq)
          .map((row) => ({ ...row })),
      ),
    create: async (doc) => {
      const dupSeq = rows.find(
        (row) =>
          String(row.companyId) === String(doc.companyId) &&
          String(row.user) === String(doc.user) &&
          String(row.date) === String(doc.date) &&
          Number(row.seq) === Number(doc.seq),
      );
      if (dupSeq) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      if (doc.requestId) {
        const dupKey = rows.find(
          (row) =>
            String(row.companyId) === String(doc.companyId) &&
            String(row.user) === String(doc.user) &&
            String(row.requestId || '') === String(doc.requestId),
        );
        if (dupKey) {
          const err = new Error('duplicate key');
          err.code = 11000;
          throw err;
        }
      }
      const row = {
        ...doc,
        _id: `evt${seq}`,
        id: `evt${seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        toObject() {
          return { ...this };
        },
      };
      seq += 1;
      rows.push(row);
      return row;
    },
  };
};

const makeCompanyModel = (timezone = 'Asia/Kolkata') => ({
  findById: () => ({ select: () => ({ lean: async () => ({ timezone }) }) }),
});

// Controllable clock + deps bundle.
const makeCtx = ({ policy = policyAllModes(), engine = null, now = null, attendanceOpts = {} } = {}) => {
  let current = now ? new Date(now).getTime() : new Date('2026-09-12T09:00:00+05:30').getTime();
  const AttendanceModel = makeFakeAttendanceModel(attendanceOpts);
  const AttendanceEventModel = makeFakeEventModel();
  const deps = {
    AttendanceModel,
    AttendanceEventModel,
    CompanyModel: makeCompanyModel('Asia/Kolkata'),
    policyReader: async ({ companyId }) => {
      assert.ok(companyId, 'policy reader must receive the tenant');
      return { policy, configured: Boolean(policy), hasActive: Boolean(policy) };
    },
    engine: engine || fakeEngine(),
    now: () => new Date(current),
  };
  return {
    deps,
    AttendanceModel,
    AttendanceEventModel,
    setNow: (iso) => {
      current = new Date(iso).getTime();
    },
  };
};

const punch = (ctx, action, overrides = {}) =>
  recordEvent({
    companyId: COMPANY_A,
    userId: USER_A,
    action,
    workMode: null,
    date: null,
    idempotencyKey: null,
    deps: ctx.deps,
    ...overrides,
  });

// ── PURE STATE MACHINE ───────────────────────────────────────

test('machine: the happy path NOT_IN → WORKING → ON_BREAK → WORKING → COMPLETED', () => {
  assert.deepEqual(transition(LIVE_STATE.NOT_IN, EVENT_TYPE.CLOCK_IN).allowed, true);
  assert.equal(transition(LIVE_STATE.NOT_IN, EVENT_TYPE.CLOCK_IN).next, LIVE_STATE.WORKING);
  assert.equal(transition(LIVE_STATE.WORKING, EVENT_TYPE.BREAK_START).next, LIVE_STATE.ON_BREAK);
  assert.equal(transition(LIVE_STATE.ON_BREAK, EVENT_TYPE.BREAK_END).next, LIVE_STATE.WORKING);
  assert.equal(transition(LIVE_STATE.WORKING, EVENT_TYPE.CLOCK_OUT).next, LIVE_STATE.COMPLETED);
});

test('machine: multiple breaks cycle WORKING ⇄ ON_BREAK', () => {
  let state = LIVE_STATE.WORKING;
  for (let i = 0; i < 3; i += 1) {
    state = transition(state, EVENT_TYPE.BREAK_START).next;
    assert.equal(state, LIVE_STATE.ON_BREAK);
    state = transition(state, EVENT_TYPE.BREAK_END).next;
    assert.equal(state, LIVE_STATE.WORKING);
  }
});

test('machine: invalid transitions are rejected with reasons', () => {
  const cases = [
    [LIVE_STATE.NOT_IN, EVENT_TYPE.BREAK_START],
    [LIVE_STATE.NOT_IN, EVENT_TYPE.BREAK_END],
    [LIVE_STATE.NOT_IN, EVENT_TYPE.CLOCK_OUT],
    [LIVE_STATE.WORKING, EVENT_TYPE.CLOCK_IN],
    [LIVE_STATE.WORKING, EVENT_TYPE.BREAK_END],
    [LIVE_STATE.ON_BREAK, EVENT_TYPE.CLOCK_IN],
    [LIVE_STATE.ON_BREAK, EVENT_TYPE.BREAK_START],
    [LIVE_STATE.ON_BREAK, EVENT_TYPE.CLOCK_OUT], // break must end first
    [LIVE_STATE.COMPLETED, EVENT_TYPE.CLOCK_IN],
    [LIVE_STATE.COMPLETED, EVENT_TYPE.BREAK_START],
    [LIVE_STATE.COMPLETED, EVENT_TYPE.BREAK_END],
    [LIVE_STATE.COMPLETED, EVENT_TYPE.CLOCK_OUT],
  ];
  for (const [state, action] of cases) {
    const result = transition(state, action);
    assert.equal(result.allowed, false, `${state} + ${action} must be rejected`);
    assert.ok(result.reason, 'rejection carries a human reason');
  }
  assert.equal(transition(LIVE_STATE.COMPLETED, EVENT_TYPE.CLOCK_IN).code, 'SESSION_COMPLETED');
  assert.equal(
    transition(LIVE_STATE.ON_BREAK, EVENT_TYPE.CLOCK_OUT).reason,
    'End your break before clocking out',
  );
});

test('machine: allowed next actions are backend-derived per state', () => {
  assert.deepEqual(allowedActions(LIVE_STATE.NOT_IN), [EVENT_TYPE.CLOCK_IN]);
  assert.deepEqual(allowedActions(LIVE_STATE.WORKING), [EVENT_TYPE.BREAK_START, EVENT_TYPE.CLOCK_OUT]);
  assert.deepEqual(allowedActions(LIVE_STATE.ON_BREAK), [EVENT_TYPE.BREAK_END]);
  assert.deepEqual(allowedActions(LIVE_STATE.COMPLETED), []);
  assert.deepEqual(allowedActions('BOGUS'), []);
});

test('machine: unknown states and actions never throw', () => {
  assert.equal(transition('BOGUS', EVENT_TYPE.CLOCK_IN).allowed, false);
  assert.equal(transition(LIVE_STATE.WORKING, 'NAP').allowed, false);
});

test('machine: live state derives from control facts; control wins when set', () => {
  assert.equal(deriveLiveState(null), LIVE_STATE.NOT_IN);
  assert.equal(deriveLiveState({}), LIVE_STATE.NOT_IN);
  assert.equal(deriveLiveState({ punchIn: new Date() }), LIVE_STATE.WORKING);
  assert.equal(
    deriveLiveState({ punchIn: new Date(), punchOut: new Date() }),
    LIVE_STATE.COMPLETED,
  );
  assert.equal(deriveLiveState({ liveState: LIVE_STATE.ON_BREAK }), LIVE_STATE.ON_BREAK);
  assert.equal(isSessionOpen(LIVE_STATE.WORKING), true);
  assert.equal(isSessionOpen(LIVE_STATE.ON_BREAK), true);
  assert.equal(isSessionOpen(LIVE_STATE.COMPLETED), false);
  assert.equal(isSessionOpen(LIVE_STATE.NOT_IN), false);
});

// ── DURATIONS ────────────────────────────────────────────────

const evt = (seq, type, iso) => ({ seq, type, at: new Date(iso) });

test('durations: simple in/out span with no breaks', () => {
  const events = [evt(1, 'CLOCK_IN', '2026-09-12T09:00:00+05:30'), evt(2, 'CLOCK_OUT', '2026-09-12T18:00:00+05:30')];
  const closed = deriveClosedDurations(events, {
    sessionOpenedAt: events[0].at,
    sessionClosedAt: events[1].at,
    includeBreaks: false,
  });
  assert.deepEqual(closed, { spanMinutes: 540, breakMinutes: 0, workedMinutes: 540 });
});

test('durations: one break excluded vs included', () => {
  const events = [
    evt(1, 'CLOCK_IN', '2026-09-12T09:00:00+05:30'),
    evt(2, 'BREAK_START', '2026-09-12T12:00:00+05:30'),
    evt(3, 'BREAK_END', '2026-09-12T12:30:00+05:30'),
    evt(4, 'CLOCK_OUT', '2026-09-12T18:00:00+05:30'),
  ];
  const excluded = deriveClosedDurations(events, {
    sessionOpenedAt: events[0].at,
    sessionClosedAt: events[3].at,
    includeBreaks: false,
  });
  assert.deepEqual(excluded, { spanMinutes: 540, breakMinutes: 30, workedMinutes: 510 });

  const included = deriveClosedDurations(events, {
    sessionOpenedAt: events[0].at,
    sessionClosedAt: events[3].at,
    includeBreaks: true,
  });
  assert.deepEqual(included, { spanMinutes: 540, breakMinutes: 30, workedMinutes: 540 });
});

test('durations: multiple breaks accumulate', () => {
  const events = [
    evt(1, 'CLOCK_IN', '2026-09-12T09:02:00+05:30'),
    evt(2, 'BREAK_START', '2026-09-12T11:10:00+05:30'),
    evt(3, 'BREAK_END', '2026-09-12T11:25:00+05:30'),
    evt(4, 'BREAK_START', '2026-09-12T13:05:00+05:30'),
    evt(5, 'BREAK_END', '2026-09-12T13:47:00+05:30'),
    evt(6, 'CLOCK_OUT', '2026-09-12T18:11:00+05:30'),
  ];
  const closed = deriveClosedDurations(events, {
    sessionOpenedAt: events[0].at,
    sessionClosedAt: events[5].at,
    includeBreaks: false,
  });
  assert.equal(closed.breakMinutes, 57);
  assert.equal(closed.spanMinutes, 549);
  assert.equal(closed.workedMinutes, 492);
});

test('durations: open work and break intervals report live anchors', () => {
  const working = [evt(1, 'CLOCK_IN', '2026-09-12T09:00:00+05:30')];
  const liveWork = deriveLiveDurations(working, {
    now: new Date('2026-09-12T10:00:30+05:30'),
    sessionOpenedAt: working[0].at,
    includeBreaks: false,
  });
  assert.equal(liveWork.openInterval.kind, 'WORK');
  assert.equal(liveWork.openInterval.elapsedSeconds, 3630);
  assert.equal(liveWork.workedSecondsSoFar, 3630);
  assert.equal(liveWork.breakSecondsSoFar, 0);

  const onBreak = [...working, evt(2, 'BREAK_START', '2026-09-12T12:00:00+05:30')];
  const liveBreak = deriveLiveDurations(onBreak, {
    now: new Date('2026-09-12T12:05:00+05:30'),
    sessionOpenedAt: working[0].at,
    includeBreaks: false,
  });
  assert.equal(liveBreak.openInterval.kind, 'BREAK');
  assert.equal(liveBreak.openInterval.elapsedSeconds, 300);
  assert.equal(liveBreak.breakSecondsSoFar, 300);
});

test('durations: skewed timestamps never produce negative time', () => {
  const events = [
    evt(1, 'CLOCK_IN', '2026-09-12T09:00:00+05:30'),
    evt(2, 'BREAK_START', '2026-09-12T08:00:00+05:30'), // earlier than in
    evt(3, 'BREAK_END', '2026-09-12T08:05:00+05:30'),
    evt(4, 'CLOCK_OUT', '2026-09-12T07:00:00+05:30'), // earlier than all
  ];
  const closed = deriveClosedDurations(events, {
    sessionOpenedAt: events[0].at,
    sessionClosedAt: events[3].at,
    includeBreaks: false,
  });
  assert.ok(closed.spanMinutes >= 0);
  assert.ok(closed.breakMinutes >= 0);
  assert.ok(closed.workedMinutes >= 0);
});

test('durations: adopted legacy sessions open work at punchIn', () => {
  const punchIn = new Date('2026-09-12T09:00:00+05:30');
  const events = [
    { seq: 1, type: 'BREAK_START', at: new Date('2026-09-12T12:00:00+05:30') },
    { seq: 2, type: 'BREAK_END', at: new Date('2026-09-12T12:30:00+05:30') },
  ];
  const closed = deriveClosedDurations(events, {
    sessionOpenedAt: punchIn,
    sessionClosedAt: new Date('2026-09-12T18:00:00+05:30'),
    includeBreaks: false,
  });
  assert.deepEqual(closed, { spanMinutes: 540, breakMinutes: 30, workedMinutes: 510 });
});

test('timeline: deterministic ordering by sequence then time', () => {
  const shuffled = [
    evt(3, 'BREAK_END', '2026-09-12T12:30:00+05:30'),
    evt(1, 'CLOCK_IN', '2026-09-12T09:00:00+05:30'),
    evt(2, 'BREAK_START', '2026-09-12T12:00:00+05:30'),
  ];
  const ordered = orderEvents(shuffled);
  assert.deepEqual(ordered.map((event) => event.seq), [1, 2, 3]);

  const timeline = buildTimeline(shuffled);
  assert.equal(timeline[0].label, 'Clocked in');
  assert.equal(timeline[1].label, 'Break started');
  assert.equal(timeline[2].label, 'Break ended');
  assert.ok(timeline[0].at.endsWith('Z'));
});

// ── WORK MODES ───────────────────────────────────────────────

test('modes: enabled set follows the 31.1 policy; office always present', () => {
  assert.deepEqual(enabledWorkModes(policyAllModes()).sort(), [
    'BUSINESS_TRAVEL',
    'CLIENT_SITE',
    'FIELD',
    'OFFICE',
    'WFH',
  ]);
  assert.deepEqual(enabledWorkModes(policyOfficeOnly()), ['OFFICE']);
  assert.deepEqual(enabledWorkModes(null), ['OFFICE']);
  assert.deepEqual(enabledWorkModes(undefined), ['OFFICE']);
  assert.equal(isWorkModeAllowed('WFH', policyAllModes()), true);
  assert.equal(isWorkModeAllowed('WFH', policyOfficeOnly()), false);
  assert.equal(isWorkModeAllowed('OFFICE', null), true);
  assert.equal(isWorkModeAllowed('WFH', null), false);
  assert.equal(isWorkModeAllowed('SPACESHIP', policyAllModes()), false);
});

// ── SERVICE: FULL DAY ────────────────────────────────────────

test('service: full two-break day derives states, timeline and durations', async () => {
  const ctx = makeCtx();

  ctx.setNow('2026-09-12T09:02:00+05:30');
  const inResult = await punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', idempotencyKey: 'key-clock-in-1' });
  assert.equal(inResult.replayed, false);
  assert.equal(inResult.event.seq, 1);
  assert.equal(inResult.event.type, 'CLOCK_IN');
  assert.equal(inResult.event.workMode, 'OFFICE');
  assert.equal(inResult.event.source, 'WEB');
  assert.equal(inResult.snapshot.liveState, 'WORKING');
  assert.deepEqual(inResult.snapshot.allowedActions, ['BREAK_START', 'CLOCK_OUT']);

  ctx.setNow('2026-09-12T11:10:00+05:30');
  const break1 = await punch(ctx, 'BREAK_START');
  assert.equal(break1.snapshot.liveState, 'ON_BREAK');
  assert.equal(break1.event.seq, 2);
  assert.equal(break1.event.workMode, null);

  ctx.setNow('2026-09-12T11:25:00+05:30');
  const back1 = await punch(ctx, 'BREAK_END');
  assert.equal(back1.snapshot.liveState, 'WORKING');

  ctx.setNow('2026-09-12T13:05:00+05:30');
  await punch(ctx, 'BREAK_START');
  ctx.setNow('2026-09-12T13:47:00+05:30');
  await punch(ctx, 'BREAK_END');

  ctx.setNow('2026-09-12T18:11:00+05:30');
  const out = await punch(ctx, 'CLOCK_OUT');
  assert.equal(out.snapshot.liveState, 'COMPLETED');
  assert.deepEqual(out.snapshot.allowedActions, []);
  assert.equal(out.snapshot.timeline.length, 6);
  assert.deepEqual(
    out.snapshot.timeline.map((row) => row.type),
    ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'],
  );
  // 09:02 → 18:11 = 549 span; breaks 15 + 42 = 57; excluded → 492.
  assert.equal(out.snapshot.spanMinutes, 549);
  assert.equal(out.snapshot.breakMinutes, 57);
  assert.equal(out.snapshot.workedMinutes, 492);
  assert.equal(out.snapshot.openInterval, null);
  assert.ok(['PRESENT', 'LATE', 'HALF_DAY'].includes(out.snapshot.status));

  // Projection carries the payroll/report contract.
  const control = ctx.AttendanceModel.rows[0];
  assert.equal(control.companyId, COMPANY_A);
  assert.equal(control.user, USER_A);
  assert.equal(control.date, '2026-09-12');
  assert.equal(control.liveState, 'COMPLETED');
  assert.equal(control.workMode, 'OFFICE');
  assert.equal(control.eventSeq, 6);
  assert.equal(control.workMinutes, 492);
  assert.equal(control.breakMinutes, 57);
  assert.ok(control.punchIn instanceof Date);
  assert.ok(control.punchOut instanceof Date);
  assert.ok(['PRESENT', 'LATE', 'HALF_DAY'].includes(control.status));
  assert.equal(control.policyVersion, 3);
});

test('service: breaks-included policy counts the full span as worked', async () => {
  const ctx = makeCtx({ policy: policyBreaksIncluded() });

  ctx.setNow('2026-09-12T09:00:00+05:30');
  await punch(ctx, 'CLOCK_IN', { workMode: 'WFH' });
  ctx.setNow('2026-09-12T12:00:00+05:30');
  await punch(ctx, 'BREAK_START');
  ctx.setNow('2026-09-12T12:30:00+05:30');
  await punch(ctx, 'BREAK_END');
  ctx.setNow('2026-09-12T18:00:00+05:30');
  const out = await punch(ctx, 'CLOCK_OUT');

  assert.equal(out.snapshot.breakMinutes, 30);
  assert.equal(out.snapshot.workedMinutes, 540);
});

test('service: no active policy falls back to legacy break maths', async () => {
  const engine = fakeEngine({
    resolveShiftForUser: async () => ({
      shift: { _id: 'shift1', ...ruleDoc({ breakMinutes: 45 }) },
      schedule: null,
      source: 'SHIFT',
    }),
  });
  const ctx = makeCtx({ policy: null, engine });

  ctx.setNow('2026-09-12T09:00:00+05:30');
  await punch(ctx, 'CLOCK_IN'); // defaults to OFFICE
  ctx.setNow('2026-09-12T18:00:00+05:30');
  const out = await punch(ctx, 'CLOCK_OUT');

  // Legacy formula: 540 span − 45 fixed rule breaks = 495.
  assert.equal(out.snapshot.workedMinutes, 495);
  assert.equal(ctx.AttendanceModel.rows[0].workMode, 'OFFICE');
  assert.deepEqual(out.snapshot.enabledWorkModes, ['OFFICE']);
});

// ── SERVICE: REJECTIONS ──────────────────────────────────────

test('service: break/out before clock-in and duplicates are refused', async () => {
  const ctx = makeCtx();

  await assert.rejects(() => punch(ctx, 'BREAK_START'), /not clocked in/);
  await assert.rejects(() => punch(ctx, 'BREAK_END'), /not clocked in/);
  await assert.rejects(() => punch(ctx, 'CLOCK_OUT'), /not clocked in/);

  await punch(ctx, 'CLOCK_IN');
  // Stale duplicates (past the 10s merge window) still refuse loudly.
  ctx.setNow('2026-09-12T09:05:00+05:30');
  await assert.rejects(() => punch(ctx, 'CLOCK_IN'), /already clocked in/);
  await assert.rejects(() => punch(ctx, 'BREAK_END'), /no active break/);

  await punch(ctx, 'BREAK_START');
  ctx.setNow('2026-09-12T09:10:00+05:30');
  await assert.rejects(() => punch(ctx, 'BREAK_START'), /already in progress/);
  await assert.rejects(() => punch(ctx, 'CLOCK_OUT'), /End your break/);

  await punch(ctx, 'BREAK_END');
  await punch(ctx, 'CLOCK_OUT');
  ctx.setNow('2026-09-12T09:15:00+05:30');
  await assert.rejects(() => punch(ctx, 'CLOCK_IN'), /already clocked in/);
  await assert.rejects(() => punch(ctx, 'BREAK_START'), /already completed/);
  await assert.rejects(() => punch(ctx, 'CLOCK_OUT'), /already completed/);

  // Exactly 4 facts; every rejection wrote nothing.
  assert.equal(ctx.AttendanceEventModel.rows.length, 4);
});

test('service: disabled and invalid work modes are refused', async () => {
  const ctx = makeCtx({ policy: policyOfficeOnly() });

  await assert.rejects(() => punch(ctx, 'CLOCK_IN', { workMode: 'WFH' }), /not enabled/);
  await assert.rejects(() => punch(ctx, 'CLOCK_IN', { workMode: 'SPACESHIP' }), /Invalid work mode/);
  assert.equal(ctx.AttendanceEventModel.rows.length, 0);

  const ok = await punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE' });
  assert.equal(ok.snapshot.liveState, 'WORKING');
});

// ── IDEMPOTENCY ──────────────────────────────────────────────

test('service: retried requests replay instead of duplicating', async () => {
  const ctx = makeCtx();

  const first = await punch(ctx, 'CLOCK_IN', { idempotencyKey: 'retry-key-01' });
  assert.equal(first.replayed, false);

  const second = await punch(ctx, 'CLOCK_IN', { idempotencyKey: 'retry-key-01' });
  assert.equal(second.replayed, true);
  assert.equal(second.event.id, first.event.id);
  assert.equal(ctx.AttendanceEventModel.rows.length, 1);
  assert.equal(ctx.AttendanceModel.rows[0].eventSeq, 1);
});

test('service: same key with a conflicting action is refused', async () => {
  const ctx = makeCtx();

  await punch(ctx, 'CLOCK_IN', { idempotencyKey: 'conflict-key-1' });
  await assert.rejects(
    () => punch(ctx, 'BREAK_START', { idempotencyKey: 'conflict-key-1' }),
    /different attendance action/,
  );
  assert.equal(ctx.AttendanceEventModel.rows.length, 1);
});

test('service: idempotency keys are isolated per employee and company', async () => {
  const ctx = makeCtx();
  await punch(ctx, 'CLOCK_IN', { idempotencyKey: 'shared-key-12' });

  const otherUser = await punch(ctx, 'CLOCK_IN', { userId: USER_B, idempotencyKey: 'shared-key-12' });
  assert.equal(otherUser.replayed, false);

  // NOTE: same userId across companies is impossible via real auth
  // (tenant derives from the user) and the legacy {user,date} unique
  // gate reflects that — cross-tenant punches always carry their own user.
  const otherCompany = await punch(ctx, 'CLOCK_IN', {
    companyId: COMPANY_B,
    userId: USER_C,
    idempotencyKey: 'shared-key-12',
  });
  assert.equal(otherCompany.replayed, false);
  assert.equal(ctx.AttendanceEventModel.rows.length, 3);
});

// ── CONCURRENCY ──────────────────────────────────────────────

test('service: lost CAS races report conflict without corrupting state', async () => {
  const ctx = makeCtx({ attendanceOpts: { failCasTimes: 1 } });

  await punch(ctx, 'CLOCK_IN');
  await assert.rejects(() => punch(ctx, 'BREAK_START'), /state changed/);
  assert.equal(ctx.AttendanceEventModel.rows.length, 1);

  // The retry after refresh succeeds normally.
  const retry = await punch(ctx, 'BREAK_START');
  assert.equal(retry.event.seq, 2);
  assert.equal(retry.snapshot.liveState, 'ON_BREAK');
});

test('service: concurrent clock-in creation collapses to one session', async () => {
  const ctx = makeCtx();

  await punch(ctx, 'CLOCK_IN', { idempotencyKey: 'race-winner-1' });
  ctx.setNow('2026-09-12T09:20:00+05:30'); // past the merge window
  // A second creator hits the unique gate (simulated by direct insert).
  await assert.rejects(
    () =>
      ctx.AttendanceModel.create({
        companyId: COMPANY_A,
        user: USER_A,
        date: '2026-09-12',
        punchIn: new Date(),
      }),
    /duplicate key/,
  );
  await assert.rejects(() => punch(ctx, 'CLOCK_IN'), /already clocked in/);
  assert.equal(ctx.AttendanceModel.rows.length, 1);
});

// ── TENANCY ──────────────────────────────────────────────────

test('service: every write carries the authoritative tenant; cross-reads see nothing', async () => {
  const ctx = makeCtx();
  await punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE' });

  for (const row of ctx.AttendanceModel.rows) assert.equal(row.companyId, COMPANY_A);
  for (const row of ctx.AttendanceEventModel.rows) assert.equal(row.companyId, COMPANY_A);

  const foreign = await getLiveAttendance({ companyId: COMPANY_B, userId: USER_A, deps: ctx.deps });
  assert.equal(foreign.liveState, 'NOT_IN');
  assert.deepEqual(foreign.timeline, []);

  // Company B mutating creates its own isolated session (its own user:
  // tenant identity derives from the authenticated user in production).
  const own = await punch(ctx, 'CLOCK_IN', { companyId: COMPANY_B, userId: USER_B });
  assert.equal(own.snapshot.liveState, 'WORKING');
  assert.equal(ctx.AttendanceModel.rows.length, 2);
});

// ── LEGACY ADOPTION + COMPAT ─────────────────────────────────

test('service: legacy in-progress sessions are adopted without fabricated events', async () => {
  const ctx = makeCtx();
  await ctx.AttendanceModel.create({
    companyId: COMPANY_A,
    user: USER_A,
    date: '2026-09-12',
    punchIn: new Date('2026-09-12T09:00:00+05:30'),
    status: 'PRESENT',
    eventSeq: 0,
  });

  const live = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps: ctx.deps });
  assert.equal(live.liveState, 'WORKING');
  assert.deepEqual(live.timeline, []);
  assert.deepEqual(live.allowedActions, ['BREAK_START', 'CLOCK_OUT']);

  await assert.rejects(() => punch(ctx, 'CLOCK_IN'), /already clocked in/);

  ctx.setNow('2026-09-12T12:00:00+05:30');
  const started = await punch(ctx, 'BREAK_START');
  assert.equal(started.snapshot.liveState, 'ON_BREAK');
  assert.equal(started.event.seq, 1);

  ctx.setNow('2026-09-12T12:30:00+05:30');
  await punch(ctx, 'BREAK_END');
  ctx.setNow('2026-09-12T18:00:00+05:30');
  const out = await punch(ctx, 'CLOCK_OUT');
  assert.equal(out.snapshot.liveState, 'COMPLETED');
  assert.equal(out.snapshot.workedMinutes, 510);

  // Original punch-in preserved; no CLOCK_IN invented.
  const control = ctx.AttendanceModel.rows[0];
  assert.equal(new Date(control.punchIn).toISOString(), '2026-09-12T03:30:00.000Z');
  assert.ok(ctx.AttendanceEventModel.rows.every((row) => row.type !== 'CLOCK_IN'));
});

test('service: completed legacy sessions stay terminal', async () => {
  const ctx = makeCtx();
  await ctx.AttendanceModel.create({
    companyId: COMPANY_A,
    user: USER_A,
    date: '2026-09-12',
    punchIn: new Date('2026-09-12T09:00:00+05:30'),
    punchOut: new Date('2026-09-12T18:00:00+05:30'),
    status: 'PRESENT',
    workMinutes: 540,
    eventSeq: 0,
  });

  const live = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps: ctx.deps });
  assert.equal(live.liveState, 'COMPLETED');

  await assert.rejects(() => punch(ctx, 'CLOCK_IN'), /already clocked in/);
  await assert.rejects(() => punch(ctx, 'BREAK_START'), /already completed/);
  assert.equal(ctx.AttendanceEventModel.rows.length, 0);
});

test('compat: legacy Attendance contract and routes are intact', async () => {
  const paths = AttendanceReal.default.schema.paths;
  ['companyId', 'user', 'date', 'punchIn', 'punchOut', 'workMinutes', 'status', 'shift', 'schedule', 'shiftSource', 'lateMinutes', 'earlyMinutes', 'overtimeMinutes'].forEach(
    (field) => assert.ok(paths[field], `Attendance.${field} still exists`),
  );
  assert.deepEqual([...AttendanceReal.default.schema.paths.status.enumValues], ['PRESENT', 'LATE', 'HALF_DAY']);

  const routesSource = await readFile(new URL('../src/routes/attendanceRoutes.js', import.meta.url), 'utf8');
  ['/punch-in', '/punch-out', '/today', '/my', '/company', '/report', '/events', '/today/live'].forEach(
    (route) => assert.ok(routesSource.includes(`'${route}'`), `route ${route} wired`),
  );
  assert.ok(routesSource.includes('ATTENDANCE_CREATE_SELF'));

  const legacySource = await readFile(
    new URL('../src/controllers/attendanceController.js', import.meta.url),
    'utf8',
  );
  assert.ok(legacySource.includes('You have already punched in today'));
  assert.ok(legacySource.includes('You have already punched out today'));
  assert.ok(legacySource.includes('advanced punching'));
});

// ── TIME ─────────────────────────────────────────────────────

test('time: cross-midnight sessions stay on the clock-in day', async () => {
  const ctx = makeCtx();

  ctx.setNow('2026-09-12T23:00:00+05:30');
  const inResult = await punch(ctx, 'CLOCK_IN');
  assert.equal(inResult.snapshot.date, '2026-09-12');

  // After midnight the open session is still the target — never stranded.
  ctx.setNow('2026-09-13T01:00:00+05:30');
  const live = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps: ctx.deps });
  assert.equal(live.date, '2026-09-12');
  assert.equal(live.isToday, false);
  assert.equal(live.liveState, 'WORKING');

  await assert.rejects(() => punch(ctx, 'CLOCK_IN'), /open session from 2026-09-12/);

  const out = await punch(ctx, 'CLOCK_OUT');
  assert.equal(out.snapshot.liveState, 'COMPLETED');
  assert.equal(out.snapshot.spanMinutes, 120);
  assert.equal(ctx.AttendanceModel.rows.length, 1);
});

test('time: day boundaries use the policy timezone, never server-local', async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const ctx = makeCtx();
    // 2026-09-11T18:30:00Z is 2026-09-12 00:00 in IST.
    ctx.setNow('2026-09-11T18:30:00Z');
    const inResult = await punch(ctx, 'CLOCK_IN');
    assert.equal(inResult.snapshot.date, '2026-09-12');
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('time: explicit date targets only real open sessions', async () => {
  const ctx = makeCtx();
  ctx.setNow('2026-09-12T23:00:00+05:30');
  await punch(ctx, 'CLOCK_IN');

  ctx.setNow('2026-09-13T01:00:00+05:30');
  const out = await punch(ctx, 'CLOCK_OUT', { date: '2026-09-12' });
  assert.equal(out.snapshot.liveState, 'COMPLETED');

  await assert.rejects(() => punch(ctx, 'CLOCK_OUT', { date: '2026-09-10' }), /No attendance session/);
  await assert.rejects(() => punch(ctx, 'CLOCK_OUT', { date: '2099-01-01' }), /future date/);
  await assert.rejects(() => punch(ctx, 'CLOCK_OUT', { date: '12-09-2026' }), /YYYY-MM-DD/);
});

// ── VALIDATORS ───────────────────────────────────────────────

test('validators: action allowlist, identity refusal and key bounds', async () => {
  const { attendanceEventValidator } = await import('../src/validators/attendanceEventValidator.js');
  const { validationResult } = await import('express-validator');

  const runChain = async (body) => {
    const req = { body, query: {} };
    for (const middleware of attendanceEventValidator.slice(0, -1)) {
      await middleware.run(req);
    }
    return validationResult(req);
  };

  assert.equal((await runChain({ action: 'CLOCK_IN' })).isEmpty(), true);
  assert.equal(
    (
      await runChain({
        action: 'BREAK_START',
        workMode: null,
        date: null,
        idempotencyKey: null,
      })
    ).isEmpty(),
    true,
  );
  assert.equal((await runChain({ action: 'NAP_TIME' })).isEmpty(), false);
  assert.equal((await runChain({})).isEmpty(), false);
  assert.equal((await runChain({ action: 'CLOCK_IN', workMode: 'SPACESHIP' })).isEmpty(), false);
  assert.equal((await runChain({ action: 'CLOCK_IN', date: 'yesterday' })).isEmpty(), false);
  assert.equal((await runChain({ action: 'CLOCK_IN', idempotencyKey: 'short' })).isEmpty(), false);

  // Self-service identity can never be smuggled in the body.
  for (const field of ['companyId', 'employeeId', 'user', 'userId']) {
    const result = await runChain({ action: 'CLOCK_IN', [field]: 'someone-else' });
    assert.equal(result.isEmpty(), false, `${field} override must be refused`);
  }
});

// ── PAYROLL + 31.1 COMPAT ────────────────────────────────────

test('compat: payroll-facing projection fields stay populated; no money maths', async () => {
  const ctx = makeCtx();
  ctx.setNow('2026-09-12T09:00:00+05:30');
  await punch(ctx, 'CLOCK_IN');
  ctx.setNow('2026-09-12T18:00:00+05:30');
  await punch(ctx, 'CLOCK_OUT');

  const control = ctx.AttendanceModel.rows[0];
  // The exact 29.5 reader selection: date/status/lateMinutes/overtimeMinutes/shift.
  for (const field of ['date', 'status', 'lateMinutes', 'overtimeMinutes', 'shift', 'workMinutes', 'punchIn', 'punchOut']) {
    assert.ok(control[field] !== undefined, `projection.${field} populated`);
  }

  const [rulesSource, serviceSource] = await Promise.all([
    readFile(new URL('../src/services/attendance/attendanceEventRules.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/attendance/attendanceEventService.js', import.meta.url), 'utf8'),
  ]);
  ['netPay', 'basicSalary', 'grossSalary', 'providentFund', 'professionalTax', 'calculateSalary'].forEach(
    (term) => {
      assert.ok(!rulesSource.includes(term), `rules must not mention ${term}`);
      assert.ok(!serviceSource.includes(term), `service must not mention ${term}`);
    },
  );
  assert.ok(!rulesSource.includes('mongoose'));
});

test('compat: 31.1 policy generation is pinned to the session', async () => {
  const ctx = makeCtx({ policy: policyAllModes() });
  await punch(ctx, 'CLOCK_IN');
  assert.equal(ctx.AttendanceModel.rows[0].policyVersion, 3);
});

test('service: legacy-interleaved double-open sessions stay resolvable', async () => {
  const ctx = makeCtx();
  // Yesterday left open via the classic path, today opened the same way.
  await ctx.AttendanceModel.create({
    companyId: COMPANY_A,
    user: USER_A,
    date: '2026-09-11',
    punchIn: new Date('2026-09-11T09:00:00+05:30'),
    status: 'PRESENT',
    eventSeq: 0,
  });
  await ctx.AttendanceModel.create({
    companyId: COMPANY_A,
    user: USER_A,
    date: '2026-09-12',
    punchIn: new Date('2026-09-12T09:00:00+05:30'),
    status: 'PRESENT',
    eventSeq: 0,
  });

  const live = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps: ctx.deps });
  assert.equal(live.date, '2026-09-12');
  assert.deepEqual(live.otherOpenSession, { date: '2026-09-11', liveState: 'WORKING' });

  ctx.setNow('2026-09-12T10:00:00+05:30');
  const closed = await punch(ctx, 'CLOCK_OUT', { date: '2026-09-11' });
  assert.equal(closed.snapshot.liveState, 'COMPLETED');
  assert.equal(closed.snapshot.date, '2026-09-11');

  const after = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps: ctx.deps });
  assert.equal(after.otherOpenSession, null);
});

test('merge: fresh duplicate CLOCK_IN replays instead of a phantom 409', async () => {
  const ctx = makeCtx();
  const first = await punch(ctx, 'CLOCK_IN', { idempotencyKey: 'merge-dup-key-a1' });
  assert.equal(first.replayed, false);

  // Same action, fresh key, seconds later (double-click / render-gap).
  ctx.setNow('2026-09-12T09:00:05+05:30');
  const second = await punch(ctx, 'CLOCK_IN', { idempotencyKey: 'merge-dup-key-a2' });
  assert.equal(second.replayed, true);
  assert.equal(second.event.id, first.event.id);
  assert.equal(second.snapshot.liveState, 'WORKING');
  assert.equal(ctx.AttendanceEventModel.rows.length, 1);
  assert.equal(ctx.AttendanceModel.rows.length, 1);
});

test('merge: fresh duplicate break/out actions replay mid-flow', async () => {
  const ctx = makeCtx();
  await punch(ctx, 'CLOCK_IN');

  ctx.setNow('2026-09-12T09:01:00+05:30');
  await punch(ctx, 'BREAK_START', { idempotencyKey: 'merge-dup-key-b1' });
  ctx.setNow('2026-09-12T09:01:04+05:30');
  const dupStart = await punch(ctx, 'BREAK_START', { idempotencyKey: 'merge-dup-key-b2' });
  assert.equal(dupStart.replayed, true);
  assert.equal(dupStart.snapshot.liveState, 'ON_BREAK');

  ctx.setNow('2026-09-12T09:05:00+05:30');
  await punch(ctx, 'BREAK_END', { idempotencyKey: 'merge-dup-key-c1' });
  ctx.setNow('2026-09-12T09:05:03+05:30');
  const dupEnd = await punch(ctx, 'BREAK_END', { idempotencyKey: 'merge-dup-key-c2' });
  assert.equal(dupEnd.replayed, true);
  assert.equal(dupEnd.snapshot.liveState, 'WORKING');

  ctx.setNow('2026-09-12T18:00:00+05:30');
  await punch(ctx, 'CLOCK_OUT', { idempotencyKey: 'merge-dup-key-d1' });
  ctx.setNow('2026-09-12T18:00:02+05:30');
  const dupOut = await punch(ctx, 'CLOCK_OUT', { idempotencyKey: 'merge-dup-key-d2' });
  assert.equal(dupOut.replayed, true);
  assert.equal(dupOut.snapshot.liveState, 'COMPLETED');

  // Exactly 4 facts for 8 dispatches.
  assert.equal(ctx.AttendanceEventModel.rows.length, 4);
});

test('merge: wrong-state actions never merge, even when fresh', async () => {
  const ctx = makeCtx();
  await punch(ctx, 'CLOCK_IN');

  ctx.setNow('2026-09-12T09:00:05+05:30');
  await assert.rejects(() => punch(ctx, 'BREAK_END'), /no active break/);

  await punch(ctx, 'BREAK_START');
  ctx.setNow('2026-09-12T09:00:08+05:30');
  await assert.rejects(() => punch(ctx, 'CLOCK_OUT'), /End your break/);

  assert.equal(ctx.AttendanceEventModel.rows.length, 2);
});
