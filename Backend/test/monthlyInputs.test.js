// Hermetic suite for Phase 29.5 — Variable Pay & Monthly Payroll Inputs.
// No MongoDB, no Redis, no network: the service is instantiated with fake
// models, a fake cache, a fake audit writer and a fake notifier.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';

const [rules, serviceFactory, registry, templates] = await Promise.all([
  import('../src/services/payroll/monthlyInputRules.js'),
  import('../src/services/payroll/monthlyInputService.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/utils/roleTemplates.js'),
]);

const {
  BULK_ACTIONS,
  ENTRY_TYPES,
  MAX_IMPORT_ROWS,
  PERIOD_STATUSES,
  PERIOD_TRANSITIONS,
  computeAutomaticSummary,
  entryTotals,
  financialYearOf,
  isDateInMonth,
  isValidMonth,
  monthBounds,
  monthLabel,
  normalizeEntry,
  parseImportCsv,
  statusFor,
  summarizeMonth,
  validateEmployeeInput,
  validateEntry,
} = rules;
const { makeMonthlyInputService } = serviceFactory;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;
const { ROLE_TEMPLATES } = templates;

const MONTH = '2026-08';

// ── fakes ──────────────────────────────────────────────────────────────────

let counter = 0;

const makeFakeModel = (prefix = 'row') => {
  const rows = [];

  const makeDoc = (row) => ({
    ...row,
    toObject: () => ({ ...row, entries: (row.entries || []).map((entry) => ({ ...entry })) }),
    save: async function save() {
      for (const [key, value] of Object.entries(this)) {
        if (key === 'toObject' || key === 'save' || key === '_id') continue;
        row[key] = value;
      }
      return this;
    },
  });

  const match = (row, filter = {}) =>
    Object.entries(filter).every(([key, value]) => {
      if (value && typeof value === 'object' && value.$in) {
        return value.$in.some((entry) => String(entry) === String(row[key]));
      }
      if (value && typeof value === 'object' && (value.$gte || value.$lte)) {
        const actual = String(row[key] || '');
        if (value.$gte && actual < value.$gte) return false;
        if (value.$lte && actual > value.$lte) return false;
        return true;
      }
      return String(row[key]) === String(value);
    });

  const findRows = (filter = {}) => rows.filter((row) => match(row, filter));

  const leanRows = (filter) => findRows(filter).map((row) => ({ ...row }));

  const query = (filter = {}) => {
    const api = {
      sort: () => api,
      limit: () => api,
      select: () => api,
      lean: async () => leanRows(filter),
      // Mongoose queries are awaitable and resolve to DOCUMENTS (with save),
      // while `.lean()` returns plain objects — the service relies on both.
      then: (resolve, reject) =>
        Promise.resolve(findRows(filter).map((row) => makeDoc(row))).then(resolve, reject),
    };
    return api;
  };

  return {
    rows,
    find: (filter = {}) => query(filter),
    findOne: (filter = {}) => {
      const api = {
        select: () => api,
        lean: async () => findRows(filter).map((row) => ({ ...row }))[0] || null,
        then: (resolve, reject) => {
          const row = findRows(filter)[0];
          return Promise.resolve(row ? makeDoc(row) : null).then(resolve, reject);
        },
      };
      return api;
    },
    create: async (data) => {
      counter += 1;
      const stored = { _id: `${prefix}-${counter}`, createdAt: new Date(), ...data };
      rows.push(stored);
      return makeDoc(stored);
    },
    updateMany: async (filter = {}, update = {}) => {
      findRows(filter).forEach((row) => Object.assign(row, update.$set || {}));
      return { modifiedCount: findRows(filter).length };
    },
    countDocuments: async (filter = {}) => findRows(filter).length,
  };
};

const EMPLOYEES = [
  { _id: 'employee-1', employeeCode: 'EMP001', name: 'Asha Rao', status: 'ACTIVE', department: 'dept-1' },
  { _id: 'employee-2', employeeCode: 'EMP002', name: 'Rahul Menon', status: 'ACTIVE', department: 'dept-2' },
  { _id: 'employee-3', employeeCode: 'EMP003', name: 'Priya Nair', status: 'INACTIVE', department: 'dept-1' },
];

const makeHarness = ({ attendance = [], leaves = [], holidays = [] } = {}) => {
  const PeriodModel = makeFakeModel('period');
  const InputModel = makeFakeModel('input');
  const ProfileModel = makeFakeModel('profile');
  const UserModel = {
    find: (filter = {}) => ({
      select: () => ({
        lean: async () => {
          let rows = EMPLOYEES.slice();
          if (filter.status) rows = rows.filter((row) => row.status === filter.status);
          if (filter._id?.$in) {
            const ids = filter._id.$in.map(String);
            rows = rows.filter((row) => ids.includes(String(row._id)));
          }
          if (filter.employeeCode?.$in) {
            const codes = filter.employeeCode.$in.map((code) => String(code).toUpperCase());
            rows = rows.filter((row) => codes.includes(String(row.employeeCode).toUpperCase()));
          }
          return rows.map((row) => ({ ...row }));
        },
      }),
    }),
    findOne: (filter = {}) => ({
      select: () => ({
        lean: async () => EMPLOYEES.find((row) => String(row._id) === String(filter._id)) || null,
      }),
    }),
  };
  const AttendanceModel = {
    find: (filter = {}) => ({
      select: () => ({
        lean: async () =>
          attendance.filter(
            (row) =>
              String(row.user) === String(filter.user) &&
              row.date >= filter.date.$gte &&
              row.date <= filter.date.$lte,
          ),
      }),
    }),
  };
  const LeaveModel = {
    find: (filter = {}) => ({
      select: () => ({
        lean: async () => leaves.filter((row) => String(row.user) === String(filter.user)),
      }),
    }),
  };
  const HolidayModel = { find: () => ({ select: () => ({ lean: async () => holidays }) }) };
  const SetupModel = {
    findOne: () => ({
      select: () => ({
        lean: async () => ({
          payrollCycle: { frequency: 'MONTHLY', workingDays: 22 },
          weekendPolicy: { weekendDays: [0, 6] },
        }),
      }),
    }),
  };

  const auditRows = [];
  const notifications = [];
  const cacheCalls = { del: 0 };

  const service = makeMonthlyInputService({
    PayrollPeriodModel: PeriodModel,
    EmployeeMonthlyInputModel: InputModel,
    EmployeePayrollProfileModel: ProfileModel,
    UserModel,
    AttendanceModel,
    LeaveModel,
    HolidayModel,
    PayrollSetupModel: SetupModel,
    ShiftModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
    cache: {
      buildKey: ({ companyId, namespace, segments = [] }) =>
        `test:${companyId}:${namespace}:${segments.join(':')}`,
      del: async () => {
        cacheCalls.del += 1;
        return true;
      },
    },
    audit: async (row) => auditRows.push(row),
    notify: async (row) => notifications.push(row),
  });

  return { service, PeriodModel, InputModel, ProfileModel, auditRows, notifications, cacheCalls };
};

const actor = { _id: 'hr-1', name: 'HR Manager' };

const bonusEntry = (overrides = {}) => ({
  type: 'BONUS_PERFORMANCE',
  amount: 5000,
  reason: 'Q2 performance',
  ...overrides,
});

// ── 1. month helpers ───────────────────────────────────────────────────────

test('payroll month helpers agree on August 2026', () => {
  assert.equal(isValidMonth('2026-08'), true);
  assert.equal(isValidMonth('2026-8'), false);
  assert.equal(isValidMonth('August 2026'), false);

  const bounds = monthBounds(MONTH);
  assert.equal(bounds.startKey, '2026-08-01');
  assert.equal(bounds.endKey, '2026-08-31');
  assert.equal(bounds.daysInMonth, 31);

  assert.equal(monthLabel(MONTH), 'August 2026');
  assert.equal(financialYearOf(MONTH), 'FY 2026-27');
  assert.equal(financialYearOf('2026-02'), 'FY 2025-26');

  assert.equal(isDateInMonth('2026-08-15', MONTH), true);
  assert.equal(isDateInMonth('2026-09-01', MONTH), false);
});

test('period statuses and transitions follow §6 / §20', () => {
  assert.deepEqual(PERIOD_STATUSES, [
    'DRAFT',
    'COLLECTING_INPUTS',
    'VALIDATED',
    'LOCKED',
    'SENT_TO_PAYROLL',
  ]);
  assert.deepEqual(PERIOD_TRANSITIONS.COLLECTING_INPUTS, ['VALIDATED', 'LOCKED']);
  assert.deepEqual(PERIOD_TRANSITIONS.SENT_TO_PAYROLL, []);
});

// ── 2. entries (§8 / §13 / §19) ────────────────────────────────────────────

test('a valid bonus entry passes; amount, reason and month are enforced', () => {
  assert.deepEqual(validateEntry(normalizeEntry(bonusEntry()), { month: MONTH }), []);

  const noType = validateEntry(normalizeEntry(bonusEntry({ type: 'NOPE' })), { month: MONTH });
  assert.ok(noType.some((error) => error.field === 'type'));

  const zeroAmount = validateEntry(normalizeEntry(bonusEntry({ amount: 0 })), { month: MONTH });
  assert.ok(zeroAmount.some((error) => error.field === 'amount'));

  const noReason = validateEntry(normalizeEntry(bonusEntry({ reason: '' })), { month: MONTH });
  assert.ok(noReason.some((error) => error.field === 'reason'));
});

test('a duplicate bonus entry is rejected (§19)', () => {
  const existing = [normalizeEntry(bonusEntry())];
  const errors = validateEntry(normalizeEntry(bonusEntry()), { month: MONTH, existing });
  assert.ok(errors.some((error) => /already exists/i.test(error.message)));
});

test('employee validation reports the missing 29.4 pieces', () => {
  const noProfile = validateEmployeeInput({ month: MONTH, hasProfile: false });
  assert.ok(noProfile.issues.some((issue) => /payroll profile/i.test(issue)));

  const noStructure = validateEmployeeInput({ month: MONTH, hasProfile: true, hasStructure: false });
  assert.ok(noStructure.issues.some((issue) => /salary structure/i.test(issue)));

  const inactive = validateEmployeeInput({
    month: MONTH,
    hasProfile: true,
    hasStructure: true,
    employeeActive: false,
  });
  assert.ok(inactive.issues.some((issue) => /not active/i.test(issue)));

  const clean = validateEmployeeInput({ month: MONTH, hasProfile: true, hasStructure: true });
  assert.deepEqual(clean.issues, []);
});

test('status derivation follows §18', () => {
  assert.equal(statusFor({ issues: [], locked: false }), 'READY');
  assert.equal(statusFor({ issues: ['x'] }), 'ERROR');
  assert.equal(statusFor({ issues: [], locked: true }), 'LOCKED');
});

// ── 3. CSV import (§11) ────────────────────────────────────────────────────

test('the CSV parser reads quoted commas and rejects bad rows', () => {
  const csv = [
    'employeeCode,type,amount,reason,claimDate,remarks',
    'EMP001,BONUS_FESTIVAL,5000,"Diwali, 2026",2026-08-15,team gift',
    'EMP002,REIMBURSEMENT_TRAVEL,1200,Client visit,,',
    ',BONUS_FESTIVAL,5000,Missing code,,',
    'EMP003,NOPE_TYPE,1000,Bad type,,',
    'EMP001,BONUS_FESTIVAL,5000,"Diwali, 2026",,duplicate row',
  ].join('\n');

  const { rows, rejected } = parseImportCsv(csv);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].entry.reason, 'Diwali, 2026');
  assert.equal(rows[0].employeeCode, 'EMP001');
  assert.equal(rows[1].entry.type, 'REIMBURSEMENT_TRAVEL');

  const messages = rejected.map((row) => row.message).join(' | ');
  assert.match(messages, /Employee code is missing/);
  assert.match(messages, /Choose what this entry is/);
  assert.match(messages, /Duplicate row/);
});

test('a file without the required header is rejected as a whole', () => {
  const { rows, rejected } = parseImportCsv('name,value\nEMP001,5000');
  assert.equal(rows.length, 0);
  assert.match(rejected[0].message, /header/i);
});

test('the importer refuses more than the row cap', () => {
  const header = 'employeeCode,type,amount,reason';
  const many = Array.from({ length: MAX_IMPORT_ROWS + 5 }, (_, index) =>
    `EMP00${(index % 3) + 1},BONUS_FESTIVAL,100,row ${index}`,
  ).join('\n');

  const { rows, rejected } = parseImportCsv(`${header}\n${many}`);
  assert.equal(rows.length, MAX_IMPORT_ROWS);
  assert.ok(rejected.some((row) => /split the file/i.test(row.message)));
});

// ── 4. automatic imports (§7 / §14 / §15) ──────────────────────────────────

test('attendance drives present, late, half-day, OT and absence', () => {
  const auto = computeAutomaticSummary({
    month: MONTH,
    workingDays: 22,
    attendance: [
      { date: '2026-08-03', status: 'PRESENT', lateMinutes: 0, overtimeMinutes: 60 },
      { date: '2026-08-04', status: 'LATE', lateMinutes: 25, overtimeMinutes: 0 },
      { date: '2026-08-05', status: 'HALF_DAY', lateMinutes: 0, overtimeMinutes: 0 },
      { date: '2026-08-06', status: 'PRESENT', lateMinutes: 0, overtimeMinutes: 120 },
    ],
    leaves: [],
  });

  assert.equal(auto.presentDays, 3); // two PRESENT + one LATE
  assert.equal(auto.lateMarks, 1);
  assert.equal(auto.halfDays, 1);
  assert.equal(auto.otHours, 3);
  // 22 working days − (3 present + 0.5 half day)
  assert.equal(auto.absentDays, 18.5);
  assert.equal(auto.lopDays, 18.5);
  assert.equal(auto.lopSource, 'ATTENDANCE');
});

test('approved leave counts as paid, and LOP follows the Leave module when it owns the type', () => {
  const paid = computeAutomaticSummary({
    month: MONTH,
    workingDays: 22,
    attendance: [],
    leaves: [{ type: 'CASUAL', days: 2, status: 'APPROVED', startDate: '2026-08-10' }],
  });
  assert.equal(paid.paidLeaveDays, 2);

  const withLopType = computeAutomaticSummary({
    month: MONTH,
    workingDays: 22,
    attendance: [],
    leaves: [{ type: 'LOP', days: 3, status: 'APPROVED', startDate: '2026-08-10' }],
    lopLeaveType: 'LOP',
  });
  assert.equal(withLopType.lopDays, 3);
  assert.equal(withLopType.lopSource, 'LEAVE');
});

test('weekend and holiday shifts are counted from the imported data', () => {
  const auto = computeAutomaticSummary({
    month: MONTH,
    workingDays: 22,
    attendance: [
      { date: '2026-08-02', status: 'PRESENT', weekendPolicy: { weekendDays: [0, 6] } }, // Sunday
      { date: '2026-08-15', status: 'PRESENT', weekendPolicy: { weekendDays: [0, 6] } }, // Saturday
    ],
    leaves: [],
    holidays: [{ date: '2026-08-15' }],
  });

  assert.equal(auto.weekendShiftCount, 2);
  assert.equal(auto.holidayShiftCount, 1);
});

// ── 5. totals and KPIs (§25) ───────────────────────────────────────────────

test('bonus, reimbursement and deduction totals stay separate and ignore rejected claims', () => {
  const totals = entryTotals([
    normalizeEntry({ type: 'BONUS_FESTIVAL', amount: 5000, reason: 'Diwali' }),
    normalizeEntry({ type: 'REIMBURSEMENT_TRAVEL', amount: 1200, reason: 'Client visit' }),
    normalizeEntry({ type: 'DEDUCTION_LOAN_EMI', amount: 3000, reason: 'Loan EMI' }),
    normalizeEntry({
      type: 'REIMBURSEMENT_FOOD',
      amount: 900,
      reason: 'Rejected claim',
      claimStatus: 'REJECTED',
    }),
  ]);

  assert.equal(totals.bonus, 5000);
  assert.equal(totals.reimbursement, 1200);
  assert.equal(totals.deduction, 3000);
});

test('the month summary produces the §25 KPIs', () => {
  const summary = summarizeMonth([
    { entries: [normalizeEntry({ type: 'BONUS_FESTIVAL', amount: 5000, reason: 'Diwali' })], issues: [], auto: { lopDays: 1, otHours: 2 } },
    { entries: [], issues: ['No payroll profile'], auto: {} },
    { entries: [], issues: [], locked: true, auto: { lopDays: 2 } },
  ]);

  assert.equal(summary.employees, 3);
  assert.equal(summary.ready, 1);
  assert.equal(summary.error, 1);
  assert.equal(summary.locked, 1);
  assert.equal(summary.totalBonus, 5000);
  assert.equal(summary.totalLopDays, 3);
  assert.equal(summary.totalOtHours, 2);
});

// ── 6. service ─────────────────────────────────────────────────────────────

test('ensurePeriod creates the month once and copies the 29.1 financial year', async () => {
  const { service, PeriodModel } = makeHarness();

  const first = await service.ensurePeriod({ companyId: 'company-a', month: MONTH, actor });
  const second = await service.ensurePeriod({ companyId: 'company-a', month: MONTH, actor });

  assert.equal(String(first._id), String(second._id));
  assert.equal(PeriodModel.rows.length, 1);
  assert.equal(first.financialYear, 'FY 2026-27');
  assert.equal(first.status, 'COLLECTING_INPUTS');
  assert.equal(first.workingDays, 22);
});

test('importAutomatic builds one row per active employee and stamps the period', async () => {
  const { service, InputModel, PeriodModel } = makeHarness();

  const result = await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  assert.equal(result.imported, 2, 'inactive employees are skipped');
  assert.equal(InputModel.rows.length, 2);
  assert.ok(
    InputModel.rows.every((row) => String(row.periodId) === String(PeriodModel.rows[0]._id)),
  );
  assert.ok(PeriodModel.rows[0].attendanceImportedAt instanceof Date);
});

test('HR adds an entry, the duplicate is refused and the audit records it', async () => {
  const { service, InputModel, auditRows, cacheCalls } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  const input = await service.addEntry({
    companyId: 'company-a',
    month: MONTH,
    employeeId: 'employee-1',
    entry: bonusEntry(),
    actor,
  });

  assert.equal(input.entries.length, 1);
  assert.equal(input.entries[0].amount, 5000);
  assert.equal(auditRows.at(-1).action, 'PAYROLL_BONUS_ADDED');
  assert.ok(cacheCalls.del > 0);

  await assert.rejects(
    () =>
      service.addEntry({
        companyId: 'company-a',
        month: MONTH,
        employeeId: 'employee-1',
        entry: bonusEntry(),
        actor,
      }),
    (error) => error.statusCode === 400,
  );

  assert.equal(InputModel.rows.find((row) => String(row.employeeId) === 'employee-1').entries.length, 1);
});

test('a refund-style deduction is audited as a deduction, a claim as a reimbursement', async () => {
  const { service, auditRows } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  await service.addEntry({
    companyId: 'company-a',
    month: MONTH,
    employeeId: 'employee-1',
    entry: { type: 'REIMBURSEMENT_TRAVEL', amount: 1200, reason: 'Client visit' },
    actor,
  });
  assert.equal(auditRows.at(-1).action, 'PAYROLL_REIMBURSEMENT_ADDED');

  await service.addEntry({
    companyId: 'company-a',
    month: MONTH,
    employeeId: 'employee-1',
    entry: { type: 'DEDUCTION_LOAN_EMI', amount: 3000, reason: 'Loan EMI' },
    actor,
  });
  assert.equal(auditRows.at(-1).action, 'PAYROLL_DEDUCTION_ADDED');
});

test('bulk actions apply to the month and are audited per employee (§12)', async () => {
  const { service, auditRows } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  const result = await service.bulkAction({
    companyId: 'company-a',
    month: MONTH,
    action: 'ADD_FESTIVAL_BONUS',
    payload: { amount: 2500, reason: 'Diwali 2026' },
    actor,
  });

  assert.equal(result.touched, 2);
  assert.ok(auditRows.some((row) => row.action === 'PAYROLL_INPUT_BULK_ACTION'));

  // Mark-zero clears bonuses again.
  const cleared = await service.bulkAction({
    companyId: 'company-a',
    month: MONTH,
    action: 'MARK_ZERO_BONUS',
    actor,
  });
  assert.equal(cleared.touched, 2);
});

test('the import preview rejects unknown employee codes, confirm stores the rest', async () => {
  const { service, InputModel } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  const csv = [
    'employeeCode,type,amount,reason',
    'EMP001,BONUS_FESTIVAL,5000,Diwali',
    'EMP002,REIMBURSEMENT_INTERNET,800,Internet',
    'EMP999,BONUS_FESTIVAL,5000,Ghost employee',
  ].join('\n');

  const preview = await service.previewImport({ companyId: 'company-a', month: MONTH, content: csv });

  assert.equal(preview.totals.accepted, 2);
  assert.equal(preview.totals.rejected, 1);
  assert.deepEqual(preview.unknownCodes, ['EMP999']);

  const confirmed = await service.confirmImport({
    companyId: 'company-a',
    month: MONTH,
    rows: preview.accepted,
    actor,
  });

  assert.equal(confirmed.created, 2);
  assert.equal(
    InputModel.rows.reduce((sum, row) => sum + row.entries.length, 0),
    2,
  );
});

test('validation blocks locking, and locking freezes every row (§19 / §20)', async () => {
  const { service, InputModel, ProfileModel, auditRows } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  // Nobody has a 29.4 profile yet ⇒ every row is an error.
  const report = await service.validateMonth({ companyId: 'company-a', month: MONTH, actor });
  assert.equal(report.withErrors, 2);

  await assert.rejects(
    () => service.setPeriodStatus({ companyId: 'company-a', month: MONTH, status: 'LOCKED', actor }),
    (error) => error.statusCode === 400 && /validation errors/.test(error.message),
  );

  // Give both employees a 29.4 payroll profile with a structure, then lock.
  await ProfileModel.create({
    companyId: 'company-a',
    employeeId: 'employee-1',
    isCurrent: true,
    structureId: 'structure-1',
    annualCtc: 1200000,
    monthlyGross: 100000,
  });
  await ProfileModel.create({
    companyId: 'company-a',
    employeeId: 'employee-2',
    isCurrent: true,
    structureId: 'structure-1',
    annualCtc: 900000,
    monthlyGross: 75000,
  });

  const cleaned = await service.validateMonth({ companyId: 'company-a', month: MONTH, actor });
  assert.equal(cleaned.withErrors, 0);

  const period = await service.setPeriodStatus({
    companyId: 'company-a',
    month: MONTH,
    status: 'LOCKED',
    actor,
  });

  assert.equal(period.status, 'LOCKED');
  assert.ok(period.lockedAt instanceof Date);
  assert.ok(InputModel.rows.every((row) => row.lockedAt instanceof Date));
  assert.ok(auditRows.some((row) => row.action === 'PAYROLL_INPUTS_LOCKED'));

  // Editing a locked month is refused.
  await assert.rejects(
    () =>
      service.addEntry({
        companyId: 'company-a',
        month: MONTH,
        employeeId: 'employee-1',
        entry: bonusEntry({ reason: 'After lock' }),
        actor,
      }),
    (error) => error.statusCode === 400 && /locked/i.test(error.message),
  );

  // Reopening is the one way back, and it clears the freeze.
  const reopened = await service.setPeriodStatus({
    companyId: 'company-a',
    month: MONTH,
    status: 'COLLECTING_INPUTS',
    actor,
  });
  assert.equal(reopened.status, 'COLLECTING_INPUTS');
  assert.ok(reopened.reopenedAt instanceof Date);
  assert.ok(auditRows.some((row) => row.action === 'PAYROLL_INPUTS_REOPENED'));
});

// ── 7. tenant isolation (§3) ───────────────────────────────────────────────

test('another company sees none of this month inputs', async () => {
  const { service } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  const other = await service.listInputs({ companyId: 'company-b', month: MONTH });
  assert.equal(other.inputs.length, 0);
  assert.equal(other.summary.employees, 0);
});

test('the payroll scope narrows the rows, it never widens them (§4 / §24)', async () => {
  const { service } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  const scoped = await service.listInputs({
    companyId: 'company-a',
    month: MONTH,
    allowedEmployeeIds: ['employee-2'],
  });

  assert.equal(scoped.inputs.length, 1);
  assert.equal(String(scoped.inputs[0].employeeId), 'employee-2');
});

// ── 8. RBAC (§4) ───────────────────────────────────────────────────────────

test('monthly input permissions follow permissions, not role names', () => {
  const catalogue = DEFAULT_PERMISSIONS.map((permission) => permission.name);

  for (const permission of ['PAYROLL_INPUT_READ', 'PAYROLL_INPUT_MANAGE', 'PAYROLL_INPUT_LOCK']) {
    assert.ok(catalogue.includes(permission), `${permission} missing`);
    assert.ok(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(permission));
  }

  // HR collects and edits, but §20 keeps locking with Company/Payroll Admin.
  assert.ok(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('PAYROLL_INPUT_MANAGE'));
  assert.equal(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('PAYROLL_INPUT_LOCK'), false);

  // Manager reads their TEAM only; Team Lead and Employee get nothing.
  assert.deepEqual(
    DEFAULT_ROLE_MATRIX.MANAGER.filter((permission) => permission.startsWith('PAYROLL_INPUT')),
    ['PAYROLL_INPUT_READ'],
  );
  for (const role of ['TEAM_LEAD', 'EMPLOYEE']) {
    assert.equal(
      DEFAULT_ROLE_MATRIX[role].filter((permission) => permission.startsWith('PAYROLL_INPUT')).length,
      0,
    );
  }

  const payrollAdmin = ROLE_TEMPLATES.find((entry) => entry.key === 'PAYROLL_ADMIN');
  for (const permission of ['PAYROLL_INPUT_READ', 'PAYROLL_INPUT_MANAGE', 'PAYROLL_INPUT_LOCK']) {
    assert.ok(payrollAdmin.permissions.includes(permission));
  }
});

// ── 9. source conventions ──────────────────────────────────────────────────

const readSource = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('29.5 backend sources are ESM, tenant-scoped and role-name free', async () => {
  const files = [
    'src/services/payroll/monthlyInputRules.js',
    'src/services/payroll/monthlyInputService.js',
    'src/controllers/monthlyInputController.js',
    'src/validators/monthlyInputValidator.js',
    'src/routes/monthlyInputRoutes.js',
    'src/middlewares/payrollInputScope.js',
    'src/models/EmployeeMonthlyInput.js',
    'src/models/PayrollPeriod.js',
  ];

  for (const file of files) {
    const source = await readSource(file);

    assert.equal(/\bfunction\s+\w+\s*\(/.test(source), false, `${file} must stay arrow-function ESM`);
    assert.equal(/\brequire\s*\(/.test(source), false, `${file} must not use require()`);
    const needsTenantScope = !file.includes('Rules') && !file.includes('Validator');
    if (needsTenantScope) {
      assert.ok(/companyId/.test(source), `${file} must be tenant-scoped`);
    }
    assert.equal(
      /role\s*===\s*['"](COMPANY_ADMIN|HR_MANAGER|Payroll Admin)['"]/.test(source),
      false,
      `${file} must not hardcode role names`,
    );
    // §26 — no payroll calculation may sneak into this phase.
    assert.equal(
      /netPay|netSalary|calculateSalary|providentFund/i.test(source),
      false,
      `${file} must not calculate payroll`,
    );
  }
});

// ── 9. spec gaps closed on the second pass (§7 / §10 / §14 / §15 / §16) ────

test('leave is broken down by type, and LOP keeps the leave records behind it (§7 / §14)', () => {
  const auto = computeAutomaticSummary({
    month: MONTH,
    workingDays: 22,
    attendance: [],
    leaves: [
      { _id: 'leave-1', type: 'CASUAL', days: 2, status: 'APPROVED', startDate: '2026-08-10' },
      { _id: 'leave-2', type: 'SICK', days: 1, status: 'APPROVED', startDate: '2026-08-12' },
      { _id: 'leave-3', type: 'EARNED', days: 3, status: 'APPROVED', startDate: '2026-08-17' },
      { _id: 'leave-4', type: 'SICK', days: 4, status: 'PENDING', startDate: '2026-08-20' },
    ],
  });

  assert.equal(auto.paidLeaveDays, 6);
  assert.equal(auto.leaveBreakdown.CASUAL, 2);
  assert.equal(auto.leaveBreakdown.SICK, 1); // the PENDING one is not paid
  assert.equal(auto.leaveBreakdown.EARNED, 3);

  const withLop = computeAutomaticSummary({
    month: MONTH,
    workingDays: 22,
    attendance: [],
    leaves: [{ _id: 'leave-9', type: 'LOP', days: 3, status: 'APPROVED', startDate: '2026-08-10' }],
    lopLeaveType: 'LOP',
  });
  assert.equal(withLop.lopSource, 'LEAVE');
  assert.deepEqual(withLop.lopLeaveIds, ['leave-9']);
  assert.equal(withLop.paidLeaveDays, 0);
});

test('the overtime policy is a preview read of 29.1 — never an amount (§15)', () => {
  const auto = computeAutomaticSummary({
    month: MONTH,
    workingDays: 22,
    attendance: [{ date: '2026-08-03', status: 'PRESENT', overtimeMinutes: 180 }],
    leaves: [],
    overtimePolicy: { enabled: true, basis: 'HOURLY', multiplier: 2 },
  });

  assert.equal(auto.otHours, 3);
  assert.deepEqual(auto.otPolicy, { enabled: true, basis: 'HOURLY', multiplier: 2 });
  // §26 — no amount is ever produced here.
  assert.equal(auto.otAmount, undefined);
  assert.equal(auto.otPay, undefined);
});

test('claims carry their approver, and a rejected claim never reaches payroll (§16 / §17)', async () => {
  const { service } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  const approved = await service.addEntry({
    companyId: 'company-a',
    month: MONTH,
    employeeId: 'employee-1',
    entry: { type: 'REIMBURSEMENT_TRAVEL', amount: 1200, reason: 'Client visit' },
    actor,
  });
  assert.equal(approved.entries[0].claimStatus, 'APPROVED');
  assert.equal(String(approved.entries[0].approvedBy), 'hr-1');
  assert.ok(approved.entries[0].approvedAt instanceof Date);

  const pending = await service.addEntry({
    companyId: 'company-a',
    month: MONTH,
    employeeId: 'employee-1',
    entry: {
      type: 'REIMBURSEMENT_FOOD',
      amount: 400,
      reason: 'Team dinner',
      claimStatus: 'PENDING',
    },
    actor,
  });
  const pendingEntry = pending.entries.find((row) => row.type === 'REIMBURSEMENT_FOOD');
  assert.equal(pendingEntry.claimStatus, 'PENDING');
  assert.equal(pendingEntry.approvedBy, null);

  // §16 — only approved claims flow into payroll: rejected ones are excluded
  // from the totals while staying visible in the drawer.
  const rejected = await service.addEntry({
    companyId: 'company-a',
    month: MONTH,
    employeeId: 'employee-1',
    entry: {
      type: 'REIMBURSEMENT_MEDICAL',
      amount: 900,
      reason: 'Not covered',
      claimStatus: 'REJECTED',
    },
    actor,
  });
  const totals = entryTotals(rejected.entries);
  assert.equal(totals.reimbursement, 1600); // 1200 approved + 400 pending, not 900
  assert.equal(rejected.entries.length, 3);
});

test('pending claims are counted in the month summary (§16 / §25)', () => {
  const summary = summarizeMonth([
    {
      issues: [],
      entries: [
        { type: 'REIMBURSEMENT_TRAVEL', amount: 100, claimStatus: 'PENDING' },
        { type: 'REIMBURSEMENT_FOOD', amount: 50, claimStatus: 'APPROVED' },
        { type: 'REIMBURSEMENT_FUEL', amount: 70, claimStatus: 'REJECTED' },
      ],
    },
  ]);

  assert.equal(summary.claimsPending, 1);
  assert.equal(summary.totalReimbursement, 150);
});

test('HR notes are saved on the employee month and audited (§10)', async () => {
  const { service, auditRows } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  const input = await service.updateRemarks({
    companyId: 'company-a',
    month: MONTH,
    employeeId: 'employee-1',
    remarks: 'Bonus approved by finance on 28 Aug',
    actor,
  });

  assert.equal(input.remarks, 'Bonus approved by finance on 28 Aug');
  assert.equal(auditRows.at(-1).action, 'PAYROLL_INPUT_EDITED');
  assert.equal(auditRows.at(-1).newValue.remarks, 'Bonus approved by finance on 28 Aug');
});

test('imported rows keep their source so bulk actions can remove only those (§12)', async () => {
  const { service, InputModel } = makeHarness();
  await service.importAutomatic({ companyId: 'company-a', month: MONTH, actor });

  const preview = await service.previewImport({
    companyId: 'company-a',
    month: MONTH,
    content: 'employeeCode,type,amount,reason\nEMP001,BONUS_FESTIVAL,3000,Diwali',
  });
  assert.equal(preview.accepted.length, 1);

  await service.confirmImport({ companyId: 'company-a', month: MONTH, rows: preview.accepted, actor });

  const row = InputModel.rows.find((item) => String(item.employeeId) === 'employee-1');
  assert.equal(row.entries[0].source, 'BULK_IMPORT');

  await service.bulkAction({
    companyId: 'company-a',
    month: MONTH,
    action: 'REMOVE_IMPORTED_ENTRIES',
    employeeIds: ['employee-1'],
    actor,
  });
  assert.equal(row.entries.length, 0);
});

test('entry types stay inside the documented catalogue', () => {
  assert.ok(ENTRY_TYPES.includes('BONUS_FESTIVAL'));
  assert.ok(ENTRY_TYPES.includes('REIMBURSEMENT_TRAVEL'));
  assert.ok(ENTRY_TYPES.includes('DEDUCTION_LOAN_EMI'));
  assert.ok(ENTRY_TYPES.length >= 18);
  assert.ok(BULK_ACTIONS.includes('REMOVE_IMPORTED_ENTRIES'));
});
