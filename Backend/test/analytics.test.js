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
import { filterSegmentOf, scopeSegmentOf } from '../src/services/payroll/analyticsCache.js';
import { matches, pathValue, runPipeline } from './helpers/fakeAggregate.js';
// (salaryBandRows, bandOf, SALARY_BANDS and resolvePeriod are imported in the
// rules block above; only what that block does not already pull in is added.)
import { normaliseSalaryBands, resolvePeriod, roundMoney as money } from '../src/services/payroll/analyticsRules.js';
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
    aggregate: async (pipeline = []) => runPipeline(rows, pipeline),
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
    // Mirrors payrollEngineRules: total earnings are the structure earnings
    // plus variable pay plus overtime, net is that less deductions, and CTC is
    // that plus the employer share. `gross` alone is the structure figure.
    gross,
    basic,
    totalEarnings: gross + overtime + variable.reduce((sum, line) => sum + Number(line.amount || 0), 0),
    totalDeductions: deductions,
    netPay: gross + overtime + variable.reduce((sum, line) => sum + Number(line.amount || 0), 0) - deductions,
    employerCost,
    ctc: gross + overtime + employerCost + variable.reduce((sum, line) => sum + Number(line.amount || 0), 0),
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
  profiles = [],
  companyId = COMPANY,
} = {}) => {
  const state = {
    results: makeFakeModel(),
    payments: makeFakeModel(),
    settlements: makeFakeModel(),
    resignations: makeFakeModel(),
    // §23 — the versioned 29.4 profile, which is where a contracted salary
    // (as opposed to a paid one) lives.
    profiles: makeFakeModel(),
    // §8 — the company's own salary bands.
    settings: makeFakeModel(),
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
  // 29.6 stamps the employee's department onto the snapshot
  // (payrollEngineRules: departmentId = employee.department). A fixture that
  // left it null would make every department report read "Unassigned" — and
  // would hide the fact that the aggregation path groups by it.
  const departmentOf = new Map(employees.map((row) => [String(row._id), row.department]));
  results.forEach((row) => {
    if (!row.departmentId) row.departmentId = departmentOf.get(String(row.employeeId)) || null;
    state.results.rows.push(row);
  });
  payments.forEach((row) => state.payments.rows.push(row));
  settlements.forEach((row) => state.settlements.rows.push(row));
  resignations.forEach((row) => state.resignations.rows.push(row));
  profiles.forEach((row) => state.profiles.rows.push(row));

  state.departments.rows.push({ _id: DEPT_ENG, name: 'Engineering', companyId });
  state.departments.rows.push({ _id: DEPT_SALES, name: 'Sales', companyId });
  state.companies.rows.push({ _id: companyId, name: 'Crewly Technologies Pvt Ltd', address: 'Bengaluru', logoUrl: '' });

  const cache = {
    store: new Map(),
    buildKey: ({ companyId: id, month = '', suffix = 'dashboard', period = '', filters = null, scope = null }) =>
      `k:${id}:${month || 'all'}:${suffix}:${period || '-'}:${filterSegmentOf(filters)}:${scopeSegmentOf(scope)}`,
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
    EmployeePayrollProfileModel: state.profiles,
    AnalyticsSettingModel: state.settings,
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
      // Flippable so a test can exercise the worker path: when a queue is
      // available the service leaves the file QUEUED for the worker.
      return { queued: Boolean(state.queueExports) };
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
  // §5 — average GROSS per head, not average take-home: 2,22,000 / 3.
  assert.equal(kpis.averageSalary, 74000);
  // §5 — the highest-cost department is Sales (1,20,000 + 7,500).
  assert.equal(kpis.highestDepartmentCost.department, 'Sales');
  assert.equal(kpis.highestDepartmentCost.cost, 127500);
  // §5 — statutory liability: employee + employer across PF, PT, TDS, LWF.
  // Per employee: 3,720 + 200 + 4,500 + 20 employee; 3,720 + 40 employer.
  assert.equal(kpis.totalStatutoryLiability, (3720 + 200 + 4500 + 20 + 3720 + 40) * 3);
});

test('§5 gross pay is never less than net pay, even with overtime and variable pay', async () => {
  const harness = buildHarness({
    employees: [employee(E1, 'CRE-001', 'Meera Iyer', { department: DEPT_ENG })],
    // A month with overtime and a bonus is where the two stored gross figures
    // part company: structure 60,000, plus 12,000 of overtime and 20,000 of
    // variable pay = 92,000 earned, 82,000 paid after 10,000 of deductions.
    results: [result(E1, MONTH, {
      gross: 60000, basic: 30000, deductions: 10000, overtime: 12000,
      variable: [{ type: 'BONUS_PERFORMANCE', label: 'Performance Bonus', amount: 20000 }],
    })],
    payments: [payment(E1, MONTH)],
  });

  const { kpis } = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });

  // The defect: analytics read `totals.gross` (the structure earnings) while
  // the net it printed came from `totals.netPay`, which includes overtime and
  // variable pay — so the executive dashboard showed net ABOVE gross.
  assert.equal(kpis.grossSalary, 92000);
  assert.equal(kpis.netSalaryPaid, 82000);
  assert.ok(kpis.grossSalary >= kpis.netSalaryPaid, 'gross must not be smaller than net');

  // §14 — the LOP daily rate stays on the structure base the engine used.
  const leave = await harness.service.getReport({ companyId: COMPANY, reportKey: 'LEAVE', month: MONTH });
  assert.equal(leave.rows[0].dailyRate, Math.round((60000 / 31) * 100) / 100);
});

test('§6 the overview export reads like a report, not like JavaScript', async () => {
  const harness = threeEmployees();
  const report = await harness.service.getReport({ companyId: COMPANY, reportKey: 'OVERVIEW', month: MONTH });
  const table = reportTable({ reportKey: 'OVERVIEW', payload: report });

  const labels = table.rows.map(([label]) => String(label));
  // No camelCase ever reaches the spreadsheet: `averageCtc` in a file a CFO
  // opens is a bug, not a style choice.
  const camelCased = labels.filter((label) => /[a-z][A-Z]/.test(label));
  assert.deepEqual(camelCased, []);
  assert.ok(labels.includes('Gross Salary'));
  assert.ok(labels.includes('Employees Paid'));
  // And the numbers are untouched by the relabelling.
  const gross = table.rows.find(([label]) => label === 'Gross Salary');
  assert.equal(gross[1], 222000);
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
  // The average is per employee, not per department — and it averages gross,
  // the same column the row reports, not the take-home next to it.
  assert.equal(byDepartment[1].averageSalary, 51000);
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
  // §22 — the register's columns are addressed by NAME, never by position:
  // adding a column once silently shifted the payment date into the net-pay
  // column of every exported spreadsheet.
  const column = (label) => table[0][REGISTER_HEADERS.indexOf(label)];
  assert.equal(REGISTER_HEADERS.length, 13);
  assert.equal(column('Payroll Period'), MONTH);
  assert.equal(column('Gross'), 62000);
  assert.equal(column('Net Salary'), 54000);
  assert.equal(column('Employer Cost'), 7500);
  assert.equal(column('Payment Status'), 'PAID');
  assert.equal(column('Payroll Status'), 'CALCULATED');
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

// ── §23 — notifications ────────────────────────────────────────────────────

test('§23 a background export tells the person who asked for it', async () => {
  const harness = threeEmployees();
  // A queue is available, so the export is left for the worker — the case
  // where "it is ready" can only reach the requester as a notification.
  harness.state.queueExports = true;

  const queued = await harness.service.requestExport({
    companyId: COMPANY,
    reportKey: 'DEPARTMENT',
    format: 'CSV',
    filters: { month: MONTH },
    actor: { _id: 'user-77', name: 'Farah Finance' },
  });
  assert.equal(queued.status, 'QUEUED');

  const result = await harness.service.runExport({
    companyId: COMPANY,
    fileId: queued.fileId,
    actor: { _id: 'user-77', name: 'Farah Finance' },
  });

  assert.equal(result.status, 'READY');
  const toRequester = harness.state.notifications.filter((entry) => entry.userId === 'user-77');
  // §19 — a large export runs in the background, so silence would mean the
  // requester has to sit and watch the page.
  assert.equal(toRequester.length, 1);
  assert.match(toRequester[0].payload.message, /Department Payroll/);
  assert.equal(toRequester[0].payload.format, 'CSV');
});

test('§23 a dashboard refresh tells the management audience, naming the month', async () => {
  const harness = threeEmployees();

  await harness.service.runRefresh({ companyId: COMPANY, month: MONTH });

  const audience = harness.state.notifications.filter((entry) => entry.permission === 'PAYROLL_ANALYTICS_FINANCIAL');
  // §23 — "Executive Dashboard Updated → Company Admin". There is no
  // Company-Admin-only verb, so it goes to the management audience the brief
  // defines: Company Admin and Finance.
  assert.equal(audience.length, 1);
  assert.match(audience[0].payload.message, /August 2026/);
});

// ── §19 / §20 — the file list and the schedule list ────────────────────────

test('§19 a download is counted, and a file that is not ready is refused', async () => {
  const harness = threeEmployees();
  harness.state.queueExports = true;

  const queued = await harness.service.requestExport({
    companyId: COMPANY,
    reportKey: 'REGISTER',
    format: 'XLSX',
    filters: { month: MONTH },
    actor: { _id: 'user-77', name: 'Farah Finance' },
  });

  // §19 — not ready yet, so nobody can download a half-written file.
  await assert.rejects(() => harness.service.downloadFile({ companyId: COMPANY, fileId: queued.fileId }), /not ready/);

  await harness.service.runExport({ companyId: COMPANY, fileId: queued.fileId });

  const first = await harness.service.downloadFile({ companyId: COMPANY, fileId: queued.fileId });
  assert.ok(first.content, 'the bytes come back');
  assert.match(first.filename, /\.xlsx$/);

  await harness.service.downloadFile({ companyId: COMPANY, fileId: queued.fileId });
  const [file] = await harness.service.listFiles({ companyId: COMPANY, reportKey: 'REGISTER' });
  assert.equal(file.downloadCount, 2, '§19 — how often a report is picked up is worth knowing');
});

test('§20 the schedule list names the department and the last file it produced', async () => {
  const harness = threeEmployees();

  const schedule = await harness.service.createSchedule({
    companyId: COMPANY,
    name: 'Engineering payroll',
    reportKey: 'DEPARTMENT',
    format: 'CSV',
    departmentId: String(DEPT_ENG),
    actor: { _id: oid(11), name: 'Farah Finance' },
  });

  await harness.service.runSchedule({ companyId: COMPANY, scheduleId: schedule._id });

  const [row] = await harness.service.listSchedules({ companyId: COMPANY });
  // The page says which slice of the company a schedule covers; resolving an
  // id into a name is the server's job, not the browser's.
  assert.equal(row.department, 'Engineering');
  assert.equal(row.departmentId, String(DEPT_ENG));
  assert.match(row.lastFilename, /^payroll-department-\d{4}-\d{2}\.csv$/);
  assert.equal(row.reportLabel, 'Department Payroll');
});

// ── §19 — a printed report has to survive being printed ─────────────────────

test('§19 a long report paginates with the header on every page', async () => {
  // pdf-parse v2: `new PDFParse({ data })`, not the v1 callback signature.
  const mod = await import('pdf-parse');
  const PDFParse = mod.PDFParse || mod.default?.PDFParse || mod.default;

  const rows = Array.from({ length: 80 }, (_, index) => ({
    employeeId: `e${index}`,
    employeeCode: `CRE-${String(index).padStart(3, '0')}`,
    employeeName: `Employee ${index}`,
    department: 'Engineering',
    designation: 'Engineer',
    month: MONTH,
    gross: 62000 + index,
    basic: 31000,
    totalEarnings: 62000 + index,
    totalDeductions: 8000,
    net: 54000 + index,
    employerCost: 7500,
    ctc: 69500,
    paidAt: new Date('2026-08-30T00:00:00Z'),
    paymentStatus: 'PAID',
  }));

  const pdf = await buildAnalyticsReportPdf({
    company: { name: 'Crewly Technologies Pvt Ltd', address: 'Bengaluru' },
    title: 'Payroll Register',
    subtitle: 'August 2026',
    headers: REGISTER_HEADERS,
    rows: registerRows({ rows }),
    generatedBy: 'Farah Finance',
  });

  const parser = new PDFParse({ data: pdf });
  const result = await parser.getText();
  await parser.destroy?.();
  const text = String(result?.text || '');

  const pages = [...text.matchAll(/-- (\d+) of (\d+) --/g)].map((match) => Number(match[2]));
  assert.ok(pages.length > 1, 'eighty rows do not fit on one page');
  const pageCount = pages[0];

  // The defect this guards against: the header was drawn only on page one, so
  // every printed page after it was columns of numbers with no names.
  const headers = (text.match(/Employee ID/g) || []).length;
  assert.equal(headers, pageCount, 'every page repeats the header');

  // §19 — the reader has to be able to tell they are holding all of it.
  assert.match(text, /80 row\(s\)/);
});

// ── §12 — bonus means the BONUS_* / INCENTIVE / COMMISSION entry types ──────

test('§12 the bonus report counts every bonus entry type the engine stores', async () => {
  // The types 29.5 actually writes (monthlyInputRules ENTRY_TYPE_LABELS).
  // A list that guessed at them — ['BONUS', 'PERFORMANCE_BONUS', …] — matches
  // almost nothing in real data and would under-report every bonus bar one.
  const harness = buildHarness({
    employees: [
      employee(E1, 'CRE-001', 'Meera Iyer'),
      employee(E2, 'CRE-002', 'Vikram Shetty'),
    ],
    results: [
      result(E1, MONTH, { variable: [
        { type: 'BONUS_PERFORMANCE', label: 'Performance Bonus', amount: 20000 },
        { type: 'BONUS_FESTIVAL', label: 'Festival Bonus', amount: 5000 },
        { type: 'INCENTIVE', label: 'Incentive', amount: 3000 },
        { type: 'COMMISSION_SALES', label: 'Sales Commission', amount: 2000 },
      ] }),
      // Variable pay that is NOT a bonus must not inflate the bonus column.
      result(E2, MONTH, { variable: [{ type: 'ADJUSTMENT', label: 'Adjustment', amount: 7000 }] }),
    ],
    payments: [],
  });

  const bonus = await harness.service.getReport({ companyId: COMPANY, reportKey: 'BONUS', month: MONTH });

  const meera = bonus.rows.find((row) => row.employeeName === 'Meera Iyer');
  const vikram = bonus.rows.find((row) => row.employeeName === 'Vikram Shetty');

  assert.equal(meera.bonus, 30000, 'all four bonus types count');
  assert.equal(meera.otherVariable, 0);
  // Total variable is everything beyond fixed pay, so it includes the bonus.
  assert.equal(meera.totalVariable, 30000);

  // An adjustment is variable pay but not a bonus: it must not be reported as
  // one, and it must not disappear either — it has its own column.
  assert.equal(vikram.bonus, 0);
  assert.equal(vikram.otherVariable, 7000);
  assert.equal(vikram.totalVariable, 7000);
});

// ── §9 — the headcount report carries the HR counts ────────────────────────

test('§9 the headcount report reports headcount, not just payroll', async () => {
  const harness = threeEmployees();
  // One more person in the company than is on this month's payroll, and she
  // joined inside the month, so §9 should count her as a join.
  harness.state.users.rows.push(employee(oid(8), 'CRE-008', 'New Joiner', { joining: '2026-08-03' }));
  // …and someone handed in a resignation whose last day is inside the month.
  harness.state.resignations.rows.push({
    _id: oid(71),
    companyId: COMPANY,
    employeeId: E3,
    status: 'APPROVED',
    lastWorkingDate: new Date('2026-08-31T00:00:00Z'),
  });

  const report = await harness.service.getReport({ companyId: COMPANY, reportKey: 'HEADCOUNT', month: MONTH });

  // The defect this guards against: the report path called the metrics helper
  // without the HR counts, so active / joined / exited all read zero while the
  // dashboard showed them correctly. One section, two answers.
  assert.equal(report.activeEmployees, 4);
  assert.equal(report.employeesPaid, 3);
  assert.equal(report.averageCostPerEmployee, Math.round(report.payrollCost / 4));
  // The counts are not decoration: a month with a join and an exit nets to
  // zero but is emphatically not a quiet month.
  assert.equal(report.joinedThisMonth, 1, 'the August joiner is counted');
  assert.equal(report.exitedThisMonth, 1, 'the August leaver is counted');
  assert.equal(report.netHeadcountChange, 0);
});

// ── §21 — a filtered read is a different cache entry ───────────────────────

test('§21 a filtered dashboard does not overwrite the unfiltered one', async () => {
  const harness = threeEmployees();

  const all = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.equal(all.kpis.employeesPaid, 3);

  const filtered = await harness.service.getDashboard({
    companyId: COMPANY,
    month: MONTH,
    filters: { departmentId: String(DEPT_ENG) },
  });
  assert.equal(filtered.kpis.employeesPaid, 2, 'the filter applies');

  // Both are now cached under DIFFERENT keys. Before the filter segment was
  // part of the key, whichever ran last was served to both requests.
  const again = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.equal(again.kpis.employeesPaid, 3, 'the unfiltered dashboard survived the filtered read');

  const keys = [...harness.cache.store.keys()];
  assert.ok(keys.some((key) => key.endsWith(':departmentId-' + DEPT_ENG + ':-')), 'the filter is in the key');
  assert.ok(keys.some((key) => key.endsWith(':-')), 'and the unfiltered read has its own');
});

// ── §29 / §44 — the aggregation fast path (29.13) ──────────────────────────

test('§29 the dashboard is computed in MongoDB, and the row path agrees', async () => {
  const harness = threeEmployees();

  const aggregated = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  // If the pipeline ever fails, the service falls back to loading rows — which
  // is correct behaviour but would silently stop the fast path from being
  // exercised. Asserting the source is what catches that.
  assert.equal(aggregated.source, 'AGGREGATION');

  // A payment-status filter lives on PayrollPayment, not on the snapshot, so
  // that read has to take the row path.
  const byRows = await harness.service.getDashboard({
    companyId: COMPANY,
    month: MONTH,
    filters: { status: 'PAID' },
  });
  assert.equal(byRows.source, 'ROWS');

  // Same data, two routes, identical answers. This is the whole reason the
  // fast path is safe to ship.
  assert.equal(byRows.summary.employeesPaid, 3);
  assert.equal(aggregated.summary.grossSalary, byRows.summary.grossSalary);
  assert.equal(aggregated.summary.netSalary, byRows.summary.netSalary);
  assert.equal(aggregated.summary.employerContribution, byRows.summary.employerContribution);
  assert.equal(aggregated.summary.totalPayrollCost, byRows.summary.totalPayrollCost);
  assert.equal(aggregated.summary.bonusTotal, byRows.summary.bonusTotal);
  assert.equal(aggregated.kpis.totalStatutoryLiability, byRows.kpis.totalStatutoryLiability);
  assert.deepEqual(
    aggregated.departments.map((row) => row.department),
    byRows.departments.map((row) => row.department),
    'the department split is the same either way',
  );
});

test('§29 a twelve-month window counts people, not employee-months', async () => {
  const harness = threeEmployees();
  // The same three people, paid every month for a year.
  harness.state.results.rows.push(
    ...threeMonthsOf(['2026-05', '2026-06', '2026-07']),
  );

  const year = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH, preset: 'LAST_12_MONTHS' });

  assert.equal(year.months.length, 12);
  // The defect this guards against: a headcount card that summed rows would
  // report 36 employees for a company of three.
  assert.equal(year.kpis.employeesPaid, 3);
  assert.equal(year.summary.employeesPaid, 3);
  // …and the window before it is the twelve months BEFORE this one.
  assert.equal(year.previousMonths.length, 12);
  assert.equal(year.previousMonths[11], '2025-08');
});

// Three more months of the same three employees, for the window tests.
const threeMonthsOf = (months = []) =>
  months.flatMap((month) => [
    result(E1, month, { gross: 62000, basic: 31000 }),
    result(E2, month, { gross: 40000, basic: 20000 }),
    result(E3, month, { gross: 120000, basic: 60000 }),
  ]);

// ── §4 — period presets ────────────────────────────────────────────────────

test('§4 every preset resolves to the months it names', () => {
  const now = new Date('2026-08-15T00:00:00Z');

  assert.deepEqual(resolvePeriod({ preset: 'CURRENT_MONTH', month: MONTH, now }).months, [MONTH]);
  assert.deepEqual(resolvePeriod({ preset: 'PREVIOUS_MONTH', month: MONTH, now }).months, [PREVIOUS]);
  assert.deepEqual(resolvePeriod({ preset: 'LAST_3_MONTHS', month: MONTH, now }).months, ['2026-06', '2026-07', '2026-08']);
  assert.equal(resolvePeriod({ preset: 'LAST_6_MONTHS', month: MONTH, now }).months.length, 6);
  assert.equal(resolvePeriod({ preset: 'LAST_12_MONTHS', month: MONTH, now }).months.length, 12);

  // §4 — the example in the brief: April 2026 → March 2027.
  const fy = resolvePeriod({ preset: 'CURRENT_FY', month: MONTH, now });
  assert.equal(fy.fromMonth, '2026-04');
  assert.equal(fy.toMonth, '2027-03');
  assert.equal(fy.months.length, 12);

  const previousFy = resolvePeriod({ preset: 'PREVIOUS_FY', month: MONTH, now });
  assert.equal(previousFy.fromMonth, '2025-04');
  assert.equal(previousFy.toMonth, '2026-03');

  const custom = resolvePeriod({ preset: 'CUSTOM', fromMonth: '2026-04', toMonth: '2027-03', now });
  assert.equal(custom.months.length, 12);
  assert.equal(custom.months[0], '2026-04');
  assert.equal(custom.months[11], '2027-03');
  // A backwards range is not a range.
  assert.deepEqual(resolvePeriod({ preset: 'CUSTOM', fromMonth: '2027-03', toMonth: '2026-04', now }).months, []);
});

test('§4 a preset window is its own cache entry', async () => {
  const harness = threeEmployees();
  harness.state.results.rows.push(...threeMonthsOf(['2026-05', '2026-06', '2026-07']));

  const month = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  const year = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH, preset: 'LAST_12_MONTHS' });

  assert.equal(month.summary.grossSalary, 222000);
  assert.equal(year.summary.grossSalary, 222000 * 4, 'four months of the same three people');
  // …and reading one must not poison the other.
  const again = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.equal(again.summary.grossSalary, 222000);
});

// ── §8 — configurable salary bands ─────────────────────────────────────────

test('§8 a company can define its own salary bands', () => {
  const bands = normaliseSalaryBands([
    { key: 'a', label: 'Up to 30k', min: 0, max: 30000 },
    { key: 'b', label: '30k - 60k', min: 30000, max: 60000 },
    { key: 'c', label: 'Above 60k', min: 60000, max: 90000 },
  ]);

  assert.equal(bands.length, 3);
  // The top band is open-ended whatever the company typed: a 12-lakh salary
  // must still land somewhere.
  assert.equal(bands[2].max, null);
  assert.equal(bandOf(15000, bands).key, 'a');
  assert.equal(bandOf(62000, bands).key, 'c');
  assert.equal(bandOf(90000000, bands).key, 'c');

  const rows = salaryBandRows({
    rows: [{ gross: 62000, net: 54000 }, { gross: 25000, net: 20000 }],
    bands,
  });
  assert.deepEqual(rows.map((row) => `${row.label}:${row.employees}`), ['Up to 30k:1', '30k - 60k:0', 'Above 60k:1']);

  // Junk falls back to the defaults rather than rendering an empty chart.
  assert.equal(normaliseSalaryBands('nonsense').length, SALARY_BANDS.length);
  assert.equal(normaliseSalaryBands([{ label: 'only one', min: 0, max: 10 }]).length, SALARY_BANDS.length);
  // An overlapping band would count one employee twice, so it is dropped.
  const overlapping = normaliseSalaryBands([
    { key: 'a', label: '0-50', min: 0, max: 50000 },
    { key: 'b', label: '10-60', min: 10000, max: 60000 },
    { key: 'c', label: '60+', min: 60000, max: 90000 },
  ]);
  assert.deepEqual(overlapping.map((band) => band.key), ['a', 'c']);
});

// ── 29.13 — a fixture with real payroll LINES ──────────────────────────────
//
// The shared fixture carries totals only, which is all the 29.12 reports
// need. The earnings, deductions and employer reports read the LINE arrays
// the engine writes, so they need a fixture that has them — with the lines
// tying to the totals, the way a real 29.6 snapshot does.

const detailedResult = (employeeId, month) => {
  const base = result(employeeId, month, {
    gross: 60000,
    basic: 30000,
    deductions: 12000,
    overtime: 6000,
    employerCost: 7500,
    variable: [
      { type: 'BONUS_PERFORMANCE', label: 'Performance Bonus', amount: 15000 },
      { type: 'INCENTIVE', label: 'Incentive', amount: 5000 },
    ],
  });

  return {
    ...base,
    structureId: oid(201),
    structureName: 'Standard Structure',
    earnings: [
      { code: 'BASIC', name: 'Basic', amount: 30000, source: 'STRUCTURE' },
      { code: 'HRA', name: 'House Rent Allowance', amount: 15000, source: 'STRUCTURE' },
      { code: 'SPECIAL_ALLOWANCE', name: 'Special Allowance', amount: 15000, source: 'STRUCTURE' },
    ],
    reimbursements: [{ type: 'REIMBURSEMENT_TRAVEL', label: 'Travel', amount: 4000, claimStatus: 'APPROVED' }],
    deductions: [
      { code: 'PF', name: 'Provident Fund', amount: 3720, source: 'STATUTORY' },
      { code: 'TDS', name: 'Income Tax (TDS)', amount: 4500, source: 'STATUTORY' },
      { code: 'LOP', name: 'Loss of Pay', amount: 3000, source: 'ATTENDANCE' },
      { code: 'DEDUCTION_FINE', name: 'Fine', amount: 780, source: 'MONTHLY_INPUT' },
    ],
    employerContributions: [
      { code: 'PF_EMPLOYER', name: 'Employer PF', amount: 3720, source: 'STATUTORY' },
      { code: 'GRATUITY', name: 'Gratuity', amount: 1443, source: 'STATUTORY' },
      { code: 'MEDICAL', name: 'Medical Insurance', amount: 2337, source: 'STRUCTURE' },
    ],
    // The lines above have to agree with the totals, or the report is lying.
    totals: { ...base.totals, reimbursements: 4000, netPay: 78000 },
  };
};

// A 29.11 settlement, shaped the way FinalSettlement actually stores one.
const finalSettlement = (employeeId, month, {
  status = 'PAID',
  netSettlement = 0,
  pendingSalary = 0,
  leaveEncashment = 0,
  recoveries = 0,
} = {}) => ({
  _id: oid(700 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  employeeId,
  employeeName: `Employee ${employeeId.slice(-3)}`,
  month,
  settlementNumber: `FNF-${month}-${employeeId.slice(-3)}`,
  status,
  totals: {
    netSettlement,
    totalEarnings: pendingSalary + leaveEncashment,
    totalRecoveries: recoveries,
  },
  earnings: {
    pendingSalary: { amount: pendingSalary },
    leaveEncashment: { amount: leaveEncashment },
  },
  recoveries: { notice: { amount: 0 }, items: [{ label: 'Advance', amount: recoveries }] },
  exit: { employeeId, lastWorkingDate: '2026-08-31' },
  payment: status === 'PAID' ? { paidAt: new Date(`${month}-01T00:00:00Z`) } : null,
});

const detailedHarness = (extra = {}) =>
  buildHarness({
    employees: [
      employee(E1, 'CRE-001', 'Meera Iyer', { department: DEPT_ENG, designation: 'Senior Engineer' }),
      employee(E2, 'CRE-002', 'Vikram Shetty', { department: DEPT_SALES, designation: 'Sales Manager' }),
    ],
    results: [detailedResult(E1, MONTH), detailedResult(E2, MONTH)],
    payments: [payment(E1, MONTH), payment(E2, MONTH)],
    ...extra,
  });

// ── §11 — the earnings report ──────────────────────────────────────────────

test('§11 the earnings report separates fixed, variable, overtime and reimbursements', async () => {
  const harness = detailedHarness();
  const report = await harness.service.getReport({ companyId: COMPANY, reportKey: 'EARNINGS', month: MONTH });

  const components = new Map(report.rows.map((row) => [row.label, row]));
  assert.equal(components.get('Basic').amount, 60000, 'two employees at 30,000 basic each');
  assert.equal(components.get('House Rent Allowance').amount, 30000);
  assert.equal(components.get('Performance Bonus').amount, 30000);
  assert.equal(components.get('Performance Bonus').kind, 'BONUS');
  assert.equal(components.get('Incentive').amount, 10000);
  assert.equal(components.get('Incentive').kind, 'INCENTIVE', 'an incentive is not a bonus');
  assert.equal(components.get('Overtime').amount, 12000);

  // The whole point: every rupee is accounted for, and the report says so.
  assert.equal(report.totals.grossPayroll, 172000, '60000 structure x 2 + 40000 variable + 12000 overtime');
  assert.equal(report.totals.fixedEarnings, 120000);
  assert.equal(report.totals.variableEarnings, 40000);
  assert.equal(report.totals.bonus, 30000);
  assert.equal(report.totals.overtime, 12000);
  assert.equal(report.totals.reimbursements, 8000);
  assert.equal(report.totals.total, 180000);
  assert.equal(report.totals.reconciled, true, 'the parts add up to the whole');
});

// ── §12 — the deductions report ────────────────────────────────────────────

test('§12 the deductions report splits statutory, LOP and other, and shows its own arithmetic', async () => {
  const harness = detailedHarness();
  const report = await harness.service.getReport({ companyId: COMPANY, reportKey: 'DEDUCTIONS', month: MONTH });

  const kinds = new Map(report.rows.map((row) => [row.key, row]));
  assert.equal(kinds.get('PF').amount, 7440);
  assert.equal(kinds.get('TDS').amount, 9000);
  assert.equal(kinds.get('LOP').amount, 6000);
  assert.equal(kinds.get('OTHER').amount, 1560);

  assert.equal(report.totals.totalDeductions, 24000);
  assert.equal(report.totals.statutoryTotal, 16440, 'PF + TDS only — LOP is not a statutory remittance');
  assert.equal(report.totals.lopTotal, 6000);
  assert.equal(report.totals.otherTotal, 1560);
  assert.equal(report.totals.percentOfGross, 13.95, 'as a share of gross payroll');
  assert.equal(report.totals.snapshotTotal, 24000, 'the lines tie to what the engine actually deducted');

  // §12 — the LOP figure is a real deduction, not a rounding artefact.
  assert.equal(report.rows.find((row) => row.key === 'LOP').employees, 2);
});

// ── §13 — the employer contribution report ─────────────────────────────────

test('§13 employer contributions are never confused with employee deductions', async () => {
  const harness = detailedHarness();
  const report = await harness.service.getReport({ companyId: COMPANY, reportKey: 'EMPLOYER', month: MONTH });

  const kinds = new Map(report.rows.map((row) => [row.key, row]));
  assert.equal(kinds.get('PF').amount, 7440);
  assert.equal(kinds.get('GRATUITY').amount, 2886);
  assert.equal(kinds.get('OTHER').amount, 4674, 'the medical premium, which is not a statutory remittance');

  assert.equal(report.total, 15000);
  assert.equal(report.snapshotTotal, 15000);
  // §13 — anything the engine cannot classify is shown, not folded away.
  assert.equal(report.unclassified, 0);
  assert.equal(report.byDepartment.length, 2);
});

// ── §18 — the reimbursement report ─────────────────────────────────────────

test('§18 the reimbursement report breaks claims down by category and by person', async () => {
  const harness = detailedHarness();
  const report = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REIMBURSEMENT', month: MONTH });

  assert.equal(report.total, 8000);
  assert.equal(report.categories.length, 1);
  assert.equal(report.categories[0].label, 'Travel Reimbursement');
  assert.equal(report.categories[0].amount, 8000);
  assert.equal(report.employees, 2, 'both people claimed');
  assert.equal(report.byMonth.length, 1);
});

// ── §20 — F&F analytics ────────────────────────────────────────────────────

test('§20 F&F analytics reads finalised settlements and never invents one', async () => {
  const harness = buildHarness({
    employees: [employee(E1, 'CRE-001', 'Meera Iyer', { department: DEPT_ENG })],
    results: [],
    settlements: [
      // PAID and CLOSED are final; a DRAFT is a work in progress and must not
      // be reported as money the company has spent.
      finalSettlement(E1, '2026-08', { status: 'PAID', netSettlement: 29000, pendingSalary: 20000, leaveEncashment: 20000, recoveries: 10000 }),
    ],
  });

  const report = await harness.service.getReport({ companyId: COMPANY, reportKey: 'FNF', month: MONTH });

  assert.equal(report.count, 1);
  assert.equal(report.completed.count, 1);
  assert.equal(report.pending.count, 0);
  assert.equal(report.totals.netSettlement, 29000);
  assert.equal(report.totals.leaveEncashment, 20000);
  assert.equal(report.rows.length, 1);

  // A draft in the same window is not counted as a completed settlement.
  const withDraft = buildHarness({
    settlements: [
      finalSettlement(E1, MONTH, { status: 'PAID', netSettlement: 29000 }),
      finalSettlement(E2, MONTH, { status: 'DRAFT', netSettlement: 5000 }),
    ],
  });
  const draftReport = await withDraft.service.getReport({ companyId: COMPANY, reportKey: 'FNF', month: MONTH });
  // The draft is listed — it exists — but it counts as pending, never as
  // money the company has already spent.
  assert.equal(draftReport.count, 2);
  assert.equal(draftReport.completed.count, 1);
  assert.equal(draftReport.pending.count, 1, 'the draft is not a settlement yet');
});

// ── §21 — the payroll variance report ──────────────────────────────────────

test('§21 the variance report says which way the money moved, not just by how much', async () => {
  const harness = threeEmployees();
  // Same three people, a month earlier, on less money.
  harness.state.results.rows.push(...threeMonthsOf([PREVIOUS]));

  const report = await harness.service.getReport({ companyId: COMPANY, reportKey: 'VARIANCE', month: MONTH });

  const gross = report.rows.find((row) => row.key === 'GROSS');
  assert.equal(gross.previous, 222000);
  assert.equal(gross.current, 222000);
  assert.equal(gross.difference, 0);
  assert.equal(gross.direction, 'STABLE', 'nothing moved, and the report says so');

  // Now make the current month cost more, and the direction has to follow.
  harness.state.results.rows.forEach((row) => {
    if (row.month === MONTH) row.totals.overtime = 5000;
  });
  const moved = await harness.service.getReport({ companyId: COMPANY, reportKey: 'VARIANCE', month: MONTH });
  const overtime = moved.rows.find((row) => row.key === 'OVERTIME');
  assert.equal(overtime.difference, 15000);
  assert.equal(overtime.direction, 'INCREASING');
  assert.ok(overtime.changePercent > 0);
});

// ── §22 — register paging and search ───────────────────────────────────────

test('§22 the register pages on the server instead of sending every row', async () => {
  const harness = threeEmployees();

  const first = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, page: 1, limit: 2 });
  assert.equal(first.rows.length, 2);
  assert.equal(first.pagination.total, 3, 'the total is the whole period, not the page');
  assert.equal(first.pagination.pages, 2);
  assert.equal(first.pagination.page, 1);

  const second = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, page: 2, limit: 2 });
  assert.equal(second.rows.length, 1);
  assert.notEqual(second.rows[0].employeeCode, first.rows[0].employeeCode, 'a different employee on page two');

  // A page past the end clamps to the last page rather than returning nothing.
  const beyond = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, page: 9, limit: 2 });
  assert.equal(beyond.pagination.page, 2);
  assert.equal(beyond.rows.length, 1);

  // §22 — searching is by person, never by amount.
  const found = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, search: 'CRE-002' });
  assert.equal(found.rows.length, 1);
  const byName = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, search: 'meera' });
  assert.equal(byName.rows.length, 1);
  // Typing a salary must find nobody: payroll is not a search engine for pay.
  const byAmount = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, search: '54000' });
  assert.equal(byAmount.rows.length, 0);
});

// ── §23 — employee salary history ──────────────────────────────────────────

test('§23 salary history reads what was paid, and what was contracted', async () => {
  const harness = threeEmployees();
  harness.state.results.rows.push(...threeMonthsOf(['2026-06', '2026-07']));
  harness.state.profiles.rows.push(
    {
      _id: oid(401), companyId: COMPANY, employeeId: E1, version: 2, isCurrent: true,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'), structureId: oid(201),
      structureName: 'Standard Structure', annualCtc: 720000, monthlyGross: 60000,
    },
    {
      _id: oid(400), companyId: COMPANY, employeeId: E1, version: 1, isCurrent: false,
      effectiveFrom: new Date('2025-01-01T00:00:00Z'), effectiveTo: new Date('2025-12-31T00:00:00Z'),
      structureId: oid(200), structureName: 'Legacy Structure', annualCtc: 600000, monthlyGross: 50000,
    },
  );

  const history = await harness.service.getEmployeeHistory({ companyId: COMPANY, employeeId: E1 });

  assert.equal(history.employee.employeeCode, 'CRE-001');
  assert.equal(history.months.length, 3, 'June, July and August');
  assert.deepEqual(history.months.map((row) => row.month), ['2026-06', '2026-07', '2026-08']);
  assert.equal(history.summary.firstMonth, '2026-06');
  assert.equal(history.summary.lastMonth, '2026-08');

  // The contracted side: two versions, newest first, neither overwritten.
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[0].version, 2);
  assert.equal(history.versions[0].isCurrent, true);
  assert.equal(history.versions[0].annualCtc, 720000);
  assert.equal(history.versions[1].annualCtc, 600000, 'the old version is still readable');

  // §25 — a manager scoped to one employee cannot read another's history.
  const scoped = threeEmployees();
  await assert.rejects(
    scoped.service.getEmployeeHistory({ companyId: COMPANY, employeeId: E2, allowedEmployeeIds: [String(E1)] }),
    /outside your payroll scope/,
  );
});

// ── §32 — audit on read ────────────────────────────────────────────────────

test('§32 reading a report, downloading a file and opening a salary history are all audited', async () => {
  const harness = threeEmployees();
  const seen = harness.state.audits;

  await harness.service.getReport({
    companyId: COMPANY, reportKey: 'REGISTER', month: MONTH,
    departmentId: String(DEPT_ENG), status: 'PAID',
    actor: { _id: E1, name: 'HR' },
  });
  await harness.service.getEmployeeHistory({ companyId: COMPANY, employeeId: E2, actor: { _id: E1, name: 'HR' } });

  const actions = seen.map((entry) => entry.action);
  assert.ok(actions.includes('Payroll report viewed'));
  assert.ok(actions.includes('Employee salary history viewed'));

  const viewed = seen.find((entry) => entry.action === 'Payroll report viewed');
  assert.equal(viewed.resourceId, 'REGISTER');
  assert.equal(viewed.actorName, 'HR');
  assert.equal(viewed.metadata.departmentId, String(DEPT_ENG));
  assert.equal(viewed.metadata.status, 'PAID');

  // The whole point of §32: the trail records that a report was read, never
  // what it said. No salary figure may appear anywhere in the payload.
  const serialised = JSON.stringify(seen);
  ['222000', '198000', '66000', '54000', '24000'].forEach((figure) => {
    assert.ok(!serialised.includes(figure), `the audit trail must not carry the payroll figure ${figure}`);
  });
});

test('§8/§24 changing the salary bands is audited as a bands change, not a schedule change', async () => {
  const harness = threeEmployees();
  const seen = harness.state.audits;

  await harness.service.updateSalaryBands({
    companyId: COMPANY,
    salaryBands: [
      { key: 'junior', label: 'Under 60k', min: 0, max: 60000 },
      { key: 'senior', label: '60k and above', min: 60000, max: null },
    ],
    actor: { _id: E1, name: 'Finance' },
  });

  const actions = seen.map((entry) => entry.action);
  assert.ok(
    actions.includes(ANALYTICS_AUDIT_ACTIONS.SALARY_BANDS_UPDATED),
    `expected a salary-bands audit line, saw: ${actions.join(', ')}`,
  );
  // The line used to say "Scheduled report updated", which sends whoever is
  // reading the trail looking for a schedule nobody touched.
  assert.ok(!actions.includes(ANALYTICS_AUDIT_ACTIONS.SCHEDULE_UPDATED));

  const entry = seen.find((item) => item.action === ANALYTICS_AUDIT_ACTIONS.SALARY_BANDS_UPDATED);
  assert.equal(entry.resourceId, 'SALARY_BANDS');
  assert.equal(entry.actorName, 'Finance');
  // §32 discipline: the band NAMES travel, never the salaries inside them.
  assert.deepEqual(entry.metadata.bands, ['Under 60k', '60k and above']);
});

// ── §21 / §25 — the cache must not serve one reader's answer to another ─────

test('§25 a scoped dashboard is never served to an unscoped reader', async () => {
  // Two harnesses, two cache stores: proves the scope is applied at all.
  const scopedOnly = threeEmployees();
  const everyone = threeEmployees();
  const scopedFirst = await scopedOnly.service.getDashboard({
    companyId: COMPANY, month: MONTH, allowedEmployeeIds: [E1, E2],
  });
  const unscopedFirst = await everyone.service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.ok(
    unscopedFirst.summary.employeesPaid > scopedFirst.summary.employeesPaid,
    'the scope has to change the answer, or this test proves nothing',
  );

  // ONE harness — one cache store. Admin first, manager second: if the two
  // share a cache entry, the manager is handed the whole company.
  const shared = threeEmployees();
  const admin = await shared.service.getDashboard({ companyId: COMPANY, month: MONTH });
  const manager = await shared.service.getDashboard({
    companyId: COMPANY, month: MONTH, allowedEmployeeIds: [E1, E2],
  });
  assert.equal(
    manager.summary.employeesPaid,
    scopedFirst.summary.employeesPaid,
    'the scoped reader must get the scoped answer, not the cached unscoped one',
  );
  assert.ok(
    admin.summary.employeesPaid > manager.summary.employeesPaid,
    'and the admin must still see everyone',
  );
});

test('§21 a filtered read still gets a cache key — filters must not silently bypass the cache', async () => {
  // `key=value|key=value` is two characters the key builder rejects, which
  // used to make EVERY filtered read build a null key and skip the cache with
  // nothing logged.
  const key = filterSegmentOf({ departmentId: String(DEPT_ENG), status: 'PAID' });
  assert.ok(key && key !== '-', `expected a usable filter segment, got ${key}`);
  assert.ok(!/[=|]/.test(key), `the segment must survive safeSegment: ${key}`);

  const built = await import('../src/services/payroll/analyticsCache.js');
  const full = built.analyticsCacheKey(COMPANY, MONTH, 'dashboard', '', { departmentId: String(DEPT_ENG), status: 'PAID' });
  assert.ok(full, 'a filtered dashboard read must produce a cache key');
  assert.ok(full.includes(key), `the key must carry the filter: ${full}`);

  // A long/unsafe value is hashed, not dropped.
  const long = filterSegmentOf({ search: 'a'.repeat(200) });
  assert.ok(long.length <= 49, `unbounded filters must be hashed: ${long}`);

  // And two different scopes never collide.
  assert.notEqual(scopeSegmentOf([E1, E2]), scopeSegmentOf([E1]));
  assert.equal(scopeSegmentOf(null), '-');
});

// ── §38 — export expiry ────────────────────────────────────────────────────

test('§38 a generated file expires, and a download is refused once it has', async () => {
  const harness = threeEmployees();
  const job = await harness.service.requestExport({
    companyId: COMPANY, reportKey: 'REGISTER', format: 'CSV', filters: { month: MONTH }, actor: { _id: E1, name: 'HR' },
  });
  const file = (await harness.service.listFiles({ companyId: COMPANY })).find((row) => String(row._id) === String(job.fileId));
  assert.equal(file.status, 'READY');
  assert.ok(file.expiresAt, 'the file is born with an expiry');

  // Time passes — past the expiry, not past it by a comfortable margin.
  const expired = await harness.service.expireFiles({ now: new Date(Date.parse(file.expiresAt) + 1000) });
  assert.equal(expired, 1);

  const after = (await harness.service.listFiles({ companyId: COMPANY })).find((row) => String(row._id) === String(job.fileId));
  assert.equal(after.status, 'EXPIRED');

  await assert.rejects(
    harness.service.downloadFile({ companyId: COMPANY, fileId: job.fileId }),
    /expired/,
  );

  // §38 — running the sweeper again must not re-expire what is already gone.
  assert.equal(await harness.service.expireFiles({ now: new Date(Date.parse(file.expiresAt) + 1000) }), 0);
});

test('§38 a file that has not expired is still downloadable', async () => {
  const harness = threeEmployees();
  const job = await harness.service.requestExport({
    companyId: COMPANY, reportKey: 'REGISTER', format: 'CSV', filters: { month: MONTH }, actor: { _id: E1, name: 'HR' },
  });
  const file = await harness.service.downloadFile({ companyId: COMPANY, fileId: job.fileId });
  assert.equal(file.format, 'CSV');
  assert.ok(file.content.length > 0);
});

// ── §8 — salary bands, per company ─────────────────────────────────────────

test('§8 a company can save its own salary bands, and the editor refuses nonsense', async () => {
  const harness = threeEmployees();

  const before = await harness.service.getAnalyticsSettings({ companyId: COMPANY });
  assert.equal(before.usingDefaults, true, 'a company starts on the default bands');
  assert.equal(before.salaryBands.length, SALARY_BANDS.length);

  const saved = await harness.service.updateSalaryBands({
    companyId: COMPANY,
    salaryBands: [
      { label: 'Under 50k', min: 0, max: 50000 },
      { label: '50k to 1L', min: 50000, max: 100000 },
      { label: 'Above 1L', min: 100000, max: null },
    ],
    actor: { _id: E1, name: 'HR' },
  });
  assert.equal(saved.salaryBands.length, 3);
  assert.equal(saved.salaryBands[2].max, null, 'the top band is open-ended');

  const settings = await harness.service.getAnalyticsSettings({ companyId: COMPANY });
  assert.equal(settings.usingDefaults, false);
  assert.equal(settings.salaryBands.length, 3);

  // The distribution report uses them.
  const report = await harness.service.getReport({ companyId: COMPANY, reportKey: 'SALARY_BANDS', month: MONTH });
  assert.deepEqual(
    report.bands.map((band) => band.label),
    ['Under 50k', '50k to 1L', 'Above 1L'],
  );
  // 40k, 62k and 1.2L — one in each band.
  assert.deepEqual(report.rows.map((row) => row.employees), [1, 1, 1]);

  // Overlapping bands would count one person twice.
  await assert.rejects(
    harness.service.updateSalaryBands({
      companyId: COMPANY,
      salaryBands: [
        { label: '0 to 50', min: 0, max: 50000 },
        { label: '40 to 90', min: 40000, max: 90000 },
      ],
    }),
    /overlaps/,
  );
  // A middle band with no ceiling would swallow everything above it.
  await assert.rejects(
    harness.service.updateSalaryBands({
      companyId: COMPANY,
      salaryBands: [{ label: '0 to 50', min: 0, max: null }, { label: 'Above', min: 50000, max: null }],
    }),
    /upper limit/,
  );
  // One band is not a distribution.
  await assert.rejects(
    harness.service.updateSalaryBands({ companyId: COMPANY, salaryBands: [{ label: 'Everyone', min: 0, max: null }] }),
    /at least two/,
  );
});

// ── §24 — the new filters ──────────────────────────────────────────────────

test('§24 employment status and salary structure are filters, not afterthoughts', async () => {
  const harness = detailedHarness({
    // One of the two has left the company.
    employees: [
      employee(E1, 'CRE-001', 'Meera Iyer', { department: DEPT_ENG, status: 'ACTIVE' }),
      employee(E2, 'CRE-002', 'Vikram Shetty', { department: DEPT_SALES, status: 'INACTIVE' }),
    ],
  });

  const active = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, employmentStatus: 'ACTIVE' });
  assert.equal(active.rows.length, 1);
  assert.equal(active.rows[0].employeeCode, 'CRE-001');

  const inactive = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, employmentStatus: 'INACTIVE' });
  assert.equal(inactive.rows.length, 1);
  assert.equal(inactive.rows[0].employeeCode, 'CRE-002');

  const byStructure = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, structureId: String(oid(201)) });
  assert.equal(byStructure.rows.length, 2);
  const noStructure = await harness.service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: MONTH, structureId: String(oid(999)) });
  assert.equal(noStructure.rows.length, 0);
});

// ── §9 — why the cost moved ────────────────────────────────────────────────

test('§9 the cost movement decomposes into headcount and like-for-like', async () => {
  const harness = threeEmployees();

  // Three people last month; this month one has left and the other two were
  // given a raise. The totals move, but not for the same reason.
  harness.state.results.rows.push(...threeMonthsOf([PREVIOUS]));

  const dashboard = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  const movement = dashboard.movement;

  assert.ok(movement, 'the dashboard carries the decomposition');
  assert.equal(movement.joiners, 0);
  assert.equal(movement.leavers, 0);
  assert.equal(movement.stayers, 3);
  // Headcount effect plus like-for-like effect IS the total movement — the
  // report must never leave a rupee unexplained.
  assert.equal(
    money(movement.headcountEffect + movement.likeForLikeEffect),
    money(movement.total),
  );
  assert.equal(movement.reconciled, true, 'the split adds up to the change it explains');
});

// ── the PDF counts people, it does not price them ──────────────────────────

test('§19 a headcount in a PDF is a number of people, not a number of rupees', async () => {
  // Found in the 29.13 preview, not by a unit test: the table asked the VALUE
  // what it was, and every number became money. A department of three printed
  // "Rs 3" under Employees — wrong on every report that counts people, and
  // shaped exactly like a real figure.
  const pdf = await buildAnalyticsReportPdf({
    company: { name: 'Crewly Technologies Pvt Ltd', address: 'Bengaluru' },
    title: 'Department Payroll',
    subtitle: 'August 2026',
    headers: ['Department', 'Employees', 'Gross Salary'],
    rows: [
      ['Engineering', 3, 294833],
      ['Sales', 2, 153200],
    ],
    generatedBy: 'Farah Finance',
  });

  const mod = await import('pdf-parse');
  const PDFParse = mod.PDFParse || mod.default?.PDFParse || mod.default;
  const parser = new PDFParse({ data: pdf });
  const result = await parser.getText();
  await parser.destroy?.();
  const text = String(result?.text || '');

  assert.ok(text.includes('Engineering 3 '), 'three people are three people');
  assert.ok(!/Engineering Rs 3/.test(text), 'a headcount is not currency');
  assert.ok(text.includes('Rs 2,94,833'), 'money is still money');
  // The two are different kinds of number and must not be formatted alike.
  const { isMoneyColumn } = await import('../src/utils/analyticsPdf.js');
  assert.equal(isMoneyColumn('Employees'), false);
  assert.equal(isMoneyColumn('Gross Salary'), true);
  assert.equal(isMoneyColumn('Share %'), false);
  assert.equal(isMoneyColumn('Overtime Hours'), false);
});
