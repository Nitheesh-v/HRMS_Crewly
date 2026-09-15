// Phase 31.5 — Attendance Regularization & Exception Center (hermetic suite).
//
// No MongoDB, no Redis, no network: request/attendance/event/leave/
// payroll-period/work-mode/user models, policy reads, org scope,
// notify and audit are injected fakes; the REAL regularization
// rules, regularization service, event service (rebuild reuse seam
// + live interplay), scheduleEngine evaluation, validators and
// permission registry run against them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const USER_B = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const MGR_A = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const MGR_UNRELATED = 'aaaaaaaaaaaaaaaaaaaaaaa4';
const TODAY = '2026-09-15'; // a Tuesday
const MONDAY = '2026-09-14';
const SUNDAY = '2026-09-13';

const [regRules, regService, eventService, sched, policyRules, regValidator, registry] =
  await Promise.all([
    import('../src/services/attendance/attendanceRegularizationRules.js'),
    import('../src/services/attendance/attendanceRegularizationService.js'),
    import('../src/services/attendance/attendanceEventService.js'),
    import('../src/utils/scheduleEngine.js'),
    import('../src/services/attendance/attendancePolicyRules.js'),
    import('../src/validators/attendanceRegularizationValidator.js'),
    import('../src/utils/permissionRegistry.js'),
  ]);

const {
  REG_TYPE,
  REG_KIND,
  EXPLANATION_CODE,
  REQUEST_STATUS,
  kindOf,
  isRegularizationType,
  conflictGroupOf,
  isValidDayString,
  dayKeyInZone,
  toDateOrNull,
  windowCheck,
  validateProposal,
  buildEffectiveTimeline,
  canTransition,
  cancelEligibility,
  reviewEligibility,
  validateReason,
  validateReviewReason,
} = regRules;
const {
  serializeRegularization,
  submitRegularization,
  listMyRegularizations,
  listPendingRegularizations,
  getRegularization,
  rebuildDayProjection,
  decideRegularization,
  cancelRegularization,
} = regService;
const { recordEvent, derivePolicyOutcome, resolveDayScheduleRule, resolveRuleFromRecord } = eventService;
const { WORK_MODE } = policyRules;

// ── Fakes ────────────────────────────────────────────────────

const norm = (value) =>
  value && typeof value === 'object' && !(value instanceof Date) && value._id !== undefined
    ? String(value._id)
    : String(value ?? '');

const getPath = (row, key) =>
  String(key)
    .split('.')
    .reduce((acc, part) => (acc == null ? undefined : acc[part]), row);

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((clause) => matches(row, clause));
    const actual = getPath(row, key);
    if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      if (value.$in !== undefined) return value.$in.map(norm).includes(norm(actual));
      if (value.$ne !== undefined) return norm(actual) !== norm(value.$ne);
      if (value.$lte !== undefined) return norm(actual) <= norm(value.$lte);
      if (value.$gte !== undefined) return norm(actual) >= norm(value.$gte);
      if (value.$exists !== undefined) {
        const exists = actual !== undefined;
        return value.$exists ? exists : !exists;
      }
      return true;
    }
    return norm(actual) === norm(value);
  });

const chain = (resolve) => {
  const self = {
    populate: () => self,
    sort: () => self,
    lean: () => self,
    select: () => self,
    then: (resolvePromise, rejectPromise) =>
      Promise.resolve().then(resolve).then(resolvePromise, rejectPromise),
  };
  return self;
};

const withToObject = (row) => ({ ...row, toObject() { return { ...this }; } });

const makeFakeRequestModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  let seq = rows.length + 1;
  return {
    rows,
    findOne: (filter) => chain(() => rows.find((row) => matches(row, filter)) || null),
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    create: async (doc) => {
      // Mirrors schema defaults the real model applies on write.
      const row = {
        status: 'PENDING',
        authorizationOverride: false,
        appliedAt: null,
        ...doc,
        _id: `rg${seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      seq += 1;
      rows.push(row);
      return withToObject(row);
    },
    findOneAndUpdate: async (filter, update, opts = {}) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, update.$set || {});
      row.updatedAt = new Date();
      return opts.new ? withToObject(row) : { ...row };
    },
  };
};

const makeFakeAttendanceModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  let seq = rows.length + 1;
  return {
    rows,
    findOne: (filter) => chain(() => rows.find((row) => matches(row, filter)) || null),
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    findOneAndUpdate: async (filter, update, opts = {}) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, update.$set || {});
      if (update.$inc) {
        for (const [key, delta] of Object.entries(update.$inc)) row[key] = Number(row[key] || 0) + delta;
      }
      return opts.new ? withToObject(row) : { ...row };
    },
    create: async (doc) => {
      const dup = rows.find((row) => String(row.user) === String(doc.user) && String(row.date) === String(doc.date));
      if (dup) { const err = new Error('duplicate key'); err.code = 11000; throw err; }
      const row = { ...doc, _id: `att${seq}`, id: `att${seq}` };
      seq += 1;
      rows.push(row);
      return withToObject(row);
    },
  };
};

const makeFakeEventModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  let seq = rows.length + 1;
  return {
    rows,
    findOne: (filter) => chain(() => {
      const found = rows.find((row) => matches(row, filter));
      return found ? { ...found } : null;
    }),
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    create: async (doc) => {
      const row = { ...doc, _id: `evt${seq}`, id: `evt${seq}` };
      seq += 1;
      rows.push(row);
      return withToObject(row);
    },
  };
};

const readOnlyModel = (seed, label) => {
  const rows = seed.map((row) => ({ ...row }));
  return {
    rows,
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    findOne: (filter) => chain(() => rows.find((row) => matches(row, filter)) || null),
    create: async () => { throw new Error(`${label} must never be written by 31.5`); },
    findOneAndUpdate: async () => { throw new Error(`${label} must never be written by 31.5`); },
  };
};

const makeFakeUserModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  return {
    rows,
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    findById: (id) => chain(() => rows.find((row) => String(row._id) === String(id)) || null),
  };
};

const EMP = { _id: USER_A, name: 'Asha Employee', reportingTo: MGR_A };
const MGR = { _id: MGR_A, name: 'Mohan Manager', role: 'MANAGER' };
const HR = { _id: 'aaaaaaaaaaaaaaaaaaaaaaa5', name: 'Hari HR', role: 'HR_MANAGER' };
const ADMIN = { _id: 'aaaaaaaaaaaaaaaaaaaaaaa6', name: 'Ada Admin', role: 'COMPANY_ADMIN' };

// Validation-clean (31.1 validateEvaluationInput runs full policy
// validation inside the rebuild): zero grace keeps the late
// boundary exact, breaks excluded mirrors the default company.
const makePolicy = (overrides = {}) => ({
  version: 1,
  name: 'Standard Policy',
  timezone: 'Asia/Kolkata',
  locationEnforcement: 'DISABLED',
  breaks: { enabled: true, includeInWorkedTime: false, dailyLimitMinutes: null },
  workModes: { office: true, wfh: true, field: true, clientSite: true, businessTravel: true },
  workModeApproval: { wfh: true, field: true, clientSite: true, businessTravel: true },
  missingPunch: { keepUnresolved: true, allowRegularization: true, regularizationWindowDays: 7 },
  grace: { lateInMinutes: 0, earlyOutMinutes: 0 },
  thresholds: { fullDayMinutes: 480, halfDayMinutes: 240 },
  overtime: { trackingEnabled: false, minimumExtraMinutes: 0, approvalRequired: false, weekendEligible: false, holidayEligible: false },
  weekendHoliday: { allowWorkOnWeeklyOff: false, allowWorkOnHoliday: false },
  ...overrides,
});

const testEngine = () => ({
  resolveShiftForUser: async () => ({ shift: null, schedule: null, source: 'DEFAULT' }),
  resolveScheduleForUser: async () => null,
  getWorkingDaysForUser: async () => ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  getHolidaysForUser: async () => [],
  holidayOnDate: async () => null,
  evaluatePunch: sched.evaluatePunch,
  dayKey: sched.dayKey,
});

const testResolveScheduleRule = async () => ({
  rule: {
    name: 'Default', startTime: '09:00', endTime: '18:00', breakMinutes: 0,
    graceMinutes: 0, minWorkingHours: 8, halfDayHours: 4, overtimeEligible: false,
  },
  shift: null,
  schedule: null,
  source: 'DEFAULT',
});

const makeSvcCtx = ({
  policy = makePolicy(),
  requests = [],
  attendance = [],
  events = [],
  leaves = [],
  periods = [],
  workModes = [],
  users = [],
} = {}) => {
  const RequestModel = makeFakeRequestModel(requests);
  const AttendanceModel = makeFakeAttendanceModel(attendance);
  const AttendanceEventModel = makeFakeEventModel(events);
  const LeaveModel = readOnlyModel(leaves, 'Leave');
  const PayrollPeriodModel = readOnlyModel(periods, 'PayrollPeriod');
  const WorkModeRequestModel = readOnlyModel(workModes, 'AttendanceWorkModeRequest');
  const UserModel = makeFakeUserModel(users);
  const notifications = [];
  const audits = [];
  const base = {
    today: TODAY,
    policyReader: async () => ({ policy, configured: true, hasActive: true }),
    RequestModel,
    AttendanceModel,
    AttendanceEventModel,
    LeaveModel,
    PayrollPeriodModel,
    WorkModeRequestModel,
    UserModel,
    engine: testEngine(),
    resolveScheduleRule: testResolveScheduleRule,
    resolveScopeIds: async () => [USER_A],
    notify: async (userId, payload) => notifications.push({ userId: String(userId), payload }),
    audit: async (entry) => audits.push(entry),
  };
  return {
    ...base, RequestModel, AttendanceModel, AttendanceEventModel, LeaveModel,
    PayrollPeriodModel, WorkModeRequestModel, UserModel, notifications, audits, policy,
  };
};

// A recorded full day: in 09:05, lunch 13:00–13:30, out 18:10 (IST).
const fullDayEvents = (date = MONDAY, user = USER_A, company = COMPANY_A) => [
  { companyId: company, user, date, seq: 1, type: 'CLOCK_IN', at: new Date(`${date}T09:05:00+05:30`), workMode: 'OFFICE' },
  { companyId: company, user, date, seq: 2, type: 'BREAK_START', at: new Date(`${date}T13:00:00+05:30`) },
  { companyId: company, user, date, seq: 3, type: 'BREAK_END', at: new Date(`${date}T13:30:00+05:30`) },
  { companyId: company, user, date, seq: 4, type: 'CLOCK_OUT', at: new Date(`${date}T18:10:00+05:30`) },
];

const fullDayControl = (date = MONDAY, user = USER_A, company = COMPANY_A, extra = {}) => ({
  _id: `att-${date}`,
  companyId: company,
  user,
  date,
  punchIn: new Date(`${date}T09:05:00+05:30`),
  punchOut: new Date(`${date}T18:10:00+05:30`),
  workMinutes: 515,
  breakMinutes: 30,
  lateMinutes: 5,
  earlyMinutes: 0,
  overtimeMinutes: 0,
  status: 'LATE',
  workMode: 'OFFICE',
  liveState: 'COMPLETED',
  eventSeq: 4,
  policyVersion: 1,
  policyOutcome: 'WORKED',
  policyExceptions: ['LATE_IN'],
  ...extra,
});

const openDayControl = (date = TODAY, user = USER_A, company = COMPANY_A, extra = {}) => ({
  _id: `att-${date}`,
  companyId: company,
  user,
  date,
  punchIn: new Date(`${date}T09:05:00+05:30`),
  punchOut: null,
  workMinutes: 0,
  breakMinutes: 0,
  lateMinutes: 5,
  earlyMinutes: 0,
  overtimeMinutes: 0,
  status: 'LATE',
  workMode: 'OFFICE',
  liveState: 'WORKING',
  eventSeq: 1,
  policyVersion: 1,
  policyOutcome: null,
  policyExceptions: [],
  ...extra,
});

const pendingSeed = (type = 'MISSED_CLOCK_OUT', attendanceDate = TODAY, extra = {}) => ({
  _id: 'rg1',
  companyId: COMPANY_A,
  user: USER_A,
  type,
  attendanceDate,
  reason: 'seeded pending',
  proposal: { correctedIn: null, correctedOut: new Date(`${attendanceDate}T18:00:00+05:30`), breaks: undefined, workMode: null },
  originalSnapshot: {},
  status: 'PENDING',
  ...extra,
});

// ── PURE RULES ─────────────────────────────────────────────

test('rules: ten allowlisted types split into six corrections and four explanations', () => {
  assert.equal(Object.keys(REG_TYPE).length, 10);
  for (const type of Object.values(REG_TYPE)) assert.equal(isRegularizationType(type), true);
  assert.equal(isRegularizationType('MISSED_PUNCH'), false);
  assert.equal(isRegularizationType(null), false);
  assert.equal(kindOf(REG_TYPE.MISSED_CLOCK_IN), REG_KIND.CORRECTION);
  assert.equal(kindOf(REG_TYPE.CLOCK_IN_TIME_CORRECTION), REG_KIND.CORRECTION);
  assert.equal(kindOf(REG_TYPE.CLOCK_OUT_TIME_CORRECTION), REG_KIND.CORRECTION);
  assert.equal(kindOf(REG_TYPE.BREAK_CORRECTION), REG_KIND.CORRECTION);
  assert.equal(kindOf(REG_TYPE.WORK_MODE_CORRECTION), REG_KIND.CORRECTION);
  assert.equal(kindOf(REG_TYPE.MISSED_CLOCK_OUT), REG_KIND.CORRECTION);
  assert.equal(kindOf(REG_TYPE.LATE_EXPLANATION), REG_KIND.EXPLANATION);
  assert.equal(kindOf(REG_TYPE.EARLY_EXIT_EXPLANATION), REG_KIND.EXPLANATION);
  assert.equal(kindOf(REG_TYPE.SHORT_HOURS_EXPLANATION), REG_KIND.EXPLANATION);
  assert.equal(kindOf(REG_TYPE.GEOFENCE_EXPLANATION), REG_KIND.EXPLANATION);
  assert.deepEqual(EXPLANATION_CODE, {
    LATE_EXPLANATION: 'LATE_IN',
    EARLY_EXIT_EXPLANATION: 'EARLY_OUT',
    SHORT_HOURS_EXPLANATION: 'SHORT_HOURS',
    GEOFENCE_EXPLANATION: 'OUTSIDE_GEOFENCE',
  });
});

test('rules: conflict groups pair same-fact corrections, explanations group per-type', () => {
  assert.equal(conflictGroupOf('MISSED_CLOCK_IN'), conflictGroupOf('CLOCK_IN_TIME_CORRECTION'));
  assert.equal(conflictGroupOf('MISSED_CLOCK_OUT'), conflictGroupOf('CLOCK_OUT_TIME_CORRECTION'));
  assert.notEqual(conflictGroupOf('MISSED_CLOCK_IN'), conflictGroupOf('MISSED_CLOCK_OUT'));
  assert.equal(conflictGroupOf('BREAK_CORRECTION'), 'BREAK');
  assert.equal(conflictGroupOf('WORK_MODE_CORRECTION'), 'MODE');
  assert.notEqual(conflictGroupOf('LATE_EXPLANATION'), conflictGroupOf('EARLY_EXIT_EXPLANATION'));
});

test('rules: submission window follows the missingPunch policy (default 7 days)', () => {
  const policy = makePolicy().missingPunch;
  assert.equal(windowCheck(TODAY, TODAY, policy), null);
  assert.equal(windowCheck('2026-09-08', TODAY, policy), null);
  assert.match(windowCheck('2026-09-07', TODAY, policy), /within 7 day/);
  assert.match(windowCheck('2026-09-16', TODAY, policy), /future day/);
  assert.match(
    windowCheck(MONDAY, TODAY, { allowRegularization: false, regularizationWindowDays: 7 }),
    /disabled by the company/,
  );
  assert.equal(windowCheck('2026-08-16', TODAY, { allowRegularization: true, regularizationWindowDays: 31 }), null);
  assert.match(windowCheck('2026-08-14', TODAY, { allowRegularization: true, regularizationWindowDays: 31 }), /within 31 day/);
  assert.match(windowCheck('2026-13-40', TODAY, policy), /valid YYYY-MM-DD/);
  assert.match(windowCheck(MONDAY, 'someday', policy), /today is unavailable/);
});

test('rules: missed clock-in needs a same-day proposal before any recorded out', () => {
  const ctx = { attendanceDate: MONDAY, timezone: 'Asia/Kolkata' };
  const out = new Date(`${MONDAY}T18:00:00+05:30`);
  assert.deepEqual(
    validateProposal('MISSED_CLOCK_IN', { correctedIn: `${MONDAY}T09:00:00+05:30` }, { firstIn: null, lastOut: out }, ctx),
    [],
  );
  assert.match(
    validateProposal('MISSED_CLOCK_IN', { correctedIn: `${MONDAY}T09:00:00+05:30` }, { firstIn: new Date(`${MONDAY}T09:05:00+05:30`), lastOut: out }, ctx).join('|'),
    /already exists/,
  );
  assert.match(
    validateProposal('MISSED_CLOCK_IN', {}, { firstIn: null, lastOut: out }, ctx).join('|'),
    /correctedIn is required/,
  );
  assert.match(
    validateProposal('MISSED_CLOCK_IN', { correctedIn: `${TODAY}T09:00:00+05:30` }, { firstIn: null, lastOut: out }, ctx).join('|'),
    /must fall on the attendance day/,
  );
  assert.match(
    validateProposal('MISSED_CLOCK_IN', { correctedIn: `${MONDAY}T19:00:00+05:30` }, { firstIn: null, lastOut: out }, ctx).join('|'),
    /before the recorded clock-out/,
  );
});

test('rules: missed clock-out needs a recorded in and allows overnight outs', () => {
  const ctx = { attendanceDate: MONDAY, timezone: 'Asia/Kolkata' };
  const inAt = new Date(`${MONDAY}T09:05:00+05:30`);
  assert.deepEqual(
    validateProposal('MISSED_CLOCK_OUT', { correctedOut: `${MONDAY}T18:00:00+05:30` }, { firstIn: inAt, lastOut: null }, ctx),
    [],
  );
  assert.deepEqual(
    validateProposal('MISSED_CLOCK_OUT', { correctedOut: `${TODAY}T01:00:00+05:30` }, { firstIn: inAt, lastOut: null }, ctx),
    [],
  );
  assert.match(
    validateProposal('MISSED_CLOCK_OUT', { correctedOut: `${MONDAY}T18:00:00+05:30` }, { firstIn: null, lastOut: null }, ctx).join('|'),
    /recorded clock-in first/,
  );
  assert.match(
    validateProposal('MISSED_CLOCK_OUT', { correctedOut: `${MONDAY}T08:00:00+05:30` }, { firstIn: inAt, lastOut: null }, ctx).join('|'),
    /after the clock-in/,
  );
  assert.match(
    validateProposal('MISSED_CLOCK_OUT', { correctedOut: '2026-09-16T02:00:00+05:30' }, { firstIn: inAt, lastOut: null }, ctx).join('|'),
    /or the next day/,
  );
});

test('rules: time corrections need an existing punch that actually changes', () => {
  const ctx = { attendanceDate: MONDAY, timezone: 'Asia/Kolkata' };
  const inAt = new Date(`${MONDAY}T09:05:00+05:30`);
  const outAt = new Date(`${MONDAY}T18:10:00+05:30`);
  assert.deepEqual(
    validateProposal('CLOCK_IN_TIME_CORRECTION', { correctedIn: `${MONDAY}T09:00:00+05:30` }, { firstIn: inAt, lastOut: outAt }, ctx),
    [],
  );
  assert.match(
    validateProposal('CLOCK_IN_TIME_CORRECTION', { correctedIn: `${MONDAY}T09:00:00+05:30` }, { firstIn: null, lastOut: outAt }, ctx).join('|'),
    /no recorded clock-in/,
  );
  assert.match(
    validateProposal('CLOCK_IN_TIME_CORRECTION', { correctedIn: inAt.toISOString() }, { firstIn: inAt, lastOut: outAt }, ctx).join('|'),
    /equals the recorded/,
  );
  assert.match(
    validateProposal('CLOCK_IN_TIME_CORRECTION', { correctedIn: `${MONDAY}T19:00:00+05:30` }, { firstIn: inAt, lastOut: outAt }, ctx).join('|'),
    /before the clock-out/,
  );
  assert.deepEqual(
    validateProposal('CLOCK_OUT_TIME_CORRECTION', { correctedOut: `${MONDAY}T18:00:00+05:30` }, { firstIn: inAt, lastOut: outAt }, ctx),
    [],
  );
  assert.match(
    validateProposal('CLOCK_OUT_TIME_CORRECTION', { correctedOut: `${MONDAY}T18:00:00+05:30` }, { firstIn: inAt, lastOut: null }, ctx).join('|'),
    /no recorded clock-out/,
  );
  assert.match(
    validateProposal('CLOCK_OUT_TIME_CORRECTION', { correctedOut: outAt.toISOString() }, { firstIn: inAt, lastOut: outAt }, ctx).join('|'),
    /equals the recorded/,
  );
});

test('rules: break correction replaces the full list inside a completed day', () => {
  const ctx = { attendanceDate: MONDAY, timezone: 'Asia/Kolkata' };
  const original = {
    firstIn: new Date(`${MONDAY}T09:05:00+05:30`),
    lastOut: new Date(`${MONDAY}T18:10:00+05:30`),
  };
  const good = [{ start: `${MONDAY}T13:00:00+05:30`, end: `${MONDAY}T13:45:00+05:30` }];
  assert.deepEqual(validateProposal('BREAK_CORRECTION', { breaks: good }, original, ctx), []);
  assert.match(
    validateProposal('BREAK_CORRECTION', { breaks: good }, { ...original, lastOut: null }, ctx).join('|'),
    /completed day/,
  );
  assert.match(
    validateProposal('BREAK_CORRECTION', { breaks: [] }, original, ctx).join('|'),
    /full effective break list/,
  );
  assert.match(
    validateProposal('BREAK_CORRECTION', { breaks: [{ start: `${MONDAY}T08:00:00+05:30`, end: `${MONDAY}T08:30:00+05:30` }] }, original, ctx).join('|'),
    /within clock-in/,
  );
  assert.match(
    validateProposal('BREAK_CORRECTION', {
      breaks: [
        { start: `${MONDAY}T13:00:00+05:30`, end: `${MONDAY}T14:00:00+05:30` },
        { start: `${MONDAY}T13:30:00+05:30`, end: `${MONDAY}T14:30:00+05:30` },
      ],
    }, original, ctx).join('|'),
    /must not overlap/,
  );
  assert.match(
    validateProposal('BREAK_CORRECTION', { breaks: [{ start: `${MONDAY}T14:00:00+05:30`, end: `${MONDAY}T13:00:00+05:30` }] }, original, ctx).join('|'),
    /end after it starts/,
  );
});

test('rules: work-mode correction needs an existing day and a real change', () => {
  const ctx = { attendanceDate: MONDAY, timezone: 'Asia/Kolkata' };
  assert.deepEqual(validateProposal('WORK_MODE_CORRECTION', { workMode: 'WFH' }, { hasControl: true, workMode: 'OFFICE' }, ctx), []);
  assert.match(
    validateProposal('WORK_MODE_CORRECTION', { workMode: 'WFH' }, { hasControl: false, workMode: null }, ctx).join('|'),
    /existing attendance day/,
  );
  assert.match(
    validateProposal('WORK_MODE_CORRECTION', { workMode: 'REMOTE' }, { hasControl: true, workMode: 'OFFICE' }, ctx).join('|'),
    /valid work mode/,
  );
  assert.match(
    validateProposal('WORK_MODE_CORRECTION', { workMode: 'OFFICE' }, { hasControl: true, workMode: 'OFFICE' }, ctx).join('|'),
    /equals the recorded/,
  );
});

test('rules: explanations carry words only — any proposal is refused', () => {
  const ctx = { attendanceDate: MONDAY, timezone: 'Asia/Kolkata' };
  for (const type of ['LATE_EXPLANATION', 'EARLY_EXIT_EXPLANATION', 'SHORT_HOURS_EXPLANATION', 'GEOFENCE_EXPLANATION']) {
    assert.deepEqual(validateProposal(type, {}, { firstIn: new Date() }, ctx), []);
    assert.match(
      validateProposal(type, { correctedIn: `${MONDAY}T09:00:00+05:30` }, { firstIn: null }, ctx).join('|'),
      /must not propose/,
    );
  }
  assert.match(validateProposal('BOGUS', {}, {}, ctx).join('|'), /supported regularization type/);
});

test('rules: effective timeline composes corrections deterministically', () => {
  const original = {
    firstIn: new Date(`${MONDAY}T09:05:00+05:30`),
    lastOut: new Date(`${MONDAY}T18:10:00+05:30`),
    breaks: [{ start: new Date(`${MONDAY}T13:00:00+05:30`), end: new Date(`${MONDAY}T13:30:00+05:30`) }],
    workMode: 'OFFICE',
  };
  const passthrough = buildEffectiveTimeline(original, []);
  assert.equal(passthrough.clockIn.getTime(), original.firstIn.getTime());
  assert.equal(passthrough.clockOut.getTime(), original.lastOut.getTime());
  assert.equal(passthrough.breaks.length, 1);
  assert.equal(passthrough.workMode, 'OFFICE');
  assert.deepEqual(passthrough.resolvedExceptions, []);

  const composed = buildEffectiveTimeline(original, [
    { type: 'CLOCK_IN_TIME_CORRECTION', proposal: { correctedIn: `${MONDAY}T09:00:00+05:30` } },
    { type: 'BREAK_CORRECTION', proposal: { breaks: [{ start: `${MONDAY}T13:00:00+05:30`, end: `${MONDAY}T14:00:00+05:30` }] } },
    { type: 'WORK_MODE_CORRECTION', proposal: { workMode: 'WFH' } },
    { type: 'LATE_EXPLANATION', proposal: {} },
  ]);
  assert.equal(dayKeyInZone(composed.clockIn, 'Asia/Kolkata'), MONDAY);
  assert.equal(composed.clockIn.toISOString(), new Date(`${MONDAY}T09:00:00+05:30`).toISOString());
  assert.equal(composed.clockOut.getTime(), original.lastOut.getTime());
  assert.equal(composed.breaks.length, 1);
  assert.equal(composed.breaks[0].end.toISOString(), new Date(`${MONDAY}T14:00:00+05:30`).toISOString());
  assert.equal(composed.workMode, 'WFH');
  assert.deepEqual(composed.resolvedExceptions, ['LATE_IN']);
});

test('rules: APPROVED is terminal, PENDING fans out, review/cancel stay guarded', () => {
  assert.equal(canTransition('PENDING', 'APPROVED'), true);
  assert.equal(canTransition('PENDING', 'REJECTED'), true);
  assert.equal(canTransition('PENDING', 'CANCELLED'), true);
  assert.equal(canTransition('APPROVED', 'CANCELLED'), false);
  assert.equal(canTransition('APPROVED', 'PENDING'), false);
  assert.equal(canTransition('REJECTED', 'APPROVED'), false);
  assert.equal(canTransition('CANCELLED', 'PENDING'), false);
  assert.equal(cancelEligibility({ status: 'PENDING' }, { isOwner: true }), null);
  assert.equal(cancelEligibility({ status: 'PENDING' }, { isReviewer: true }), null);
  assert.match(cancelEligibility({ status: 'APPROVED' }, { isOwner: true }), /only pending/);
  assert.match(cancelEligibility({ status: 'PENDING' }, {}), /not authorized/);
  assert.equal(reviewEligibility({ status: 'PENDING', user: USER_A }, MGR_A), null);
  assert.match(reviewEligibility({ status: 'PENDING', user: USER_A }, USER_A), /own request/);
  assert.match(reviewEligibility({ status: 'APPROVED', user: USER_A }, MGR_A), /already approved/);
  assert.equal(validateReason('  forgot to punch  '), null);
  assert.match(validateReason('   '), /required/);
  assert.match(validateReason('x'.repeat(301)), /at most 300/);
  assert.equal(validateReviewReason(null, { required: false }), null);
  assert.match(validateReviewReason('no', { required: true }), /at least 3/);
  assert.match(validateReviewReason('  ', { required: true }), /at least 3/);
});

test('rules: day helpers reject impossible dates, dayKey stays zone-aware', () => {
  assert.equal(isValidDayString('2026-09-15'), true);
  assert.equal(isValidDayString('2026-02-30'), false);
  assert.equal(isValidDayString('15-09-2026'), false);
  assert.equal(isValidDayString(null), false);
  assert.equal(dayKeyInZone(new Date('2026-09-14T18:30:00Z'), 'Asia/Kolkata'), '2026-09-15');
  assert.equal(toDateOrNull('bogus'), null);
  assert.equal(toDateOrNull(null), null);
  assert.ok(toDateOrNull('2026-09-14T09:00:00+05:30') instanceof Date);
});

// ── SUBMIT ───────────────────────────────────────────────

test('submit: missed clock-out is captured with an interpretable snapshot', async () => {
  const ctx = makeSvcCtx({
    attendance: [openDayControl()],
    events: [{ companyId: COMPANY_A, user: USER_A, date: TODAY, seq: 1, type: 'CLOCK_IN', at: new Date(`${TODAY}T09:05:00+05:30`), workMode: 'OFFICE' }],
  });
  const created = await submitRegularization({
    ...ctx,
    companyId: COMPANY_A,
    requester: EMP,
    input: {
      type: 'MISSED_CLOCK_OUT',
      attendanceDate: TODAY,
      reason: 'Fire drill — left with the floor warden',
      proposal: { correctedOut: `${TODAY}T18:00:00+05:30` },
    },
  });
  assert.equal(created.status, 'PENDING');
  assert.equal(created.kind, 'CORRECTION');
  assert.equal(created.typeLabel, 'Missed clock-out');
  assert.equal(created.canCancel, true);
  assert.equal(new Date(created.originalSnapshot.firstIn).toISOString(), new Date(`${TODAY}T09:05:00+05:30`).toISOString());
  assert.equal(created.originalSnapshot.lastOut, null);
  assert.equal(created.originalSnapshot.status, 'LATE');
  assert.equal(new Date(created.proposal.correctedOut).toISOString(), new Date(`${TODAY}T18:00:00+05:30`).toISOString());
  assert.equal(ctx.audits.length, 1);
  assert.equal(ctx.audits[0].action, 'ATTENDANCE_REGULARIZATION_SUBMITTED');
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].userId, MGR_A);
  assert.equal(ctx.notifications[0].payload.category, 'ATTENDANCE');
});

test('submit: malformed inputs are refused before any read', async () => {
  const ctx = makeSvcCtx();
  await assert.rejects(
    () => submitRegularization({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { type: 'BOGUS', attendanceDate: TODAY, reason: 'x' } }),
    /supported regularization type/,
  );
  await assert.rejects(
    () => submitRegularization({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { type: 'MISSED_CLOCK_OUT', attendanceDate: 'tomorrow', reason: 'x' } }),
    /valid YYYY-MM-DD/,
  );
  await assert.rejects(
    () => submitRegularization({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { type: 'MISSED_CLOCK_OUT', attendanceDate: TODAY, reason: '  ' } }),
    /reason is required/,
  );
  await assert.rejects(
    () => submitRegularization({ ...ctx, companyId: COMPANY_A, requester: null, input: { type: 'MISSED_CLOCK_OUT', attendanceDate: TODAY, reason: 'x' } }),
    /Requester identity/,
  );
  assert.equal(ctx.RequestModel.rows.length, 0);
  assert.equal(ctx.audits.length, 0);
});

test('submit: window, future days and policy opt-out are refused', async () => {
  const open = { attendance: [openDayControl()], events: [] };
  const stale = makeSvcCtx(open);
  await assert.rejects(
    () => submitRegularization({ ...stale, companyId: COMPANY_A, requester: EMP, input: { type: 'LATE_EXPLANATION', attendanceDate: '2026-09-07', reason: 'old' } }),
    /within 7 day/,
  );
  const future = makeSvcCtx(open);
  await assert.rejects(
    () => submitRegularization({ ...future, companyId: COMPANY_A, requester: EMP, input: { type: 'LATE_EXPLANATION', attendanceDate: '2026-09-16', reason: 'early' } }),
    /future day/,
  );
  const disabled = makeSvcCtx({ ...open, policy: makePolicy({ missingPunch: { allowRegularization: false, regularizationWindowDays: 7 } }) });
  await assert.rejects(
    () => submitRegularization({ ...disabled, companyId: COMPANY_A, requester: EMP, input: { type: 'LATE_EXPLANATION', attendanceDate: MONDAY, reason: 'x' } }),
    /disabled by the company/,
  );
});

test('submit: locked payroll months refuse, open months pass (read-only)', async () => {
  const attempt = (periods) => {
    const ctx = makeSvcCtx({
      attendance: [fullDayControl()],
      events: fullDayEvents(),
      periods,
    });
    return submitRegularization({
      ...ctx,
      companyId: COMPANY_A,
      requester: EMP,
      input: { type: 'LATE_EXPLANATION', attendanceDate: MONDAY, reason: 'Metro delay' },
    }).then(() => ctx, (error) => { error.ctx = ctx; throw error; });
  };
  await assert.rejects(() => attempt([{ companyId: COMPANY_A, month: '2026-09', status: 'LOCKED' }]), /already locked/);
  await assert.rejects(() => attempt([{ companyId: COMPANY_A, month: '2026-09', status: 'SENT_TO_PAYROLL' }]), /sent to payroll/);
  const draftCtx = await attempt([{ companyId: COMPANY_A, month: '2026-09', status: 'DRAFT' }]);
  assert.equal(draftCtx.RequestModel.rows.length, 1);
  const missingCtx = await attempt([]);
  assert.equal(missingCtx.RequestModel.rows.length, 1);
  // A lock on another month never blocks this day.
  const otherCtx = await attempt([{ companyId: COMPANY_A, month: '2026-08', status: 'LOCKED' }]);
  assert.equal(otherCtx.RequestModel.rows.length, 1);
});

test('submit: approved leave on the day refuses any request class', async () => {
  const leave = { companyId: COMPANY_A, user: USER_A, status: 'APPROVED', startDate: MONDAY, endDate: MONDAY };
  for (const input of [
    { type: 'MISSED_CLOCK_IN', attendanceDate: MONDAY, reason: 'x', proposal: { correctedIn: `${MONDAY}T09:00:00+05:30` } },
    { type: 'LATE_EXPLANATION', attendanceDate: MONDAY, reason: 'x' },
  ]) {
    const ctx = makeSvcCtx({ leaves: [leave] });
    await assert.rejects(
      () => submitRegularization({ ...ctx, companyId: COMPANY_A, requester: EMP, input }),
      /leave already covers/,
    );
  }
  // Pending leave is not a boundary.
  const ctx = makeSvcCtx({ leaves: [{ companyId: COMPANY_A, user: USER_A, status: 'PENDING', startDate: MONDAY, endDate: MONDAY }] });
  const created = await submitRegularization({
    ...ctx, companyId: COMPANY_A, requester: EMP,
    input: { type: 'LATE_EXPLANATION', attendanceDate: MONDAY, reason: 'x' },
  });
  assert.equal(created.status, 'PENDING');
});

test('submit: one correction per fact — pending and applied rivals both block', async () => {
  const day = {
    attendance: [fullDayControl()],
    events: fullDayEvents(),
  };
  const pending = makeSvcCtx({ ...day, requests: [pendingSeed('CLOCK_IN_TIME_CORRECTION', MONDAY)] });
  await assert.rejects(
    () => submitRegularization({
      ...pending, companyId: COMPANY_A, requester: EMP,
      input: { type: 'CLOCK_IN_TIME_CORRECTION', attendanceDate: MONDAY, reason: 'x', proposal: { correctedIn: `${MONDAY}T09:00:00+05:30` } },
    }),
    /already pending/,
  );
  const applied = makeSvcCtx({ ...day, requests: [{ ...pendingSeed('CLOCK_IN_TIME_CORRECTION', MONDAY), status: 'APPROVED' }] });
  await assert.rejects(
    () => submitRegularization({
      ...applied, companyId: COMPANY_A, requester: EMP,
      input: { type: 'CLOCK_IN_TIME_CORRECTION', attendanceDate: MONDAY, reason: 'x', proposal: { correctedIn: `${MONDAY}T09:00:00+05:30` } },
    }),
    /already regularized/,
  );
  // A different fact group on the same day is independent.
  const other = makeSvcCtx({ ...day, requests: [pendingSeed('CLOCK_IN_TIME_CORRECTION', MONDAY)] });
  const created = await submitRegularization({
    ...other, companyId: COMPANY_A, requester: EMP,
    input: { type: 'WORK_MODE_CORRECTION', attendanceDate: MONDAY, reason: 'was WFH', proposal: { workMode: 'WFH' } },
  });
  assert.equal(created.status, 'PENDING');
  // Another employee's request never blocks mine.
  const stranger = makeSvcCtx({ ...day, requests: [{ ...pendingSeed('MISSED_CLOCK_OUT', MONDAY), user: USER_B }] });
  const mine = await submitRegularization({
    ...stranger, companyId: COMPANY_A, requester: EMP,
    input: { type: 'CLOCK_OUT_TIME_CORRECTION', attendanceDate: MONDAY, reason: 'x', proposal: { correctedOut: `${MONDAY}T18:00:00+05:30` } },
  });
  assert.equal(mine.status, 'PENDING');
});

test('submit: proposal preconditions surface against recorded facts', async () => {
  const ctx = makeSvcCtx({ attendance: [fullDayControl()], events: fullDayEvents() });
  await assert.rejects(
    () => submitRegularization({
      ...ctx, companyId: COMPANY_A, requester: EMP,
      input: { type: 'MISSED_CLOCK_IN', attendanceDate: MONDAY, reason: 'x', proposal: { correctedIn: `${MONDAY}T09:00:00+05:30` } },
    }),
    /already exists/,
  );
  await assert.rejects(
    () => submitRegularization({
      ...ctx, companyId: COMPANY_A, requester: EMP,
      input: { type: 'MISSED_CLOCK_OUT', attendanceDate: MONDAY, reason: 'x', proposal: { correctedOut: `${MONDAY}T19:00:00+05:30` } },
    }),
    /already exists/,
  );
  await assert.rejects(
    () => submitRegularization({
      ...ctx, companyId: COMPANY_A, requester: EMP,
      input: { type: 'LATE_EXPLANATION', attendanceDate: MONDAY, reason: 'x', proposal: { correctedIn: `${MONDAY}T09:00:00+05:30` } },
    }),
    /must not propose/,
  );
});

test('submit: explanations and break/work-mode corrections persist clean snapshots', async () => {
  const ctx = makeSvcCtx({ attendance: [fullDayControl()], events: fullDayEvents() });
  const explanation = await submitRegularization({
    ...ctx, companyId: COMPANY_A, requester: EMP,
    input: { type: 'LATE_EXPLANATION', attendanceDate: MONDAY, reason: 'Metro signal failure' },
  });
  assert.equal(explanation.kind, 'EXPLANATION');
  assert.deepEqual(explanation.originalSnapshot.policyExceptions, ['LATE_IN']);
  assert.deepEqual(explanation.originalSnapshot.eventIds, []);
  assert.equal(new Date(explanation.originalSnapshot.firstIn).toISOString(), new Date(`${MONDAY}T09:05:00+05:30`).toISOString());

  const breaks = await submitRegularization({
    ...ctx, companyId: COMPANY_A, requester: EMP,
    input: {
      type: 'BREAK_CORRECTION', attendanceDate: MONDAY, reason: 'Forgot to end lunch break',
      proposal: { breaks: [{ start: `${MONDAY}T13:00:00+05:30`, end: `${MONDAY}T14:00:00+05:30` }] },
    },
  });
  assert.equal(breaks.originalSnapshot.breaks.length, 1);

  const mode = await submitRegularization({
    ...ctx, companyId: COMPANY_A, requester: EMP,
    input: { type: 'WORK_MODE_CORRECTION', attendanceDate: MONDAY, reason: 'WFH day', proposal: { workMode: 'WFH' } },
  });
  assert.equal(mode.originalSnapshot.workMode, 'OFFICE');
});

test('submit: cross-tenant rows never collide', async () => {
  const ctx = makeSvcCtx({
    attendance: [fullDayControl()],
    events: fullDayEvents(),
    requests: [{ ...pendingSeed('CLOCK_OUT_TIME_CORRECTION', MONDAY), companyId: COMPANY_B }],
  });
  const created = await submitRegularization({
    ...ctx, companyId: COMPANY_A, requester: EMP,
    input: { type: 'CLOCK_OUT_TIME_CORRECTION', attendanceDate: MONDAY, reason: 'x', proposal: { correctedOut: `${MONDAY}T18:00:00+05:30` } },
  });
  assert.equal(created.status, 'PENDING');
});

test('submit: manager-less employees notify Admin + HR', async () => {
  const ctx = makeSvcCtx({
    users: [
      { _id: MGR_A, companyId: COMPANY_A, role: 'MANAGER' },
      { _id: 'aaaaaaaaaaaaaaaaaaaaaaa6', companyId: COMPANY_A, role: 'COMPANY_ADMIN' },
      { _id: 'aaaaaaaaaaaaaaaaaaaaaaa5', companyId: COMPANY_A, role: 'HR_MANAGER' },
    ],
  });
  await submitRegularization({
    ...ctx,
    companyId: COMPANY_A,
    requester: { _id: USER_A, name: 'Orphan Ollie' },
    input: { type: 'LATE_EXPLANATION', attendanceDate: MONDAY, reason: 'x' },
  });
  const targets = ctx.notifications.map((note) => note.userId).sort();
  assert.deepEqual(targets, ['aaaaaaaaaaaaaaaaaaaaaaa5', 'aaaaaaaaaaaaaaaaaaaaaaa6']);
});

// ── DECIDE ───────────────────────────────────────────────

test('approve: missed clock-out rebuilds the day — recorded punches untouched', async () => {
  const ctx = makeSvcCtx({
    attendance: [openDayControl()],
    events: [{ companyId: COMPANY_A, user: USER_A, date: TODAY, seq: 1, type: 'CLOCK_IN', at: new Date(`${TODAY}T09:05:00+05:30`), workMode: 'OFFICE' }],
    requests: [pendingSeed('MISSED_CLOCK_OUT', TODAY)],
  });
  const decided = await decideRegularization({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' });
  assert.equal(decided.status, 'APPROVED');
  assert.ok(decided.appliedAt);
  assert.equal(decided.approver.id, MGR_A);
  assert.equal(decided.canCancel, false);

  const control = ctx.AttendanceModel.rows[0];
  assert.equal(control.regularized, true);
  // Recorded facts are immutable: the out-punch was never taken.
  assert.equal(control.punchOut, null);
  assert.equal(control.punchIn.toISOString(), new Date(`${TODAY}T09:05:00+05:30`).toISOString());
  // Effective facts come from the overlay.
  assert.equal(control.regularization.correctedOut.toISOString(), new Date(`${TODAY}T18:00:00+05:30`).toISOString());
  assert.equal(control.regularization.correctedIn.toISOString(), control.punchIn.toISOString());
  assert.deepEqual(control.regularization.appliedRequestIds, ['rg1']);
  // Re-derived through the shared CLOCK_OUT math: 09:05 → 18:00.
  // Phase 31.6 verdict: day-framed schedule math (09:00 start) sees
  // the 5-minute delay the old UTC-anchored evaluator missed, and the
  // on-time 18:00 out-punch records zero early minutes (not 330).
  assert.equal(control.workMinutes, 535);
  assert.equal(control.breakMinutes, 0);
  assert.equal(control.status, 'LATE');
  assert.equal(control.lateMinutes, 5);
  assert.equal(control.earlyMinutes, 0);
  assert.equal(control.policyOutcome, 'PRESENT');
  assert.deepEqual(control.policyExceptions, ['LATE_IN']);
  // The raw ledger gained nothing: approvals never append events.
  assert.equal(ctx.AttendanceEventModel.rows.length, 1);

  const actions = ctx.audits.map((entry) => entry.action);
  assert.deepEqual(actions, ['ATTENDANCE_REGULARIZATION_APPROVED', 'ATTENDANCE_REGULARIZATION_APPLIED']);
  assert.equal(ctx.audits[0].newValue.from, 'PENDING');
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].userId, USER_A);
});

test('approve: clock-in correction recomputes lateness from the effective in-time', async () => {
  const ctx = makeSvcCtx({
    attendance: [fullDayControl()],
    events: fullDayEvents(),
    requests: [{
      ...pendingSeed('CLOCK_IN_TIME_CORRECTION', MONDAY),
      proposal: { correctedIn: new Date(`${MONDAY}T08:55:00+05:30`), correctedOut: null, workMode: null },
    }],
  });
  const decided = await decideRegularization({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE', reviewReason: 'CCTV verified' });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.reviewReason, 'CCTV verified');
  const control = ctx.AttendanceModel.rows[0];
  assert.equal(control.punchIn.toISOString(), new Date(`${MONDAY}T09:05:00+05:30`).toISOString());
  assert.equal(control.regularization.correctedIn.toISOString(), new Date(`${MONDAY}T08:55:00+05:30`).toISOString());
  assert.equal(control.lateMinutes, 0);
  assert.equal(control.status, 'PRESENT');
  // 08:55 → 18:10 minus the 30-minute lunch.
  assert.equal(control.workMinutes, 525);
  assert.equal(control.breakMinutes, 30);
});

test('approve: missed clock-in opens a working day the employee can clock out of', async () => {
  const ctx = makeSvcCtx({
    requests: [{
      ...pendingSeed('MISSED_CLOCK_IN', MONDAY),
      proposal: { correctedIn: new Date(`${MONDAY}T09:00:00+05:30`), correctedOut: null, workMode: null },
    }],
  });
  const decided = await decideRegularization({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(ctx.AttendanceModel.rows.length, 1);
  const control = ctx.AttendanceModel.rows[0];
  assert.equal(control.date, MONDAY);
  assert.equal(control.punchIn ?? null, null);
  assert.equal(control.punchOut ?? null, null);
  assert.equal(control.liveState, 'WORKING');
  assert.equal(control.status, 'PRESENT');
  assert.equal(control.regularization.correctedIn.toISOString(), new Date(`${MONDAY}T09:00:00+05:30`).toISOString());

  // Live interplay: the real clock-out seeds its session from the
  // effective clock-in and stays honest about recorded facts.
  const live = await recordEvent({
    companyId: COMPANY_A,
    userId: USER_A,
    action: 'CLOCK_OUT',
    workMode: null,
    date: MONDAY,
    idempotencyKey: 'reg-live-out',
    location: null,
    deps: {
      AttendanceModel: ctx.AttendanceModel,
      AttendanceEventModel: ctx.AttendanceEventModel,
      policyReader: ctx.policyReader,
      engine: testEngine(),
      resolveScheduleRule: testResolveScheduleRule,
      now: () => new Date(`${MONDAY}T18:00:00+05:30`),
      sleep: async () => {},
    },
  });
  assert.equal(live.snapshot.liveState, 'COMPLETED');
  assert.equal(live.snapshot.clockOutAt, new Date(`${MONDAY}T18:00:00+05:30`).toISOString());
  const afterOut = ctx.AttendanceModel.rows[0];
  assert.equal(afterOut.punchIn ?? null, null);
  assert.equal(afterOut.punchOut.toISOString(), new Date(`${MONDAY}T18:00:00+05:30`).toISOString());
  // 09:00 (effective) → 18:00 (live) = 540 minutes.
  assert.equal(afterOut.workMinutes, 540);
  assert.equal(afterOut.status, 'PRESENT');
});

test('decide: review reasons follow the 31.4 pattern, actions are strict', async () => {
  const ctx = makeSvcCtx({ requests: [pendingSeed('LATE_EXPLANATION', MONDAY, { proposal: {} })] });
  await assert.rejects(
    () => decideRegularization({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'REJECT' }),
    /at least 3/,
  );
  await assert.rejects(
    () => decideRegularization({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'MAYBE' }),
    /APPROVE or REJECT/,
  );
  const rejected = await decideRegularization({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'REJECT', reviewReason: 'No evidence' });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reviewReason, 'No evidence');
  assert.equal(ctx.audits.length, 1);
  assert.equal(ctx.audits[0].action, 'ATTENDANCE_REGULARIZATION_REJECTED');
  // Rejection never touches the projection or the ledger.
  assert.equal(ctx.AttendanceModel.rows.length, 0);
  assert.equal(ctx.AttendanceEventModel.rows.length, 0);
});

test('decide: self-review and out-of-scope reviewers are refused', async () => {
  const mine = makeSvcCtx({ requests: [pendingSeed('LATE_EXPLANATION', MONDAY, { proposal: {} })] });
  await assert.rejects(
    () => decideRegularization({ ...mine, companyId: COMPANY_A, viewer: EMP, requestId: 'rg1', action: 'APPROVE' }),
    /own request/,
  );
  const scoped = makeSvcCtx({ requests: [pendingSeed('LATE_EXPLANATION', MONDAY, { proposal: {} })] });
  scoped.resolveScopeIds = async () => [USER_B];
  await assert.rejects(
    () => decideRegularization({ ...scoped, companyId: COMPANY_A, viewer: { _id: MGR_UNRELATED }, requestId: 'rg1', action: 'APPROVE' }),
    /not in your team/,
  );
  const missing = makeSvcCtx();
  await assert.rejects(
    () => decideRegularization({ ...missing, companyId: COMPANY_A, viewer: MGR, requestId: 'rg9', action: 'APPROVE' }),
    /not found/,
  );
});

test('decide: settled requests refuse re-decision, races refuse cleanly', async () => {
  const approved = makeSvcCtx({ requests: [{ ...pendingSeed(), status: 'APPROVED', appliedAt: new Date() }] });
  await assert.rejects(
    () => decideRegularization({ ...approved, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' }),
    /already approved/,
  );
  const cancelled = makeSvcCtx({ requests: [{ ...pendingSeed(), status: 'CANCELLED' }] });
  await assert.rejects(
    () => decideRegularization({ ...cancelled, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'REJECT', reviewReason: 'late' }),
    /already cancelled/,
  );
  // Lost the decide race between read and CAS.
  const racy = makeSvcCtx({ requests: [pendingSeed('LATE_EXPLANATION', MONDAY, { proposal: {} })] });
  const realUpdate = racy.RequestModel.findOneAndUpdate;
  racy.RequestModel.findOneAndUpdate = async (filter, update, opts) => {
    if (filter.status === 'PENDING' && update.$set?.status) return null;
    return realUpdate(filter, update, opts);
  };
  await assert.rejects(
    () => decideRegularization({ ...racy, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'REJECT', reviewReason: 'raced' }),
    /no longer pending/,
  );
});

test('decide: approval revalidates leave, payroll, drift and rivals', async () => {
  const seed = () => pendingSeed('MISSED_CLOCK_OUT', TODAY);
  const base = {
    attendance: [openDayControl()],
    events: [{ companyId: COMPANY_A, user: USER_A, date: TODAY, seq: 1, type: 'CLOCK_IN', at: new Date(`${TODAY}T09:05:00+05:30`), workMode: 'OFFICE' }],
  };
  const leaveCtx = makeSvcCtx({ ...base, requests: [seed()], leaves: [{ companyId: COMPANY_A, user: USER_A, status: 'APPROVED', startDate: TODAY, endDate: TODAY }] });
  await assert.rejects(
    () => decideRegularization({ ...leaveCtx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' }),
    /cannot approve over it/,
  );
  const lockCtx = makeSvcCtx({ ...base, requests: [seed()], periods: [{ companyId: COMPANY_A, month: '2026-09', status: 'LOCKED' }] });
  await assert.rejects(
    () => decideRegularization({ ...lockCtx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' }),
    /frozen/,
  );
  const drifted = makeSvcCtx({
    attendance: [fullDayControl(TODAY)],
    events: fullDayEvents(TODAY),
    requests: [seed()],
  });
  await assert.rejects(
    () => decideRegularization({ ...drifted, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' }),
    /changed since submission/,
  );
  const rival = makeSvcCtx({
    ...base,
    requests: [seed(), { ...pendingSeed('CLOCK_OUT_TIME_CORRECTION', TODAY), _id: 'rg2', status: 'APPROVED' }],
  });
  await assert.rejects(
    () => decideRegularization({ ...rival, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' }),
    /only one correction per fact/,
  );
  const lapsed = makeSvcCtx({ requests: [pendingSeed('LATE_EXPLANATION', '2026-09-05', { proposal: {} })] });
  await assert.rejects(
    () => decideRegularization({ ...lapsed, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' }),
    /within 7 day/,
  );
});

test('decide: mode guard needs 31.4 cover — HR/Admin may record an override', async () => {
  const seed = () => ({
    ...pendingSeed('WORK_MODE_CORRECTION', MONDAY),
    proposal: { correctedIn: null, correctedOut: null, workMode: 'WFH' },
  });
  const day = { attendance: [fullDayControl()], events: fullDayEvents() };
  const bare = makeSvcCtx({ ...day, requests: [seed()] });
  await assert.rejects(
    () => decideRegularization({ ...bare, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' }),
    /must cover/,
  );
  const hrCtx = makeSvcCtx({ ...day, requests: [seed()] });
  const overridden = await decideRegularization({ ...hrCtx, companyId: COMPANY_A, viewer: HR, requestId: 'rg1', action: 'APPROVE' });
  assert.equal(overridden.status, 'APPROVED');
  assert.equal(overridden.authorizationOverride, true);
  assert.equal(hrCtx.audits[0].newValue.authorizationOverride, true);
  assert.equal(hrCtx.AttendanceModel.rows[0].workMode, 'WFH');
  assert.equal(hrCtx.AttendanceModel.rows[0].regularization.correctedWorkMode, 'WFH');
  // Times unchanged, so durations stand; lateness recomputes through
  // the shared 31.6 verdict (day-framed: the 09:05 arrival is 5 late).
  assert.equal(hrCtx.AttendanceModel.rows[0].workMinutes, 515);
  assert.equal(hrCtx.AttendanceModel.rows[0].lateMinutes, 5);
  assert.equal(hrCtx.AttendanceModel.rows[0].status, 'LATE');

  const covered = makeSvcCtx({
    ...day,
    requests: [seed()],
    workModes: [{ companyId: COMPANY_A, user: USER_A, mode: 'WFH', status: 'APPROVED', startDate: MONDAY, endDate: MONDAY }],
  });
  const viaCover = await decideRegularization({ ...covered, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' });
  assert.equal(viaCover.authorizationOverride, false);

  // OFFICE never needs cover.
  const officeSeed = { ...seed(), proposal: { correctedIn: null, correctedOut: null, workMode: 'OFFICE' } };
  const officeDay = { attendance: [fullDayControl(MONDAY, USER_A, COMPANY_A, { workMode: 'WFH' })], events: fullDayEvents() };
  const officeCtx = makeSvcCtx({ ...officeDay, requests: [officeSeed] });
  const office = await decideRegularization({ ...officeCtx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' });
  assert.equal(office.status, 'APPROVED');
  assert.equal(officeCtx.AttendanceModel.rows[0].workMode, 'OFFICE');
});

test('decide: crashed approvals complete on re-approve instead of 409ing', async () => {
  const ctx = makeSvcCtx({
    attendance: [openDayControl()],
    events: [{ companyId: COMPANY_A, user: USER_A, date: TODAY, seq: 1, type: 'CLOCK_IN', at: new Date(`${TODAY}T09:05:00+05:30`), workMode: 'OFFICE' }],
    requests: [{ ...pendingSeed('MISSED_CLOCK_OUT', TODAY), status: 'APPROVED', approver: MGR_A, decidedAt: new Date(), appliedAt: null }],
  });
  const completed = await decideRegularization({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' });
  assert.equal(completed.status, 'APPROVED');
  assert.ok(completed.appliedAt);
  assert.equal(ctx.audits.length, 1);
  assert.equal(ctx.audits[0].action, 'ATTENDANCE_REGULARIZATION_APPLIED');
  assert.equal(ctx.audits[0].newValue.completed, 'retry');
  assert.equal(ctx.AttendanceModel.rows[0].workMinutes, 535);
  // Out-of-scope reviewers cannot complete someone else's crash.
  const scoped = makeSvcCtx({ requests: [{ ...pendingSeed(), status: 'APPROVED', appliedAt: null }] });
  scoped.resolveScopeIds = async () => [USER_B];
  await assert.rejects(
    () => decideRegularization({ ...scoped, companyId: COMPANY_A, viewer: { _id: MGR_UNRELATED }, requestId: 'rg1', action: 'APPROVE' }),
    /not in your team/,
  );
});

test('approve: explanations resolve exceptions while facts stay put', async () => {
  const ctx = makeSvcCtx({
    attendance: [fullDayControl()],
    events: fullDayEvents(),
    requests: [pendingSeed('LATE_EXPLANATION', MONDAY, { proposal: {} })],
  });
  const decided = await decideRegularization({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', action: 'APPROVE' });
  assert.equal(decided.status, 'APPROVED');
  const control = ctx.AttendanceModel.rows[0];
  assert.equal(control.regularized, true);
  assert.deepEqual(control.regularization.resolvedExceptions, ['LATE_IN']);
  // The factual record is untouched: only the overlay speaks.
  assert.deepEqual(control.policyExceptions, ['LATE_IN']);
  assert.equal(control.status, 'LATE');
  assert.equal(control.workMinutes, 515);
  assert.equal(control.lateMinutes, 5);
  assert.equal(control.punchIn.toISOString(), new Date(`${MONDAY}T09:05:00+05:30`).toISOString());
});

// ── CANCEL ───────────────────────────────────────────────

test('cancel: owner and scoped reviewer cancel pending; approved is terminal', async () => {
  const own = makeSvcCtx({ requests: [pendingSeed()] });
  const cancelled = await cancelRegularization({ ...own, companyId: COMPANY_A, viewer: EMP, requestId: 'rg1' });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(own.audits[0].action, 'ATTENDANCE_REGULARIZATION_CANCELLED');
  assert.equal(own.audits[0].newValue.from, 'PENDING');
  assert.equal(own.notifications[0].userId, MGR_A);

  const byReviewer = makeSvcCtx({ requests: [pendingSeed()] });
  const viaReviewer = await cancelRegularization({ ...byReviewer, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1' });
  assert.equal(viaReviewer.status, 'CANCELLED');
  assert.equal(byReviewer.notifications[0].userId, USER_A);

  const stranger = makeSvcCtx({ requests: [pendingSeed()] });
  stranger.resolveScopeIds = async () => [USER_B];
  await assert.rejects(
    () => cancelRegularization({ ...stranger, companyId: COMPANY_A, viewer: { _id: MGR_UNRELATED }, requestId: 'rg1' }),
    /not authorized/,
  );
  const settled = makeSvcCtx({ requests: [{ ...pendingSeed(), status: 'APPROVED', appliedAt: new Date() }] });
  await assert.rejects(
    () => cancelRegularization({ ...settled, companyId: COMPANY_A, viewer: EMP, requestId: 'rg1' }),
    /only pending/,
  );
});

// ── LISTS / GET ──────────────────────────────────────────

test('lists: mine is newest-first, pending is oldest-first and scope-bound', async () => {
  const ctx = makeSvcCtx({
    requests: [
      { ...pendingSeed('LATE_EXPLANATION', MONDAY, { proposal: {} }), _id: 'rg1', createdAt: new Date('2026-09-14T10:00:00Z') },
      { ...pendingSeed('MISSED_CLOCK_OUT', TODAY), _id: 'rg2', createdAt: new Date('2026-09-15T10:00:00Z') },
      { ...pendingSeed('LATE_EXPLANATION', MONDAY, { proposal: {} }), _id: 'rg3', user: USER_B, createdAt: new Date('2026-09-14T11:00:00Z') },
    ],
  });
  const mine = await listMyRegularizations({ ...ctx, companyId: COMPANY_A, userId: USER_A });
  // Fake sort is a no-op: assert membership + shape, not order.
  assert.equal(mine.length, 2);
  assert.ok(mine.every((row) => row.kind && row.typeLabel && typeof row.canCancel === 'boolean'));

  const pending = await listPendingRegularizations({ ...ctx, companyId: COMPANY_A, viewer: MGR });
  assert.deepEqual(pending.map((row) => row.id).sort(), ['rg1', 'rg2']);
  const otherScope = makeSvcCtx({ requests: ctx.RequestModel.rows });
  otherScope.resolveScopeIds = async () => [USER_B];
  const theirs = await listPendingRegularizations({ ...otherScope, companyId: COMPANY_A, viewer: { _id: MGR_UNRELATED } });
  assert.deepEqual(theirs.map((row) => row.id), ['rg3']);
});

test('get: owners read freely, reviewers need grant + scope, tenants stay blind', async () => {
  const ctx = makeSvcCtx({ requests: [pendingSeed()] });
  const own = await getRegularization({ ...ctx, companyId: COMPANY_A, viewer: EMP, requestId: 'rg1' });
  assert.equal(own.id, 'rg1');
  await assert.rejects(
    () => getRegularization({ ...ctx, companyId: COMPANY_A, viewer: { _id: USER_B }, requestId: 'rg1' }),
    /not found/,
  );
  const scoped = await getRegularization({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'rg1', asReviewer: true });
  assert.equal(scoped.id, 'rg1');
  const narrow = makeSvcCtx({ requests: [pendingSeed()] });
  narrow.resolveScopeIds = async () => [USER_B];
  await assert.rejects(
    () => getRegularization({ ...narrow, companyId: COMPANY_A, viewer: { _id: MGR_UNRELATED }, requestId: 'rg1', asReviewer: true }),
    /not in your team/,
  );
  await assert.rejects(
    () => getRegularization({ ...ctx, companyId: COMPANY_B, viewer: EMP, requestId: 'rg1' }),
    /not found/,
  );
});

test('serialize: null-safe shape with owner/reviewer cancel rights', () => {
  assert.equal(serializeRegularization(null), null);
  const row = {
    _id: 'rg1', user: USER_A, attendanceDate: MONDAY, type: 'LATE_EXPLANATION',
    reason: 'x', status: 'PENDING', proposal: {}, originalSnapshot: {},
  };
  assert.equal(serializeRegularization(row, { viewerId: USER_A }).canCancel, true);
  assert.equal(serializeRegularization(row, { viewerId: MGR_A, isReviewer: true }).canCancel, true);
  assert.equal(serializeRegularization(row, { viewerId: USER_B }).canCancel, false);
  assert.equal(serializeRegularization({ ...row, status: 'APPROVED' }, { viewerId: USER_A }).canCancel, false);
});

// ── REBUILD EDGES ────────────────────────────────────────

test('rebuild: explanation-only on an unrecorded day stands alone', async () => {
  const ctx = makeSvcCtx({ requests: [{ ...pendingSeed('GEOFENCE_EXPLANATION', MONDAY, { proposal: {} }), status: 'APPROVED' }] });
  const { control, overlayOnly } = await rebuildDayProjection({
    ...ctx, companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY, policy: ctx.policy,
  });
  assert.equal(control, null);
  assert.equal(overlayOnly, true);
  assert.equal(ctx.AttendanceModel.rows.length, 0);
});

test('rebuild: multi-group approvals compose into one effective day', async () => {
  const ctx = makeSvcCtx({
    attendance: [fullDayControl()],
    events: fullDayEvents(),
    requests: [
      { ...pendingSeed('CLOCK_IN_TIME_CORRECTION', MONDAY), status: 'APPROVED', proposal: { correctedIn: new Date(`${MONDAY}T09:00:00+05:30`) } },
      {
        ...pendingSeed('BREAK_CORRECTION', MONDAY),
        _id: 'rg2',
        status: 'APPROVED',
        proposal: { breaks: [{ start: new Date(`${MONDAY}T13:00:00+05:30`), end: new Date(`${MONDAY}T14:00:00+05:30`) }] },
      },
      { ...pendingSeed('LATE_EXPLANATION', MONDAY, { proposal: {} }), _id: 'rg3', status: 'APPROVED' },
    ],
  });
  const { control, overlayOnly } = await rebuildDayProjection({
    ...ctx, companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY, policy: ctx.policy,
  });
  assert.equal(overlayOnly, false);
  assert.equal(control.regularization.correctedIn.toISOString(), new Date(`${MONDAY}T09:00:00+05:30`).toISOString());
  assert.equal(control.regularization.correctedBreakMinutes, 60);
  assert.deepEqual(control.regularization.resolvedExceptions, ['LATE_IN']);
  assert.deepEqual(control.regularization.appliedRequestIds, ['rg1', 'rg2', 'rg3']);
  // 09:00 → 18:10 minus the corrected 60-minute lunch.
  assert.equal(control.workMinutes, 490);
  assert.equal(control.breakMinutes, 60);
  assert.equal(control.lateMinutes, 0);
  assert.equal(control.status, 'PRESENT');
});

test('rebuild: break-inclusive policies and legacy controls stay consistent', async () => {
  const included = makeSvcCtx({
    attendance: [fullDayControl()],
    events: fullDayEvents(),
    policy: makePolicy({ breaks: { includeInWorkedTime: true } }),
    requests: [{ ...pendingSeed('CLOCK_OUT_TIME_CORRECTION', MONDAY), status: 'APPROVED', proposal: { correctedOut: new Date(`${MONDAY}T18:00:00+05:30`) } }],
  });
  const { control } = await rebuildDayProjection({
    ...included, companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY, policy: included.policy,
  });
  // Span 09:05 → 18:00 counts whole when breaks are included.
  assert.equal(control.workMinutes, 535);
  assert.equal(control.breakMinutes, 30);

  // Legacy control: classic punches, no event ledger at all.
  const legacy = makeSvcCtx({
    attendance: [fullDayControl(MONDAY, USER_A, COMPANY_A, { liveState: null, eventSeq: 0, policyOutcome: null, policyExceptions: [] })],
    requests: [{ ...pendingSeed('CLOCK_OUT_TIME_CORRECTION', MONDAY), status: 'APPROVED', proposal: { correctedOut: new Date(`${MONDAY}T18:00:00+05:30`) } }],
  });
  const rebuilt = await rebuildDayProjection({
    ...legacy, companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY, policy: legacy.policy,
  });
  assert.equal(rebuilt.control.workMinutes, 535);
  assert.equal(rebuilt.control.regularization.correctedOut.toISOString(), new Date(`${MONDAY}T18:00:00+05:30`).toISOString());
  assert.equal(rebuilt.control.punchOut.toISOString(), new Date(`${MONDAY}T18:10:00+05:30`).toISOString());
});

test('rebuild: short effective days become HALF_DAY like a live early out', async () => {
  const ctx = makeSvcCtx({
    attendance: [fullDayControl()],
    events: fullDayEvents(),
    requests: [{ ...pendingSeed('CLOCK_OUT_TIME_CORRECTION', MONDAY), status: 'APPROVED', proposal: { correctedOut: new Date(`${MONDAY}T12:00:00+05:30`) } }],
  });
  const { control } = await rebuildDayProjection({
    ...ctx, companyId: COMPANY_A, userId: USER_A, attendanceDate: MONDAY, policy: ctx.policy,
  });
  assert.equal(control.workMinutes, 145);
  assert.equal(control.breakMinutes, 30);
  assert.equal(control.status, 'HALF_DAY');
  assert.equal(control.policyOutcome, 'ABSENT');
});

// ── RBAC ───────────────────────────────────────────────────

test('rbac: REQUEST is self-service, REVIEW is least-privilege', () => {
  const names = registry.DEFAULT_PERMISSIONS.map((permission) => permission.name);
  assert.ok(names.includes('ATTENDANCE_REGULARIZATION_REQUEST'));
  assert.ok(names.includes('ATTENDANCE_REGULARIZATION_REVIEW'));
  assert.ok(registry.DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('ATTENDANCE_REGULARIZATION_REQUEST'));
  assert.ok(!registry.DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('ATTENDANCE_REGULARIZATION_REVIEW'));
  assert.ok(registry.DEFAULT_ROLE_MATRIX.MANAGER.includes('ATTENDANCE_REGULARIZATION_REVIEW'));
  assert.ok(registry.DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('ATTENDANCE_REGULARIZATION_REVIEW'));
});

// ── VALIDATOR ──────────────────────────────────────────────

const runChain = async (chainList, { body = {}, params = {} } = {}) => {
  const req = { body, params, query: {} };
  for (const middleware of chainList) {
    await new Promise((resolve, reject) => {
      Promise.resolve(middleware(req, {}, (err) => (err ? reject(err) : resolve()))).then(
        () => resolve(),
        (err) => reject(err),
      );
    });
  }
};

test('validator: identity overrides are refused outright', async () => {
  const good = { type: 'MISSED_CLOCK_OUT', attendanceDate: MONDAY, reason: 'ok', proposal: { correctedOut: `${MONDAY}T18:00:00+05:30` } };
  await assert.rejects(() => runChain(regValidator.regularizationCreateValidator, { body: { ...good, employeeId: USER_B } }), /must not be supplied/);
  await assert.rejects(() => runChain(regValidator.regularizationCreateValidator, { body: { ...good, approverId: MGR_A } }), /must not be supplied/);
  await assert.rejects(() => runChain(regValidator.regularizationCreateValidator, { body: { ...good, companyId: COMPANY_B } }), /must not be supplied/);
  await assert.rejects(() => runChain(regValidator.regularizationCreateValidator, { body: { ...good, user: USER_B } }), /must not be supplied/);
});

test('validator: legitimate payloads pass, bad shapes fail', async () => {
  await runChain(regValidator.regularizationCreateValidator, {
    body: { type: 'BREAK_CORRECTION', attendanceDate: MONDAY, reason: 'Forgot lunch punch', proposal: { breaks: [{ start: `${MONDAY}T13:00:00+05:30`, end: `${MONDAY}T14:00:00+05:30` }] } },
  });
  await runChain(regValidator.regularizationCreateValidator, {
    body: { type: 'LATE_EXPLANATION', attendanceDate: MONDAY, reason: 'Metro delay' },
  });
  await runChain(regValidator.regularizationIdValidator, { params: { requestId: COMPANY_A } });
  await assert.rejects(() => runChain(regValidator.regularizationCreateValidator, { body: { type: 'MISSED_PUNCH', attendanceDate: MONDAY, reason: 'x' } }), /type must be/);
  await assert.rejects(() => runChain(regValidator.regularizationCreateValidator, { body: { type: 'MISSED_CLOCK_OUT', attendanceDate: 'yesterday', reason: 'x' } }), /YYYY-MM-DD/);
  await assert.rejects(() => runChain(regValidator.regularizationCreateValidator, { body: { type: 'MISSED_CLOCK_OUT', attendanceDate: MONDAY, reason: 'x', proposal: { correctedOut: 'soon' } } }), /ISO datetime/);
  await assert.rejects(() => runChain(regValidator.regularizationCreateValidator, { body: { type: 'WORK_MODE_CORRECTION', attendanceDate: MONDAY, reason: 'x', proposal: { workMode: 'REMOTE' } } }), /valid work mode/);
  await assert.rejects(() => runChain(regValidator.regularizationIdValidator, { params: { requestId: 'nope' } }), /valid id/);
});

// ── REUSE-SEAM + LIVE REGRESSION ───────────────────────────

test('seam: the rebuild reuses the live derivation helpers, not copies', () => {
  assert.equal(typeof derivePolicyOutcome, 'function');
  assert.equal(typeof resolveDayScheduleRule, 'function');
  assert.equal(typeof resolveRuleFromRecord, 'function');
  assert.equal(WORK_MODE.OFFICE, 'OFFICE');
});

test('regression: full OFFICE cycle + breaks + replay under 31.5', async () => {
  const AttendanceModel = makeFakeAttendanceModel();
  const AttendanceEventModel = makeFakeEventModel();
  const deps = {
    AttendanceModel,
    AttendanceEventModel,
    policyReader: async () => ({ policy: makePolicy(), configured: true, hasActive: true }),
    engine: testEngine(),
    resolveScheduleRule: testResolveScheduleRule,
    now: () => new Date(`${TODAY}T09:00:00+05:30`),
    sleep: async () => {},
  };
  const punch = (action, overrides = {}) =>
    recordEvent({ companyId: COMPANY_A, userId: USER_A, action, workMode: null, date: null, idempotencyKey: null, location: null, deps, ...overrides });
  const clockIn = await punch('CLOCK_IN', { workMode: 'OFFICE', idempotencyKey: 'reg-in' });
  assert.equal(clockIn.snapshot.liveState, 'WORKING');
  await punch('BREAK_START', { idempotencyKey: 'reg-b1' });
  await punch('BREAK_END', { idempotencyKey: 'reg-b1e' });
  const out = await punch('CLOCK_OUT', { idempotencyKey: 'reg-out' });
  assert.equal(out.snapshot.liveState, 'COMPLETED');
  assert.equal(AttendanceEventModel.rows.length, 4);
  const replay = await punch('CLOCK_IN', { workMode: 'OFFICE', idempotencyKey: 'reg-in' });
  assert.equal(replay.replayed, true);
  assert.equal(AttendanceEventModel.rows.length, 4);
  assert.ok(!('regularization' in out.snapshot) || out.snapshot.regularization == null);
});

// ── STATIC GUARDS ──────────────────────────────────────────

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const codeOf = (file) => {
  const raw = readFileSync(join(SRC, file), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
};

test('static: 31.5 never writes payroll, leave, work-mode requests or events', () => {
  const files = [
    'models/AttendanceRegularization.js',
    'services/attendance/attendanceRegularizationRules.js',
    'services/attendance/attendanceRegularizationService.js',
    'validators/attendanceRegularizationValidator.js',
    'controllers/attendanceRegularizationController.js',
    'routes/attendanceRegularizationRoutes.js',
  ];
  for (const file of files) {
    const content = codeOf(file);
    // The payroll boundary is a READ of the period lock only.
    assert.ok(!/PayrollResult|payrollEngine|salaryComponent|payslip|fnf/i.test(content), `${file} must not touch payroll computation`);
    assert.ok(!/PayrollPeriodModel\.(create|findOneAndUpdate|updateOne|updateMany|save|deleteOne)/.test(content), `${file} must never write payroll periods`);
    assert.ok(!/LeaveModel\.(create|findOneAndUpdate|updateOne|updateMany|save|deleteOne)/.test(content), `${file} must never write leave`);
    assert.ok(!/WorkModeRequestModel\.(create|findOneAndUpdate|updateOne|updateMany|save|deleteOne)/.test(content), `${file} must never write work-mode requests`);
    assert.ok(!/AttendanceEventModel\.(create|findOneAndUpdate|updateOne|updateMany|save|deleteOne)/.test(content), `${file} must never write attendance events`);
  }
});

test('static: recorded punches only ever feed derivations, never persistence', () => {
  const content = codeOf('services/attendance/attendanceRegularizationService.js');
  // Derivation inputs are legitimate: the effective timeline feeds
  // the shared evaluators. Everything else must not name them.
  const withoutDerivations = content
    .split('\n')
    .filter((line) => !/^\s*punch(In|Out): effective\./.test(line))
    .join('\n');
  assert.ok(!/\bpunch(In|Out)\s*:/.test(withoutDerivations), 'punchIn/punchOut must never be set by 31.5');
  assert.ok(!/patch\.punch(In|Out)/.test(withoutDerivations), 'the rebuild patch must never carry punches');
  assert.ok(!/\.punch(In|Out)\s*=/.test(withoutDerivations), 'recorded punches must never be assigned');
});

test('static: controller keeps the repo comment convention', () => {
  const content = readFileSync(join(SRC, 'controllers/attendanceRegularizationController.js'), 'utf8');
  assert.ok(content.includes('// Data from frontend'), 'controller must mark frontend inputs');
  assert.ok(content.includes('// DB Logic'), 'controller must mark DB logic');
  assert.ok(content.includes('// Data to frontend'), 'controller must mark frontend outputs');
});
