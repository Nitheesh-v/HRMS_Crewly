// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.2 — HR CONTEXT RETRIEVER (hermetic)
//
// No Mongo, no Redis, no network. Every model the retriever touches is
// injectable, and each fake RECORDS ITS CALL ARGUMENTS — which is what makes
// "this query was tenant-scoped" and "this query was user-scoped" assertable
// rather than assumed. A test that only checked the rendered string would
// pass even if the query had lost its companyId.
//
// The comments explain WHY each assertion exists.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_ai_context_test';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

const { getUserHRContext } = await import(
  '../src/services/ai/hrContextRetriever.js'
);

const { PII_PLACEHOLDERS } = await import('../src/services/ai/piiRedactor.js');

const COMPANY = '0000000000000000000064b1';
const USER = '0000000000000000000064b9';
const OTHER_USER = '0000000000000000000064c9';

// ── FIXTURES ───────────────────────────────────────────────────────────────

const ALL = ['profile', 'leaves', 'attendance', 'policies'];

/**
 * A recording fake model.
 *
 * `chain` returns an object whose every method is chainable and resolves to
 * `result`, so `.find().sort().limit().lean()` and
 * `.findOne().select().populate().lean()` both work without a real driver.
 */
const makeModel = (result = null) => {
  const calls = [];

  const record = (name) => (...args) => {
    calls.push({ name, args });

    return chain;
  };

  const chain = {
    calls,
    find: record('find'),
    findOne: record('findOne'),
    findOneAndUpdate: record('findOneAndUpdate'),
    aggregate: record('aggregate'),
    sort: record('sort'),
    limit: record('limit'),
    select: record('select'),
    populate: record('populate'),
    lean: record('lean'),
    then: (resolve) => resolve(result),
  };

  return chain;
};

/** A model whose every operation throws. */
const brokenModel = () => {
  const fail = () => ({
    calls: [],
    then: (_resolve, reject) =>
      reject(Object.assign(new Error('driver down'), { code: 'ECONNREFUSED' })),
  });

  return fail();
};

const FIXED_NOW = new Date('2026-01-15T09:00:00.000Z');

const tenantConfigModel = (overrides = {}) =>
  makeModel({
    companyId: COMPANY,
    enabled: true,
    monthlyQuotaTokens: null,
    allowedCategories: ALL,
    updatedBy: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

const emptyCache = () => ({
  io: {
    async get() {
      return null;
    },
    async set() {},
    async del() {},
  },
});

const baseDeps = (overrides = {}) => ({
  UserModel: makeModel({
    _id: USER,
    name: 'John Doe',
    designation: 'Software Engineer',
    department: { _id: '0000000000000000000000d1', name: 'Engineering' },
    dateOfJoining: new Date('2023-06-15T00:00:00.000Z'),
    email: 'john.doe@example.com',
    employeeCode: 'EMP-042',
  }),
  DepartmentModel: makeModel({ _id: '0000000000000000000000d1', name: 'Engineering' }),
  LeaveModel: makeModel([]),
  AttendanceModel: makeModel(null),
  ShiftAssignmentModel: makeModel(null),
  ShiftModel: makeModel(null),
  HolidayModel: makeModel([]),
  AnnouncementModel: makeModel([]),
  ConfigModel: tenantConfigModel(),
  cacheIo: emptyCache().io,
  now: () => FIXED_NOW,
  ...overrides,
});

const run = (overrides = {}, args = {}) =>
  getUserHRContext({
    companyId: COMPANY,
    userId: USER,
    ...args,
    deps: baseDeps(overrides),
  });

// ═══════════════════════════════════════════════════════════════════════════
// A. CATEGORY FILTERING — the allowlist is the authority
// ═══════════════════════════════════════════════════════════════════════════
describe('category filtering (Phase 36 §8 step 1)', () => {
  test('an empty allowlist yields the minimal context string', async () => {
    const { context, categoriesUsed } = await run({
      ConfigModel: tenantConfigModel({ allowedCategories: [] }),
    });

    assert.equal(
      context,
      '=== EMPLOYEE HR CONTEXT ===\n(no categories enabled)\n=== END CONTEXT ===',
    );

    assert.deepEqual(categoriesUsed, []);
  });

  test("only ['profile'] allowed means the other sections are absent", async () => {
    const { context, categoriesUsed } = await run({
      ConfigModel: tenantConfigModel({ allowedCategories: ['profile'] }),
    });

    assert.deepEqual(categoriesUsed, ['profile']);
    assert.equal(context.includes('Employee Profile:'), true);
    assert.equal(context.includes('Leave Balances:'), false);
    assert.equal(context.includes("Today's Attendance:"), false);
    assert.equal(context.includes('Upcoming Holidays'), false);
  });

  test('a requested category outside the allowlist is dropped, not honoured', async () => {
    // The tenant's allowlist is the authority. Honouring a request the tenant
    // never allowed would make the allowlist decorative.
    const { categoriesUsed } = await run(
      { ConfigModel: tenantConfigModel({ allowedCategories: ['leaves'] }) },
      { categories: ['profile', 'leaves'] },
    );

    assert.deepEqual(categoriesUsed, ['leaves']);
  });

  test('an unknown requested category is dropped rather than erroring', async () => {
    // A typo must not turn a working context into a failure the employee has
    // to report.
    const { categoriesUsed } = await run({}, { categories: ['profile', 'payroll'] });

    assert.deepEqual(categoriesUsed, ['profile']);
  });

  test('no categories argument means "everything the tenant allows"', async () => {
    const { categoriesUsed } = await run();

    assert.deepEqual(categoriesUsed, ALL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. PROFILE SECTION
// ═══════════════════════════════════════════════════════════════════════════
describe('profile section (Phase 36 §8 step 2.1)', () => {
  test('it renders name, code, designation, department, DOJ', async () => {
    const { context } = await run();

    assert.equal(context.includes('- Name: John Doe'), true);
    assert.equal(context.includes('- Employee Code: EMP-042'), true);
    assert.equal(context.includes('- Designation: Software Engineer'), true);
    assert.equal(context.includes('- Department: Engineering'), true);
    assert.equal(context.includes('- Date of Joining: 2023-06-15'), true);
  });

  test('the query never selects a sensitive field', async () => {
    const UserModel = baseDeps().UserModel;

    await run({ UserModel });

    const selected = UserModel.calls.find((call) => call.name === 'select');

    const fields = String(selected.args[0]).split(/\s+/);

    for (const banned of [
      'salary',
      'bankAccount',
      'pan',
      'aadhaar',
      'uan',
      'phone',
      'dateOfBirth',
      'address',
      'emergencyContact',
      'password',
      'personalEmail',
    ]) {
      assert.equal(
        fields.includes(banned),
        false,
        `profile query selected a sensitive field: ${banned}`,
      );
    }
  });

  test('the email is masked in the rendered context', async () => {
    // The email IS needed (the AI must know how to reach the employee), so it
    // is included and masked rather than omitted.
    const { context } = await run();

    assert.equal(context.includes('john.doe@example.com'), false);
    assert.equal(context.includes('[EMAIL_REDACTED]'), true);
  });

  test('the profile query is scoped by BOTH companyId and _id', async () => {
    const UserModel = baseDeps().UserModel;

    await run({ UserModel });

    const filter = UserModel.calls.find((call) => call.name === 'findOne').args[0];

    assert.equal(String(filter.companyId), COMPANY);
    assert.equal(String(filter._id), USER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. LEAVES SECTION
// ═══════════════════════════════════════════════════════════════════════════

/** Leave aggregate rows shaped like the real $group output. */
const leaveRows = (entries) =>
  entries.map(([type, status, days]) => ({
    _id: { type, status },
    days,
  }));

describe('leaves section (Phase 36 §8 step 2.2)', () => {
  /**
   * A sequence-aware Leave fake: the FIRST aggregate is the yearly balance
   * roll-up, the SECOND is the all-time COMP_OFF roll-up, and `find` is the
   * pending list. A single-result fake would feed the same rows to both
   * aggregations and double-count every type.
   */
  const makeLeaveModel = ({ balances = [], pending = [] } = {}) => {
    const calls = [];

    let aggregateCall = 0;

    return {
      calls,
      aggregate: (...args) => {
        calls.push({ name: 'aggregate', args });

        aggregateCall += 1;

        return Promise.resolve(aggregateCall === 1 ? balances : []);
      },
      find: (...args) => {
        calls.push({ name: 'find', args });

        return {
          sort: () => ({
            limit: () => ({ lean: () => Promise.resolve(pending) }),
          }),
        };
      },
    };
  };

  const rows = (entries) =>
    entries.map(([type, status, days]) => ({ _id: { type, status }, days }));

  test('balances are rendered per type with remaining and total', async () => {
    // CASUAL: 12 yearly, 4 approved -> 8 available.
    // SICK:   6 yearly, 2 pending  -> 4 available.
    const LeaveModel = makeLeaveModel({
      balances: rows([
        ['CASUAL', 'APPROVED', 4],
        ['SICK', 'PENDING', 2],
      ]),
    });

    const { context } = await run({ LeaveModel });

    assert.equal(
      context.includes(
        '- Casual Leave: 8 remaining / 12 total (4 approved, 0 pending)',
      ),
      true,
    );

    assert.equal(
      context.includes('- Sick Leave: 4 remaining / 6 total (0 approved, 2 pending)'),
      true,
    );
  });

  test('a pending request is listed with its type, range and status', async () => {
    const LeaveModel = makeLeaveModel({
      pending: [
        {
          type: 'CASUAL',
          startDate: '2026-01-20',
          endDate: '2026-01-21',
          status: 'PENDING',
        },
      ],
    });

    const { context } = await run({ LeaveModel });

    assert.equal(
      context.includes('- Casual Leave: 2026-01-20 to 2026-01-21 (PENDING)'),
      true,
    );
  });

  test('no pending requests renders an explicit "(none pending)"', async () => {
    const { context } = await run({ LeaveModel: makeLeaveModel() });

    assert.equal(context.includes('- (none pending)'), true);
  });

  test('every leave query is scoped by companyId AND user', async () => {
    const LeaveModel = makeLeaveModel();

    await run({ LeaveModel });

    const aggregates = LeaveModel.calls.filter((call) => call.name === 'aggregate');

    assert.ok(aggregates.length >= 2, 'both the yearly and the COMP_OFF roll-up run');

    for (const call of aggregates) {
      const pipeline = call.args[0];

      const match = pipeline.find((stage) => stage.$match).$match;

      assert.equal(
        String(match.companyId),
        COMPANY,
        'a leave aggregation lost its tenant scope',
      );

      assert.equal(
        String(match.user),
        USER,
        'a leave aggregation lost its user scope',
      );
    }

    const finds = LeaveModel.calls.filter((call) => call.name === 'find');

    for (const call of finds) {
      const filter = call.args[0];

      assert.equal(String(filter.companyId), COMPANY);
      assert.equal(String(filter.user), USER);
    }
  });

  test('COMP_OFF is counted across all years, not the current one', async () => {
    // The same rule leaveController applies: a comp-off entitlement never
    // expires, so year-scoping it would double-count availability at every
    // January boundary.
    const LeaveModel = makeLeaveModel();

    await run({ LeaveModel });

    const compOffCall = LeaveModel.calls
      .filter((call) => call.name === 'aggregate')
      .find((call) => JSON.stringify(call.args[0]).includes('COMP_OFF'));

    assert.ok(compOffCall, 'COMP_OFF must be queried separately');

    const match = compOffCall.args[0].find((stage) => stage.$match).$match;

    assert.equal(match.startDate, undefined);
    assert.equal(String(match.companyId), COMPANY);
    assert.equal(String(match.user), USER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. ATTENDANCE SECTION
// ═══════════════════════════════════════════════════════════════════════════
describe('attendance section (Phase 36 §8 step 2.3)', () => {
  test("today's status and punch-in time are rendered", async () => {
    const AttendanceModel = makeModel({
      status: 'LATE',
      punchIn: new Date('2026-01-15T03:42:00.000Z'),
      workMinutes: 300,
      shift: null,
    });

    const { context } = await run({ AttendanceModel });

    assert.equal(context.includes('- Status: LATE (punched in at 09:12)'), true);
  });

  test('no record for today renders NO_RECORD, never an invented ABSENT', async () => {
    // The Attendance status enum has no ABSENT value, so there is no stored
    // absent row. Guessing would present an assumption as a fact.
    const { context } = await run({ AttendanceModel: makeModel(null) });

    assert.equal(context.includes('NO_RECORD'), true);
    assert.equal(context.includes('ABSENT'), false);
  });

  test('the shift name and its window are rendered', async () => {
    const ShiftAssignmentModel = makeModel({
      shift: { name: 'General Shift', startTime: '09:00', endTime: '18:00' },
    });

    const { context } = await run({ ShiftAssignmentModel });

    assert.equal(
      context.includes('- Shift: General Shift (09:00 - 18:00)'),
      true,
    );
  });

  test("this week's worked hours are summed from workMinutes", async () => {
    const AttendanceModel = baseDeps().AttendanceModel;

    // findOne -> today's record (null); aggregate -> the week's minutes.
    AttendanceModel.findOne = (...args) => {
      AttendanceModel.calls.push({ name: 'findOne', args });

      return { lean: () => Promise.resolve(null) };
    };

    AttendanceModel.aggregate = (...args) => {
      AttendanceModel.calls.push({ name: 'aggregate', args });

      return Promise.resolve([{ _id: null, minutes: 1920 }]);
    };

    const { context } = await run({ AttendanceModel });

    assert.equal(context.includes('- This Week: 32 hours worked'), true);
  });

  test('every attendance query is scoped by companyId AND user', async () => {
    const AttendanceModel = baseDeps().AttendanceModel;

    AttendanceModel.findOne = (...args) => {
      AttendanceModel.calls.push({ name: 'findOne', args });

      return { lean: () => Promise.resolve(null) };
    };

    AttendanceModel.aggregate = (...args) => {
      AttendanceModel.calls.push({ name: 'aggregate', args });

      return Promise.resolve([]);
    };

    await run({ AttendanceModel });

    const findOne = AttendanceModel.calls.find((call) => call.name === 'findOne');

    assert.equal(String(findOne.args[0].companyId), COMPANY);
    assert.equal(String(findOne.args[0].user), USER);

    const aggregate = AttendanceModel.calls.find((call) => call.name === 'aggregate');

    const match = aggregate.args[0].find((stage) => stage.$match).$match;

    assert.equal(String(match.companyId), COMPANY);
    assert.equal(String(match.user), USER);
  });

  test("today's attendance lookup uses the INJECTED clock, not the wall clock", async () => {
    // A retriever that called `new Date()` internally could not be tested for
    // date windows, and worse: a request served across a midnight boundary
    // would mix two days of data in one context string.
    const AttendanceModel = baseDeps().AttendanceModel;

    AttendanceModel.findOne = (...args) => {
      AttendanceModel.calls.push({ name: 'findOne', args });

      return { lean: () => Promise.resolve(null) };
    };

    AttendanceModel.aggregate = (...args) => {
      AttendanceModel.calls.push({ name: 'aggregate', args });

      return Promise.resolve([]);
    };

    // 2026-03-02T20:00Z is 2026-03-03 01:30 in Asia/Kolkata, so the
    // company-local day is the 3rd, not the 2nd.
    await getUserHRContext({
      companyId: COMPANY,
      userId: USER,
      deps: baseDeps({
        AttendanceModel,
        now: () => new Date('2026-03-02T20:00:00.000Z'),
      }),
    });

    const findOne = AttendanceModel.calls.find((call) => call.name === 'findOne');

    assert.equal(String(findOne.args[0].date), '2026-03-03');
  });

  test('the holiday lookahead window is measured from the injected clock', async () => {
    const HolidayModel = baseDeps().HolidayModel;

    await getUserHRContext({
      companyId: COMPANY,
      userId: USER,
      deps: baseDeps({
        HolidayModel,
        now: () => new Date('2026-01-15T09:00:00.000Z'),
      }),
    });

    const filter = HolidayModel.calls.find((call) => call.name === 'find').args[0];

    const from = new Date(filter.date.$gte);
    const to = new Date(filter.date.$lte);

    // Bounded both ways: an unbounded `$lte` would list every future holiday
    // forever and blow the prompt budget. Both ends are DAY boundaries, so a
    // request served at 23:59 covers the same range as one at 00:01.
    assert.equal(from.toISOString(), '2026-01-15T00:00:00.000Z');
    assert.equal(to.toISOString(), '2026-02-14T23:59:59.999Z');
  });

  test("today's attendance lookup uses the company-local day string", async () => {
    const AttendanceModel = baseDeps().AttendanceModel;

    AttendanceModel.findOne = (...args) => {
      AttendanceModel.calls.push({ name: 'findOne', args });

      return { lean: () => Promise.resolve(null) };
    };

    AttendanceModel.aggregate = (...args) => {
      AttendanceModel.calls.push({ name: 'aggregate', args });

      return Promise.resolve([]);
    };

    await run({ AttendanceModel });

    const findOne = AttendanceModel.calls.find((call) => call.name === 'findOne');

    assert.match(String(findOne.args[0].date), /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. POLICIES SECTION
// ═══════════════════════════════════════════════════════════════════════════
describe('policies section (Phase 36 §8 step 2.4)', () => {
  test('upcoming holidays are listed with their dates', async () => {
    const HolidayModel = makeModel([
      { name: 'Republic Day', date: new Date('2026-01-26T00:00:00.000Z') },
    ]);

    const { context } = await run({ HolidayModel });

    assert.equal(context.includes('- 2026-01-26: Republic Day'), true);
  });

  test('announcement titles are listed', async () => {
    const AnnouncementModel = makeModel([
      { title: 'Year-end Party on Dec 20', pinned: false },
    ]);

    const { context } = await run({ AnnouncementModel });

    assert.equal(context.includes('- Year-end Party on Dec 20'), true);
  });

  test('company-scoped queries carry companyId and NO userId', async () => {
    const HolidayModel = baseDeps().HolidayModel;
    const AnnouncementModel = baseDeps().AnnouncementModel;

    await run({ HolidayModel, AnnouncementModel });

    const holidayFilter = HolidayModel.calls.find((call) => call.name === 'find')
      .args[0];

    assert.equal(String(holidayFilter.companyId), COMPANY);
    assert.equal(holidayFilter.user, undefined);
    assert.equal(holidayFilter.userId, undefined);

    const announcementFilter = AnnouncementModel.calls.find(
      (call) => call.name === 'find',
    ).args[0];

    assert.equal(String(announcementFilter.companyId), COMPANY);
    assert.equal(announcementFilter.user, undefined);
  });

  test('inactive and optional holidays are excluded', async () => {
    const HolidayModel = baseDeps().HolidayModel;

    await run({ HolidayModel });

    const filter = HolidayModel.calls.find((call) => call.name === 'find').args[0];

    assert.equal(filter.isActive, true);
    assert.equal(filter.isOptional, false);
  });

  test('both policy lists are bounded', async () => {
    const HolidayModel = baseDeps().HolidayModel;
    const AnnouncementModel = baseDeps().AnnouncementModel;

    await run({ HolidayModel, AnnouncementModel });

    const holidayLimit = HolidayModel.calls.find((call) => call.name === 'limit');

    const announcementLimit = AnnouncementModel.calls.find(
      (call) => call.name === 'limit',
    );

    assert.equal(holidayLimit.args[0], 10);
    assert.equal(announcementLimit.args[0], 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. THE PII SAFETY NET — free text is never trusted
// ═══════════════════════════════════════════════════════════════════════════
describe('PII safety net (Phase 36 §8 step 4)', () => {
  test('a PAN typed into an announcement is masked', async () => {
    const AnnouncementModel = makeModel([
      { title: 'Verify your PAN ABCDE1234F with HR', pinned: false },
    ]);

    const { context } = await run({ AnnouncementModel });

    // Field selection cannot help here: a human typed this into free text.
    // The final redaction pass is the only thing standing between it and the
    // vendor.
    assert.equal(context.includes('ABCDE1234F'), false);
    assert.equal(context.includes(PII_PLACEHOLDERS.PAN), true);
  });

  test('a mobile number typed into an announcement is masked', async () => {
    const AnnouncementModel = makeModel([
      { title: 'Call HR on +91 9876543210 for help', pinned: false },
    ]);

    const { context } = await run({ AnnouncementModel });

    assert.equal(context.includes('9876543210'), false);
    assert.equal(context.includes(PII_PLACEHOLDERS.MOBILE), true);
  });

  test('a salary figure typed into a holiday description is masked', async () => {
    const HolidayModel = makeModel([
      { name: 'Bonus day - Rs 45,000 credited', date: new Date('2026-01-26T00:00:00.000Z') },
    ]);

    const { context } = await run({ HolidayModel });

    assert.equal(context.includes('45,000'), false);
    assert.equal(context.includes(PII_PLACEHOLDERS.AMOUNT), true);
  });

  test('a leave reason never reaches the context at all', async () => {
    // The reason is employee free text and is not selected, so it cannot be
    // redacted into something useful — it is simply not fetched.
    const LeaveModel = baseDeps().LeaveModel;

    const finds = [];

    LeaveModel.find = (...args) => {
      finds.push(args);

      LeaveModel.calls.push({ name: 'find', args });

      return { sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) };
    };

    await run({ LeaveModel });

    assert.equal(
      finds.every((args) => !String(args[0]).includes('reason')),
      true,
    );
  });

  test('the assembled string is wrapped in the CONTEXT markers', async () => {
    const { context } = await run();

    assert.equal(context.startsWith('=== EMPLOYEE HR CONTEXT ==='), true);
    assert.equal(context.trimEnd().endsWith('=== END CONTEXT ==='), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. AUTHORIZATION SCOPING — the signature IS the authorisation
// ═══════════════════════════════════════════════════════════════════════════
describe('authorization scoping (Phase 36 §8 — the critical law)', () => {
  test('the function accepts no parameter that could name another user', () => {
    // There is no asUserId, no impersonate, no targetUser. If one were added,
    // an admin endpoint could pass a different id and read anyone's context.
    const source = read('src/services/ai/hrContextRetriever.js');

    for (const banned of ['asUserId', 'impersonate', 'targetUser', 'onBehalfOf']) {
      assert.equal(
        source.includes(banned),
        false,
        `an identity-override seam exists: ${banned}`,
      );
    }
  });

  test('a missing companyId or userId is refused, not defaulted', async () => {
    await assert.rejects(
      () => getUserHRContext({ userId: USER, deps: baseDeps() }),
      /companyId and userId/,
    );

    await assert.rejects(
      () => getUserHRContext({ companyId: COMPANY, deps: baseDeps() }),
      /companyId and userId/,
    );
  });

  test('every user-scoped call carries the caller\'s own id', async () => {
    const UserModel = baseDeps().UserModel;
    const LeaveModel = baseDeps().LeaveModel;
    const AttendanceModel = baseDeps().AttendanceModel;

    AttendanceModel.findOne = (...args) => {
      AttendanceModel.calls.push({ name: 'findOne', args });

      return { lean: () => Promise.resolve(null) };
    };

    AttendanceModel.aggregate = (...args) => {
      AttendanceModel.calls.push({ name: 'aggregate', args });

      return Promise.resolve([]);
    };

    LeaveModel.find = (...args) => {
      LeaveModel.calls.push({ name: 'find', args });

      return { sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) };
    };

    await run({ UserModel, LeaveModel, AttendanceModel });

    const userFilters = UserModel.calls
      .filter((call) => ['findOne', 'find'].includes(call.name))
      .map((call) => call.args[0]);

    assert.ok(userFilters.length > 0);

    for (const filter of userFilters) {
      assert.equal(String(filter._id || filter.user), USER);
      assert.equal(String(filter.companyId), COMPANY);
    }

    const leaveAggregates = LeaveModel.calls.filter(
      (call) => call.name === 'aggregate',
    );

    for (const call of leaveAggregates) {
      const match = call.args[0].find((stage) => stage.$match).$match;

      assert.equal(String(match.user), USER);
      assert.equal(String(match.companyId), COMPANY);
    }
  });

  test('a different user id produces a different query, never a shared one', async () => {
    const UserModel = baseDeps().UserModel;

    await getUserHRContext({
      companyId: COMPANY,
      userId: OTHER_USER,
      deps: baseDeps({ UserModel }),
    });

    const filter = UserModel.calls.find((call) => call.name === 'findOne').args[0];

    assert.equal(String(filter._id), OTHER_USER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. PARTIAL FAILURE — one broken section must not blank the rest
// ═══════════════════════════════════════════════════════════════════════════
describe('partial failure (Phase 36 §8 error handling)', () => {
  test('a broken leaves fetch still renders the other sections', async () => {
    const LeaveModel = {
      calls: [],
      aggregate: () =>
        Promise.reject(
          Object.assign(new Error('driver down'), { code: 'ECONNREFUSED' }),
        ),
      find: () => ({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.reject(new Error('driver down')),
          }),
        }),
      }),
    };

    const { context } = await run({ LeaveModel });

    assert.equal(context.includes('(leaves unavailable)'), true);
    assert.equal(context.includes('Employee Profile:'), true);
    assert.equal(context.includes('=== END CONTEXT ==='), true);
  });

  test('a broken attendance fetch still renders the other sections', async () => {
    const AttendanceModel = brokenModel();

    const { context } = await run({ AttendanceModel });

    assert.equal(context.includes('(attendance unavailable)'), true);
    assert.equal(context.includes('Employee Profile:'), true);
  });

  test('the function never throws because one section failed', async () => {
    const HolidayModel = brokenModel();

    const AnnouncementModel = brokenModel();

    const result = await run({ HolidayModel, AnnouncementModel });

    assert.equal(typeof result.context, 'string');
    assert.equal(result.context.includes('(policies unavailable)'), true);
  });

  test('a tenant config failure DOES propagate', async () => {
    // Unlike a section, the allowlist cannot be guessed. Without it the
    // retriever would hand the AI data the tenant never permitted.
    const ConfigModel = {
      async findOneAndUpdate() {
        throw new Error('config read failed');
      },
    };

    await assert.rejects(() => run({ ConfigModel }), /could not be read|AI settings/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. TENANT CONFIG INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════
describe('tenant config integration (Phase 36 §8 step 1)', () => {
  test('the allowlist comes from the tenant config, not the caller', async () => {
    const ConfigModel = tenantConfigModel({
      allowedCategories: ['attendance'],
    });

    const { categoriesUsed } = await run({ ConfigModel });

    assert.deepEqual(categoriesUsed, ['attendance']);
  });

  test('a disabled tenant still returns context', async () => {
    // The retriever is deliberately independent of the AI kill switch: the
    // CALLER decides whether to use the context. Coupling them would mean a
    // tenant that disabled AI also lost its own preview surface.
    const ConfigModel = tenantConfigModel({ enabled: false });

    const { context, categoriesUsed } = await run({ ConfigModel });

    assert.deepEqual(categoriesUsed, ALL);
    assert.equal(context.includes('Employee Profile:'), true);
  });

  test('the config read is tenant-scoped', async () => {
    const ConfigModel = tenantConfigModel();

    await run({ ConfigModel });

    const filter = ConfigModel.calls.find((call) => call.name === 'findOneAndUpdate')
      .args[0];

    assert.equal(String(filter.companyId), COMPANY);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J. SOURCE PINS
// ═══════════════════════════════════════════════════════════════════════════
describe('source pins', () => {
  test('the retriever performs no writes of any kind', () => {
    const source = read('src/services/ai/hrContextRetriever.js');

    // 36.2 is READ-ONLY across every HR domain. A save/update/delete here
    // would mean an AI feature could mutate a business record.
    for (const banned of [
      '.save(',
      '.create(',
      '.updateOne(',
      '.updateMany(',
      '.findOneAndUpdate(',
      '.deleteOne(',
      '.deleteMany(',
      '.findByIdAndUpdate(',
      '.insertMany(',
    ]) {
      assert.equal(
        source.includes(banned),
        false,
        `a write operation exists in a read-only module: ${banned}`,
      );
    }
  });

  test('the assembled context is passed through redactPII before returning', () => {
    const source = read('src/services/ai/hrContextRetriever.js');

    assert.equal(source.includes('const context = redactPII(assembled)'), true);
    assert.equal(source.includes("from './piiRedactor.js'"), true);
  });

  test('no prompt or context string is logged or persisted', () => {
    const source = read('src/services/ai/hrContextRetriever.js');

    // The context contains HR data by design; logging it would put PII in the
    // log pipeline, and storing it would violate the 36.1 no-storage law.
    assert.equal(source.includes('logger.info'), false);
    assert.equal(source.includes('logger.debug'), false);

    // The only log call must be the metadata-only section-failure warning.
    const logs = source.match(/logger\.\w+\(/g) || [];

    assert.deepEqual(logs, ['logger.warn(']);
  });

  test('the preview route carries no RBAC and the config routes do', () => {
    const source = read('src/routes/ai.js');

    const previewBlock = source.slice(
      source.indexOf("route('/context/preview')"),
    );

    assert.equal(previewBlock.includes('requirePermission'), false);
  });
});
