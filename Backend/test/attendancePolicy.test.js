// Phase 31.1 — Attendance Foundation & Policy Engine (hermetic suite).
//
// No MongoDB, no Redis, no network: every model/cache/audit collaborator
// is injected. Redis is disabled so the cache abstraction fails open.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const [rules, service, registry, Attendance, apiErrorMod] = await Promise.all([
  import('../src/services/attendance/attendancePolicyRules.js'),
  import('../src/services/attendance/attendancePolicyService.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/models/Attendance.js'),
  import('../src/utils/ApiError.js'),
]);

const {
  DAILY_OUTCOME,
  EXCEPTION_CODE,
  DAY_TYPE,
  LEAVE_CONTEXT,
  validatePolicy,
  validateThresholds,
  validateGrace,
  validateWorkModes,
  classifyWorkedMinutes,
  detectLate,
  detectEarlyOut,
  applyBreakTreatment,
  deriveMissingPunchExceptions,
  deriveOTEligibleMinutes,
  validateEvaluationInput,
  evaluateDay,
  canTransitionPolicy,
  isValidTimeZone,
  dayKeyInZone,
  minutesSinceMidnightInZone,
  shiftEndMinutes,
} = rules;

const {
  getCurrentPolicy,
  listPolicyHistory,
  saveDraftPolicy,
  activatePolicy,
  buildAttendancePolicyCacheKey,
  getPolicyCacheTtlSeconds,
} = service;

const ApiError = apiErrorMod.default;

// ── fixtures ───────────────────────────────────────────────────

const validPolicy = () => ({
  name: 'Standard Policy',
  description: 'Test policy',
  timezone: 'Asia/Kolkata',
  locationEnforcement: 'DISABLED',
  thresholds: { fullDayMinutes: 480, halfDayMinutes: 240 },
  grace: { lateInMinutes: 15, earlyOutMinutes: 15 },
  breaks: { enabled: true, includeInWorkedTime: false, dailyLimitMinutes: null },
  missingPunch: { keepUnresolved: true, allowRegularization: true, regularizationWindowDays: 7 },
  overtime: {
    trackingEnabled: true,
    minimumExtraMinutes: 30,
    approvalRequired: true,
    weekendEligible: true,
    holidayEligible: false,
  },
  weekendHoliday: { allowWorkOnWeeklyOff: true, allowWorkOnHoliday: true },
  workModes: { office: true, wfh: true, field: false, clientSite: false, businessTravel: false },
});

// In-memory fake with a chainable Mongoose-like query surface.
const makeFakePolicyModel = (seen = []) => {
  const rows = [];
  let seq = 1;

  const matches = (row, filter = {}) =>
    Object.entries(filter).every(([key, value]) => {
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        if (value.$in) return value.$in.map(String).includes(String(row[key]));
        return true;
      }
      return String(row[key] ?? '') === String(value ?? '');
    });

  const attachSave = (row) => {
    row.save = async () => {
      row.updatedAt = new Date();
      return row;
    };
    return row;
  };

  const query = (resolve) => {
    let sortSpec = null;
    let limitCount = null;
    const chain = {
      lean: () => chain,
      sort: (spec) => {
        sortSpec = spec;
        return chain;
      },
      limit: (count) => {
        limitCount = count;
        return chain;
      },
      select: () => chain,
      then: (resolvePromise, rejectPromise) =>
        Promise.resolve()
          .then(resolve)
          .then((value) => {
            if (!Array.isArray(value)) return value;
            let out = [...value];
            if (sortSpec) {
              const [[key, direction]] = Object.entries(sortSpec);
              out.sort(
                (a, b) =>
                  (Number(a[key] ?? 0) - Number(b[key] ?? 0)) * (direction === -1 ? -1 : 1),
              );
            }
            if (limitCount !== null) out = out.slice(0, limitCount);
            return out;
          })
          .then(resolvePromise, rejectPromise),
    };
    return chain;
  };

  return {
    rows,
    findOne: (filter) => {
      seen.push({ op: 'findOne', filter });
      return query(() => {
        const found = rows.find((row) => matches(row, filter));
        return found ? attachSave(found) : null;
      });
    },
    find: (filter) => {
      seen.push({ op: 'find', filter });
      return query(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row })));
    },
    create: async (doc) => {
      seen.push({ op: 'create', filter: { companyId: doc.companyId } });
      const row = attachSave({
        ...doc,
        _id: `policy${seq}`,
        id: `policy${seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      seq += 1;
      rows.push(row);
      return row;
    },
  };
};

const makeFakeCompanyModel = (timezone = 'Asia/Kolkata') => ({
  findById: () => ({
    select: () => ({
      lean: async () => ({ _id: COMPANY_A, timezone }),
    }),
  }),
});

const makeAuditFake = () => {
  const calls = [];
  const audit = async (args) => {
    calls.push(args);
    return null;
  };
  return { calls, audit };
};

const validInput = () => ({
  scheduledStart: 540,
  scheduledEnd: 1020,
  clockIn: 545,
  clockOut: 1030,
  breakMinutes: 30,
  workMode: 'OFFICE',
  dayType: DAY_TYPE.WORK_DAY,
  leave: LEAVE_CONTEXT.NONE,
});

// ── POLICY RULES ─────────────────────────────────────────────

test('rules: a complete policy validates', () => {
  const check = validatePolicy(validPolicy());
  assert.equal(check.valid, true);
  assert.deepEqual(check.errors, []);
});

test('rules: half-day threshold must stay below full-day threshold', () => {
  assert.ok(validateThresholds({ fullDayMinutes: 480, halfDayMinutes: 480 }).length > 0);
  assert.ok(validateThresholds({ fullDayMinutes: 240, halfDayMinutes: 480 }).length > 0);
  assert.deepEqual(validateThresholds({ fullDayMinutes: 480, halfDayMinutes: 0 }), []);
});

test('rules: negative or absurd thresholds are refused', () => {
  assert.ok(validateThresholds({ fullDayMinutes: -5, halfDayMinutes: 0 }).length > 0);
  assert.ok(validateThresholds({ fullDayMinutes: 0, halfDayMinutes: 0 }).length > 0);
  assert.ok(validateThresholds({ fullDayMinutes: 1500, halfDayMinutes: 100 }).length > 0);
  assert.ok(validateThresholds({ fullDayMinutes: 480.5, halfDayMinutes: 100 }).length > 0);
});

test('rules: grace periods are bounded non-negative integers', () => {
  assert.deepEqual(validateGrace({ lateInMinutes: 0, earlyOutMinutes: 120 }), []);
  assert.ok(validateGrace({ lateInMinutes: -1, earlyOutMinutes: 0 }).length > 0);
  assert.ok(validateGrace({ lateInMinutes: 0, earlyOutMinutes: 121 }).length > 0);
  assert.ok(validateGrace({ lateInMinutes: 1.5, earlyOutMinutes: 0 }).length > 0);
});

test('rules: office work mode must remain enabled', () => {
  const modes = { office: true, wfh: false, field: false, clientSite: false, businessTravel: false };
  assert.deepEqual(validateWorkModes(modes), []);
  assert.ok(validateWorkModes({ ...modes, office: false }).length > 0);
  assert.ok(validateWorkModes({ ...modes, wfh: 'yes' }).length > 0);
});

test('rules: invalid timezone is refused', () => {
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(validatePolicy({ ...validPolicy(), timezone: 'Mars/Olympus' }).valid, false);
});

test('rules: worked-minute classification bands', () => {
  const thresholds = { fullDayMinutes: 480, halfDayMinutes: 240 };

  assert.equal(classifyWorkedMinutes(480, thresholds).band, DAILY_OUTCOME.PRESENT);
  assert.equal(classifyWorkedMinutes(600, thresholds).band, DAILY_OUTCOME.PRESENT);
  assert.equal(classifyWorkedMinutes(240, thresholds).band, DAILY_OUTCOME.HALF_DAY);
  assert.equal(classifyWorkedMinutes(479, thresholds).band, DAILY_OUTCOME.HALF_DAY);
  assert.equal(classifyWorkedMinutes(239, thresholds).band, 'SHORT');
  assert.equal(classifyWorkedMinutes(0, thresholds).band, 'SHORT');
});

test('rules: late detection honors grace', () => {
  assert.deepEqual(detectLate(10, 15), { isLate: false, lateMinutes: 10 });
  assert.deepEqual(detectLate(15, 15), { isLate: false, lateMinutes: 15 });
  assert.deepEqual(detectLate(16, 15), { isLate: true, lateMinutes: 16 });
  assert.deepEqual(detectEarlyOut(20, 15), { isEarly: true, earlyMinutes: 20 });
  assert.deepEqual(detectEarlyOut(15, 15), { isEarly: false, earlyMinutes: 15 });
});

test('rules: missing punches derive exceptions, never invented time', () => {
  assert.deepEqual(
    deriveMissingPunchExceptions({ clockIn: null, clockOut: 1000 }),
    [EXCEPTION_CODE.MISSED_IN],
  );
  assert.deepEqual(
    deriveMissingPunchExceptions({ clockIn: 500, clockOut: undefined }),
    [EXCEPTION_CODE.MISSED_OUT],
  );
  assert.deepEqual(deriveMissingPunchExceptions({ clockIn: 500, clockOut: 1000 }), []);
});

test('rules: break treatment included vs excluded', () => {
  const excluded = applyBreakTreatment({
    grossMinutes: 500,
    breakMinutes: 60,
    breaks: { enabled: true, includeInWorkedTime: false, dailyLimitMinutes: null },
  });
  assert.equal(excluded.workedMinutes, 440);
  assert.equal(excluded.countedBreakMinutes, 0);

  const included = applyBreakTreatment({
    grossMinutes: 500,
    breakMinutes: 60,
    breaks: { enabled: true, includeInWorkedTime: true, dailyLimitMinutes: 30 },
  });
  assert.equal(included.workedMinutes, 470);
  assert.equal(included.countedBreakMinutes, 30);
  assert.equal(included.cappedBreakMinutes, 30);

  const disabled = applyBreakTreatment({
    grossMinutes: 500,
    breakMinutes: 60,
    breaks: { enabled: false, includeInWorkedTime: false, dailyLimitMinutes: null },
  });
  assert.equal(disabled.workedMinutes, 500);
});

test('rules: OT eligibility honors tracking, minimum, and day gates', () => {
  const base = {
    trackingEnabled: true,
    minimumExtraMinutes: 30,
    approvalRequired: true,
    weekendEligible: true,
    holidayEligible: false,
  };

  assert.equal(
    deriveOTEligibleMinutes({ extraMinutes: 45, overtime: base, dayType: DAY_TYPE.WORK_DAY })
      .eligibleMinutes,
    45,
  );
  assert.equal(
    deriveOTEligibleMinutes({ extraMinutes: 20, overtime: base, dayType: DAY_TYPE.WORK_DAY })
      .eligibleMinutes,
    0,
  );
  assert.equal(
    deriveOTEligibleMinutes({
      extraMinutes: 45,
      overtime: { ...base, trackingEnabled: false },
      dayType: DAY_TYPE.WORK_DAY,
    }).eligibleMinutes,
    0,
  );
  assert.equal(
    deriveOTEligibleMinutes({ extraMinutes: 45, overtime: base, dayType: DAY_TYPE.WEEKLY_OFF })
      .eligibleMinutes,
    45,
  );
  assert.equal(
    deriveOTEligibleMinutes({ extraMinutes: 45, overtime: base, dayType: DAY_TYPE.HOLIDAY })
      .eligibleMinutes,
    0,
  );
});

// ── EVALUATION CONTRACT ────────────────────────────────────

test('evaluateDay: full worked day with schedule is PRESENT', () => {
  const result = evaluateDay({ policy: validPolicy(), ...validInput(), clockOut: 1060 });

  assert.equal(result.outcome, DAILY_OUTCOME.PRESENT);
  // gross 515 − 30 break = 485.
  assert.equal(result.workedMinutes, 485);
  assert.deepEqual(result.exceptions, []);
  assert.equal(result.lateMinutes, 0);
  assert.equal(result.holidayWorked, false);
});

test('evaluateDay: late arrival and early exit raise exceptions', () => {
  const result = evaluateDay({
    policy: validPolicy(),
    ...validInput(),
    clockIn: 600,
    clockOut: 990,
  });

  assert.deepEqual(result.exceptions, [EXCEPTION_CODE.LATE_IN, EXCEPTION_CODE.EARLY_OUT]);
  assert.equal(result.lateMinutes, 60);
  assert.equal(result.earlyMinutes, 30);
  // gross 390 − 30 = 360 → HALF_DAY band, still evaluated (not hidden).
  assert.equal(result.outcome, DAILY_OUTCOME.HALF_DAY);
});

test('evaluateDay: short hours become ABSENT + SHORT_HOURS', () => {
  const result = evaluateDay({
    policy: validPolicy(),
    ...validInput(),
    clockIn: 540,
    clockOut: 700,
    breakMinutes: 0,
  });

  assert.equal(result.outcome, DAILY_OUTCOME.ABSENT);
  assert.ok(result.exceptions.includes(EXCEPTION_CODE.SHORT_HOURS));
  assert.equal(result.shortfallMinutes, 240 - 160);
});

test('evaluateDay: partial punches stay UNRESOLVED with missing-punch codes', () => {
  const noOut = evaluateDay({ policy: validPolicy(), ...validInput(), clockOut: null });

  assert.equal(noOut.outcome, DAILY_OUTCOME.UNRESOLVED);
  assert.deepEqual(noOut.exceptions, [EXCEPTION_CODE.MISSED_OUT]);
  assert.equal(noOut.workedMinutes, 0);

  const noIn = evaluateDay({ policy: validPolicy(), ...validInput(), clockIn: null });
  assert.deepEqual(noIn.exceptions, [EXCEPTION_CODE.MISSED_IN]);
});

test('evaluateDay: absence, leave, and non-working days stay distinct', () => {
  const policy = validPolicy();
  const bare = { policy, dayType: DAY_TYPE.WORK_DAY, leave: LEAVE_CONTEXT.NONE };

  assert.equal(evaluateDay(bare).outcome, DAILY_OUTCOME.ABSENT);
  assert.equal(
    evaluateDay({ ...bare, leave: LEAVE_CONTEXT.FULL_DAY }).outcome,
    DAILY_OUTCOME.NON_WORKING_DAY,
  );
  assert.equal(
    evaluateDay({ ...bare, dayType: DAY_TYPE.HOLIDAY }).outcome,
    DAILY_OUTCOME.NON_WORKING_DAY,
  );
  assert.equal(
    evaluateDay({ ...bare, dayType: DAY_TYPE.WEEKLY_OFF }).outcome,
    DAILY_OUTCOME.NON_WORKING_DAY,
  );
  // Leave is never forced into PRESENT.
  assert.notEqual(
    evaluateDay({ ...bare, leave: LEAVE_CONTEXT.FULL_DAY }).outcome,
    DAILY_OUTCOME.PRESENT,
  );
});

test('evaluateDay: holiday work reports facts and honors eligibility', () => {
  const policy = validPolicy();
  const result = evaluateDay({
    policy,
    ...validInput(),
    dayType: DAY_TYPE.HOLIDAY,
    clockIn: 540,
    clockOut: 1100,
    breakMinutes: 0,
  });

  assert.equal(result.outcome, DAILY_OUTCOME.NON_WORKING_DAY);
  assert.equal(result.holidayWorked, true);
  // holidayEligible=false → no eligible OT despite 80 extra minutes.
  assert.equal(result.eligibleOtMinutes, 0);

  const eligible = evaluateDay({
    policy: { ...policy, overtime: { ...policy.overtime, holidayEligible: true } },
    ...validInput(),
    dayType: DAY_TYPE.HOLIDAY,
    clockIn: 540,
    clockOut: 1100,
    breakMinutes: 0,
  });
  assert.equal(eligible.eligibleOtMinutes, 80);
});

test('evaluateDay: disabled work mode and bad input are rejected, not guessed', () => {
  const policy = validPolicy();

  assert.throws(
    () => evaluateDay({ policy, ...validInput(), workMode: 'FIELD' }),
    /not enabled/,
  );
  assert.throws(
    () => evaluateDay({ policy, ...validInput(), clockIn: 900, clockOut: 800 }),
    /before clockIn/,
  );
  assert.throws(
    () => evaluateDay({ policy, ...validInput(), dayType: 'FUNDAY' }),
    /dayType/,
  );

  const check = validateEvaluationInput({ policy, ...validInput(), workMode: 'FIELD' });
  assert.equal(check.valid, false);
});

test('rules: lifecycle transitions are constrained', () => {
  assert.equal(canTransitionPolicy('DRAFT', 'ACTIVE'), true);
  assert.equal(canTransitionPolicy('ACTIVE', 'ARCHIVED'), true);
  assert.equal(canTransitionPolicy('DRAFT', 'ARCHIVED'), false);
  assert.equal(canTransitionPolicy('ARCHIVED', 'ACTIVE'), false);
  assert.equal(canTransitionPolicy('ACTIVE', 'DRAFT'), false);
});

// ── TIME ─────────────────────────────────────────────────────

test('time: zone helpers never use server-local time', () => {
  // 2026-09-11T18:30:00Z is exactly midnight starting 2026-09-12 in IST.
  assert.equal(dayKeyInZone('2026-09-11T18:30:00Z', 'Asia/Kolkata'), '2026-09-12');
  assert.equal(dayKeyInZone('2026-09-11T18:29:00Z', 'Asia/Kolkata'), '2026-09-11');
  assert.equal(minutesSinceMidnightInZone('2026-09-11T18:30:00Z', 'Asia/Kolkata'), 0);
  assert.equal(minutesSinceMidnightInZone('2026-09-11T03:30:00Z', 'Asia/Kolkata'), 540);
  assert.equal(minutesSinceMidnightInZone('2026-09-11T03:30:00Z', 'UTC'), 210);
});

test('time: overnight spans are expressible past midnight', () => {
  assert.equal(shiftEndMinutes(1320, 360), 1800);
  assert.equal(shiftEndMinutes(540, 1020), 1020);

  // 22:00 → 02:00 next day = 240 gross; minus 0 break < 240 half-day? No:
  // exactly 240 → HALF_DAY band floor.
  const result = evaluateDay({
    policy: validPolicy(),
    scheduledStart: 1320,
    scheduledEnd: 360,
    clockIn: 1320,
    clockOut: 1680,
    breakMinutes: 0,
    dayType: DAY_TYPE.WORK_DAY,
    leave: LEAVE_CONTEXT.NONE,
  });
  assert.equal(result.workedMinutes, 360);
  assert.equal(result.outcome, DAILY_OUTCOME.HALF_DAY);
});

// ── LIFECYCLE (service, fake models) ─────────────────────────

test('lifecycle: unconfigured company returns empty, not an error', async () => {
  const AttendancePolicyModel = makeFakePolicyModel();

  const result = await getCurrentPolicy({
    companyId: COMPANY_A,
    AttendancePolicyModel,
  });

  assert.equal(result.configured, false);
  assert.equal(result.hasActive, false);
  assert.equal(result.policy, null);
});

test('lifecycle: draft create → update → activate → history preserved', async () => {
  const AttendancePolicyModel = makeFakePolicyModel();
  const { calls, audit } = makeAuditFake();
  const CompanyModel = makeFakeCompanyModel('Asia/Kolkata');

  const created = await saveDraftPolicy({
    companyId: COMPANY_A,
    input: { name: 'V1', thresholds: { fullDayMinutes: 480, halfDayMinutes: 240 } },
    actor: { _id: 'admin1' },
    AttendancePolicyModel,
    CompanyModel,
    audit,
  });
  assert.equal(created.created, true);
  assert.equal(created.policy.status, 'DRAFT');
  assert.equal(created.policy.timezone, 'Asia/Kolkata');

  const updated = await saveDraftPolicy({
    companyId: COMPANY_A,
    input: { thresholds: { fullDayMinutes: 480, halfDayMinutes: 200 } },
    expectedConfigVersion: 1,
    AttendancePolicyModel,
    CompanyModel,
    audit,
  });
  assert.equal(updated.created, false);
  assert.equal(updated.policy.thresholds.halfDayMinutes, 200);
  assert.equal(updated.policy.configVersion, 2);

  const activated = await activatePolicy({
    companyId: COMPANY_A,
    actor: { _id: 'admin1' },
    AttendancePolicyModel,
    audit,
  });
  assert.equal(activated.policy.status, 'ACTIVE');
  assert.equal(activated.policy.isCurrent, true);
  assert.equal(activated.policy.version, 1);

  // Second generation archives the first instead of mutating it.
  await saveDraftPolicy({
    companyId: COMPANY_A,
    input: { thresholds: { fullDayMinutes: 480, halfDayMinutes: 100 } },
    AttendancePolicyModel,
    CompanyModel,
    audit,
  });
  await activatePolicy({ companyId: COMPANY_A, AttendancePolicyModel, audit });

  const history = await listPolicyHistory({ companyId: COMPANY_A, AttendancePolicyModel });
  assert.equal(history.history.length, 2);
  assert.equal(history.history[0].version, 2);
  assert.equal(history.history[0].status, 'ACTIVE');
  assert.equal(history.history[1].status, 'ARCHIVED');
  // No historical reinterpretation: v1 keeps its own thresholds.
  assert.equal(history.history[1].thresholds.halfDayMinutes, 200);
  assert.equal(history.history[0].thresholds.halfDayMinutes, 100);

  const actions = calls.map((call) => call.action);
  assert.ok(actions.includes('ATTENDANCE_POLICY_CREATED'));
  assert.ok(actions.includes('ATTENDANCE_POLICY_UPDATED'));
  assert.ok(actions.includes('ATTENDANCE_POLICY_ACTIVATED'));
});

test('lifecycle: activation without a draft and stale writes are refused', async () => {
  const AttendancePolicyModel = makeFakePolicyModel();
  const { calls, audit } = makeAuditFake();

  await assert.rejects(
    () => activatePolicy({ companyId: COMPANY_A, AttendancePolicyModel, audit }),
    /No draft/,
  );

  await saveDraftPolicy({
    companyId: COMPANY_A,
    input: { name: 'V1' },
    AttendancePolicyModel,
    CompanyModel: makeFakeCompanyModel(),
    audit,
  });

  await assert.rejects(
    () =>
      saveDraftPolicy({
        companyId: COMPANY_A,
        input: { name: 'V2' },
        expectedConfigVersion: 999,
        AttendancePolicyModel,
        audit,
      }),
    /someone else/,
  );

  // Failed writes produce no success audit.
  assert.ok(calls.every((call) => call.action !== 'ATTENDANCE_POLICY_ACTIVATED'));
});

test('lifecycle: invalid drafts are refused before any write', async () => {
  const AttendancePolicyModel = makeFakePolicyModel();
  const { calls, audit } = makeAuditFake();

  await assert.rejects(
    () =>
      saveDraftPolicy({
        companyId: COMPANY_A,
        input: { thresholds: { fullDayMinutes: 200, halfDayMinutes: 300 } },
        AttendancePolicyModel,
        CompanyModel: makeFakeCompanyModel(),
        audit,
      }),
    /halfDayMinutes/,
  );

  assert.equal(AttendancePolicyModel.rows.length, 0);
  assert.equal(calls.length, 0);
});

// ── TENANCY ──────────────────────────────────────────────────

test('tenancy: every query is company-scoped; client companyId never wins', async () => {
  const seen = [];
  const AttendancePolicyModel = makeFakePolicyModel(seen);

  await getCurrentPolicy({ companyId: COMPANY_A, AttendancePolicyModel });
  await listPolicyHistory({ companyId: COMPANY_A, AttendancePolicyModel });
  await saveDraftPolicy({
    companyId: COMPANY_A,
    input: { name: 'A-policy', companyId: COMPANY_B },
    AttendancePolicyModel,
    CompanyModel: makeFakeCompanyModel(),
    audit: async () => null,
  });

  assert.ok(seen.length > 0);
  seen.forEach((entry) => {
    assert.equal(String(entry.filter.companyId), COMPANY_A);
  });
  assert.equal(String(AttendancePolicyModel.rows[0].companyId), COMPANY_A);
});

test('tenancy: cache keys are tenant-separated', () => {
  const keyA = buildAttendancePolicyCacheKey(COMPANY_A);
  const keyB = buildAttendancePolicyCacheKey(COMPANY_B);

  assert.ok(keyA.includes(COMPANY_A));
  assert.ok(!keyA.includes(COMPANY_B));
  assert.notEqual(keyA, keyB);
  assert.ok(keyA.includes('attendance-policy'));
});

// ── CACHE ────────────────────────────────────────────────────

test('cache: hit serves cached policy without touching Mongo', async () => {
  const seen = [];
  const AttendancePolicyModel = makeFakePolicyModel(seen);
  const cached = { policy: { id: 'cached', status: 'ACTIVE' }, configured: true, hasActive: true };

  const result = await getCurrentPolicy({
    companyId: COMPANY_A,
    AttendancePolicyModel,
    io: {
      get: async () => ({ v: 1, at: Date.now(), payload: cached }),
      set: async () => true,
      del: async () => true,
    },
  });

  assert.equal(result.cache, 'HIT');
  assert.deepEqual(result.policy, cached.policy);
  assert.equal(seen.length, 0);
});

test('cache: Redis failure falls back to Mongo (fail-open)', async () => {
  const AttendancePolicyModel = makeFakePolicyModel();
  await AttendancePolicyModel.create({
    companyId: COMPANY_A,
    status: 'ACTIVE',
    isCurrent: true,
    version: 1,
    ...validPolicy(),
  });

  const result = await getCurrentPolicy({
    companyId: COMPANY_A,
    AttendancePolicyModel,
    io: {
      get: async () => null,
      set: async () => false,
      del: async () => false,
    },
  });

  assert.equal(result.configured, true);
  assert.equal(result.policy.status, 'ACTIVE');
});

test('cache: TTL parser clamps to the documented band', () => {
  assert.equal(getPolicyCacheTtlSeconds({}), 300);
  assert.equal(getPolicyCacheTtlSeconds({ ATTENDANCE_POLICY_CACHE_TTL_SECONDS: '5' }), 10);
  assert.equal(getPolicyCacheTtlSeconds({ ATTENDANCE_POLICY_CACHE_TTL_SECONDS: '99999' }), 3600);
  assert.equal(getPolicyCacheTtlSeconds({ ATTENDANCE_POLICY_CACHE_TTL_SECONDS: '60' }), 60);
});

// ── RBAC (registry assertions) ───────────────────────────────

test('rbac: attendance policy permissions exist and are least-privilege', () => {
  const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;

  ['ATTENDANCE_POLICY_READ', 'ATTENDANCE_POLICY_MANAGE', 'ATTENDANCE_POLICY_ACTIVATE'].forEach(
    (name) => {
      const found = DEFAULT_PERMISSIONS.find((entry) => entry.name === name);
      assert.ok(found, `${name} registered`);
      assert.equal(found.resource, 'ATTENDANCE_POLICY');
    },
  );

  const hr = DEFAULT_ROLE_MATRIX.HR_MANAGER || [];
  assert.ok(hr.includes('ATTENDANCE_POLICY_READ'));
  assert.ok(hr.includes('ATTENDANCE_POLICY_MANAGE'));
  assert.ok(!hr.includes('ATTENDANCE_POLICY_ACTIVATE'));

  ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE'].forEach((role) => {
    const perms = DEFAULT_ROLE_MATRIX[role] || [];
    assert.ok(!perms.includes('ATTENDANCE_POLICY_READ'), `${role} has no policy read`);
    assert.ok(!perms.includes('ATTENDANCE_POLICY_MANAGE'), `${role} has no policy manage`);
    assert.ok(!perms.includes('ATTENDANCE_POLICY_ACTIVATE'), `${role} has no policy activate`);
  });

  // Company Admin inherits the whole catalogue automatically.
  const admin = DEFAULT_ROLE_MATRIX.COMPANY_ADMIN || [];
  assert.ok(admin.includes('ATTENDANCE_POLICY_READ'));
  assert.ok(admin.includes('ATTENDANCE_POLICY_MANAGE'));
  assert.ok(admin.includes('ATTENDANCE_POLICY_ACTIVATE'));
});

// ── COMPATIBILITY ────────────────────────────────────────────

test('compat: legacy Attendance contract is untouched', () => {
  const paths = Attendance.default.schema.paths;

  ['companyId', 'user', 'date', 'punchIn', 'punchOut', 'workMinutes', 'status', 'shift', 'schedule', 'shiftSource', 'lateMinutes', 'earlyMinutes', 'overtimeMinutes'].forEach(
    (field) => assert.ok(paths[field], `Attendance.${field} still exists`),
  );

  assert.deepEqual([...Attendance.default.schema.paths.status.enumValues], [
    'PRESENT',
    'LATE',
    'HALF_DAY',
  ]);
});

test('compat: policy layer never touches punches or money', async () => {
  const [rulesSource, serviceSource] = await Promise.all([
    readFile(new URL('../src/services/attendance/attendancePolicyRules.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/attendance/attendancePolicyService.js', import.meta.url), 'utf8'),
  ]);

  assert.ok(!rulesSource.includes('models/Attendance.js'));
  assert.ok(!serviceSource.includes('models/Attendance.js'));
  assert.ok(!rulesSource.includes('mongoose'));
  assert.ok(!serviceSource.includes('PayrollResult'));

  const moneyTerms = ['netPay', 'basicSalary', 'grossSalary', 'providentFund', 'professionalTax'];
  moneyTerms.forEach((term) => {
    assert.ok(!rulesSource.includes(term), `rules must not mention ${term}`);
    assert.ok(!serviceSource.includes(term), `service must not mention ${term}`);
  });

  // ApiError import resolves (service throws HTTP-safe errors).
  assert.equal(typeof ApiError.badRequest, 'function');
});

// ── VALIDATOR REGRESSION (31.1 walkthrough bug) ──────────────

test('validators: explicit null concurrency tokens are treated as absent', async () => {
  const {
    attendancePolicyDraftValidator,
    attendancePolicyActivateValidator,
  } = await import('../src/validators/attendancePolicyValidator.js');
  const { validationResult } = await import('express-validator');

  // Run every chain item except the terminal `validate` thrower.
  const runChain = async (chain, body) => {
    const req = { body, query: {} };
    for (const middleware of chain.slice(0, -1)) {
      await middleware.run(req);
    }
    return validationResult(req);
  };

  const draftErrors = await runChain(attendancePolicyDraftValidator, {
    expectedConfigVersion: null,
    name: 'V1',
  });
  assert.equal(draftErrors.isEmpty(), true);

  const activateErrors = await runChain(attendancePolicyActivateValidator, {
    expectedConfigVersion: null,
  });
  assert.equal(activateErrors.isEmpty(), true);

  // A non-integer token is still refused.
  const badErrors = await runChain(attendancePolicyDraftValidator, {
    expectedConfigVersion: 'abc',
  });
  assert.equal(badErrors.isEmpty(), false);
});
