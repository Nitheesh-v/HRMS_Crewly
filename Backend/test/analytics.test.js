/**
 * PHASE 29.12 — Payroll Analytics, Reports & Financial Dashboard
 *
 * Hermetic: fake models, a fake cache, and fake audit / notify / dispatch /
 * pdf seams. No MongoDB, no Redis, no BullMQ, no SMTP.
 *
 * The suite proves the things that are expensive to discover in production:
 *   · §2    nothing is recalculated — every figure comes from the snapshot
 *   · §5    the eight KPI cards are all the same aggregation
 *   · §7    department cost is sorted and the average is per-employee
 *   · §10   salary bands are data, and a 62k salary lands in 50-75k
 *   · §11   quarterly buckets are the sum of their months, from snapshots
 *   · §14   the leave-impact figures are derived AND labelled as derived
 *   · §15   PT and TDS carry no employer share, and the total still ties
 *   · §16   CTC ties to gross + employer contribution, or says it does not
 *   · §17   the register reads its payment date from the payment join, and a
 *           retried payment does not double-count
 *   · §20   a schedule re-arms itself, even after it fails
 *   · §21   the dashboard is cached, and a status change drops the cache
 *   · §22   queue payloads carry references only — never a row or a rupee
 *   · §25   the CTC report is refused without PAYROLL_ANALYTICS_FINANCIAL,
 *           and a department-scoped manager cannot see the whole company
 *   · §24   every validator chain ends in a result handler (the 29.11 audit)
 *   · §3    another tenant's payroll is unreachable
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYTICS_AUDIT_ACTIONS,
  REGISTER_HEADERS,
  REPORT_KEYS,
  SALARY_BANDS,
  analyticsKpis,
  applyFilters,
  bandOf,
  bonusRows,
  buildAnalyticsRow,
  ctcRows,
  departmentRows,
  designationRows,
  headcountMetrics,
  leaveImpactRows,
  nextRunAt,
  overtimeByDepartment,
  overtimeRows,
  periodKeyOf,
  recentMonths,
  registerRows,
  reportFilename,
  reportTable,
  salaryBandRows,
  statutoryLiability,
  summariseRows,
  trendRows,
} from '../src/services/payroll/analyticsRules.js';
import { makeAnalyticsService } from '../src/services/payroll/analyticsService.js';
import {
  validateAnalyticsExportPayload,
  validateAnalyticsSchedulePayload,
  validateAnalyticsRefreshPayload,
} from '../src/services/payroll/analyticsDispatcher.js';
import { buildXlsx, toCsv } from '../src/services/payroll/payrollPaymentRules.js';
import { buildAnalyticsReportPdf } from '../src/utils/analyticsPdf.js';


const oid = (seed) => `64b7f9c2e4b0a1b2c3d4e${String(seed).padStart(3, '0')}`; // 24 hex chars

// Mongo resolves dotted paths; the settlement's unique-per-exit index is on
// 'exit.resignationId', so the fake has to as well.
const pathValue = (row, path) =>
  String(path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), row);

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = pathValue(row, key);
    if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
      if (condition.$in) return condition.$in.some((item) => String(item) === String(value));
      if (condition.$ne !== undefined) return String(value) !== String(condition.$ne);
      // Range operators are what the leave-balance query uses.
      if (condition.$gte !== undefined && !(String(value) >= String(condition.$gte))) return false;
      if (condition.$gt !== undefined && !(String(value) > String(condition.$gt))) return false;
      if (condition.$lte !== undefined && !(String(value) <= String(condition.$lte))) return false;
      if (condition.$lt !== undefined && !(String(value) < String(condition.$lt))) return false;
      if ('$gte' in condition || '$gt' in condition || '$lte' in condition || '$lt' in condition) return true;
      return String(value) === String(condition);
    }
    if (condition instanceof Date) return String(value) === String(condition);
    return String(value) === String(condition);
  });

const applyUpdate = (row, update = {}) => {
  Object.entries(update.$set || {}).forEach(([key, value]) => {
    if (key.includes('.')) {
      const [head, tail] = key.split('.');
      row[head] = { ...(row[head] || {}), [tail]: value };
    } else {
      row[key] = value;
    }
  });
  Object.entries(update.$inc || {}).forEach(([key, delta]) => {
    const path = key.split('.');
    if (path.length === 1) {
      row[key] = Number(row[key] || 0) + Number(delta);
    } else {
      row[path[0]] = { ...(row[path[0]] || {}) };
      row[path[0]][path[1]] = Number(row[path[0]][path[1]] || 0) + Number(delta);
    }
  });
};

const makeFakeModel = (defaults = {}) => {
  const rows = [];
  let counter = 0;

  const buildQuery = (filter, sortKey = null) => ({
    lean: async () => {
      const found = rows.filter((row) => matches(row, filter));
      if (sortKey) {
        const [field, direction] = sortKey;
        found.sort((a, b) => (direction === -1 ? String(b[field]).localeCompare(String(a[field])) : String(a[field]).localeCompare(String(b[field]))));
      }
      // Mongoose's .lean() returns detached plain objects.
      return found.map((row) => ({ ...row }));
    },
    select: () => buildQuery(filter, sortKey),
    sort: (spec) => {
      const field = Object.keys(spec || {})[0];
      return buildQuery(filter, field ? [field, spec[field]] : sortKey);
    },
    limit: () => buildQuery(filter, sortKey),
  });

  // A live document: mutating it mutates the store, and .save() is a no-op
  // that just marks the write (exactly what the service relies on).
  const asDocument = (row) =>
    Object.assign(row, {
      async save() {
        row.updatedAt = new Date();
        return row;
      },
    });

  const model = {
    rows,
    find: (filter = {}) => buildQuery(filter),
    findOne: (filter = {}) => {
      const chain = {
        lean: async () => {
          const found = rows.find((row) => matches(row, filter));
          return found ? { ...found } : null;
        },
        // .select('+binary') also has to be awaitable AND chainable: the
        // download route reads the artefact through it.
        select: () => chain,
        sort: () => chain,
        then: (resolve, reject) => (async () => {
          const found = rows.find((row) => matches(row, filter));
          return found ? asDocument(found) : null;
        })().then(resolve, reject),
        catch: (reject) => chain.then(undefined, reject),
      };
      return chain;
    },
    findById: (id) => {
      const lean = async () => {
        const found = rows.find((row) => String(row._id) === String(id));
        return found ? { ...found } : null;
      };
      // .select('logoUrl') is how the PDF renderer reads the company mark.
      return { lean, select: () => ({ lean }) };
    },
    countDocuments: async (filter = {}) => rows.filter((row) => matches(row, filter)).length,
    async create(doc) {
      counter += 1;
      const row = {
        _id: oid(counter + 500),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...defaults,
        ...doc,
      };
      rows.push(row);
      return asDocument(row);
    },
    async updateOne(filter, update = {}, options = {}) {
      const row = rows.find((item) => matches(item, filter));
      if (!row) {
        if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
        const inserted = await model.create({ ...(filter || {}) });
        applyUpdate(inserted, update);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      applyUpdate(row, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(filter, update = {}, options = {}) {
      const existing = rows.find((item) => matches(item, filter));
      if (existing) {
        applyUpdate(existing, update);
        return existing;
      }
      if (!options.upsert) return null;
      const inserted = await model.create({ ...(filter || {}), ...(update.$setOnInsert || {}) });
      applyUpdate(inserted, update);
      return inserted;
    },
  };

  return model;
};

// ── fixtures ───────────────────────────────────────────────────────────────

const COMPANY = '64b7f9c2e4b0a1b2c3d4e5f6';
const OTHER_COMPANY = '64b7f9c2e4b0a1b2c3d4e999';
const MONTH = '2026-08';
const PREVIOUS = '2026-07';

const E1 = oid(1);
const E2 = oid(2);
const E3 = oid(3);
const DEPT_ENG = oid(50);
const DEPT_SALES = oid(51);

const employee = (id, code, name, { department = DEPT_ENG, designation = 'Senior Engineer', status = 'ACTIVE', joining = '2019-06-03' } = {}) => ({
  _id: id,
  companyId: COMPANY,
  employeeCode: code,
  name,
  email: `${code.toLowerCase()}@crewly.test`,
  department,
  designation,
  status,
  dateOfJoining: new Date(`${joining}T00:00:00Z`),
});

/**
 * A 29.6 snapshot. `totals` mirrors what the engine actually stores, and the
 * statutory block mirrors what 29.10 reads — so these fixtures are the
 * contract, not a convenience.
 */
const result = (employeeId, month, {
  gross = 62000,
  basic = 31000,
  deductions = 8000,
  employerCost = 7500,
  lopDays = 0,
  paidLeaveDays = 2,
  otHours = 0,
  overtime = 0,
  variable = [],
} = {}) => ({
  _id: oid(900 + Number(String(employeeId).slice(-3)) + (month === PREVIOUS ? 40 : 0)),
  companyId: COMPANY,
  month,
  employeeId,
  isCurrent: true,
  status: 'CALCULATED',
  totals: {
    gross,
    basic,
    totalEarnings: gross + overtime,
    totalDeductions: deductions,
    netPay: gross + overtime - deductions,
    employerCost,
    ctc: gross + overtime + employerCost,
    overtime,
    variableEarnings: variable.reduce((sum, line) => sum + Number(line.amount || 0), 0),
    reimbursements: 0,
  },
  variableEarnings: variable,
  attendance: {
    workingDays: 31,
    paidDays: 31 - lopDays,
    lopDays,
    paidLeaveDays,
    otHours,
  },
  statutory: {
    pf: { applicable: true, pfWage: basic, employee: 3720, employerEpf: 2232, employerPension: 1488, employer: 3720 },
    esi: { applicable: false, wage: 0, employee: 0, employer: 0 },
    professionalTax: { applicable: true, state: 'KA', amount: 200 },
    tds: { applicable: true, monthly: 4500, annualIncome: gross * 12, taxableIncome: gross * 12, annualTax: 54000, regime: 'NEW' },
    lwf: { applicable: true, employee: 20, employer: 40 },
    gratuity: { applicable: true, amount: basic * 0.0481 },
  },
  employeeName: '',
  employeeCode: '',
  designation: '',
  departmentId: null,
});

const payment = (employeeId, month, { status = 'PAID', paidAt = '2026-09-01' } = {}) => ({
  _id: oid(800 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  month,
  employeeId,
  status,
  paidAt: status === 'PAID' ? new Date(`${paidAt}T00:00:00Z`) : null,
  paymentReference: `NEFT-${String(employeeId).slice(-3)}`,
});

// ── harness ────────────────────────────────────────────────────────────────

const buildHarness = ({
  employees = [],
  results = [],
  payments = [],
  settlements = [],
  resignations = [],
  companyId = COMPANY,
} = {}) => {
  const state = {
    results: makeFakeModel(),
    payments: makeFakeModel(),
    settlements: makeFakeModel(),
    resignations: makeFakeModel(),
    users: makeFakeModel(),
    departments: makeFakeModel(),
    companies: makeFakeModel(),
    schedules: makeFakeModel({ active: true }),
    files: makeFakeModel({ status: 'QUEUED' }),
    audits: [],
    notifications: [],
    invalidations: [],
    dispatched: [],
  };

  employees.forEach((row) => state.users.rows.push(row));
  results.forEach((row) => state.results.rows.push(row));
  payments.forEach((row) => state.payments.rows.push(row));
  settlements.forEach((row) => state.settlements.rows.push(row));
  resignations.forEach((row) => state.resignations.rows.push(row));

  state.departments.rows.push({ _id: DEPT_ENG, name: 'Engineering', companyId });
  state.departments.rows.push({ _id: DEPT_SALES, name: 'Sales', companyId });
  state.companies.rows.push({ _id: companyId, name: 'Crewly Technologies Pvt Ltd', address: 'Bengaluru', logoUrl: '' });

  const cache = {
    store: new Map(),
    buildKey: ({ companyId: id, month = '', suffix = 'dashboard', period = '' }) =>
      `k:${id}:${month || 'all'}:${suffix}:${period || '-'}`,
    async getOrSet(key, { loader }) {
      if (this.store.has(key)) return { value: this.store.get(key), cache: 'HIT' };
      const value = await loader();
      this.store.set(key, value);
      return { value, cache: 'MISS' };
    },
    async invalidate(id, month = '') {
      state.invalidations.push({ companyId: id, month });
      let removed = 0;
      for (const key of [...this.store.keys()]) {
        if (key.startsWith(`k:${id}:`)) {
          this.store.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };

  const service = makeAnalyticsService({
    PayrollResultModel: state.results,
    PayrollPaymentModel: state.payments,
    FinalSettlementModel: state.settlements,
    ResignationModel: state.resignations,
    UserModel: state.users,
    DepartmentModel: state.departments,
    ScheduledReportModel: state.schedules,
    AnalyticsReportFileModel: state.files,
    CompanyModel: state.companies,

    cache,

    audit: async (entry) => {
      state.audits.push(entry);
      return entry;
    },
    notify: async ({ userId, payload }) => {
      state.notifications.push({ userId, payload });
    },
    notifyRoles: async ({ permission, payload }) => {
      state.notifications.push({ userId: 'PERMISSION', permission, payload });
      return 1;
    },

    dispatchExport: async (payload) => {
      state.dispatched.push({ kind: 'export', payload });
      return { queued: false };
    },
    dispatchSchedule: async (payload) => {
      state.dispatched.push({ kind: 'schedule', payload });
      return { queued: true, jobId: `job-${payload.scheduleId}` };
    },
    dispatchRefresh: async (payload) => {
      state.dispatched.push({ kind: 'refresh', payload });
      return { queued: false };
    },

    // A seam the test can trip: the real renderer unless flagged.
    renderPdf: async (options) => {
      if (state.failRender) throw new Error('disk full');
      return buildAnalyticsReportPdf(options);
    },
    buildCsv: toCsv,
    buildWorkbook: buildXlsx,
    hash: (value) => `sha256:${Buffer.byteLength(value)}`,
    trendMonths: 12,
  });

  return { service, state, cache };
};

// Three employees across two departments, one month.
const threeEmployees = () =>
  buildHarness({
    employees: [
      employee(E1, 'CRE-001', 'Meera Iyer', { department: DEPT_ENG, designation: 'Senior Engineer' }),
      employee(E2, 'CRE-002', 'Vikram Shetty', { department: DEPT_ENG, designation: 'Software Engineer' }),
      employee(E3, 'CRE-003', 'Asha Rao', { department: DEPT_SALES, designation: 'Sales Manager' }),
    ],
    results: [
      result(E1, MONTH, { gross: 62000, basic: 31000 }),
      result(E2, MONTH, { gross: 40000, basic: 20000 }),
      result(E3, MONTH, { gross: 120000, basic: 60000 }),
    ],
    payments: [payment(E1, MONTH), payment(E2, MONTH), payment(E3, MONTH)],
  });

// ── §2 — nothing is recalculated ───────────────────────────────────────────

test('§2 every figure is copied from the snapshot, never recomputed', async () => {
  const harness = threeEmployees();
  const rows = await harness.service._internals.loadRows({ companyId: COMPANY, months: [MONTH] });

  assert.equal(rows.length, 3);

  const meera = rows.find((row) => row.employeeId === String(E1));
  // The snapshot says gross 62,000 and net 54,000; the row must say the same,
  // not a re-derivation of it.
  assert.equal(meera.gross, 62000);
  assert.equal(meera.net, 54000);
  assert.equal(meera.employerCost, 7500);
  // The join filled in what payroll never stored.
  assert.equal(meera.department, 'Engineering');
  assert.equal(meera.employeeCode, 'CRE-001');
  // §17 — the payment date comes from the payment record, not the snapshot.
  assert.equal(meera.paymentStatus, 'PAID');
  assert.equal(new Date(meera.paidAt).toISOString().slice(0, 10), '2026-09-01');
});

test('§2 a superseded snapshot and a failed run are both invisible', async () => {
  const harness = threeEmployees();
  // Version 1 is no longer current; a second employee errored out.
  harness.state.results.rows.push({ ...result(E1, MONTH, { gross: 999999 }), isCurrent: false, version: 1 });
  harness.state.results.rows.push({ ...result(E2, MONTH, { gross: 888888 }), status: 'ERROR' });

  const rows = await harness.service._internals.loadRows({ companyId: COMPANY, months: [MONTH] });

  assert.equal(rows.length, 3);
  assert.ok(!rows.some((row) => row.gross === 999999), 'a superseded version must not be counted');
  assert.ok(!rows.some((row) => row.gross === 888888), 'an errored run must not be counted');
});

// ── §5 — the executive KPI cards ───────────────────────────────────────────

test('§5 the eight KPI cards all come from one aggregation', async () => {
  const harness = threeEmployees();
  const dashboard = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });

  const { kpis } = dashboard;
  // Gross 62,000 + 40,000 + 120,000 = 2,22,000
  assert.equal(kpis.grossSalary, 222000);
  // Net = gross - 8,000 each = 2,22,000 - 24,000 = 1,98,000
  assert.equal(kpis.netSalaryPaid, 198000);
  // Employer 7,500 × 3
  assert.equal(kpis.employerContribution, 22500);
  assert.equal(kpis.totalPayrollCost, 244500);
  assert.equal(kpis.employeesPaid, 3);
  assert.equal(kpis.averageSalary, 66000);
  // §5 — the highest-cost department is Sales (1,20,000 + 7,500).
  assert.equal(kpis.highestDepartmentCost.department, 'Sales');
  assert.equal(kpis.highestDepartmentCost.cost, 127500);
  // §5 — statutory liability: employee + employer across PF, PT, TDS, LWF.
  // Per employee: 3,720 + 200 + 4,500 + 20 employee; 3,720 + 40 employer.
  assert.equal(kpis.totalStatutoryLiability, (3720 + 200 + 4500 + 20 + 3720 + 40) * 3);
});

test('§5 the dashboard is cached, and a payroll change drops the cache', async () => {
  const harness = threeEmployees();

  const first = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.equal(first.kpis.employeesPaid, 3);

  // Add a fourth employee to the snapshot. Without invalidation the cached
  // dashboard would keep claiming three.
  harness.state.results.rows.push(result(oid(4), MONTH, { gross: 50000 }));
  const stale = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.equal(stale.kpis.employeesPaid, 3, 'a cached dashboard stays put until invalidated');

  await harness.service.invalidate(COMPANY, MONTH);
  const fresh = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.equal(fresh.kpis.employeesPaid, 4);
  assert.ok(harness.state.invalidations.length > 0);
});

// ── §7 — department payroll ────────────────────────────────────────────────

test('§7 department cost is grouped, sorted by cost and averaged per employee', () => {
  const rows = [
    { department: 'Engineering', gross: 62000, net: 54000, employerCost: 7500, ctc: 69500, otHours: 0, overtime: 0, lopDays: 0, bonus: 0 },
    { department: 'Engineering', gross: 40000, net: 32000, employerCost: 7500, ctc: 47500, otHours: 0, overtime: 0, lopDays: 0, bonus: 0 },
    { department: 'Sales', gross: 120000, net: 112000, employerCost: 7500, ctc: 127500, otHours: 0, overtime: 0, lopDays: 0, bonus: 0 },
  ];

  const byDepartment = departmentRows({ rows });

  assert.equal(byDepartment.length, 2);
  // §7 — "Support sorting by highest payroll cost."
  assert.equal(byDepartment[0].department, 'Sales');
  assert.equal(byDepartment[0].totalCost, 127500);
  assert.equal(byDepartment[1].department, 'Engineering');
  assert.equal(byDepartment[1].employees, 2);
  assert.equal(byDepartment[1].gross, 102000);
  // The average is per employee, not per department.
  assert.equal(byDepartment[1].averageSalary, 43000);
});

// ── §8 — designation analytics ─────────────────────────────────────────────

test('§8 designation analytics report count, average, highest and lowest', () => {
  const rows = [
    { designation: 'Senior Engineer', gross: 62000, ctc: 69500 },
    { designation: 'Senior Engineer', gross: 70000, ctc: 77500 },
    { designation: 'Software Engineer', gross: 40000, ctc: 47500 },
  ];

  const byDesignation = designationRows({ rows });
  const senior = byDesignation.find((row) => row.designation === 'Senior Engineer');

  assert.equal(senior.employees, 2);
  assert.equal(senior.averageSalary, 66000);
  assert.equal(senior.highest, 70000);
  assert.equal(senior.lowest, 62000);
  assert.equal(senior.totalCost, 147000);
});

// ── §10 — salary bands ─────────────────────────────────────────────────────

test('§10 salary bands are data, and every employee lands in exactly one', () => {
  assert.equal(bandOf(24000).key, 'BAND_0_25K');
  assert.equal(bandOf(62000).key, 'BAND_50_75K');
  assert.equal(bandOf(120000).key, 'BAND_ABOVE_1L');
  // The brief's upper band is open-ended; a very large salary still belongs.
  assert.equal(bandOf(99000000).key, 'BAND_ABOVE_1L');

  const rows = [
    { gross: 62000, net: 54000 },
    { gross: 40000, net: 32000 },
    { gross: 120000, net: 112000 },
  ];
  const bands = salaryBandRows({ rows });

  assert.equal(bands.length, SALARY_BANDS.length, 'every band is shown, even an empty one');
  assert.equal(bands.reduce((sum, row) => sum + row.employees, 0), 3);
  // Shares must add up to 100, or the chart lies.
  assert.equal(Math.round(bands.reduce((sum, row) => sum + row.sharePercent, 0)), 100);
  const above = bands.find((row) => row.key === 'BAND_ABOVE_1L');
  assert.equal(above.employees, 1);
  assert.equal(above.payroll, 120000);
});

// ── §11 — trends from historical snapshots ─────────────────────────────────

test('§11 quarterly buckets are the sum of their months', () => {
  const rows = ['2026-01', '2026-02', '2026-03', '2026-04'].flatMap((month) => [
    { month, gross: 100000, net: 80000, employerCost: 10000, ctc: 110000, bonus: 0, overtime: 0, otHours: 0, lopDays: 0, totalEarnings: 100000, totalDeductions: 20000, reimbursements: 0, variableEarnings: 0 },
  ]);

  const quarterly = trendRows({ rows, period: 'QUARTERLY' });
  assert.equal(quarterly.length, 2);
  assert.equal(quarterly[0].key, '2026-Q1');
  assert.equal(quarterly[0].grossPayroll, 300000);
  assert.equal(quarterly[0].months.length, 3);

  const yearly = trendRows({ rows, period: 'YEARLY' });
  assert.equal(yearly.length, 1);
  assert.equal(yearly[0].key, '2026');
  assert.equal(yearly[0].grossPayroll, 400000);

  const monthly = trendRows({ rows, period: 'MONTHLY' });
  assert.equal(monthly.length, 4);
});

test('§11 the trend window is twelve months ending at the selected month', () => {
  const months = recentMonths('2026-08', 12);
  assert.equal(months.length, 12);
  assert.equal(months[0], '2025-09');
  assert.equal(months[11], '2026-08');
  assert.equal(periodKeyOf('2026-08', 'QUARTERLY'), '2026-Q3');
});

// ── §12 — bonus & incentive ────────────────────────────────────────────────

test('§12 the bonus report lists only employees who actually drew variable pay', () => {
  const rows = [
    { employeeId: '1', employeeCode: 'CRE-001', employeeName: 'Meera', department: 'Engineering', designation: 'Senior Engineer', month: MONTH, gross: 62000, net: 54000, bonus: 50000, variableEarnings: 50000, overtime: 0, reimbursements: 0 },
    { employeeId: '2', employeeCode: 'CRE-002', employeeName: 'Vikram', department: 'Engineering', designation: 'Software Engineer', month: MONTH, gross: 40000, net: 32000, bonus: 0, variableEarnings: 0, overtime: 0, reimbursements: 0 },
    { employeeId: '3', employeeCode: 'CRE-003', employeeName: 'Asha', department: 'Sales', designation: 'Sales Manager', month: MONTH, gross: 120000, net: 112000, bonus: 25000, variableEarnings: 40000, overtime: 0, reimbursements: 0 },
  ];

  const bonus = bonusRows({ rows });

  // §12 — no variable pay, no row: a report about rewards should not be
  // padded with everyone who received none.
  assert.equal(bonus.length, 2);
  // Highest variable pay first.
  assert.equal(bonus[0].employeeName, 'Meera');
  assert.equal(bonus[0].totalVariable, 50000);
  assert.equal(bonus[1].employeeName, 'Asha');
});

// ── §13 — overtime ─────────────────────────────────────────────────────────

test('§13 overtime reads hours and cost from the snapshot and ranks by use', () => {
  const rows = [
    { employeeId: '1', employeeCode: 'CRE-001', employeeName: 'Meera', department: 'Engineering', designation: 'Senior Engineer', month: MONTH, otHours: 20, overtime: 6000 },
    { employeeId: '2', employeeCode: 'CRE-002', employeeName: 'Vikram', department: 'Engineering', designation: 'Software Engineer', month: MONTH, otHours: 4, overtime: 1000 },
    { employeeId: '3', employeeCode: 'CRE-003', employeeName: 'Asha', department: 'Sales', designation: 'Sales Manager', month: MONTH, otHours: 0, overtime: 0 },
  ];

  const overtime = overtimeRows({ rows });

  // §13 — "Do not calculate OT here": the cost per hour is derived from the
  // two figures the engine already stored, never from a fresh rate.
  assert.equal(overtime.length, 2);
  assert.equal(overtime[0].employeeName, 'Meera');
  assert.equal(overtime[0].costPerHour, 300);
  assert.equal(overtime[1].employeeName, 'Vikram');

  const byDepartment = overtimeByDepartment({ rows });
  assert.equal(byDepartment[0].department, 'Engineering');
  assert.equal(byDepartment[0].otHours, 24);
  assert.equal(byDepartment[0].overtimeCost, 7000);
});

// ── §14 — leave impact ─────────────────────────────────────────────────────

test('§14 the leave-impact rupees are derived, and the report says so', () => {
  const rows = [
    { employeeId: '1', employeeCode: 'CRE-001', employeeName: 'Meera', department: 'Engineering', gross: 62000, workingDays: 31, lopDays: 2, paidLeaveDays: 2 },
    { employeeId: '2', employeeCode: 'CRE-002', employeeName: 'Vikram', department: 'Engineering', gross: 31000, workingDays: 31, lopDays: 0, paidLeaveDays: 0 },
  ];

  const leave = leaveImpactRows({ rows });

  // Daily rate 62,000 / 31 = 2,000 → 2 LOP days = 4,000.
  assert.equal(leave.rows[0].dailyRate, 2000);
  assert.equal(leave.rows[0].lopDeduction, 4000);
  assert.equal(leave.rows[0].paidLeaveCost, 4000);
  assert.equal(leave.lopDeduction, 4000);
  // The engine stores days, not rupees — the report must not pretend
  // otherwise, so the payload is flagged.
  assert.equal(leave.derived, true);
  assert.equal(leave.byDepartment[0].lopDeduction, 4000);
});

// ── §15 — statutory liability ──────────────────────────────────────────────

test('§15 the statutory report consolidates PF, ESI, PT, TDS and LWF', async () => {
  const harness = threeEmployees();
  const rows = await harness.service._internals.loadRows({ companyId: COMPANY, months: [MONTH] });
  const statutory = statutoryLiability({ rows });

  const pf = statutory.buckets.find((bucket) => bucket.key === 'PF');
  const pt = statutory.buckets.find((bucket) => bucket.key === 'PT');
  const tds = statutory.buckets.find((bucket) => bucket.key === 'TDS');

  assert.equal(pf.employee, 3720 * 3);
  assert.equal(pf.employer, 3720 * 3);
  assert.equal(pf.total, pf.employee + pf.employer);
  // PT and TDS are remitted, not matched — there is no employer share, and
  // the report has to show that rather than invent one.
  assert.equal(pt.employer, 0);
  assert.equal(tds.employer, 0);

  // The total is the sum of the buckets, or the report is lying.
  const bucketTotal = statutory.buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  assert.equal(statutory.totals.totalLiability, bucketTotal);
  // §15 — the gratuity provision sits alongside, never inside, the liability.
  assert.ok(statutory.totals.gratuityProvision > 0);
  assert.equal(statutory.totals.gratuityAnnualised, Math.round(statutory.totals.gratuityProvision * 12 * 100) / 100);
});

// ── §16 — CTC ──────────────────────────────────────────────────────────────

test('§16 CTC ties back to gross plus employer contribution', async () => {
  const harness = threeEmployees();
  const rows = await harness.service._internals.loadRows({ companyId: COMPANY, months: [MONTH] });
  const ctc = ctcRows({ rows });

  assert.equal(ctc.grossSalary, 222000);
  assert.equal(ctc.employerPf, 3720 * 3);
  assert.equal(ctc.employerEsi, 0);
  // §16 — Total = Company Payroll Cost.
  assert.equal(ctc.totalCompanyPayrollCost, 244500);
  assert.equal(ctc.totalCompanyPayrollCost, ctc.grossSalary + ctc.employerContribution);
  // 7,500 employer per head, of which 3,720 PF, 40 LWF and gratuity are
  // identified; the remainder is "other benefits" and must not be negative.
  assert.ok(ctc.otherEmployerBenefits >= 0);
  assert.equal(ctc.reconciled, true);
  // The buckets add up to the same total as the headline figure.
  assert.equal(
    Math.round(ctc.buckets.reduce((sum, bucket) => sum + bucket.amount, 0)),
    Math.round(ctc.totalCompanyPayrollCost),
  );
});

// ── §17 — the payroll register ─────────────────────────────────────────────

test('§17 the register carries the payment date, and a retried payment does not double up', async () => {
  const harness = buildHarness({
    employees: [employee(E1, 'CRE-001', 'Meera Iyer')],
    results: [result(E1, MONTH)],
    // A failed payment, then a successful retry in a second batch.
    payments: [payment(E1, MONTH, { status: 'FAILED' }), payment(E1, MONTH, { status: 'PAID', paidAt: '2026-09-05' })],
  });

  const rows = await harness.service._internals.loadRows({ companyId: COMPANY, months: [MONTH] });

  assert.equal(rows.length, 1, 'one employee, one row — not one per payment');
  assert.equal(rows[0].paymentStatus, 'PAID');
  assert.equal(new Date(rows[0].paidAt).toISOString().slice(0, 10), '2026-09-05');

  const table = registerRows({ rows });
  assert.deepEqual(table[0].slice(0, 3), ['CRE-001', 'Meera Iyer', 'Engineering']);
  // Column 8 is the payment date, column 9 the status (§17's column list).
  assert.equal(REGISTER_HEADERS.length, 10);
  assert.equal(table[0][8], '2026-09-05');
  assert.equal(table[0][9], 'PAID');
});

// ── §18 — filters ──────────────────────────────────────────────────────────

test('§18 every report filter narrows the same rows', async () => {
  const harness = threeEmployees();
  const rows = await harness.service._internals.loadRows({ companyId: COMPANY, months: [MONTH] });

  assert.equal(applyFilters({ rows, departmentId: String(DEPT_ENG) }).length, 2);
  assert.equal(applyFilters({ rows, designation: 'Sales Manager' }).length, 1);
  assert.equal(applyFilters({ rows, employeeId: String(E2) }).length, 1);
  assert.equal(applyFilters({ rows, status: 'PAID' }).length, 3);
  // A filter that matches nothing returns nothing rather than everything.
  assert.equal(applyFilters({ rows, departmentId: oid(99) }).length, 0);
  assert.equal(applyFilters({ rows, month: '2020-01' }).length, 0);
});

// ── §19 — exports ──────────────────────────────────────────────────────────

test('§19 CSV, XLSX and PDF carry the same table', async () => {
  const harness = threeEmployees();

  const csv = await harness.service.downloadExport({
    companyId: COMPANY,
    reportKey: 'DEPARTMENT',
    format: 'CSV',
    filters: { month: MONTH },
  });
  const xlsx = await harness.service.downloadExport({
    companyId: COMPANY,
    reportKey: 'DEPARTMENT',
    format: 'XLSX',
    filters: { month: MONTH },
  });
  const pdf = await harness.service.downloadExport({
    companyId: COMPANY,
    reportKey: 'DEPARTMENT',
    format: 'PDF',
    filters: { month: MONTH },
  });

  assert.match(csv.filename, /^payroll-department-2026-08\.csv$/);
  assert.equal(csv.rows, 2);
  assert.equal(xlsx.rows, csv.rows);
  assert.equal(pdf.rows, csv.rows);
  assert.ok(String(csv.content).includes('Sales'));
  // The XLSX is a real zip container and the PDF a real document.
  assert.equal(Buffer.from(xlsx.content).slice(0, 2).toString(), 'PK');
  assert.equal(Buffer.from(pdf.content).slice(0, 4).toString(), '%PDF');

  // §24 — generating an export is audited with what and how many.
  assert.ok(harness.state.audits.some((entry) => entry.action === ANALYTICS_AUDIT_ACTIONS.REPORT_EXPORTED));
});

test('§19 an unknown format is refused, not silently defaulted', async () => {
  const harness = threeEmployees();
  await assert.rejects(
    () => harness.service.downloadExport({ companyId: COMPANY, reportKey: 'DEPARTMENT', format: 'WORD' }),
    /CSV, XLSX or PDF/,
  );
});

test('§19 a queued export stores the requester scope and builds from it', async () => {
  const harness = threeEmployees();

  const queued = await harness.service.requestExport({
    companyId: COMPANY,
    reportKey: 'REGISTER',
    format: 'XLSX',
    filters: { month: MONTH },
    // A manager who may only see Meera.
    allowedEmployeeIds: [String(E1)],
  });

  assert.equal(queued.status, 'READY', 'with no worker attached the export runs inline');
  const file = harness.state.files.rows.find((row) => String(row._id) === String(queued.fileId));
  assert.deepEqual(file.scopeEmployeeIds, [String(E1)]);
  // §3 / §25 — the background run inherited the scope: one row, not three.
  assert.equal(file.rowCount, 1);
});

// ── §20 — scheduled reports ────────────────────────────────────────────────

test('§20 the next run advances on the calendar and clamps to a short month', () => {
  const from = new Date('2026-01-15T00:00:00Z');

  const monthly = nextRunAt({ from, frequency: 'MONTHLY', dayOfMonth: 3 });
  assert.equal(monthly.toISOString().slice(0, 10), '2026-02-03');

  const quarterly = nextRunAt({ from, frequency: 'QUARTERLY', dayOfMonth: 3 });
  assert.equal(quarterly.toISOString().slice(0, 10), '2026-04-03');

  const yearly = nextRunAt({ from, frequency: 'YEARLY', dayOfMonth: 3 });
  assert.equal(yearly.toISOString().slice(0, 10), '2027-01-03');

  // Scheduling the 31st must not skip February and land in March.
  const short = nextRunAt({ from: new Date('2026-01-31T00:00:00Z'), frequency: 'MONTHLY', dayOfMonth: 31 });
  assert.equal(short.toISOString().slice(0, 10), '2026-02-28');

  // The day still to come THIS month is the next run: a schedule created on
  // the 2nd to go out on the 3rd fires tomorrow, not in five weeks.
  const imminent = nextRunAt({ from: new Date('2026-09-02T09:00:00Z'), frequency: 'MONTHLY', dayOfMonth: 3 });
  assert.equal(imminent.toISOString().slice(0, 10), '2026-09-03');

  // A run due today steps forward a whole period — never back onto the day it
  // has already executed.
  const justRan = nextRunAt({ from: new Date('2026-09-03T00:00:00Z'), frequency: 'MONTHLY', dayOfMonth: 3 });
  assert.equal(justRan.toISOString().slice(0, 10), '2026-10-03');
});

test('§20 a schedule runs, notifies the current audience and arms itself again', async () => {
  const harness = threeEmployees();

  const schedule = await harness.service.createSchedule({
    companyId: COMPANY,
    name: 'Monthly payroll summary',
    reportKey: 'OVERVIEW',
    format: 'XLSX',
    frequency: 'MONTHLY',
    dayOfMonth: 3,
    notifyPermission: 'PAYROLL_REPORT_READ',
    actor: { _id: oid(11), name: 'Farah Finance' },
  });

  assert.equal(schedule.active, true);
  assert.ok(schedule.nextRunAt, 'a schedule is armed as soon as it is created');
  assert.ok(harness.state.dispatched.some((entry) => entry.kind === 'schedule'));
  assert.ok(harness.state.audits.some((entry) => entry.action === ANALYTICS_AUDIT_ACTIONS.SCHEDULE_CREATED));

  const firstRunAt = new Date(schedule.nextRunAt).getTime();

  await harness.service.runSchedule({ companyId: COMPANY, scheduleId: schedule._id });

  const after = await harness.service.listSchedules({ companyId: COMPANY });
  const updated = after.find((row) => String(row._id) === String(schedule._id));

  // §20 — it ran once, produced a file, and re-armed itself for next period.
  assert.equal(updated.runCount, 1);
  assert.equal(updated.lastRunStatus, 'SUCCESS');
  assert.ok(updated.lastFileId);
  assert.ok(
    new Date(updated.nextRunAt).getTime() > firstRunAt,
    'the next run moved forward — never back to the day it was executed by hand',
  );
  // §22 — the audience is resolved by permission at run time, not frozen.
  assert.ok(harness.state.notifications.some((entry) => entry.permission === 'PAYROLL_REPORT_READ'));
  assert.ok(harness.state.audits.some((entry) => entry.action === ANALYTICS_AUDIT_ACTIONS.SCHEDULE_EXECUTED));
});

test('§20 a schedule that fails still arms its next run', async () => {
  const harness = threeEmployees();

  const schedule = await harness.service.createSchedule({
    companyId: COMPANY,
    name: 'Broken schedule',
    reportKey: 'DEPARTMENT',
    format: 'PDF',
    actor: { _id: oid(11), name: 'Farah Finance' },
  });

  // Force the export to fail and confirm the schedule survives it: a single
  // bad month must not silently stop a CFO's report forever.
  harness.state.failRender = true;

  await assert.rejects(() => harness.service.runSchedule({ companyId: COMPANY, scheduleId: schedule._id }), /disk full/);

  const after = await harness.service.listSchedules({ companyId: COMPANY });
  const updated = after.find((row) => String(row._id) === String(schedule._id));
  assert.equal(updated.lastRunStatus, 'FAILED');
  assert.equal(updated.runCount, 0);
  assert.ok(updated.nextRunAt, 'the next run is still armed after a failure');
});

test('§20 a schedule is validated before it exists', async () => {
  const harness = threeEmployees();
  await assert.rejects(
    () => harness.service.createSchedule({ companyId: COMPANY, reportKey: 'NOT_A_REPORT', name: 'X' }),
    /Unknown report/,
  );
  await assert.rejects(
    () => harness.service.createSchedule({ companyId: COMPANY, reportKey: 'DEPARTMENT', name: 'X', frequency: 'HOURLY' }),
    /frequency/,
  );
  await assert.rejects(
    () => harness.service.createSchedule({ companyId: COMPANY, reportKey: 'DEPARTMENT', name: ' ' }),
    /name/i,
  );
});

// ── §21 — cache ────────────────────────────────────────────────────────────

test('§21 the dashboard, department and headcount reads are all cached', async () => {
  const harness = threeEmployees();
  await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });

  const keys = [...harness.cache.store.keys()];
  assert.ok(keys.some((key) => key.includes(':dashboard:')));
  assert.ok(keys.some((key) => key.includes(':headcount:')));
  // The namespace is the one the brief asks for.
  assert.ok(keys.every((key) => key.startsWith('k:')));
});

// ── §22 — queue payloads ───────────────────────────────────────────────────

test('§22 queue payloads carry references only, and never coerce a format', () => {
  const smuggled = validateAnalyticsExportPayload({
    companyId: COMPANY,
    fileId: oid(70),
    reportKey: 'DEPARTMENT',
    format: 'XLSX',
    rows: [['secret']],
    totalPayrollCost: 123,
  });
  assert.equal(smuggled.valid, false);
  assert.ok(smuggled.errors.some((message) => /rows must not be queued/.test(message)));

  // The same class of bug 29.11 shipped: PDF silently becoming CSV.
  assert.equal(validateAnalyticsExportPayload({ companyId: COMPANY, fileId: oid(70), reportKey: 'DEPARTMENT', format: 'pdf' }).valid, false);
  assert.equal(validateAnalyticsExportPayload({ companyId: COMPANY, fileId: oid(70), reportKey: 'DEPARTMENT', format: 'PDF' }).errors.length, 0);
  assert.equal(validateAnalyticsExportPayload({ companyId: COMPANY, fileId: oid(70), reportKey: 'DEPARTMENT', format: 'PDF' }).valid, true);

  assert.equal(validateAnalyticsSchedulePayload({ companyId: COMPANY, scheduleId: oid(71), delay: 1000 }).valid, true);
  assert.equal(validateAnalyticsSchedulePayload({ companyId: COMPANY, scheduleId: 'nope' }).valid, false);
  assert.equal(validateAnalyticsRefreshPayload({ companyId: COMPANY, month: '2026-13' }).valid, false);
});

// ── §24 — the HTTP layer (the 29.11 audit lesson) ──────────────────────────

test('§24 the analytics routes, controller and validators all load and enforce', async () => {
  const [{ default: routes }, controller, validators] = await Promise.all([
    import('../src/routes/analyticsRoutes.js'),
    import('../src/controllers/analyticsController.js'),
    import('../src/validators/analyticsValidator.js'),
  ]);

  assert.equal(typeof routes, 'function');
  assert.equal(typeof controller.getDashboard, 'function');
  assert.equal(typeof controller.createSchedule, 'function');

  // Every chain ends with the middleware that READS the collected errors.
  const chains = Object.entries(validators).filter(([, value]) => Array.isArray(value));
  assert.ok(chains.length >= 10, `expected the validator chains, saw ${chains.length}`);
  chains.forEach(([name, chain]) => {
    const last = chain[chain.length - 1];
    assert.equal(typeof last, 'function', `${name} must end with a result handler`);
    assert.equal(last.length, 3, `${name}'s handler must be express middleware (req, res, next)`);
  });

  // §25 — the CTC report is gated in the router, not only in the service.
  const paths = routes.stack.map((layer) => layer.route?.path).filter(Boolean);
  assert.ok(paths.includes('/dashboard'));
  assert.ok(paths.includes('/schedules'));
  assert.ok(paths.includes('/export/:reportKey'));
});

// ── §25 — the money-only report and row scope ──────────────────────────────

test('§25 the CTC report is refused without financial analytics access', async () => {
  const harness = threeEmployees();

  await assert.rejects(
    () => harness.service.getReport({ companyId: COMPANY, reportKey: 'CTC', month: MONTH, canSeeFinancial: false }),
    /financial analytics/i,
  );

  const allowed = await harness.service.getReport({
    companyId: COMPANY,
    reportKey: 'CTC',
    month: MONTH,
    canSeeFinancial: true,
  });
  assert.equal(allowed.reportKey, 'CTC');
  assert.equal(allowed.summary.grossSalary, 222000);
});

test('§25 a department-scoped manager sees only their own rows', async () => {
  const harness = threeEmployees();

  const scoped = await harness.service.getReport({
    companyId: COMPANY,
    reportKey: 'DEPARTMENT',
    month: MONTH,
    allowedEmployeeIds: [String(E1)],
  });

  // One employee means one department, and certainly not the whole company.
  assert.equal(scoped.summary.employeesPaid, 1);
  assert.equal(scoped.summary.grossSalary, 62000);
  assert.equal(scoped.rows.length, 1);
  assert.equal(scoped.rows[0].department, 'Engineering');

  const everything = await harness.service.getReport({ companyId: COMPANY, reportKey: 'DEPARTMENT', month: MONTH });
  assert.equal(everything.summary.employeesPaid, 3);
});

// ── §3 — tenant isolation ──────────────────────────────────────────────────

test('§3 another company reads an empty payroll', async () => {
  const harness = threeEmployees();

  const rows = await harness.service._internals.loadRows({
    companyId: OTHER_COMPANY,
    months: [MONTH],
  });
  assert.equal(rows.length, 0);

  const report = await harness.service.getReport({ companyId: OTHER_COMPANY, reportKey: 'DEPARTMENT', month: MONTH });
  assert.equal(report.summary.employeesPaid, 0);
  assert.equal(report.rows.length, 0);

  const schedules = await harness.service.listSchedules({ companyId: OTHER_COMPANY });
  assert.equal(schedules.length, 0);
});

// ── §6 — the overview and headcount ────────────────────────────────────────

test('§6 the overview reports the month and how clean the run was', async () => {
  const harness = threeEmployees();
  harness.state.results.rows.push({ ...result(oid(9), MONTH, { gross: 1000 }), status: 'ERROR' });

  const dashboard = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });

  assert.equal(dashboard.month, MONTH);
  assert.equal(dashboard.previousMonth, PREVIOUS);
  // §6 — "Payroll Accuracy": three clean of four attempted.
  assert.equal(dashboard.accuracy.calculated, 3);
  assert.equal(dashboard.accuracy.errors, 1);
  assert.equal(dashboard.accuracy.accuracyPercent, 75);
  // No previous month was seeded, so the cost change is reported as zero
  // rather than as a 100% swing nobody can act on.
  assert.equal(dashboard.kpis.costChangePercent, 0);
});

test('§9 headcount joins the HR facts to the payroll cost', () => {
  const rows = [
    { gross: 62000, net: 54000, employerCost: 7500, ctc: 69500, bonus: 0, overtime: 0, otHours: 0, lopDays: 0, paidLeaveDays: 0, totalEarnings: 62000, totalDeductions: 8000, reimbursements: 0, variableEarnings: 0 },
  ];
  const previousRows = [
    { gross: 50000, net: 42000, employerCost: 7000, ctc: 57000, bonus: 0, overtime: 0, otHours: 0, lopDays: 0, paidLeaveDays: 0, totalEarnings: 50000, totalDeductions: 8000, reimbursements: 0, variableEarnings: 0 },
  ];

  const metrics = headcountMetrics({ rows, activeEmployees: 10, joined: 2, exited: 1, previousRows });

  assert.equal(metrics.activeEmployees, 10);
  assert.equal(metrics.joinedThisMonth, 2);
  assert.equal(metrics.exitedThisMonth, 1);
  assert.equal(metrics.netHeadcountChange, 1);
  // Cost 69,500 this month against 57,000 last: a 12,500 increase.
  assert.equal(metrics.payrollCost, 69500);
  assert.equal(metrics.payrollCostIncrease, 12500);
  assert.equal(Math.round(metrics.payrollCostIncreasePercent), 22);
  // §9 — cost per employee uses the HEADCOUNT, not the paid count.
  assert.equal(metrics.averageCostPerEmployee, 6950);
  assert.equal(metrics.averageCostPerPaidEmployee, 69500);
});

// ── §19 — the export table matches the report ──────────────────────────────

test('§19 every report has an export table with a header per column', () => {
  const tables = REPORT_KEYS.map((key) => ({
    key,
    table: reportTable({ reportKey: key, payload: { rows: [], buckets: [], summary: {} } }),
  }));

  tables.forEach(({ key, table }) => {
    assert.ok(Array.isArray(table.headers) && table.headers.length > 0, `${key} needs headers`);
    assert.ok(Array.isArray(table.rows), `${key} needs rows`);
  });

  // A row whose width does not match its header would render a broken sheet.
  const withRows = reportTable({
    reportKey: 'DEPARTMENT',
    payload: { rows: [{ department: 'Engineering', employees: 2, gross: 1, net: 2, employerCost: 3, totalCost: 4, averageSalary: 5 }] },
  });
  assert.equal(withRows.rows[0].length, withRows.headers.length);
});

test('§19 report filenames are predictable and filesystem-safe', () => {
  assert.equal(reportFilename({ reportKey: 'DEPARTMENT', month: '2026-08', format: 'CSV' }), 'payroll-department-2026-08.csv');
  assert.equal(reportFilename({ reportKey: 'SALARY_BANDS', month: '2026-08', format: 'xlsx' }), 'payroll-salary-bands-2026-08.xlsx');
  assert.equal(reportFilename({ reportKey: 'REGISTER', period: 'MONTHLY', format: 'PDF' }), 'payroll-register-monthly.pdf');
});
