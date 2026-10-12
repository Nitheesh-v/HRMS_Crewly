// Weekly-hours flexi target — hermetic suite.
//
// "Finish the weekly hours goal early, rest the remaining working days."
// No MongoDB, no Redis, no network: every collaborator is a stub. The
// rules module is pure; the service is exercised with injected models.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const COMPANY = 'cccccccccccccccccccccccc';
const USER = 'dddddddddddddddddddddddd';

const [rules, service, notificationMod] = await Promise.all([
  import('../src/services/attendance/attendanceWeeklyTargetRules.js'),
  import('../src/services/attendance/attendanceWeeklyTargetService.js'),
  import('../src/models/Notification.js'),
]);
const Notification = notificationMod.default;

const {
  weekWindowFor,
  achievedMinutesBefore,
  achievedMinutesThrough,
  normaliseWeeklyTargetPolicy,
  restDayDecision,
  crossingDecision,
} = rules;
const { getWeekContext, onControlDayFinalized, materializeRestDays } = service;

// ── chainable AttendanceModel stub ───────────────────────────
const makeAttendanceStub = ({ rows = [], onCreate = null, createError = null } = {}) => {
  const created = [];
  const queries = [];
  const stub = {
    created,
    queries,
    find(query) {
      queries.push(query);
      return {
        select() {
          return this;
        },
        lean() {
          return Promise.resolve(rows);
        },
      };
    },
    create(doc) {
      if (createError) return Promise.reject(createError);
      if (onCreate) onCreate(doc);
      created.push(doc);
      return Promise.resolve(doc);
    },
  };
  return stub;
};

const ENABLED = {
  weeklyTarget: {
    enabled: true,
    targetMinutes: 2400,
    restDayMode: 'AUTO_MARK',
    includeApprovedOvertime: false,
  },
};

// ═══ 1. Week window (Monday→Sunday, company-local, month-boundary safe) ═══

test('weekWindowFor: Monday through Sunday, across month and year bounds', () => {
  // Thu 1 Oct 2026 → week starts Mon 28 Sep 2026.
  assert.deepEqual(weekWindowFor('2026-10-01'), { weekStart: '2026-09-28', weekEnd: '2026-10-04' });
  // Monday itself is identity.
  assert.deepEqual(weekWindowFor('2026-10-05'), { weekStart: '2026-10-05', weekEnd: '2026-10-11' });
  // Sunday 4 Oct 2026 → still the 28 Sep week (week ENDS Sunday).
  assert.deepEqual(weekWindowFor('2026-10-04'), { weekStart: '2026-09-28', weekEnd: '2026-10-04' });
  // 1 Jan 2027 is a Friday → week starts Mon 29 Dec 2026 (year boundary).
  assert.deepEqual(weekWindowFor('2027-01-01'), { weekStart: '2026-12-28', weekEnd: '2027-01-03' });
  // Bad input stays null-shaped.
  assert.deepEqual(weekWindowFor('garbage'), { weekStart: null, weekEnd: null });
});

// ═══ 2. Policy normalisation ═══

test('normaliseWeeklyTargetPolicy: absent, legacy and junk shapes fall back disabled-safe', () => {
  assert.deepEqual(normaliseWeeklyTargetPolicy(null), {
    enabled: false, targetMinutes: 2400, restDayMode: 'AUTO_MARK', includeApprovedOvertime: false,
  });
  assert.equal(normaliseWeeklyTargetPolicy({ weeklyTarget: { enabled: true } }).targetMinutes, 2400);
  // Clamped to the representable window.
  assert.equal(
    normaliseWeeklyTargetPolicy({ weeklyTarget: { enabled: true, targetMinutes: 5 } }).targetMinutes,
    60,
  );
  assert.equal(
    normaliseWeeklyTargetPolicy({ weeklyTarget: { enabled: true, targetMinutes: 999999 } }).targetMinutes,
    10080,
  );
  // Unknown mode snaps to AUTO_MARK, not the other way.
  assert.equal(
    normaliseWeeklyTargetPolicy({ weeklyTarget: { enabled: true, restDayMode: 'WEIRD' } }).restDayMode,
    'AUTO_MARK',
  );
  assert.equal(
    normaliseWeeklyTargetPolicy({ weeklyTarget: { enabled: 'yes' } }).enabled,
    false,
  );
});

// ═══ 3. Achieved minutes — strictly-before semantics and OT flag ═══

test('achievedMinutesBefore/Through: workMinutes always, overtime only when flagged', () => {
  const weekRows = [
    { date: '2026-10-05', workMinutes: 600, overtimeMinutes: 120 },
    { date: '2026-10-06', workMinutes: 900, overtimeMinutes: 60 },
    { date: '2026-10-07', workMinutes: 480, overtimeMinutes: 0 },
  ];
  // Before the 7th: 600 + 900 = 1500; overtime NOT counted by default.
  assert.equal(achievedMinutesBefore({ weekRows, targetDate: '2026-10-07' }), 1500);
  assert.equal(
    achievedMinutesBefore({ weekRows, targetDate: '2026-10-07', includeApprovedOvertime: true }),
    1680,
  );
  // Strictly before: the target date's own minutes are excluded.
  assert.equal(achievedMinutesBefore({ weekRows, targetDate: '2026-10-06' }), 600);
  assert.equal(achievedMinutesThrough({ weekRows }), 1980);
  assert.equal(achievedMinutesThrough({ weekRows, includeApprovedOvertime: true }), 2160);
});

// ═══ 4. Crossing decision — exactly-once semantics ═══

test('crossingDecision: fires only on the day the target is first reached', () => {
  // Mon 600 + Tue 900 = 1500 (< 2400) → not yet.
  const notYet = crossingDecision({
    policyBlock: ENABLED,
    weekRows: [
      { date: '2026-10-05', workMinutes: 600 },
      { date: '2026-10-06', workMinutes: 900 },
    ],
    date: '2026-10-06',
  });
  assert.equal(notYet.crossed, false);
  assert.equal(notYet.reason, 'NOT_YET');

  // Wed 900 → through = 2400 exactly → crosses TODAY.
  const exact = crossingDecision({
    policyBlock: ENABLED,
    weekRows: [
      { date: '2026-10-05', workMinutes: 600 },
      { date: '2026-10-06', workMinutes: 900 },
      { date: '2026-10-07', workMinutes: 900 },
    ],
    date: '2026-10-07',
  });
  assert.equal(exact.crossed, true);
  assert.equal(exact.reason, 'CROSSED_TODAY');
  assert.equal(exact.weekStart, '2026-10-05');

  // A later day in the same qualified week does NOT re-cross.
  const later = crossingDecision({
    policyBlock: ENABLED,
    weekRows: [
      { date: '2026-10-05', workMinutes: 2400 },
      { date: '2026-10-07', workMinutes: 0 },
    ],
    date: '2026-10-07',
  });
  assert.equal(later.crossed, false);
  assert.equal(later.reason, 'ALREADY_QUALIFIED');

  // Disabled policy never crosses.
  assert.equal(crossingDecision({ policyBlock: null, weekRows: [], date: '2026-10-07' }).crossed, false);
});

// ═══ 5. Rest-day decision — precedence ladder ═══

test('restDayDecision: qualified elapsed unworked days become rest, in strict precedence', () => {
  const weekRows = [
    { date: '2026-10-05', workMinutes: 1500, overtimeMinutes: 0 },
    { date: '2026-10-06', workMinutes: 900, overtimeMinutes: 0 },
  ];

  // Thu 2026-10-08: Mon+Tue = 2400 ≥ target → earned rest.
  const rest = restDayDecision({
    policyBlock: ENABLED, weekRows, date: '2026-10-08', todayKey: '2026-10-10',
  });
  assert.equal(rest.rest, true);
  assert.equal(rest.reason, 'TARGET_MET');
  assert.equal(rest.achievedMinutes, 2400);
  assert.equal(rest.weekStart, '2026-10-05');

  // Same day, but hours still short → not rest.
  const short = restDayDecision({
    policyBlock: ENABLED,
    weekRows: [{ date: '2026-10-05', workMinutes: 600 }],
    date: '2026-10-08',
    todayKey: '2026-10-10',
  });
  assert.equal(short.rest, false);
  assert.equal(short.reason, 'WEEK_NOT_QUALIFIED');

  // Approved leave always wins over rest (leave stays leave).
  const onLeave = restDayDecision({
    policyBlock: ENABLED, weekRows, date: '2026-10-08',
    leaveDates: new Set(['2026-10-08']), todayKey: '2026-10-10',
  });
  assert.equal(onLeave.rest, false);
  assert.equal(onLeave.reason, 'ON_APPROVED_LEAVE');

  // Holidays don't participate.
  const holiday = restDayDecision({
    policyBlock: ENABLED, weekRows, date: '2026-10-08',
    holidayDates: new Set(['2026-10-08']), todayKey: '2026-10-10',
  });
  assert.equal(holiday.rest, false);
  assert.equal(holiday.reason, 'HOLIDAY');

  // A day that already has a row is never overwritten (the service passes
  // hasRow from the fetched Attendance rows).
  const hasRow = restDayDecision({
    policyBlock: ENABLED, weekRows, date: '2026-10-06',
    hasRow: true, todayKey: '2026-10-10',
  });
  assert.equal(hasRow.rest, false);
  assert.equal(hasRow.reason, 'HAS_ROW');

  // Today/future never materializes (absence is end-of-day truth).
  const today = restDayDecision({
    policyBlock: ENABLED, weekRows, date: '2026-10-10', todayKey: '2026-10-10',
  });
  assert.equal(today.rest, false);
  assert.equal(today.reason, 'NOT_ELAPSED');

  // SUGGEST_ONLY never auto-marks.
  const suggest = restDayDecision({
    policyBlock: { weeklyTarget: { ...ENABLED.weeklyTarget, restDayMode: 'SUGGEST_ONLY' } },
    weekRows, date: '2026-10-08', todayKey: '2026-10-10',
  });
  assert.equal(suggest.rest, false);
  assert.equal(suggest.reason, 'SUGGEST_ONLY');

  // Disabled policy: nothing.
  const off = restDayDecision({
    policyBlock: { weeklyTarget: { ...ENABLED.weeklyTarget, enabled: false } },
    weekRows, date: '2026-10-08', todayKey: '2026-10-10',
  });
  assert.equal(off.rest, false);
  assert.equal(off.reason, 'POLICY_DISABLED');

  // No carry across weeks: last week's hours never qualify this week.
  const otherWeek = restDayDecision({
    policyBlock: ENABLED,
    weekRows: [
      { date: '2026-09-28', workMinutes: 1500 },
      { date: '2026-09-29', workMinutes: 900 },
    ],
    date: '2026-10-08', // a different (later) week with no worked rows
    todayKey: '2026-10-10',
  });
  assert.equal(otherWeek.rest, false);
  assert.equal(otherWeek.reason, 'WEEK_NOT_QUALIFIED');
});

// ═══ 6. materializeRestDays — writes, skips, idempotence, races ═══

test('materializeRestDays: writes rest rows for elapsed unworked days of a qualified week', async () => {
  const stub = makeAttendanceStub({
    rows: [
      { date: '2026-10-05', status: 'PRESENT', workMinutes: 1500, overtimeMinutes: 0 },
      { date: '2026-10-06', status: 'PRESENT', workMinutes: 900, overtimeMinutes: 0 },
    ],
  });
  const out = await materializeRestDays({
    companyId: COMPANY,
    userId: USER,
    startKey: '2026-10-01',
    endKey: '2026-10-31',
    todayKey: '2026-10-10',
    AttendanceModel: stub,
    LeaveModel: null,
    HolidayModel: null,
    policy: { ...ENABLED, timezone: 'Asia/Kolkata' },
  });
  assert.equal(out.created, 3); // Wed 07, Thu 08, Fri 09 (Sat 10 is not elapsed)
  assert.ok(stub.created.every((doc) => doc.status === 'WEEKLY_TARGET_OFF'));
  assert.ok(stub.created.every((doc) => doc.companyId === COMPANY && doc.user === USER));
  assert.ok(stub.created.every((doc) => doc.weekTargetMinutes === undefined));
  assert.equal(stub.created[0].weeklyTarget.weekStart, '2026-10-05');
  assert.equal(stub.created[0].weeklyTarget.targetMinutes, 2400);
  assert.equal(stub.created[0].weeklyTarget.achievedMinutes, 2400);
});

test('materializeRestDays: leave, holidays, existing rows and race duplicates are respected', async () => {
  const stub = makeAttendanceStub({
    rows: [
      { date: '2026-10-05', status: 'PRESENT', workMinutes: 2400, overtimeMinutes: 0 },
      { date: '2026-10-06', status: 'LATE', workMinutes: 480, overtimeMinutes: 0 },
    ],
  });
  const out = await materializeRestDays({
    companyId: COMPANY,
    userId: USER,
    startKey: '2026-10-05',
    endKey: '2026-10-09',
    todayKey: '2026-10-10',
    AttendanceModel: stub,
    LeaveModel: {
      find: () => ({
        select: () => ({
          lean: () => Promise.resolve([
            { startDate: new Date('2026-10-07T00:00:00.000Z'), endDate: new Date('2026-10-07T00:00:00.000Z') },
          ]),
        }),
      }),
    },
    HolidayModel: {
      find: () => ({
        select: () => ({
          lean: () => Promise.resolve([{ date: new Date('2026-10-08T00:00:00.000Z') }]),
        }),
      }),
    },
    policy: { ...ENABLED, timezone: 'Asia/Kolkata' },
  });
  // 05+06 have rows, 07 = approved leave, 08 = holiday → only 09 is rest.
  assert.equal(out.created, 1);
  assert.deepEqual(stub.created.map((d) => d.date), ['2026-10-09']);
});

test('materializeRestDays: idempotent on re-run and tolerant of E11000 races', async () => {
  // Second run: the rest rows from run one are now rows → nothing to create.
  const rows = [
    { date: '2026-10-05', status: 'PRESENT', workMinutes: 2400, overtimeMinutes: 0 },
    { date: '2026-10-06', status: 'WEEKLY_TARGET_OFF', workMinutes: 0, overtimeMinutes: 0 },
  ];
  const secondRun = makeAttendanceStub({ rows });
  const out2 = await materializeRestDays({
    companyId: COMPANY, userId: USER,
    startKey: '2026-10-06', endKey: '2026-10-06',
    todayKey: '2026-10-10',
    AttendanceModel: secondRun, LeaveModel: null, HolidayModel: null,
    policy: { ...ENABLED, timezone: 'Asia/Kolkata' },
  });
  assert.equal(out2.created, 0);

  // A lost insert race (E11000 on the unique {user,date} index) is a win by
  // a peer, not an error.
  const racingStub = makeAttendanceStub({
    rows: [{ date: '2026-10-05', status: 'PRESENT', workMinutes: 2400, overtimeMinutes: 0 }],
    createError: Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
  });
  const out3 = await materializeRestDays({
    companyId: COMPANY, userId: USER,
    startKey: '2026-10-06', endKey: '2026-10-06',
    todayKey: '2026-10-10',
    AttendanceModel: racingStub, LeaveModel: null, HolidayModel: null,
    policy: { ...ENABLED, timezone: 'Asia/Kolkata' },
  });
  assert.equal(out3.created, 0);
});

test('materializeRestDays: disabled policy or SUGGEST_ONLY mode writes nothing', async () => {
  const off = await materializeRestDays({
    companyId: COMPANY, userId: USER,
    startKey: '2026-10-05', endKey: '2026-10-09', todayKey: '2026-10-10',
    AttendanceModel: makeAttendanceStub({ rows: [] }), LeaveModel: null, HolidayModel: null,
    policy: { weeklyTarget: { ...ENABLED.weeklyTarget, enabled: false } },
  });
  assert.equal(off.created, 0);
  assert.equal(off.skipped, 'POLICY_OFF');

  const suggest = await materializeRestDays({
    companyId: COMPANY, userId: USER,
    startKey: '2026-10-05', endKey: '2026-10-09', todayKey: '2026-10-10',
    AttendanceModel: makeAttendanceStub({ rows: [] }), LeaveModel: null, HolidayModel: null,
    policy: { weeklyTarget: { ...ENABLED.weeklyTarget, restDayMode: 'SUGGEST_ONLY' } },
  });
  assert.equal(suggest.created, 0);
  assert.equal(suggest.skipped, 'POLICY_OFF');
});

// ═══ 7. Week context + crossing nudge ═══

test('getWeekContext: sums the running week and reports qualification', async () => {
  const stub = makeAttendanceStub({
    rows: [
      { date: '2026-10-05', status: 'PRESENT', workMinutes: 1500, overtimeMinutes: 300 },
      { date: '2026-10-06', status: 'PRESENT', workMinutes: 900, overtimeMinutes: 0 },
    ],
  });
  const ctx = await getWeekContext({
    companyId: COMPANY, userId: USER, date: '2026-10-06',
    AttendanceModel: stub, policy: { ...ENABLED, timezone: 'Asia/Kolkata' },
  });
  assert.equal(ctx.enabled, true);
  assert.equal(ctx.weekStart, '2026-10-05');
  assert.equal(ctx.achievedMinutes, 2400); // OT excluded by default
  assert.equal(ctx.remainingMinutes, 0);
  assert.equal(ctx.qualified, true);

  const ctxOt = await getWeekContext({
    companyId: COMPANY, userId: USER, date: '2026-10-06',
    AttendanceModel: stub,
    policy: { weeklyTarget: { ...ENABLED.weeklyTarget, includeApprovedOvertime: true }, timezone: 'Asia/Kolkata' },
  });
  assert.equal(ctxOt.achievedMinutes, 2700);
});

test('onControlDayFinalized: crossing fires exactly-once via the eventKey index', async () => {
  const originalCreate = Notification.create;
  const inserted = [];
  try {
    Notification.create = async (doc) => {
      if (inserted.some((d) => d.eventKey === doc.eventKey)) {
        throw Object.assign(new Error('E11000'), { code: 11000 });
      }
      inserted.push(doc);
      return doc;
    };

    // Tue push crosses the 2400 target (Mon 1500 + Tue 900).
    const res = await onControlDayFinalized({
      companyId: COMPANY, userId: USER, date: '2026-10-06',
      policy: { ...ENABLED, timezone: 'Asia/Kolkata' },
      AttendanceModel: makeAttendanceStub({
        rows: [
          { date: '2026-10-05', workMinutes: 1500, overtimeMinutes: 0 },
          { date: '2026-10-06', workMinutes: 900, overtimeMinutes: 0 },
        ],
      }),
    });
    assert.equal(res.crossed, true);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].eventKey, `WEEKLY_TARGET_MET:${USER}:2026-10-05`);
    assert.equal(inserted[0].type, 'ATTENDANCE');

    // A retried punch for the same week: E11000 → treated as success.
    const retry = await onControlDayFinalized({
      companyId: COMPANY, userId: USER, date: '2026-10-06',
      policy: { ...ENABLED, timezone: 'Asia/Kolkata' },
      AttendanceModel: makeAttendanceStub({
        rows: [
          { date: '2026-10-05', workMinutes: 1500, overtimeMinutes: 0 },
          { date: '2026-10-06', workMinutes: 900, overtimeMinutes: 0 },
        ],
      }),
    });
    assert.equal(retry.crossed, true);
    assert.equal(retry.reason, 'ALREADY_NOTIFIED');
    assert.equal(inserted.length, 1);
  } finally {
    Notification.create = originalCreate;
  }
});

test('onControlDayFinalized: no crossing, no notification; failures never throw', async () => {
  const originalCreate = Notification.create;
  const inserted = [];
  try {
    Notification.create = async (doc) => {
      inserted.push(doc);
      return doc;
    };
    const quiet = await onControlDayFinalized({
      companyId: COMPANY, userId: USER, date: '2026-10-06',
      policy: { ...ENABLED, timezone: 'Asia/Kolkata' },
      AttendanceModel: makeAttendanceStub({
        rows: [{ date: '2026-10-06', workMinutes: 480, overtimeMinutes: 0 }],
      }),
    });
    assert.equal(quiet.crossed, false);
    assert.equal(inserted.length, 0);

    // A broken finder must never bubble — the punch cannot fail on a nudge.
    const boom = await onControlDayFinalized({
      companyId: COMPANY, userId: USER, date: '2026-10-06',
      policy: { ...ENABLED, timezone: 'Asia/Kolkata' },
      AttendanceModel: {
        find: () => { throw new Error('db down'); },
      },
    });
    assert.equal(boom.crossed, false);
    assert.equal(boom.reason, 'ERROR');
  } finally {
    Notification.create = originalCreate;
  }
});

// ═══ 8. Payroll parity — earned rest is paid, never LOP ═══

test('computeAutomaticSummary: WEEKLY_TARGET_OFF counts as paid — no absent, no LOP', async () => {
  const { computeAutomaticSummary } = await import('../src/services/payroll/monthlyInputRules.js');
  const summary = computeAutomaticSummary({
    month: '2026-10',
    workingDays: 23,
    attendance: [
      { date: '2026-10-05', status: 'PRESENT', lateMinutes: 0, overtimeMinutes: 0 },
      { date: '2026-10-06', status: 'PRESENT', lateMinutes: 0, overtimeMinutes: 0 },
      { date: '2026-10-07', status: 'WEEKLY_TARGET_OFF', lateMinutes: 0, overtimeMinutes: 0 },
      { date: '2026-10-08', status: 'WEEKLY_TARGET_OFF', lateMinutes: 0, overtimeMinutes: 0 },
      { date: '2026-10-09', status: 'HALF_DAY', lateMinutes: 0, overtimeMinutes: 0 },
    ],
    leaves: [],
  });
  assert.equal(summary.weeklyTargetOffDays, 2);
  assert.equal(summary.presentDays, 2);
  assert.equal(summary.halfDays, 1);
  // counted = 2 + 0.5 + 2 = 4.5 of 23 working days — the 4.5 proves the two
  // rest days count as PAID time (without them counted would be 2.5).
  assert.equal(summary.absentDays, 18.5);
  assert.equal(summary.lopDays, 18.5);
  assert.equal(summary.lopLeaveIds.length, 0);
});

test('computeAutomaticSummary: rest days cannot mask other absences', async () => {
  const { computeAutomaticSummary } = await import('../src/services/payroll/monthlyInputRules.js');
  const summary = computeAutomaticSummary({
    month: '2026-10',
    workingDays: 23,
    attendance: [
      { date: '2026-10-05', status: 'WEEKLY_TARGET_OFF', lateMinutes: 0, overtimeMinutes: 0 },
    ],
    leaves: [],
  });
  assert.equal(summary.weeklyTargetOffDays, 1);
  // 23 working days − 1 earned-rest day = 22 still unaccounted → absent.
  assert.equal(summary.absentDays, 22);
  assert.equal(summary.lopDays, 22);
});

// ═══ 9. Source pins — the seams that must not silently regress ═══

test('source pins: model enum, policy block, seams and route are all present', async () => {
  const [attendanceSrc, policySrc, policyRulesSrc, policyServiceSrc, timesheetSrc, eventSrc, routesSrc, eventControllerSrc, pkg] = await Promise.all([
    readFile(new URL('../src/models/Attendance.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/models/AttendancePolicy.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/attendance/attendancePolicyRules.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/attendance/attendancePolicyService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/attendance/attendanceTimesheetService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/attendance/attendanceEventService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/attendance/attendanceRoutes.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/attendance/attendanceEventController.js', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);

  // Attendance status enum carries the additive status…
  assert.ok(attendanceSrc.includes('"WEEKLY_TARGET_OFF"'), 'Attendance status enum');
  // …plus the why-subdoc…
  assert.ok(attendanceSrc.includes('weeklyTarget: {'), 'Attendance weeklyTarget meta');
  // …and the Phase 31.8 approved-only OT contract is untouched.
  assert.ok(attendanceSrc.includes('overtimeMinutes'), '31.8 overtimeMinutes contract intact');

  // Policy: the opt-in block with the locked defaults.
  assert.ok(policySrc.includes("default: 'AUTO_MARK'"), 'AUTO_MARK default');
  assert.ok(policySrc.includes('targetMinutes: { type: Number, default: 2400, min: 60, max: 10080 }'), 'target default 2400, capped');
  assert.ok(policyRulesSrc.includes('validateWeeklyTarget'), 'policy validator');
  assert.ok(policyServiceSrc.includes("'weeklyTarget'"), 'draft whitelist');

  // Timesheet day parity: earned rest is weekly-off-equivalent, paid.
  assert.ok(timesheetSrc.includes("control?.status === 'WEEKLY_TARGET_OFF'"), 'buildDay parity override');
  assert.ok(timesheetSrc.includes('TIMESHEET_OUTCOME.WEEKLY_OFF'), 'weekly-off bucket');

  // Punch seam: crossing check after the control write, fire-and-forget.
  assert.ok(eventSrc.includes('onControlDayFinalized'), 'punch seam');
  assert.ok(eventSrc.includes('.catch('), 'nudge can never fail the punch');

  // Route + controller.
  assert.ok(routesSrc.includes("'/weekly-target'"), 'GET /weekly-target');
  assert.ok(eventControllerSrc.includes('getMyWeeklyTarget'), 'controller');

  // Suite is registered in the full gate.
  assert.ok(pkg.includes('test/attendanceWeeklyTarget.test.js'), 'registered in test:all');
});
