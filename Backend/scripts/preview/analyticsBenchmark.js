#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.13 — PAYROLL ANALYTICS BENCHMARK (§29 / §44)
//
//      cd Backend && npm run analytics:benchmark
//      cd Backend && MONGO_URI=mongodb://localhost:27017/crewly npm run analytics:benchmark
//
//  WHY THIS EXISTS
//
//  29.13 moved the dashboard's arithmetic into MongoDB. A claim like "it
//  scales to ten thousand employees" is worth exactly as much as the evidence
//  behind it, so this script produces the evidence: it builds a company of
//  1,000 and then 10,000 people over twelve months — up to 120,000 payroll
//  snapshots — and times the reads.
//
//  WITH A DATABASE (MONGO_URI reachable) it measures the real thing: the
//  aggregation path against the row path, over a real collection with the
//  29.13 indexes.
//
//  WITHOUT ONE it still runs, over in-memory fakes, and says so loudly. Those
//  numbers measure Node's own cost with no I/O and no index — useful for
//  seeing the row loader walk off a cliff, meaningless as a prediction.
// ═══════════════════════════════════════════════════════════════════════════

import { performance } from 'node:perf_hooks';

import { makeAnalyticsService } from '../src/services/payroll/analyticsService.js';
import { runPipeline } from '../test/helpers/fakeAggregate.js';

const SIZES = [1000, 10000];
const MONTHS = 12;
const YEAR = 2026;

const MONTH_KEYS = Array.from({ length: MONTHS }, (_, index) =>
  `${YEAR}-${String(index + 1).padStart(2, '0')}`,
);

// ── the dataset ────────────────────────────────────────────────────────────

const makeSnapshot = (companyId, employeeId, month, seed) => {
  const gross = 25000 + (seed % 40) * 1750;
  const basic = Math.round(gross * 0.5);
  const pf = Math.min(1800, Math.round(basic * 0.12));
  const tds = Math.round(gross * 0.06);
  const overtime = seed % 5 === 0 ? Math.round((gross / 240) * 8) : 0;
  const variable = seed % 3 === 0 ? 5000 : 0;

  return {
    companyId,
    employeeId: String(employeeId),
    month,
    isCurrent: true,
    status: 'CALCULATED',
    departmentId: `dept-${seed % 8}`,
    designation: seed % 2 ? 'Engineer' : 'Executive',
    structureId: `structure-${seed % 3}`,
    totals: {
      gross,
      basic,
      totalEarnings: gross + overtime + variable,
      totalDeductions: pf + 200 + tds + 20,
      employerCost: pf + 40 + Math.round(basic * 0.0481),
      ctc: gross + overtime + variable + pf + 40,
      netPay: gross + overtime + variable - (pf + 200 + tds + 20),
      overtime,
      variableEarnings: variable,
      reimbursements: 0,
    },
    variableEarnings: variable ? [{ type: 'BONUS_PERFORMANCE', label: 'Performance Bonus', amount: variable }] : [],
    earnings: [
      { code: 'BASIC', name: 'Basic', amount: basic },
      { code: 'HRA', name: 'House Rent Allowance', amount: Math.round(basic * 0.4) },
      { code: 'SPECIAL_ALLOWANCE', name: 'Special Allowance', amount: gross - basic - Math.round(basic * 0.4) },
    ],
    deductions: [
      { code: 'PF', name: 'Provident Fund', amount: pf },
      { code: 'PROFESSIONAL_TAX', name: 'Professional Tax', amount: 200 },
      { code: 'TDS', name: 'Income Tax (TDS)', amount: tds },
      { code: 'LWF', name: 'Labour Welfare Fund', amount: 20 },
    ],
    employerContributions: [
      { code: 'PF_EMPLOYER', name: 'Employer PF', amount: pf },
      { code: 'LWF_EMPLOYER', name: 'Employer LWF', amount: 40 },
      { code: 'GRATUITY', name: 'Gratuity', amount: Math.round(basic * 0.0481) },
    ],
    attendance: { workingDays: 30, paidDays: 30, lopDays: 0, paidLeaveDays: 1, otHours: overtime ? 8 : 0 },
    statutory: {
      pf: { applicable: true, employee: pf, employer: pf },
      esi: { applicable: false, employee: 0, employer: 0 },
      professionalTax: { applicable: true, amount: 200 },
      tds: { applicable: true, monthly: tds },
      lwf: { applicable: true, employee: 20, employer: 40 },
      gratuity: { applicable: true, amount: Math.round(basic * 0.0481) },
    },
  };
};

// ── the in-memory store (used when there is no database) ───────────────────

const pathValue = (row, key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), row);

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = pathValue(row, key);
    if (condition && typeof condition === 'object' && !(condition instanceof Date) && !Array.isArray(condition)) {
      if (condition.$in) return condition.$in.some((item) => String(item) === String(value));
      if (condition.$gte !== undefined && !(String(value) >= String(condition.$gte))) return false;
      if (condition.$lte !== undefined && !(String(value) <= String(condition.$lte))) return false;
      return String(value) === String(condition);
    }
    return String(value) === String(condition);
  });

const fakeModel = () => {
  const rows = [];
  const buildQuery = (filter, sortSpec = null) => {
    const collect = () => {
      const found = rows.filter((row) => matches(row, filter));
      if (sortSpec) {
        const [field, direction] = Object.entries(sortSpec)[0] || [];
        if (field) {
          found.sort((a, b) => {
            const compared = String(a[field]).localeCompare(String(b[field]));
            return Number(direction) < 0 ? -compared : compared;
          });
        }
      }
      return found;
    };
    const query = {
      lean: async () => collect(),
      select: () => query,
      sort: (spec) => buildQuery(filter, spec),
      limit: (count) => ({ lean: async () => collect().slice(0, count) }),
      then: (resolve, reject) => Promise.resolve().then(collect).then(resolve, reject),
      catch: (reject) => query.then(undefined, reject),
    };
    return query;
  };

  return {
    rows,
    find: (filter = {}) => buildQuery(filter),
    findOne: (filter = {}) => {
      const collect = async () => rows.find((row) => matches(row, filter)) || null;
      const query = { lean: collect, select: () => query, sort: () => query, then: (resolve, reject) => collect().then(resolve, reject), catch: (reject) => query.then(undefined, reject) };
      return query;
    },
    countDocuments: async (filter = {}) => rows.filter((row) => matches(row, filter)).length,
    aggregate: async (pipeline = []) => runPipeline(rows, pipeline),
    create: async (doc) => { rows.push({ _id: `id-${rows.length}`, ...doc }); return rows[rows.length - 1]; },
  };
};

// ── timing ─────────────────────────────────────────────────────────────────

const time = async (label, run) => {
  const started = performance.now();
  const value = await run();
  const elapsed = performance.now() - started;
  return { label, ms: Math.round(elapsed), value };
};

const buildService = ({ models }) =>
  makeAnalyticsService({
    PayrollResultModel: models.results,
    PayrollPaymentModel: models.payments,
    FinalSettlementModel: models.settlements,
    ResignationModel: models.resignations,
    UserModel: models.users,
    DepartmentModel: models.departments,
    CompanyModel: models.companies,
    ScheduledReportModel: models.schedules,
    AnalyticsReportFileModel: models.files,
    EmployeePayrollProfileModel: models.profiles,
    AnalyticsSettingModel: models.settings,

    cache: {
      buildKey: ({ companyId, month = '', suffix = 'dashboard', period = '', filters = null }) =>
        `k:${companyId}:${month}:${suffix}:${period}:${JSON.stringify(filters || {})}`,
      getOrSet: async (key, { loader }) => {
        const value = await loader();
        return { value, cache: 'MISS' };
      },
      invalidate: async () => 0,
    },

    audit: async () => null,
    notify: async () => null,
    notifyRoles: async () => 0,
    dispatchExport: async () => ({ queued: true }),
    dispatchSchedule: async () => ({ queued: true }),
    dispatchRefresh: async () => ({ queued: false }),
    renderPdf: async () => Buffer.from(''),
    buildCsv: () => '',
    buildWorkbook: () => Buffer.from(''),
    hash: () => 'sha256',
    trendMonths: 12,
  });

const main = async () => {
  console.log('\nCREWLY — PAYROLL ANALYTICS BENCHMARK (§29 / §44)');
  console.log('='.repeat(72));

  // ── is there a database? ──
  let real = null;
  try {
    const mongoose = (await import('mongoose')).default;
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 2500 });
    const [{ default: PayrollResult }, { default: PayrollPayment }, { default: FinalSettlement },
      { default: Resignation }, { default: User }, { default: Department }, { default: Company },
      { default: ScheduledReport }, { default: AnalyticsReportFile }, { default: EmployeePayrollProfile },
      { default: PayrollAnalyticsSetting }] = await Promise.all([
      import('../src/models/PayrollResult.js'),
      import('../src/models/PayrollPayment.js'),
      import('../src/models/FinalSettlement.js'),
      import('../src/models/Resignation.js'),
      import('../src/models/User.js'),
      import('../src/models/Department.js'),
      import('../src/models/Company.js'),
      import('../src/models/ScheduledReport.js'),
      import('../src/models/AnalyticsReportFile.js'),
      import('../src/models/EmployeePayrollProfile.js'),
      import('../src/models/PayrollAnalyticsSetting.js'),
    ]);
    real = {
      mongoose,
      models: {
        results: PayrollResult, payments: PayrollPayment, settlements: FinalSettlement,
        resignations: Resignation, users: User, departments: Department, companies: Company,
        schedules: ScheduledReport, files: AnalyticsReportFile, profiles: EmployeePayrollProfile,
        settings: PayrollAnalyticsSetting,
      },
    };
    console.log('\nDatabase: CONNECTED — real collections, real indexes, real aggregation.');
  } catch {
    console.log('\nDatabase: NOT REACHABLE — running over in-memory fakes.');
    console.log('          The numbers below measure Node only: no I/O, no index, no BSON.');
    console.log('          They show the row loader scaling; they do not predict the database.');
    console.log('          Set MONGO_URI and re-run for the real comparison.');
  }

  for (const employees of SIZES) {
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`${employees.toLocaleString('en-IN')} employees × ${MONTHS} months = ${(employees * MONTHS).toLocaleString('en-IN')} snapshots`);
    console.log('─'.repeat(72));

    const companyId = real ? new real.mongoose.Types.ObjectId() : `bench-${employees}`;

    const models = real
      ? real.models
      : {
        results: fakeModel(), payments: fakeModel(), settlements: fakeModel(),
        resignations: fakeModel(), users: fakeModel(), departments: fakeModel(),
        companies: fakeModel(), schedules: fakeModel(), files: fakeModel(),
        profiles: fakeModel(), settings: fakeModel(),
      };

    // ── seed ──
    const started = performance.now();
    const batches = [];
    const BATCH = 5000;
    let written = 0;

    // A payment for every snapshot, because the row path filters on payment
    // status. Without them the two routes would be compared over different
    // row sets and the "same gross either way" check below would be measuring
    // nothing.
    const paymentRows = [];
    for (let employee = 0; employee < employees; employee += 1) {
      const employeeId = `${companyId}-e${employee}`;
      MONTH_KEYS.forEach((month) => {
        paymentRows.push({
          companyId, month, employeeId, status: 'PAID',
          paidAt: new Date(`${month}-28T00:00:00Z`), paymentReference: `NEFT-${employee}-${month}`,
        });
      });
    }

    if (!real) {
      for (let employee = 0; employee < employees; employee += 1) {
        const employeeId = `${companyId}-e${employee}`;
        models.users.rows.push({ _id: employeeId, companyId, employeeCode: `E${employee}`, name: `Employee ${employee}`, department: `dept-${employee % 8}`, designation: employee % 2 ? 'Engineer' : 'Executive', status: 'ACTIVE', dateOfJoining: new Date('2020-01-01T00:00:00Z') });
        MONTH_KEYS.forEach((month) => models.results.rows.push(makeSnapshot(companyId, employeeId, month, employee)));
        written += MONTH_KEYS.length;
      }
      paymentRows.forEach((row) => models.payments.rows.push(row));
    } else {
      const documents = [];
      for (let employee = 0; employee < employees; employee += 1) {
        const employeeId = `${companyId}-e${employee}`;
        MONTH_KEYS.forEach((month) => documents.push(makeSnapshot(companyId, employeeId, month, employee)));
      }
      for (let index = 0; index < documents.length; index += BATCH) {
        await real.models.results.insertMany(documents.slice(index, index + BATCH), { ordered: false });
        written += Math.min(BATCH, documents.length - index);
      }
      for (let index = 0; index < paymentRows.length; index += BATCH) {
        await real.models.payments.insertMany(paymentRows.slice(index, index + BATCH), { ordered: false });
      }
      await real.models.users.insertMany(
        Array.from({ length: employees }, (_, employee) => ({
          companyId,
          employeeCode: `E${employee}`,
          name: `Employee ${employee}`,
          department: `dept-${employee % 8}`,
          status: 'ACTIVE',
          dateOfJoining: new Date('2020-01-01T00:00:00Z'),
        })),
        { ordered: false },
      ).catch(() => null);
    }

    console.log(`Seeded ${written.toLocaleString('en-IN')} snapshots in ${Math.round(performance.now() - started)} ms`);

    const service = buildService({ models });

    // ── the reads ──
    const month = MONTH_KEYS[MONTHS - 1];

    const oneMonth = await time('Dashboard · one month (aggregation)', () =>
      service.getDashboard({ companyId, month }));

    const oneYear = await time('Dashboard · LAST_12_MONTHS (aggregation)', () =>
      service.getDashboard({ companyId, month, preset: 'LAST_12_MONTHS' }));

    const rowPath = await time('Dashboard · one month (row loader)', () =>
      service.getDashboard({ companyId, month, filters: { status: 'PAID' } }));

    const register = await time('Register · page 1 of 50', () =>
      service.getReport({ companyId, reportKey: 'REGISTER', month, page: 1, limit: 50 }));

    const variance = await time('Variance report · 12 months', () =>
      service.getReport({ companyId, reportKey: 'VARIANCE', month, preset: 'LAST_12_MONTHS' }));

    const earnings = await time('Earnings report · one month', () =>
      service.getReport({ companyId, reportKey: 'EARNINGS', month }));

    [
      oneMonth, oneYear, rowPath, register, variance, earnings,
    ].forEach((entry) => console.log(`  ${entry.label.padEnd(42)} ${String(entry.ms).padStart(7)} ms`));

    console.log(`  ${'Route used for the plain dashboard'.padEnd(42)} ${oneMonth.value.source}`);
    console.log(`  ${'Route used with a payment filter'.padEnd(42)} ${rowPath.value.source}`);
    console.log(`  ${'Same gross either way'.padEnd(42)} ${oneMonth.value.kpis.grossSalary === rowPath.value.kpis.grossSalary ? 'yes' : 'NO — CHECK'}`);
    console.log(`  ${'Employees paid (a headcount)'.padEnd(42)} ${oneYear.value.kpis.employeesPaid.toLocaleString('en-IN')} over ${oneYear.value.months.length} months`);
    console.log(`  ${'Register rows on the page'.padEnd(42)} ${(register.value.rows || []).length} of ${register.value.pagination.total.toLocaleString('en-IN')}`);
    console.log(`  ${'Earnings reconciled'.padEnd(42)} ${earnings.value.totals.reconciled ? 'yes' : 'NO — CHECK'}`);

    if (real) {
      await real.models.results.deleteMany({ companyId }).catch(() => null);
      await real.models.payments.deleteMany({ companyId }).catch(() => null);
      await real.models.users.deleteMany({ companyId }).catch(() => null);
    }
  }

  console.log('\nRead the two "Route used" lines first. If the plain dashboard says');
  console.log('ROWS rather than AGGREGATION, the fast path is not being taken and');
  console.log('every other number here is measured on the wrong thing.\n');

  if (real) await real.mongoose.disconnect().catch(() => null);
};

main().catch((error) => {
  console.error('\nBenchmark failed:', error);
  process.exit(1);
});
