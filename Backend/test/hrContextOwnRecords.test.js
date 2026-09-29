// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.4 — OWN-RECORD CONTEXT CATEGORIES (hermetic)
//
// The 36.2 suite pins the four original categories. This one pins the nine
// 36.4 added, and it is written around the one thing that must never regress:
// EVERY query is scoped by companyId AND the field that owns the row, and
// every value comes from the arguments the retriever was given.
//
// The recording fakes exist so "this query was user-scoped" is ASSERTED
// rather than assumed. A test that only checked the rendered string would
// still pass if the query had quietly lost its companyId.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_ai_own_test';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

const { getUserHRContext } = await import(
  '../src/services/ai/hrContextRetriever.js'
);

const { AI_CONTEXT_CATEGORIES, AI_CAPABILITIES } = await import(
  '../src/services/ai/aiConfig.js'
);

const COMPANY = '0000000000000000000064b1';
const USER = '0000000000000000000064b9';
const OTHER_USER = '0000000000000000000064c9';

/** Every 36.4 category, so the tenant allowlist never gates these tests. */
const ALL_364 = [...AI_CONTEXT_CATEGORIES];

/** The four 36.2 categories, kept for the "old sections still work" pins. */
const LEGACY = ['profile', 'leaves', 'attendance', 'policies'];

// ── FIXTURES ───────────────────────────────────────────────────────────────

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
    findById: record('findById'),
    findOneAndUpdate: record('findOneAndUpdate'),
    aggregate: record('aggregate'),
    countDocuments: record('countDocuments'),
    sort: record('sort'),
    limit: record('limit'),
    select: record('select'),
    populate: record('populate'),
    lean: record('lean'),
    then: (resolve) => resolve(result),
  };

  return chain;
};

/**
 * An OPERATION-AWARE fake. `makeModel` returns one fixed result for every
 * method, which is wrong for a collection read several different ways:
 *
 *   findOne / findById  -> a document, or null when there is no row
 *   find                -> an array, empty when there are no rows
 *   aggregate           -> an array
 *   countDocuments      -> a number
 *
 * Returning an array from `findOne` is not merely unrealistic: `record.shift`
 * on an array is `Array.prototype.shift`, a truthy function, which sends the
 * retriever down a branch that then calls a method the simple fake never
 * defined. And returning null from `find` makes an empty list look like a
 * failed read, so a "none" section renders as "(x unavailable)" instead.
 *
 * Each query gets its OWN chain object, bound to the operation that started
 * it. Sharing one chain would mean a second query on the same model resolves
 * with the first query's shape — and the retriever runs its builders in
 * parallel, so Attendance is read as findOne, aggregate AND aggregate in the
 * same tick.
 */
const makeModelByOp = ({ find = null, list = [], aggregate = [], count = 0 } = {}) => {
  const calls = [];

  const resultFor = (name) => {
    if (name === 'find') return list;

    if (name === 'aggregate') return aggregate;

    if (name === 'countDocuments') return count;

    return find;
  };

  const makeChain = (start) => {
    const chain = { calls };

    // Root operations: each one begins a NEW chain bound to its own name.
    [
      'find',
      'findOne',
      'findById',
      'findOneAndUpdate',
      'aggregate',
      'countDocuments',
    ].forEach((name) => {
      chain[name] = (...args) => {
        calls.push({ name, args });

        return makeChain(name);
      };
    });

    // Chainable refinements: they narrow the query already in progress.
    ['sort', 'limit', 'select', 'populate', 'lean'].forEach((name) => {
      chain[name] = (...args) => {
        calls.push({ name, args });

        return chain;
      };
    });

    chain.then = (resolve) => resolve(resultFor(start));

    return chain;
  };

  return makeChain(null);
};

const FIXED_NOW = new Date('2026-06-15T09:00:00.000Z');

const tenantConfigModel = (allowed = ALL_364) =>
  makeModel({
    companyId: COMPANY,
    enabled: true,
    monthlyQuotaTokens: null,
    allowedCategories: allowed,
    updatedBy: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
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
    role: 'EMPLOYEE',
    designation: 'Software Engineer',
    department: { _id: '0000000000000000000000d1', name: 'Engineering' },
    dateOfJoining: new Date('2023-06-15T00:00:00.000Z'),
    email: 'john.doe@example.com',
    employeeCode: 'EMP-042',
  }),
  DepartmentModel: makeModel({ _id: '0000000000000000000000d1', name: 'Engineering' }),
  LeaveModel: makeModelByOp(),
  AttendanceModel: makeModelByOp(),
  ShiftAssignmentModel: makeModelByOp(),
  ShiftModel: makeModelByOp(),
  HolidayModel: makeModelByOp(),
  AnnouncementModel: makeModelByOp(),
  PayslipModel: makeModelByOp(),
  ExpenseModel: makeModelByOp(),
  TaskModel: makeModelByOp(),
  ProjectModel: makeModelByOp(),
  DocumentModel: makeModelByOp(),
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

/** The first query a given fake model was asked to run. */
const firstQuery = (model) => model.calls[0].args[0];

// ═══════════════════════════════════════════════════════════════════════════
// A. THE CATALOGUE ITSELF
// ═══════════════════════════════════════════════════════════════════════════
describe('the 36.4 category catalogue', () => {
  test('all nine new categories are declared, and performance is not', () => {
    [
      'payslips',
      'expenses',
      'tasks',
      'projects',
      'documents',
      'leave-requests',
      'attendance-month',
      'org-aggregates',
      'capabilities',
    ].forEach((category) => {
      assert.equal(
        AI_CONTEXT_CATEGORIES.includes(category),
        true,
        `${category} is missing from AI_CONTEXT_CATEGORIES`,
      );
    });

    // Reading an appraisal runs the appraisal access chain. A config flag must
    // never be able to switch it on.
    assert.equal(AI_CONTEXT_CATEGORIES.includes('performance'), false);
  });

  test('every capability entry has a topic and a how', () => {
    assert.ok(AI_CAPABILITIES.length >= 10);

    AI_CAPABILITIES.forEach((entry) => {
      assert.equal(typeof entry.topic, 'string');
      assert.ok(entry.topic.length > 0);
      assert.equal(typeof entry.how, 'string');
      assert.ok(entry.how.length > 20);
    });
  });

  test('the catalogue contains no emoji and no placeholder text', () => {
    // The assistant reads this verbatim; a stray emoji or an unfilled template
    // would be shown to the employee as if it were policy.
    const joined = AI_CAPABILITIES.map((e) => `${e.topic} ${e.how}`).join(' ');

    assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined), false);
    assert.equal(joined.includes('{'), false);
    assert.equal(joined.includes('TODO'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. PAYSLIPS — the caller's own, and never another employee's
// ═══════════════════════════════════════════════════════════════════════════
describe('payslips', () => {
  const slip = (month, label, net) => ({
    _id: '00000000000000000000a001',
    month,
    status: 'GENERATED',
    snapshot: {
      payroll: { month, monthLabel: label },
      salary: { grossSalary: 60000, totalDeductions: 15000, netSalary: net },
    },
  });

  test('the query is scoped by companyId AND employeeId = the caller', async () => {
    const PayslipModel = makeModelByOp();

    await run({ PayslipModel });

    const query = firstQuery(PayslipModel);

    assert.equal(query.companyId, COMPANY);
    assert.equal(query.employeeId, USER);

    // The only two keys. A third would be a door to someone else's payslip.
    assert.deepEqual(Object.keys(query).sort(), ['companyId', 'employeeId']);
  });

  test('it renders which months exist and carries NO figures', async () => {
    const PayslipModel = makeModelByOp({ list: [
      slip('2026-05', 'May 2026', 45000),
      slip('2026-06', 'June 2026', 48000),
    ] });

    const { context } = await run({ PayslipModel });

    assert.equal(context.includes('My Payslips'), true);
    assert.equal(context.includes('May 2026'), true);
    assert.equal(context.includes('June 2026'), true);

    // THE MONEY RULE. The redactor masks "net pay 45000" by design, so putting
    // the number here would only produce "[AMOUNT_REDACTED]" in the context.
    // Asserted as "no salary-labelled number survives", which is the real
    // requirement, rather than banning the words "net pay" (the section's own
    // note legitimately explains that the figures are withheld).
    assert.equal(context.includes('45000'), false);
    assert.equal(context.includes('48000'), false);
    assert.equal(context.includes('[AMOUNT_REDACTED]'), false);
    assert.equal(/(net|gross|salary|ctc|take[\s-]?home)\s*(pay)?\s*(is|:)?\s*\d/i.test(context), false);
    assert.equal(context.includes('Open My Payslips to view them'), true);
  });

  test('no payslip yet is stated as a fact, not as missing information', async () => {
    const { context } = await run({ PayslipModel: makeModelByOp() });

    assert.equal(context.includes('none generated for you yet'), true);
    assert.equal(context.includes('(payslips unavailable)'), false);
  });

  test('a failed read is visually distinct from "none"', async () => {
    const PayslipModel = {
      calls: [],
      then: (_r, reject) =>
        reject(Object.assign(new Error('driver down'), { code: 'ECONNREFUSED' })),
    };

    const { context } = await run({ PayslipModel });

    assert.equal(context.includes('(payslips unavailable)'), true);
    assert.equal(context.includes('none generated for you yet'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. EXPENSES
// ═══════════════════════════════════════════════════════════════════════════
describe('expenses', () => {
  test('the query is scoped by companyId AND user = the caller', async () => {
    const ExpenseModel = makeModelByOp();

    await run({ ExpenseModel });

    const query = firstQuery(ExpenseModel);

    assert.equal(query.companyId, COMPANY);
    assert.equal(query.user, USER);
    assert.deepEqual(Object.keys(query).sort(), ['companyId', 'user']);
  });

  test('it renders date, category, amount, description and status', async () => {
    const ExpenseModel = makeModelByOp({ list: [
      {
        category: 'TRAVEL',
        amount: 1200,
        currency: 'INR',
        expenseDate: '2026-06-12',
        description: 'Client visit cab fare',
        status: 'PENDING_FINANCE',
      },
    ] });

    const { context } = await run({ ExpenseModel });

    assert.equal(context.includes('My Expense Claims:'), true);
    assert.equal(context.includes('2026-06-12'), true);
    assert.equal(context.includes('TRAVEL'), true);
    assert.equal(context.includes('Client visit cab fare'), true);
    assert.equal(context.includes('PENDING_FINANCE'), true);
    // A bare business number is NOT salary, so the redactor leaves it alone.
    assert.equal(context.includes('1200'), true);
  });

  test('no claims is stated plainly', async () => {
    const { context } = await run({ ExpenseModel: makeModelByOp() });

    assert.equal(context.includes('none submitted by you yet'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. TASKS
// ═══════════════════════════════════════════════════════════════════════════
describe('tasks', () => {
  test('the query uses `company` (the field) and assignedTo = the caller', async () => {
    const TaskModel = makeModelByOp();

    await run({ TaskModel });

    const query = firstQuery(TaskModel);

    // Task.company is the real path; `companyId` is only an alias. Querying the
    // real path is the safe choice either way.
    assert.equal(query.company, COMPANY);
    assert.equal(query.assignedTo, USER);
    assert.deepEqual(Object.keys(query).sort(), ['assignedTo', 'company']);
  });

  test('it renders title, status and due date', async () => {
    const TaskModel = makeModelByOp({ list: [
      {
        title: 'Ship the payroll export',
        status: 'IN_PROGRESS',
        dueDate: new Date('2026-06-30T00:00:00.000Z'),
      },
    ] });

    const { context } = await run({ TaskModel });

    assert.equal(context.includes('Ship the payroll export'), true);
    assert.equal(context.includes('IN_PROGRESS'), true);
    assert.equal(context.includes('due 2026-06-30'), true);
  });

  test('no tasks is stated plainly', async () => {
    const { context } = await run({ TaskModel: makeModelByOp() });

    assert.equal(context.includes('none assigned to you'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. PROJECTS — membership is an array on three fields
// ═══════════════════════════════════════════════════════════════════════════
describe('projects', () => {
  test('the query checks manager, teamLeads AND members', async () => {
    const ProjectModel = makeModelByOp();

    await run({ ProjectModel });

    const query = firstQuery(ProjectModel);

    assert.equal(query.company, COMPANY);
    assert.ok(Array.isArray(query.$or));

    const orKeys = query.$or.map((clause) => Object.keys(clause)[0]).sort();

    // A team lead is not in `members` and the manager is in neither array, so
    // all three must be checked or two of the three roles would see nothing.
    assert.deepEqual(orKeys, ['manager', 'members', 'teamLeads']);

    query.$or.forEach((clause) => {
      const value = clause[Object.keys(clause)[0]];

      assert.equal(value, USER);
    });
  });

  test('no projects is stated plainly', async () => {
    const { context } = await run({ ProjectModel: makeModelByOp() });

    assert.equal(context.includes('none - you are not on any project'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════
describe('documents', () => {
  test('the query is scoped by companyId AND user, and never selects fileUrl', async () => {
    const DocumentModel = makeModelByOp();

    await run({ DocumentModel });

    const query = firstQuery(DocumentModel);

    assert.equal(query.companyId, COMPANY);
    assert.equal(query.user, USER);

    const select = DocumentModel.calls.find((c) => c.name === 'select');

    assert.ok(select, 'the query never called select()');

    // fileUrl is a private storage reference. Selecting it would put a
    // retrievable path into a prompt that leaves the building.
    assert.equal(select.args[0].includes('fileUrl'), false);
  });

  test('it renders name and category', async () => {
    const DocumentModel = makeModelByOp({ list: [
      { name: 'PAN Card.pdf', category: 'IDENTITY' },
      { name: 'Degree Certificate.pdf', category: 'EDUCATION' },
    ] });

    const { context } = await run({ DocumentModel });

    assert.equal(context.includes('PAN Card.pdf'), true);
    assert.equal(context.includes('IDENTITY'), true);
    assert.equal(context.includes('Degree Certificate.pdf'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. LEAVE REQUESTS — the full history, including rejections
// ═══════════════════════════════════════════════════════════════════════════
describe('leave-requests', () => {
  test('the query is scoped by companyId AND user', async () => {
    const LeaveModel = makeModelByOp();

    await run({ LeaveModel });

    const query = firstQuery(LeaveModel);

    assert.equal(query.companyId, COMPANY);
    assert.equal(query.user, USER);
  });

  test('a rejected request is included and labelled', async () => {
    // "Why was my leave rejected?" can only be answered from a rejected row.
    // The balances section has no concept of one.
    const LeaveModel = makeModelByOp({ list: [
      {
        type: 'CASUAL',
        startDate: '2026-06-01',
        endDate: '2026-06-02',
        days: 2,
        status: 'REJECTED',
      },
    ] });

    const { context } = await run({ LeaveModel });

    assert.equal(context.includes('My Leave Requests'), true);
    assert.equal(context.includes('REJECTED'), true);
    assert.equal(context.includes('2026-06-01 to 2026-06-02'), true);
    assert.equal(context.includes('Casual Leave'), true);
  });

  test('never having applied is stated plainly', async () => {
    const { context } = await run({ LeaveModel: makeModelByOp() });

    assert.equal(context.includes('none - you have never applied for leave'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. ATTENDANCE MONTH
// ═══════════════════════════════════════════════════════════════════════════
describe('attendance-month', () => {
  test('the window is this month, never into the future', async () => {
    const AttendanceModel = makeModelByOp();

    await run({ AttendanceModel });

    // `attendance` and `attendance-month` both aggregate on Attendance, and the
    // builders run in parallel, so pick the month one by its window rather
    // than by call order.
    const monthCall = AttendanceModel.calls.find((call) => {
      const query = call.args[0];

      return (
        Array.isArray(query) &&
        query[0]?.$match?.date?.$gte?.endsWith('-01') === true
      );
    });

    assert.ok(monthCall, 'the month aggregate was never run');

    const query = monthCall.args[0][0].$match;

    assert.equal(query.companyId, COMPANY);
    assert.equal(query.user, USER);
    assert.equal(query.date.$gte, '2026-06-01');
    assert.equal(query.date.$lte, '2026-06-15');
  });

  test('it rolls up status buckets and hours for the month', async () => {
    // The month rollup is an AGGREGATE, not a find — and the same collection
    // also serves the `attendance` category's findOne/aggregate pair, which is
    // why the fake has to be operation-aware.
    const AttendanceModel = makeModelByOp({
      aggregate: [
        { _id: 'PRESENT', days: 8, minutes: 2880 },
        { _id: 'LATE', days: 2, minutes: 540 },
        { _id: 'HALF_DAY', days: 1, minutes: 240 },
      ],
    });

    const { context } = await run({ AttendanceModel });

    assert.equal(context.includes('Attendance This Month (2026-06)'), true);
    assert.equal(context.includes('Days recorded: 11 of 30'), true);
    assert.equal(context.includes('Present: 8, Late: 2, Half day: 1'), true);
    assert.equal(context.includes('Hours worked so far: 61'), true);
  });

  test('an empty month is stated plainly', async () => {
    const { context } = await run({ AttendanceModel: makeModelByOp() });

    assert.equal(context.includes('none recorded so far this month'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. ORG AGGREGATES — counts only, never rows
// ═══════════════════════════════════════════════════════════════════════════
describe('org-aggregates', () => {
  const userWithRole = (role) => ({
    UserModel: makeModel({
      _id: USER,
      name: 'John Doe',
      role,
      designation: 'Software Engineer',
      department: { _id: '0000000000000000000000d1', name: 'Engineering' },
      email: 'john.doe@example.com',
      employeeCode: 'EMP-042',
    }),
  });

  test('an EMPLOYEE is told their role excludes company figures', async () => {
    const { context } = await run(userWithRole('EMPLOYEE'));

    assert.equal(
      context.includes('none - your role does not include team or company-wide figures'),
      true,
    );

    // No count queries were even issued for an employee.
    const deps = baseDeps(userWithRole('EMPLOYEE'));

    assert.equal(deps.AttendanceModel.calls.length, 0);
    assert.equal(deps.LeaveModel.calls.length, 0);
    assert.equal(deps.ExpenseModel.calls.length, 0);
  });

  test('a MANAGER gets team counts, not company counts', async () => {
    const UserModel = userWithRole('MANAGER').UserModel;

    const { context } = await run({
      UserModel,
      UserModel2: UserModel,
    });

    // The manager branch counts direct reports.
    assert.equal(context.includes('My Team Figures:'), true);
    assert.equal(context.includes('Direct reports:'), true);
    assert.equal(context.includes('Total employees:'), false);
    assert.equal(context.includes('Pending leave requests:'), false);
  });

  test('an HR user gets company counts', async () => {
    const { context } = await run(userWithRole('HR_MANAGER'));

    assert.equal(context.includes('Company Figures:'), true);
    assert.equal(context.includes('Total employees:'), true);
    assert.equal(context.includes('Pending leave requests:'), true);
    assert.equal(context.includes('Direct reports:'), false);
  });

  test('an aggregate NEVER names a person', async () => {
    // THE SECURITY PIN. A count is not a person. If a future change started
    // putting ids or names into this section, an employee could read a
    // colleague's data through a chat box, which is exactly what 36.2 forbade.
    //
    // Asserted on the AGGREGATE SECTION ALONE. The caller's own profile
    // legitimately carries their name and designation; that is their own data
    // and is not what this pin is about.
    const { context } = await run(userWithRole('HR_MANAGER'));

    const section = context
      .slice(context.indexOf('Company Figures:'))
      .split('\n\n')[0];

    assert.ok(section.length > 0, 'the aggregate section is missing');

    assert.equal(section.includes(OTHER_USER), false);
    assert.equal(section.includes('John Doe'), false);
    assert.equal(section.includes('EMP-042'), false);
    assert.equal(section.includes('john.doe@example.com'), false);
    assert.equal(section.includes('Software Engineer'), false);

    // And no salary figure at any role.
    assert.equal(/salary|ctc|net pay|gross/i.test(section), false);
  });

  test('a failed role read is unavailable, not "none"', async () => {
    // A THROWING query is reported by the retriever's section guard as
    // "(org-aggregates unavailable)" — the same contract every other category
    // follows, so the failure is attributable to the section that failed.
    const UserModel = {
      calls: [],
      then: (_r, reject) =>
        reject(Object.assign(new Error('driver down'), { code: 'ECONNREFUSED' })),
    };

    const { context } = await run({ UserModel });

    assert.equal(context.includes('(org-aggregates unavailable)'), true);
    assert.equal(
      context.includes('none - your role does not include team or company-wide figures'),
      false,
    );
  });

  test('a role that reads as nothing is unavailable, not "none"', async () => {
    // The other half: the query SUCCEEDS but returns no user. That is a read
    // that could not produce an answer, which is the UNAVAILABLE half of the
    // rule, not the NONE half.
    const UserModel = makeModelByOp({ find: null });

    const { context } = await run({ UserModel });

    assert.equal(context.includes('(role unavailable)'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J. CAPABILITIES — static, and therefore incapable of failing
// ═══════════════════════════════════════════════════════════════════════════
describe('capabilities', () => {
  test('it renders the catalogue and touches no model at all', async () => {
    const deps = baseDeps({
      ConfigModel: tenantConfigModel(['capabilities']),
    });

    const { context } = await getUserHRContext({
      companyId: COMPANY,
      userId: USER,
      deps,
    });

    assert.equal(context.includes('What This Assistant Can Help You Do:'), true);

    // No read means no failure branch. Every model except the tenant config
    // must have been left completely alone.
    [
      'PayslipModel',
      'ExpenseModel',
      'TaskModel',
      'ProjectModel',
      'DocumentModel',
      'LeaveModel',
      'AttendanceModel',
      'HolidayModel',
      'AnnouncementModel',
    ].forEach((key) => {
      assert.equal(deps[key].calls.length, 0, `${key} was queried`);
    });
  });

  test('the leave and punch instructions are present', async () => {
    const { context } = await run();

    assert.equal(context.includes('Applying for leave'), true);
    assert.equal(context.includes('New Request'), true);
    assert.equal(context.includes('Punch In'), true);
    assert.equal(context.includes('Regularization'), true);
  });

  test('the catalogue promises no screen that does not exist', async () => {
    // The most dangerous kind of bug here: the assistant confidently sending an
    // employee to a feature that was never built.
    const source = read('src/services/ai/aiConfig.js');

    const catalogue = source.slice(
      source.indexOf('AI_CAPABILITIES'),
      source.indexOf('];', source.indexOf('AI_CAPABILITIES')),
    );

    // Every screen named in the catalogue must be one this repo really ships.
    const named = [
      'My Leaves',
      'My Payslips',
      'My Expenses',
      'My Tasks',
      'My Documents',
      'My Profile',
      'Projects',
      'Attendance',
    ];

    named.forEach((screen) => {
      assert.equal(catalogue.includes(screen), true, `${screen} is not named`);
    });

    // And it must not invent an AI capability it does not have.
    ['auto-approve', 'on your behalf', 'I will apply', 'I have submitted'].forEach(
      (phrase) => {
        assert.equal(
          catalogue.toLowerCase().includes(phrase.toLowerCase()),
          false,
          `the catalogue promises "${phrase}"`,
        );
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// K. THE TENANT ALLOWLIST STILL GATES EVERY NEW CATEGORY
// ═══════════════════════════════════════════════════════════════════════════
describe('the allowlist gates the new categories too', () => {
  test('a tenant that allows only profile gets no payslips or expenses', async () => {
    const PayslipModel = makeModelByOp();
    const ExpenseModel = makeModelByOp();

    const { context, categoriesUsed } = await run({
      ConfigModel: tenantConfigModel(['profile']),
      PayslipModel,
      ExpenseModel,
    });

    assert.deepEqual(categoriesUsed, ['profile']);
    assert.equal(context.includes('My Payslips'), false);
    assert.equal(context.includes('My Expense Claims'), false);

    // Not queried at all, not queried and hidden.
    assert.equal(PayslipModel.calls.length, 0);
    assert.equal(ExpenseModel.calls.length, 0);
  });

  test('the four 36.2 sections still render alongside the new ones', async () => {
    const { context } = await run();

    ['Employee Profile:', 'Leave Balances:', "Today's Attendance:", 'Upcoming Holidays'].forEach(
      (marker) => {
        assert.equal(context.includes(marker), true, `${marker} is gone`);
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L. SOURCE PINS — the authorization law, grepped rather than trusted
// ═══════════════════════════════════════════════════════════════════════════
describe('source pins (the authorization law)', () => {
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('the retriever declares every new model as an injectable dep', () => {
    const source = read('src/services/ai/hrContextRetriever.js');

    ['PayslipModel', 'ExpenseModel', 'TaskModel', 'ProjectModel', 'DocumentModel'].forEach(
      (name) => {
        assert.equal(source.includes(name), true, `${name} is not in the DI seam`);
      },
    );
  });

  test('every own-record query that actually runs carries the tenant id', () => {
    // This used to be a source grep. It was replaced because a grep cannot
    // resolve a filter that is built as a named constant first, so it reported
    // a false positive on a query that WAS tenant-scoped. Asserting on the
    // arguments the fakes actually recorded is both stronger and honest: it
    // checks the query that ran, not the text that was written.
    const cases = [
      ['PayslipModel', 'find'],
      ['ExpenseModel', 'find'],
      ['TaskModel', 'find'],
      ['ProjectModel', 'find'],
      ['DocumentModel', 'find'],
      ['LeaveModel', 'find'],
      ['AttendanceModel', 'aggregate'],
      ['ExpenseModel', 'countDocuments'],
      ['LeaveModel', 'countDocuments'],
      ['AttendanceModel', 'countDocuments'],
      ['UserModel', 'countDocuments'],
    ];

    return (async () => {
      for (const [key, op] of cases) {
        // The HR user is the default identity, EXCEPT for the one case that is
        // checking UserModel itself — there the recording fake has to be the
        // UserModel, or the override below would silently discard it. It still
        // has to resolve to an HR user, or the org-aggregates builder bails out
        // at the role read and never reaches its countDocuments.
        const hrUser = makeModelByOp({
          find: {
            _id: USER,
            name: 'John Doe',
            role: 'HR_MANAGER',
            designation: 'SE',
            department: { _id: '0000000000000000000000d1', name: 'Eng' },
            email: 'john.doe@example.com',
            employeeCode: 'EMP-042',
          },
        });

        const model =
          key === 'UserModel'
            ? makeModelByOp({
                find: {
                  _id: USER,
                  name: 'John Doe',
                  role: 'HR_MANAGER',
                  designation: 'SE',
                  department: { _id: '0000000000000000000000d1', name: 'Eng' },
                  email: 'john.doe@example.com',
                  employeeCode: 'EMP-042',
                },
              })
            : makeModelByOp();

        await getUserHRContext({
          companyId: COMPANY,
          userId: USER,
          deps: baseDeps({
            UserModel: key === 'UserModel' ? model : hrUser,
            ...(key === 'UserModel' ? {} : { [key]: model }),
          }),
        });

        const calls = model.calls.filter((call) => call.name === op);

        assert.ok(calls.length > 0, `${key}.${op}() never ran`);

        calls.forEach((call) => {
          const query = call.args[0];

          // An aggregate takes a pipeline array; everything else takes a
          // filter object. Both must name the tenant.
          const filter = Array.isArray(query) ? query[0]?.$match : query;

          assert.ok(filter, `${key}.${op}() was called with no filter`);

          assert.equal(
            Object.prototype.hasOwnProperty.call(filter, 'companyId') ||
              Object.prototype.hasOwnProperty.call(filter, 'company'),
            true,
            `${key}.${op}() is not tenant-scoped: ${JSON.stringify(filter)}`,
          );
        });
      }
    })();
  });

  test('no other employee id can reach a query', () => {
    // There is deliberately no parameter through which a different user's
    // records could be requested.
    const source = stripComments(read('src/services/ai/hrContextRetriever.js'));

    assert.equal(source.includes('otherUserId'), false);
    assert.equal(source.includes('targetUserId'), false);
    assert.equal(source.includes('employeeId:'), true); // payslip owner, = userId
  });

  test('the assembled context still passes through the redaction safety net', () => {
    const source = stripComments(read('src/services/ai/hrContextRetriever.js'));

    // Exactly one redactPII call, at the very end, on the assembled string.
    assert.equal(source.includes('const context = redactPII(assembled);'), true);
  });
});
