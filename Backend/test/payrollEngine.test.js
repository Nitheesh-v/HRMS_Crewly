// Hermetic suite for Phase 29.6 — Payroll Calculation Engine.
// No MongoDB, no Redis, no BullMQ: the service is instantiated with fake
// models, a fake cache, a fake audit writer and a fake dispatcher.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';

const [rules, serviceFactory, registry, templates, queueConfig, dispatcherModule] = await Promise.all([
  import('../src/services/payroll/payrollEngineRules.js'),
  import('../src/services/payroll/payrollEngineService.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/utils/roleTemplates.js'),
  import('../src/config/queueConfig.js'),
  import('../src/services/payroll/payrollRunDispatcher.js'),
]);

const {
  PAYROLL_RUN_STATUSES,
  STATUTORY_RULES,
  calculateEmployeePayroll,
  computeEsi,
  computeGratuity,
  computeLopDeduction,
  computeMonthlyTds,
  computeOvertimePay,
  computePayableDays,
  computeProfessionalTax,
  computeProvidentFund,
  precheckCompany,
  precheckEmployee,
  splitMonthlyEntries,
  statutoryKindOf,
  summarizeRun,
  taxFromSlabs,
} = rules;
const { makePayrollEngineService } = serviceFactory;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;
const { ROLE_TEMPLATES } = templates;
const { QUEUE_NAMES, JOB_NAMES } = queueConfig;
const { validatePayrollRunPayload } = dispatcherModule;

const MONTH = '2026-08';
// ObjectId-shaped: the dispatcher payload validator rejects anything else.
const COMPANY = '64b7f9c2e4b0a1b2c3d4e5f6';

// ── fakes ──────────────────────────────────────────────────────────────────

let counter = 0;

const makeFakeModel = (prefix = 'row') => {
  const rows = [];

  const makeDoc = (row) => ({
    ...row,
    toObject: () => ({ ...row }),
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
      if (value && typeof value === 'object' && value.$ne !== undefined) {
        return String(row[key]) !== String(value.$ne);
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
      // Mongoose queries are awaitable and resolve to DOCUMENTS.
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
        lean: async () => leanRows(filter)[0] || null,
        then: (resolve, reject) => {
          const row = findRows(filter)[0];
          return Promise.resolve(row ? makeDoc(row) : null).then(resolve, reject);
        },
      };
      return api;
    },
    create: async (data) => {
      counter += 1;
      // ObjectId-shaped ids: the dispatcher payload validator rejects anything
      // that is not a Mongo id, so the fakes must look real.
      const stored = { _id: String(counter).padStart(24, '0'), createdAt: new Date(), ...data };
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

const SETUP = {
  status: 'ACTIVE',
  payrollPolicy: {
    cycleStartDay: 1,
    cycleEndDay: 31,
    financialYearStartMonth: 4,
    currency: 'INR',
    lopPolicy: { basis: 'PER_DAY' },
    overtimePolicy: { enabled: true, basis: 'HOURLY', multiplier: 2 },
  },
  statutory: {
    pf: { applicable: true },
    esi: { applicable: true },
    professionalTax: { applicable: true, state: 'Karnataka' },
    labourWelfareFund: { applicable: false },
    gratuity: { applicable: true },
    tds: { applicable: true },
  },
  bankAccount: { accountNumberLast4: '9012' },
};

const PREVIEW = {
  earnings: [
    { componentCode: 'BASIC', name: 'Basic', amount: 25000, calculationMethod: 'FIXED' },
    { componentCode: 'HRA', name: 'HRA', amount: 10000, calculationMethod: 'PERCENTAGE_OF_BASIC' },
    { componentCode: 'SPECIAL', name: 'Special Allowance', amount: 15000, calculationMethod: 'REMAINING' },
  ],
  deductions: [],
  employerContributions: [],
};

const makeHarness = ({ employees = null, profiles = null, inputs = null, setup = SETUP } = {}) => {
  const RunModel = makeFakeModel('run');
  const ResultModel = makeFakeModel('result');
  const PeriodModel = makeFakeModel('period');
  const InputModel = makeFakeModel('input');
  const ProfileModel = makeFakeModel('profile');
  const StructureModel = makeFakeModel('structure');
  const ComponentModel = makeFakeModel('component');

  const defaultEmployees = [
    { _id: 'employee-1', name: 'Asha Rao', employeeCode: 'EMP001', status: 'ACTIVE', department: 'dept-1' },
    { _id: 'employee-2', name: 'Rahul Menon', employeeCode: 'EMP002', status: 'ACTIVE', department: 'dept-2' },
    { _id: 'employee-3', name: 'Priya Nair', employeeCode: 'EMP003', status: 'INACTIVE', department: 'dept-1' },
  ];

  const employeeRows = employees || defaultEmployees;

  // §9 — the earnings RULES come from the structure's components (29.2).
  [
    { code: 'BASIC', name: 'Basic', category: 'EARNING' },
    { code: 'HRA', name: 'House Rent Allowance', category: 'EARNING' },
    { code: 'SPECIAL', name: 'Special Allowance', category: 'EARNING' },
  ].forEach((component) =>
    ComponentModel.rows.push({
      ...component,
      companyId: COMPANY,
      status: 'ACTIVE',
      isCurrent: true,
    }),
  );

  const UserModel = {
    find: (filter = {}) => ({
      select: () => ({
        lean: async () => {
          let rows = employeeRows.slice();
          if (filter.status) rows = rows.filter((row) => row.status === filter.status);
          if (filter._id?.$in) {
            const ids = filter._id.$in.map(String);
            rows = rows.filter((row) => ids.includes(String(row._id)));
          }
          return rows.map((row) => ({ ...row }));
        },
      }),
    }),
    findOne: (filter = {}) => ({
      select: () => ({
        lean: async () => employeeRows.find((row) => String(row._id) === String(filter._id)) || null,
      }),
    }),
  };

  const profileRows = profiles || [
    {
      companyId: COMPANY,
      employeeId: 'employee-1',
      isCurrent: true,
      payrollStatus: 'ACTIVE',
      structureId: 'structure-1',
      structureName: 'Standard',
      monthlyGross: 50000,
      annualCtc: 700000,
      statutory: { pfMember: true, esiNumber: 'ESI-1', gratuityEligible: true, uan: '1001' },
      tax: { regime: 'NEW', tdsApplicable: true },
    },
    {
      companyId: COMPANY,
      employeeId: 'employee-2',
      isCurrent: true,
      payrollStatus: 'ACTIVE',
      structureId: 'structure-1',
      structureName: 'Standard',
      monthlyGross: 40000,
      annualCtc: 560000,
      statutory: { pfMember: true, esiNumber: '', gratuityEligible: false },
      tax: { regime: 'OLD', tdsApplicable: false },
    },
  ];
  profileRows.forEach((row) => ProfileModel.rows.push({ ...row }));

  const inputRows = inputs || [
    {
      companyId: COMPANY,
      month: MONTH,
      employeeId: 'employee-1',
      auto: { workingDays: 22, presentDays: 20, absentDays: 0, lopDays: 2, halfDays: 0, paidLeaveDays: 0, otHours: 5, lopSource: 'ATTENDANCE' },
      entries: [
        { entryId: 'e1', type: 'BONUS_PERFORMANCE', amount: 5000, reason: 'Q2', claimStatus: 'APPROVED', source: 'MANUAL' },
        { entryId: 'e2', type: 'REIMBURSEMENT_TRAVEL', amount: 1200, reason: 'Trip', claimStatus: 'APPROVED', source: 'MANUAL' },
        { entryId: 'e3', type: 'REIMBURSEMENT_FOOD', amount: 800, reason: 'Meal', claimStatus: 'REJECTED', source: 'MANUAL' },
        { entryId: 'e4', type: 'DEDUCTION_LOAN_EMI', amount: 3000, reason: 'EMI', claimStatus: 'APPROVED', source: 'MANUAL' },
      ],
    },
    {
      companyId: COMPANY,
      month: MONTH,
      employeeId: 'employee-2',
      auto: { workingDays: 22, presentDays: 22, absentDays: 0, lopDays: 0, halfDays: 0, paidLeaveDays: 0, otHours: 0 },
      entries: [],
    },
  ];
  inputRows.forEach((row) => InputModel.rows.push({ ...row }));

  StructureModel.rows.push({
    _id: 'structure-1',
    companyId: COMPANY,
    status: 'ACTIVE',
    name: 'Standard',
    items: [
      { componentCode: 'BASIC', calculationMethod: 'FIXED_AMOUNT', value: 25000, order: 0 },
      { componentCode: 'HRA', calculationMethod: 'PERCENTAGE_OF_BASIC', value: 40, order: 1 },
      { componentCode: 'SPECIAL', calculationMethod: 'REMAINING', value: 0, order: 2 },
    ],
  });

  PeriodModel.rows.push({ companyId: COMPANY, month: MONTH, status: 'LOCKED', workingDays: 22 });

  const auditRows = [];
  const notifications = [];
  const cacheCalls = { del: 0 };
  const dispatched = [];

  const service = makePayrollEngineService({
    PayrollRunModel: RunModel,
    PayrollResultModel: ResultModel,
    PayrollPeriodModel: PeriodModel,
    EmployeeMonthlyInputModel: InputModel,
    EmployeePayrollProfileModel: ProfileModel,
    SalaryStructureModel: StructureModel,
    SalaryComponentModel: ComponentModel,
    PayrollSetupModel: { findOne: () => ({ lean: async () => setup }) },
    UserModel,
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
    dispatch: async (payload) => {
      dispatched.push(payload);
      return { queued: false };
    },
  });

  return {
    service,
    RunModel,
    ResultModel,
    InputModel,
    ProfileModel,
    auditRows,
    notifications,
    cacheCalls,
    dispatched,
  };
};

const actor = { _id: '64b7f9c2e4b0a1b2c3d4e5f6', name: 'Payroll Admin' };

// ── 1. pure statutory maths (§11 / §12 / §15 / §16) ────────────────────────

test('payable days follow the company LOP basis (§10 / §11)', () => {
  const perDay = computePayableDays({ workingDays: 30, lopDays: 2, basis: 'PER_DAY' });
  assert.equal(perDay.paidDays, 28);
  assert.equal(perDay.ratio, 0.93);

  const perHour = computePayableDays({ workingDays: 30, lopDays: 2, basis: 'PER_HOUR' });
  assert.equal(perHour.paidDays, 28);
  assert.equal(perHour.workingHours, 240);

  assert.equal(computePayableDays({ workingDays: 0, lopDays: 0 }).ratio, 0);
});

test('LOP deduction is per-day basic, priced from monthly earnings (§11)', () => {
  const lop = computeLopDeduction({ monthlyEarnings: 30000, workingDays: 30, lopDays: 2 });
  assert.equal(lop.amount, 2000);
  assert.equal(computeLopDeduction({ monthlyEarnings: 30000, workingDays: 30, lopDays: 0 }).amount, 0);
});

test('overtime uses the 29.1 policy and produces no amount when disabled (§12)', () => {
  const hourly = computeOvertimePay({
    otHours: 10,
    monthlyGross: 30000,
    workingDays: 22,
    policy: { enabled: true, basis: 'HOURLY', multiplier: 2 },
  });
  // 30000 / (22 * 8) = 170.45 per hour, doubled = 340.91
  assert.equal(hourly.amount, 3409.1);

  const fixed = computeOvertimePay({
    otHours: 4,
    monthlyGross: 30000,
    workingDays: 22,
    policy: { enabled: true, basis: 'FIXED', multiplier: 250 },
  });
  assert.equal(fixed.amount, 1000);

  const disabled = computeOvertimePay({
    otHours: 10,
    monthlyGross: 30000,
    workingDays: 22,
    policy: { enabled: false, basis: 'HOURLY', multiplier: 2 },
  });
  assert.equal(disabled.amount, 0);
});

test('PF honours the wage ceiling and splits the employer share (§15 / §16)', () => {
  const below = computeProvidentFund({ pfWages: 10000, applicable: true });
  assert.equal(below.employee, 1200);
  assert.equal(below.ceilingApplied, false);

  const above = computeProvidentFund({ pfWages: 60000, applicable: true });
  assert.equal(above.employee, round(STATUTORY_RULES.PF.wageCeiling * 0.12));
  assert.equal(above.ceilingApplied, true);
  assert.equal(above.employer, round(STATUTORY_RULES.PF.wageCeiling * 0.12));
  assert.equal(above.employerPension, round(STATUTORY_RULES.PF.pensionWageCeiling * STATUTORY_RULES.PF.pensionRate));

  assert.equal(computeProvidentFund({ pfWages: 10000, applicable: false }).employee, 0);
});

test('ESI stops at the wage ceiling (§15)', () => {
  const covered = computeEsi({ monthlyGross: 18000, applicable: true });
  assert.equal(covered.employee, 135);
  assert.equal(covered.employer, 585);

  const outside = computeEsi({ monthlyGross: 25000, applicable: true });
  assert.equal(outside.outsideCeiling, true);
  assert.equal(outside.employee, 0);
});

test('professional tax follows the state table (§15)', () => {
  assert.equal(computeProfessionalTax({ monthlyGross: 30000, state: 'Karnataka', applicable: true }).amount, 200);
  assert.equal(computeProfessionalTax({ monthlyGross: 20000, state: 'Karnataka', applicable: true }).amount, 0);
  assert.equal(computeProfessionalTax({ monthlyGross: 30000, state: 'Delhi', applicable: true }).amount, 0);
  assert.equal(computeProfessionalTax({ monthlyGross: 30000, state: 'Nowhere', applicable: true }).amount, 200);
  assert.equal(computeProfessionalTax({ monthlyGross: 30000, applicable: false }).amount, 0);
});

test('gratuity is an employer contribution only (§16)', () => {
  const gratuity = computeGratuity({ monthlyBasic: 25000, applicable: true });
  assert.equal(gratuity.amount, round(25000 * STATUTORY_RULES.GRATUITY.rate));
  assert.equal(computeGratuity({ monthlyBasic: 25000, applicable: false }).amount, 0);
});

test('TDS is annualised, regime-aware and spread over the months left (§15)', () => {
  const newRegime = computeMonthlyTds({
    monthlyTaxable: 100000,
    regime: 'NEW',
    monthsRemaining: 6,
    tdsPaidThisYear: 0,
    applicable: true,
  });
  // 12,00,000 − 75,000 standard deduction = 11,25,000 → 87A rebate → nil.
  assert.equal(newRegime.annualTax, 0);
  assert.equal(newRegime.monthly, 0);

  const oldRegime = computeMonthlyTds({
    monthlyTaxable: 100000,
    regime: 'OLD',
    monthsRemaining: 6,
    tdsPaidThisYear: 0,
    applicable: true,
  });
  // 12,00,000 − 50,000 = 11,50,000 → old slabs, no rebate above 5L.
  assert.ok(oldRegime.annualTax > 0);
  assert.equal(oldRegime.monthly, round(oldRegime.annualTax / 6));

  const withPaid = computeMonthlyTds({
    monthlyTaxable: 100000,
    regime: 'OLD',
    monthsRemaining: 6,
    tdsPaidThisYear: oldRegime.annualTax / 2,
    applicable: true,
  });
  assert.ok(withPaid.monthly < oldRegime.monthly);

  assert.equal(computeMonthlyTds({ monthlyTaxable: 100000, applicable: false }).monthly, 0);
});

test('slab tax is progressive, not flat', () => {
  const slabs = STATUTORY_RULES.TDS.slabs.OLD;
  // 6,00,000 → 2.5–5L at 5% = 12,500; 5–10L at 20% on 1,00,000 = 20,000
  assert.equal(taxFromSlabs(600000, slabs), 32500);
  assert.equal(taxFromSlabs(200000, slabs), 0);
});

// ── 2. monthly inputs are consumed, not re-derived (§13 / §14 / §16) ───────

test('bonus, approved claims and deductions are split; rejected claims are dropped', () => {
  const { variableEarnings, reimbursements, deductions } = splitMonthlyEntries([
    { type: 'BONUS_FESTIVAL', amount: 2000, reason: 'Diwali' },
    { type: 'REIMBURSEMENT_TRAVEL', amount: 500, claimStatus: 'APPROVED' },
    { type: 'REIMBURSEMENT_FOOD', amount: 300, claimStatus: 'REJECTED' },
    { type: 'DEDUCTION_FINE', amount: 100, reason: 'Late' },
  ]);

  assert.equal(variableEarnings.length, 1);
  assert.equal(reimbursements.length, 1);
  assert.equal(reimbursements[0].amount, 500);
  assert.equal(deductions.length, 1);
});

test('a statutory component code is recognised whatever the casing', () => {
  assert.equal(statutoryKindOf('pf'), 'PF');
  assert.equal(statutoryKindOf('PROVIDENT_FUND'), 'PF');
  assert.equal(statutoryKindOf('professional-tax'), 'PT');
  assert.equal(statutoryKindOf('Other', 'Income Tax'), 'TDS');
  assert.equal(statutoryKindOf('SPECIAL'), null);
});

// ── 3. the pipeline (§8 / §17) ─────────────────────────────────────────────

test('the engine stores every intermediate value, not just the net (§17)', () => {
  const result = calculateEmployeePayroll({
    month: MONTH,
    employee: { _id: 'employee-1', name: 'Asha Rao', employeeCode: 'EMP001', status: 'ACTIVE' },
    profile: {
      monthlyGross: 50000,
      structureId: 'structure-1',
      statutory: { pfMember: true, esiNumber: 'x', gratuityEligible: true },
      tax: { regime: 'NEW', tdsApplicable: true },
    },
    structurePreview: PREVIEW,
    auto: { workingDays: 22, lopDays: 2, otHours: 5 },
    entries: [
      { type: 'BONUS_PERFORMANCE', amount: 5000, reason: 'Q2' },
      { type: 'REIMBURSEMENT_TRAVEL', amount: 1200, claimStatus: 'APPROVED' },
      { type: 'DEDUCTION_LOAN_EMI', amount: 3000, reason: 'EMI' },
    ],
    setup: SETUP,
    monthsRemaining: 7,
  });

  assert.equal(result.totals.gross, 50000);
  assert.equal(result.totals.variableEarnings, 5000);
  assert.equal(result.totals.reimbursements, 1200);
  assert.equal(result.totals.overtime, result.overtime.amount);
  assert.equal(result.totals.totalEarnings, round(50000 + 5000 + result.overtime.amount));
  assert.equal(
    result.totals.netPay,
    round(result.totals.totalEarnings + 1200 - result.totals.totalDeductions),
  );
  // Employer contributions never reduce net salary (§16).
  assert.ok(result.totals.employerCost > 0);
  assert.ok(result.employerContributions.every((line) => line.amount >= 0));

  // Every deduction carries a name, an amount and a source (§15).
  assert.ok(result.deductions.length >= 4);
  result.deductions.forEach((line) => {
    assert.ok(line.name && line.source);
  });
  assert.ok(result.deductions.some((line) => line.code === 'LOP'));
});

test('attendance shows working, paid, LOP and OT (§18 / §24)', () => {
  const result = calculateEmployeePayroll({
    month: MONTH,
    employee: { _id: 'e1', status: 'ACTIVE' },
    profile: { monthlyGross: 50000, statutory: {}, tax: {} },
    structurePreview: PREVIEW,
    auto: { workingDays: 22, presentDays: 20, lopDays: 2, otHours: 6 },
    entries: [],
    setup: SETUP,
  });

  assert.equal(result.attendance.workingDays, 22);
  assert.equal(result.attendance.paidDays, 20);
  assert.equal(result.attendance.lopDays, 2);
  assert.equal(result.attendance.otHours, 6);
});

// ── 4. pre-checks (§6 / §29) ───────────────────────────────────────────────

test('company pre-checks refuse an inactive setup, a missing bank and an unlocked month', () => {
  assert.deepEqual(precheckCompany({ setup: SETUP, period: { status: 'LOCKED' } }), []);

  const unlocked = precheckCompany({ setup: SETUP, period: { status: 'COLLECTING_INPUTS' } });
  assert.ok(unlocked.some((message) => /not locked/i.test(message)));

  const noBank = precheckCompany({
    setup: { ...SETUP, bankAccount: { accountNumberLast4: '' } },
    period: { status: 'LOCKED' },
  });
  assert.ok(noBank.some((message) => /bank/i.test(message)));

  const inactive = precheckCompany({ setup: { ...SETUP, status: 'DRAFT' } });
  assert.ok(inactive.some((message) => /activate/i.test(message)));

  assert.ok(precheckCompany({ setup: null }).length > 0);
});

test('employee pre-checks name the reason instead of silently skipping (§22)', () => {
  assert.deepEqual(
    precheckEmployee({
      employee: { status: 'ACTIVE' },
      profile: { payrollStatus: 'ACTIVE', structureId: 's1', monthlyGross: 50000 },
      structure: { status: 'ACTIVE' },
      monthlyGross: 50000,
    }),
    [],
  );

  const missing = precheckEmployee({ employee: null, profile: null });
  assert.ok(missing.some((message) => /profile/i.test(message)));

  const draftProfile = precheckEmployee({
    employee: { status: 'ACTIVE' },
    profile: { payrollStatus: 'DRAFT', structureId: 's1', monthlyGross: 50000 },
    structure: { status: 'ACTIVE' },
  });
  assert.ok(draftProfile.some((message) => /draft/i.test(message)));

  const noStructure = precheckEmployee({
    employee: { status: 'ACTIVE' },
    profile: { payrollStatus: 'ACTIVE', structureId: null, monthlyGross: 0 },
  });
  assert.ok(noStructure.some((message) => /structure/i.test(message)));
});

// ── 5. the run (§5 / §20 / §22 / §26 / §27) ────────────────────────────────

test('a run calculates every active employee, skips the inactive one and reports progress', async () => {
  const { service, ResultModel, auditRows } = makeHarness();

  const { run } = await service.startRun({ companyId: COMPANY, month: MONTH, actor });

  assert.equal(run.status, 'CALCULATED');
  assert.equal(run.progress.total, 2); // employee-3 is INACTIVE
  assert.equal(run.progress.processed, 2);
  assert.equal(run.progress.percent, 100);
  assert.equal(run.summary.calculated, 2);
  assert.equal(run.summary.errors, 0);
  assert.ok(run.summary.netPayroll > 0);
  assert.ok(run.summary.employerCost > 0);
  assert.equal(ResultModel.rows.length, 2);
  assert.ok(auditRows.some((row) => row.action === 'PAYROLL_RUN_STARTED'));
  assert.ok(auditRows.some((row) => row.action === 'PAYROLL_RUN_COMPLETED'));
});

test('an employee with no profile becomes an ERROR row and never stops the run', async () => {
  const { service, ResultModel } = makeHarness({
    profiles: [
      {
        companyId: COMPANY,
        employeeId: 'employee-1',
        isCurrent: true,
        payrollStatus: 'ACTIVE',
        structureId: 'structure-1',
        monthlyGross: 50000,
        statutory: {},
        tax: {},
      },
    ],
  });

  const { run } = await service.startRun({ companyId: COMPANY, month: MONTH, actor });

  assert.equal(run.summary.calculated, 1);
  assert.equal(run.summary.errors, 1);
  assert.equal(ResultModel.rows.length, 2);
  const errorRow = ResultModel.rows.find((row) => row.status === 'ERROR');
  assert.ok(errorRow.issues.length > 0);
});

test('a run refuses to start when the company pre-checks fail (§6)', async () => {
  const { service, RunModel } = makeHarness({ setup: { ...SETUP, status: 'DRAFT' } });

  await assert.rejects(
    () => service.startRun({ companyId: COMPANY, month: MONTH, actor }),
    (error) => error.statusCode === 400,
  );
  assert.equal(RunModel.rows.length, 0);
});

test('recalculation writes a NEW snapshot version and leaves the old one alone (§19 / §21)', async () => {
  const { service, ResultModel } = makeHarness();

  await service.startRun({ companyId: COMPANY, month: MONTH, actor });
  const first = ResultModel.rows.find(
    (row) => String(row.employeeId) === 'employee-1' && row.version === 1,
  );
  const firstNet = first.totals.netPay;

  const outcome = await service.recalculate({ companyId: COMPANY, month: MONTH, actor });

  assert.equal(outcome.version, 2);
  const versions = ResultModel.rows.filter((row) => String(row.employeeId) === 'employee-1');
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((row) => row.isCurrent).length, 1);
  // The first snapshot is untouched — history is immutable.
  assert.equal(versions.find((row) => row.version === 1).totals.netPay, firstNet);
  assert.equal(versions.find((row) => row.version === 2).isCurrent, true);
});

test('recalculating one employee touches only that employee (§21)', async () => {
  const { service, ResultModel } = makeHarness();
  await service.startRun({ companyId: COMPANY, month: MONTH, actor });

  await service.recalculate({
    companyId: COMPANY,
    month: MONTH,
    actor,
    employeeIds: ['employee-1'],
  });

  const v2 = ResultModel.rows.filter((row) => row.version === 2);
  assert.equal(v2.length, 1);
  assert.equal(String(v2[0].employeeId), 'employee-1');
});

test('the queue payload carries references only (§26)', async () => {
  const { service, dispatched } = makeHarness();
  await service.startRun({ companyId: COMPANY, month: MONTH, actor });

  assert.equal(dispatched.length, 1);
  const payload = dispatched[0];
  assert.equal(payload.companyId, COMPANY);
  assert.equal(payload.month, MONTH);
  assert.ok(payload.runId);
  assert.equal(payload.employeeIds, null);
  // No salary figures, no PII travel through Redis.
  const serialized = JSON.stringify(payload);
  assert.equal(/50000|Asha|netPay/i.test(serialized), false);

  const { valid } = validatePayrollRunPayload({
    ...payload,
    requestedAt: new Date().toISOString(),
  });
  assert.equal(valid, true);
  assert.equal(
    validatePayrollRunPayload({ ...payload, month: 'August 2026' }).valid,
    false,
  );
  assert.equal(QUEUE_NAMES.PAYROLL, 'payroll');
  assert.equal(JOB_NAMES.PAYROLL_RUN, 'payroll-run');
});

test('the dashboard summary is served from the cache seam (§25)', async () => {
  const { service } = makeHarness();
  await service.startRun({ companyId: COMPANY, month: MONTH, actor });

  const { summary } = await service.getRunSummary({ companyId: COMPANY, month: MONTH });
  assert.equal(summary.calculated, 2);
  assert.ok(summary.grossPayroll > 0);
});

test('results can be narrowed to a payroll scope, never widened (§3 / §30)', async () => {
  const { service } = makeHarness();
  await service.startRun({ companyId: COMPANY, month: MONTH, actor });

  const all = await service.listResults({ companyId: COMPANY, month: MONTH });
  assert.equal(all.length, 2);

  const scoped = await service.listResults({
    companyId: COMPANY,
    month: MONTH,
    allowedEmployeeIds: ['employee-2'],
  });
  assert.equal(scoped.length, 1);
  assert.equal(String(scoped[0].employeeId), 'employee-2');
});

test('cancelling a run is audited (§28)', async () => {
  const { service, auditRows } = makeHarness();
  await service.startRun({ companyId: COMPANY, month: MONTH, actor });

  const run = await service.cancelRun({ companyId: COMPANY, month: MONTH, actor });
  assert.ok(run.cancelledAt);
  assert.ok(auditRows.some((row) => row.action === 'PAYROLL_RUN_CANCELLED'));
});

test('run statuses follow §20', () => {
  assert.deepEqual(PAYROLL_RUN_STATUSES, [
    'DRAFT',
    'CALCULATING',
    'CALCULATED',
    'ERROR',
    'RECALCULATED',
  ]);
});

test('the KPI summary counts errors and money separately (§23)', () => {
  const summary = summarizeRun([
    { status: 'CALCULATED', totals: { totalEarnings: 50000, netPay: 42000, employerCost: 6000, reimbursements: 1000, totalDeductions: 8000, ctc: 56000 } },
    { status: 'CALCULATED', totals: { totalEarnings: 40000, netPay: 36000, employerCost: 4800, reimbursements: 0, totalDeductions: 4000, ctc: 44800 } },
    { status: 'ERROR' },
  ]);

  assert.equal(summary.totalEmployees, 3);
  assert.equal(summary.calculated, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.grossPayroll, 90000);
  assert.equal(summary.netPayroll, 78000);
  assert.equal(summary.employerCost, 10800);
});

// ── 6. permissions, fences and conventions (§4 / §30 / §31) ────────────────

test('payroll-run permissions follow §4 — never role names', () => {
  const perms = new Set(DEFAULT_PERMISSIONS.map((row) => row.name));
  ['PAYROLL_RUN_READ', 'PAYROLL_RUN_EXECUTE', 'PAYROLL_RUN_RECALCULATE'].forEach((name) => {
    assert.ok(perms.has(name), `${name} must exist in the catalogue`);
  });

  const has = (role, name) => (DEFAULT_ROLE_MATRIX[role] || []).includes(name);

  assert.ok(has('COMPANY_ADMIN', 'PAYROLL_RUN_EXECUTE'));
  assert.ok(has('COMPANY_ADMIN', 'PAYROLL_RUN_RECALCULATE'));

  // §4 — HR Manager runs payroll; §21 — only Payroll Admin / Company Admin
  // may recalculate.
  assert.ok(has('HR_MANAGER', 'PAYROLL_RUN_READ'));
  assert.ok(has('HR_MANAGER', 'PAYROLL_RUN_EXECUTE'));
  assert.equal(has('HR_MANAGER', 'PAYROLL_RUN_RECALCULATE'), false);

  // §4 — employees never see payroll calculations.
  ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE'].forEach((role) => {
    assert.equal(has(role, 'PAYROLL_RUN_READ'), false, `${role} must not read payroll runs`);
  });

  const template = ROLE_TEMPLATES.find((row) => row.key === 'PAYROLL_ADMIN');
  assert.ok(template.permissions.includes('PAYROLL_RUN_EXECUTE'));
  assert.ok(template.permissions.includes('PAYROLL_RUN_RECALCULATE'));

  const finance = ROLE_TEMPLATES.find((row) => row.key === 'FINANCE_MANAGER');
  assert.ok(finance.permissions.includes('PAYROLL_RUN_READ'));
  assert.equal(finance.permissions.includes('PAYROLL_RUN_EXECUTE'), false);
});

// ── helpers ────────────────────────────────────────────────────────────────

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
