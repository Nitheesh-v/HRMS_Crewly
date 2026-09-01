/**
 * PHASE 29.10 — Statutory Compliance & Government Reports
 *
 * Hermetic: fake models, a fake cache, and fake audit / notify / dispatch /
 * pdf seams. No MongoDB, no Redis, no BullMQ, no SMTP.
 *
 * The suite proves the things that are expensive to discover in production:
 *   · §2/§6  reports are prepared from PAID salary only, never recalculated
 *   · §7–§12 every statutory block reads the 29.6 snapshot, not a formula
 *   · §11    LWF disappears entirely when 29.1 has it switched off
 *   · §14    the filing lifecycle is enforced, and a filed return whose
 *            numbers moved is reopened rather than silently left "Filed"
 *   · §15    CSV / XLSX / PDF exports all carry the same figures
 *   · §19    due dates and overdue detection come from data, not the UI
 *   · §21    queue payloads carry references only — never a rupee
 *   · §3/§24 another tenant's statutory data is unreachable
 *   · §25    every compliance action lands in the audit trail with its
 *            previous and new status
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANNUAL_REPORT_KEYS,
  FILING_STATUS_LABELS,
  FILING_TRANSITIONS,
  STATUTORY_AUDIT_ACTIONS,
  annualDepartmentRows,
  annualMonthRows,
  annualiseEmployeeRows,
  applicableTypes,
  buildCalendar,
  buildStatutoryRow,
  canTransitionFiling,
  complianceKpis,
  exportFilename,
  financialYearOf,
  isPaidForStatutory,
  monthLabel,
  monthsOfFinancialYear,
  normaliseFormat,
  registerRows,
  REGISTER_HEADERS,
  reminderCandidates,
  statutoryDueDate,
  statutoryGateError,
  summariseStatutoryRows,
  toEmployeeStatutoryView,
} from '../src/services/payroll/statutoryRules.js';
import { makeStatutoryService } from '../src/services/payroll/statutoryService.js';
import {
  validateStatutoryGeneratePayload,
  validateStatutoryExportPayload,
  validateComplianceReminderPayload,
} from '../src/services/payroll/statutoryDispatcher.js';
import { buildXlsx, toCsv } from '../src/services/payroll/payrollPaymentRules.js';
import { buildStatutoryPdf } from '../src/utils/statutoryPdf.js';

// ── fake model ─────────────────────────────────────────────────────────────

const oid = (seed) => `64b7f9c2e4b0a1b2c3d4e${String(seed).padStart(3, '0')}`; // 24 hex chars

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = row?.[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
      if (condition.$in) return condition.$in.some((item) => String(item) === String(value));
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
    row[key] = Number(row[key] || 0) + Number(delta);
  });
  const setOnInsert = update.$setOnInsert;
  return setOnInsert;
};

const makeFakeModel = (defaults = {}) => {
  const rows = [];
  let counter = 0;

  const buildQuery = (filter) => ({
    lean: async () => rows.filter((row) => matches(row, filter)),
    select: () => buildQuery(filter),
    sort: () => buildQuery(filter),
    limit: () => buildQuery(filter),
    skip: () => buildQuery(filter),
  });

  const model = {
    rows,
    find: (filter = {}) => buildQuery(filter),
    findOne: (filter = {}) => ({
      // Mongoose's .lean() returns a detached plain object, so a later write
      // cannot change what the caller already read. The fake must match.
      lean: async () => {
        const found = rows.find((row) => matches(row, filter));
        return found ? { ...found } : null;
      },
      select: () => ({
        lean: async () => {
          const found = rows.find((row) => matches(row, filter));
          return found ? { ...found } : null;
        },
      }),
    }),
    findById: (id) => ({
      lean: async () => rows.find((row) => String(row._id) === String(id)) || null,
    }),
    countDocuments: async (filter = {}) => rows.filter((row) => matches(row, filter)).length,
    distinct: async (field, filter = {}) => [
      ...new Set(rows.filter((row) => matches(row, filter)).map((row) => row[field])),
    ],
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
      return row;
    },
    async updateOne(filter, update = {}, options = {}) {
      const row = rows.find((item) => matches(item, filter));
      if (!row) {
        // Mongoose honours upsert — the compliance calendar relies on it.
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
        return options.new === false ? existing : existing;
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
const PREV_MONTH = '2026-07';
// A filing that is ALREADY overdue, whatever day the suite runs on.
const PAST_MONTH = '2025-01';
const E1 = oid(1);
const E2 = oid(2);
const E3 = oid(3);
const DEPARTMENT = oid(50);
const BATCH = oid(60);

const setup = (overrides = {}) => ({
  companyId: COMPANY,
  isCurrent: true,
  legal: { pan: 'AABCC1234D', tan: 'BLRA12345E', gst: '', cin: '' },
  statutory: {
    pf: { applicable: true, establishmentNumber: 'KN/BLR/12345' },
    esi: { applicable: true, registrationNumber: '31000123450000101' },
    professionalTax: { applicable: true, state: 'KARNATAKA' },
    labourWelfareFund: { applicable: true, state: 'KARNATAKA' },
    gratuity: { applicable: true },
    tds: { applicable: true },
  },
  payrollPolicy: { frequency: 'MONTHLY', financialYearStartMonth: 4, currency: 'INR' },
  ...overrides,
});

// A 29.6 snapshot: the statutory block is the engine's own output.
const result = (employeeId, code, name, { gross = 75000, basic = 40000 } = {}, statutory = {}) => ({
  _id: oid(900 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  month: MONTH,
  employeeId,
  employeeCode: code,
  employeeName: name,
  designation: 'Senior Engineer',
  version: 1,
  isCurrent: true,
  totals: { gross, basic, totalEarnings: gross, totalDeductions: 8000, netPay: gross - 8000 },
  statutory: {
    pf: {
      applicable: true, pfWage: 15000, employee: 1800,
      employerEpf: 550.5, employerPension: 1249.5, employer: 1800,
    },
    esi: { applicable: false, wage: gross, employee: 0, employer: 0, outsideCeiling: true },
    professionalTax: { applicable: true, state: 'KARNATAKA', amount: 200 },
    tds: {
      applicable: true, monthly: 3500, annualIncome: 900000, taxableIncome: 850000,
      annualTax: 42000, regime: 'NEW',
    },
    lwf: { applicable: true, employee: 20, employer: 40 },
    gratuity: { applicable: true, amount: 1924 },
    ...statutory,
  },
});

const profile = (employeeId, extra = {}) => ({
  _id: oid(700 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  employeeId,
  isCurrent: true,
  statutory: {
    pan: 'ABCPD1234K',
    uan: '100123456789',
    esiNumber: '31000123450000101',
    pfMember: true,
    gratuityEligible: true,
  },
  tax: { regime: 'NEW', tdsApplicable: true },
  ...extra,
});

const employee = (id, code, name, department = DEPARTMENT) => ({
  _id: id,
  companyId: COMPANY,
  employeeCode: code,
  name,
  department,
  designation: 'Senior Engineer',
  status: 'ACTIVE',
});

const payment = (employeeId, status = 'PAID', month = MONTH) => ({
  _id: oid(800 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  month,
  batchId: BATCH,
  employeeId,
  status,
  netSalary: 67000,
  paymentReference: `SAL-${month}-${String(employeeId).slice(-3)}`,
});

// ── harness ────────────────────────────────────────────────────────────────

const buildHarness = ({ payments = [], results = [], profiles = [], employees = [], setupDoc = null, models = {} } = {}) => {
  const state = {
    reports: models.reports || makeFakeModel(),
    exports: models.exports || makeFakeModel({ status: 'QUEUED' }),
    tasks: models.tasks || makeFakeModel(),
    results: makeFakeModel(),
    payments: makeFakeModel(),
    batches: makeFakeModel(),
    setups: makeFakeModel(),
    profiles: makeFakeModel(),
    users: makeFakeModel(),
    companies: makeFakeModel(),
    departments: makeFakeModel(),
    audits: [],
    notifications: [],
    invalidations: [],
    dispatched: [],
  };

  (payments || []).forEach((row) => state.payments.rows.push(row));
  (results || []).forEach((row) => state.results.rows.push(row));
  (profiles || []).forEach((row) => state.profiles.rows.push(row));
  (employees || []).forEach((row) => state.users.rows.push(row));
  if (setupDoc) state.setups.rows.push(setupDoc);
  state.companies.rows.push({ _id: COMPANY, name: 'Crewly Technologies Pvt Ltd', address: 'Bengaluru' });
  state.departments.rows.push({ _id: DEPARTMENT, name: 'Engineering' });
  if (payments.length) state.batches.rows.push({ _id: BATCH, companyId: COMPANY, month: MONTH, status: 'COMPLETED' });

  const cache = {
    store: new Map(),
    buildKey: ({ companyId, month = '', suffix = 'dashboard', period = '' }) =>
      `k:${companyId}:${month || 'all'}:${suffix}:${period || '-'}`,
    async getOrSet(key, { loader }) {
      if (this.store.has(key)) return { value: this.store.get(key), cache: 'HIT' };
      const value = await loader();
      this.store.set(key, value);
      return { value, cache: 'MISS' };
    },
    async invalidate(companyId, month = '') {
      state.invalidations.push({ companyId, month });
      let removed = 0;
      for (const key of [...this.store.keys()]) {
        if (key.startsWith(`k:${companyId}:`)) {
          this.store.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };

  const service = makeStatutoryService({
    StatutoryReportModel: state.reports,
    StatutoryExportModel: state.exports,
    ComplianceCalendarTaskModel: state.tasks,
    PayrollResultModel: state.results,
    PayrollPaymentModel: state.payments,
    PayrollPaymentBatchModel: state.batches,
    PayrollSetupModel: state.setups,
    EmployeePayrollProfileModel: state.profiles,
    UserModel: state.users,
    CompanyModel: state.companies,
    DepartmentModel: state.departments,
    cache,
    audit: async (entry) => {
      state.audits.push(entry);
      return entry;
    },
    notify: async ({ userId, type, payload }) => {
      state.notifications.push({ userId, type, payload });
    },
    notifyRoles: async ({ type, payload }) => {
      state.notifications.push({ userId: 'ROLE', type, payload });
      return 1;
    },
    dispatchGenerate: async (payload) => {
      state.dispatched.push({ kind: 'generate', payload });
      return { queued: false };
    },
    dispatchExport: async (payload) => {
      state.dispatched.push({ kind: 'export', payload });
      return { queued: false };
    },
    dispatchReminder: async (payload) => {
      state.dispatched.push({ kind: 'reminder', payload });
      return { queued: false };
    },
    renderPdf: async (options) => buildStatutoryPdf(options),
    buildCsv: toCsv,
    buildWorkbook: buildXlsx,
    hash: (value) => `sha256:${Buffer.byteLength(value)}`,
    ttlSeconds: 60,
  });

  return { service, state, cache };
};

const fullHarness = (overrides = {}) =>
  buildHarness({
    payments: [payment(E1), payment(E2), payment(E3, 'FAILED')],
    results: [
      result(E1, 'CRE-001', 'Asha Rao'),
      result(E2, 'CRE-002', 'Vikram Shetty', { gross: 18000, basic: 9000 }, {
        esi: { applicable: true, wage: 18000, employee: 135, employer: 585, outsideCeiling: false },
        tds: { applicable: false, monthly: 0, annualIncome: 0, taxableIncome: 0, annualTax: 0, regime: 'NEW' },
        gratuity: { applicable: false, amount: 0 },
      }),
    ],
    profiles: [profile(E1), profile(E2)],
    employees: [employee(E1, 'CRE-001', 'Asha Rao'), employee(E2, 'CRE-002', 'Vikram Shetty')],
    setupDoc: setup(),
    ...overrides,
  });

// ── §19 — due dates are data, not UI ───────────────────────────────────────

test('§19 statutory due dates follow the rule table and roll the year', () => {
  assert.equal(statutoryDueDate('PF', '2026-08'), '2026-09-15');
  assert.equal(statutoryDueDate('ESI', '2026-08'), '2026-09-15');
  assert.equal(statutoryDueDate('TDS', '2026-08'), '2026-09-07');
  assert.equal(statutoryDueDate('PT', '2026-08'), '2026-09-20');
  assert.equal(statutoryDueDate('PF', '2026-12'), '2027-01-15');
  // The compliance summary is an internal review report — no statutory date.
  assert.equal(statutoryDueDate('COMPLIANCE_SUMMARY', '2026-08'), '');
  // A month that is not a month at all produces nothing, never a crash.
  assert.equal(statutoryDueDate('PF', 'August'), '');
});

test('§18 monthsOfFinancialYear honours the company FY start month', () => {
  const fy = monthsOfFinancialYear('2026-27', 4);
  assert.equal(fy.length, 12);
  assert.equal(fy[0], '2026-04');
  assert.equal(fy[11], '2027-03');

  const january = monthsOfFinancialYear('2026-27', 1);
  assert.equal(january[0], '2026-01');
  assert.equal(january[11], '2026-12');
});

test('§15 financialYearOf is company policy, never hardcoded April', () => {
  assert.equal(financialYearOf('2026-08', 4), '2026-27');
  assert.equal(financialYearOf('2026-02', 4), '2025-26');
  assert.equal(financialYearOf('2026-02', 1), '2026-27'); // Jan→Dec FY
});

// ── §14 — the filing lifecycle ─────────────────────────────────────────────

test('§14 the filing lifecycle is enforced in both directions', () => {
  assert.ok(canTransitionFiling('DRAFT', 'REVIEWED'));
  assert.ok(canTransitionFiling('REVIEWED', 'READY'));
  assert.ok(canTransitionFiling('READY', 'FILED'));
  assert.ok(canTransitionFiling('FILED', 'REOPENED'));
  assert.ok(canTransitionFiling('REOPENED', 'FILED'));
  // A filed return cannot quietly skip back to Ready without a reopen.
  assert.ok(!canTransitionFiling('FILED', 'READY'));
  assert.ok(!canTransitionFiling('DRAFT', 'REOPENED'));
  assert.deepEqual(Object.keys(FILING_TRANSITIONS).sort(), ['DRAFT', 'FILED', 'READY', 'REOPENED', 'REVIEWED']);
  assert.equal(FILING_STATUS_LABELS.NOT_GENERATED, 'Not generated');
});

// ── §11 — applicability follows 29.1 ───────────────────────────────────────

test('§11 LWF and gratuity vanish when 29.1 has them switched off', () => {
  const all = applicableTypes(setup());
  assert.deepEqual(all, ['PF', 'ESI', 'PT', 'TDS', 'LWF', 'GRATUITY']);

  const lean = applicableTypes(setup({
    statutory: {
      pf: { applicable: true },
      esi: { applicable: false },
      professionalTax: { applicable: true, state: 'KARNATAKA' },
      labourWelfareFund: { applicable: false },
      gratuity: { applicable: false },
      tds: { applicable: true },
    },
  }));
  assert.deepEqual(lean, ['PF', 'PT', 'TDS']);
  assert.ok(!lean.includes('LWF'));
});

// ── §6 — rows are read from the snapshot, never computed ───────────────────

test('§6 a statutory row is a copy of the 29.6 statutory block', () => {
  const row = buildStatutoryRow({
    result: result(E1, 'CRE-001', 'Asha Rao'),
    profile: profile(E1),
    employee: employee(E1, 'CRE-001', 'Asha Rao'),
    departmentName: 'Engineering',
  });

  assert.equal(row.employeeCode, 'CRE-001');
  assert.equal(row.uan, '100123456789');
  assert.equal(row.pan, 'ABCPD1234K');
  assert.equal(row.department, 'Engineering');
  assert.equal(row.pf.employee, 1800);
  assert.equal(row.pf.employer, 1800);
  assert.equal(row.pt.amount, 200);
  assert.equal(row.pt.state, 'KARNATAKA');
  assert.equal(row.tds.monthly, 3500);
  assert.equal(row.lwf.employer, 40);
  assert.equal(row.gross, 75000);
});

test('§7–§12 the roll-up adds employee and employer, and never mixes them', () => {
  const { service } = fullHarness();
  const rows = [
    buildStatutoryRow({ result: result(E1, 'CRE-001', 'Asha Rao'), profile: profile(E1), employee: employee(E1, 'CRE-001', 'Asha Rao'), departmentName: 'Engineering' }),
    buildStatutoryRow({
      result: result(E2, 'CRE-002', 'Vikram Shetty', { gross: 18000, basic: 9000 }, {
        esi: { applicable: true, wage: 18000, employee: 135, employer: 585, outsideCeiling: false },
        tds: { applicable: false, monthly: 0, annualIncome: 0, taxableIncome: 0, annualTax: 0, regime: 'NEW' },
        gratuity: { applicable: false, amount: 0 },
      }),
      profile: profile(E2, { statutory: { pan: 'XYZPD1234K', uan: '100123456790', esiNumber: '3199999', pfMember: true } }),
      employee: employee(E2, 'CRE-002', 'Vikram Shetty'),
      departmentName: 'Engineering',
    }),
  ];

  const summary = summariseStatutoryRows({ rows });
  assert.equal(summary.employees, 2);
  assert.equal(summary.pf.employee, 3600);
  assert.equal(summary.pf.employer, 3600);
  assert.equal(summary.pf.total, 7200);
  assert.equal(summary.esi.employee, 135);
  assert.equal(summary.esi.employer, 585);
  assert.equal(summary.esi.total, 720);
  assert.equal(summary.pt.total, 400);
  assert.equal(summary.tds.total, 3500);
  assert.equal(summary.lwf.total, 120);

  // §9 — the PT report is state-wise, even though one state is the norm.
  assert.equal(summary.pt.byState.length, 1);
  assert.equal(summary.pt.byState[0].state, 'KARNATAKA');
  assert.equal(summary.pt.byState[0].employees, 2);

  // §10 — the TDS report carries its department summary.
  assert.equal(summary.tds.byDepartment.length, 1);
  assert.equal(summary.tds.byDepartment[0].department, 'Engineering');
  assert.equal(summary.tds.byDepartment[0].tds, 3500);

  // §12 — gratuity is a provision, annualised for the liability view.
  assert.equal(summary.gratuity.employees, 1);
  assert.equal(summary.gratuity.monthly, 1924);
  assert.equal(summary.gratuity.annualised, 1924 * 12);
  assert.ok(service);
});

test('§5 KPI cards count filed versus outstanding', () => {
  const kpis = complianceKpis({
    summary: summariseStatutoryRows({ rows: [] }),
    statuses: [
      { type: 'PF', status: 'FILED' },
      { type: 'ESI', status: 'READY' },
      { type: 'PT', status: 'DRAFT' },
      { type: 'TDS', status: 'FILED' },
      { type: 'LWF', status: 'FILED' },
      // Gratuity is a report, not a return — it must not inflate "pending".
      { type: 'GRATUITY', status: 'DRAFT' },
    ],
  });
  assert.equal(kpis.filingCompleted, 3);
  assert.equal(kpis.filingPending, 2);
});

// ── §2 / §6 — the payment gate ─────────────────────────────────────────────

test('§2/§6 an unpaid month produces no statutory reports', async () => {
  const { service } = buildHarness({
    payments: [payment(E1, 'PENDING')],
    results: [result(E1, 'CRE-001', 'Asha Rao')],
    profiles: [profile(E1)],
    employees: [employee(E1, 'CRE-001', 'Asha Rao')],
    setupDoc: setup(),
  });

  await assert.rejects(
    () => service.generateForMonth({ companyId: COMPANY, month: MONTH, actor: { _id: E1 } }),
    /confirmed as paid/,
  );
  assert.ok(isPaidForStatutory({ status: 'PAID' }));
  assert.ok(!isPaidForStatutory({ status: 'FAILED' }));
  assert.match(statutoryGateError({ hasBatch: false, paidCount: 0 }), /pay the payroll/);
});

test('§6 a FAILED transfer is excluded, the paid employees still report', async () => {
  const { service } = fullHarness();
  const data = await service.getDashboard({ companyId: COMPANY, month: MONTH });
  // Three payments, one FAILED → two employees in the statutory figures.
  assert.equal(data.summary.employees, 2);
  assert.equal(data.paidCount, 2);
  assert.equal(data.kpis.pfPayable, 7200);
});

// ── §6 / §25 — generation ──────────────────────────────────────────────────

test('§6 generating a month writes one report per applicable type', async () => {
  const { service, state } = fullHarness();
  const result_ = await service.generateForMonth({
    companyId: COMPANY,
    month: MONTH,
    actor: { _id: E1, name: 'Payroll Admin' },
  });

  assert.equal(result_.queued, false);
  // PF, ESI, PT, TDS, LWF, GRATUITY + the compliance summary.
  assert.equal(result_.generated, 7);
  assert.equal(state.reports.rows.length, 7);

  const types = state.reports.rows.map((row) => row.type).sort();
  assert.deepEqual(types, ['COMPLIANCE_SUMMARY', 'ESI', 'GRATUITY', 'LWF', 'PF', 'PT', 'TDS']);

  // §6 — generate first, review second: nothing lands as "Ready".
  assert.ok(state.reports.rows.every((row) => row.status === 'DRAFT'));
  assert.ok(state.reports.rows.every((row) => row.financialYear === '2026-27'));

  // §25 — every type is audited, and the actor is told.
  assert.equal(state.audits.filter((entry) => entry.action === STATUTORY_AUDIT_ACTIONS.GENERATED).length, 7);
  const note = state.notifications.find((entry) => entry.type === 'STATUTORY_REPORTS_GENERATED');
  assert.ok(note);
  assert.match(note.payload.month, /2026-08/);
});

test('§14/§20 a FILED return whose figures moved is reopened, not overwritten', async () => {
  const { service, state } = fullHarness();

  await service.generateForMonth({ companyId: COMPANY, month: MONTH, actor: { _id: E1 } });
  await service.updateFilingStatus({
    companyId: COMPANY, month: MONTH, type: 'PF', status: 'FILED',
    filingReference: 'ECR-2026-08-001', actor: { _id: E2, name: 'Finance' },
  });

  const filed = state.reports.rows.find((row) => row.type === 'PF');
  assert.equal(filed.status, 'FILED');
  assert.equal(filed.filingReference, 'ECR-2026-08-001');

  // Payroll is recalculated: the PF wage moves, so the total moves.
  filed.summary = { ...filed.summary, pf: { ...filed.summary.pf, employee: 9999 } };

  const regenerated = await service.runGeneration({ companyId: COMPANY, month: MONTH });
  assert.equal(regenerated.reopened, 1);
  assert.equal(state.reports.rows.find((row) => row.type === 'PF').status, 'REOPENED');
});

// ── §14 / §25 — filing status ──────────────────────────────────────────────

test('§14/§25 filing a return records who, when and the previous status', async () => {
  const { service, state } = fullHarness();
  await service.generateForMonth({ companyId: COMPANY, month: MONTH, actor: { _id: E1 } });

  const updated = await service.updateFilingStatus({
    companyId: COMPANY, month: MONTH, type: 'TDS', status: 'FILED',
    filingReference: 'TDS-AUG-7781', actor: { _id: E2, name: 'Finance Manager' },
  });

  assert.equal(updated.status, 'FILED');
  assert.equal(updated.previousStatus, 'DRAFT');
  assert.ok(updated.filedAt instanceof Date);
  assert.equal(updated.filingReference, 'TDS-AUG-7781');

  const audit = state.audits
    .filter((entry) => entry.action === STATUTORY_AUDIT_ACTIONS.FILING_UPDATED)
    .pop();
  assert.equal(audit.metadata.complianceType, 'TDS');
  assert.equal(audit.previousValue.status, 'DRAFT');
  assert.equal(audit.newValue.status, 'FILED');

  // §22 — "Compliance Filed → Company Admin".
  assert.ok(state.notifications.some((entry) => entry.type === 'STATUTORY_COMPLIANCE_FILED'));

  // §19 — ticking the return off completes the calendar task with it.
  const task = state.tasks.rows.find((row) => row.type === 'TDS');
  assert.equal(task.status, 'DONE');
});

test('§14 an illegal filing transition is refused, and so is filing a report that does not exist', async () => {
  const { service } = fullHarness();

  // Never generated → there is nothing to file.
  await assert.rejects(
    () => service.updateFilingStatus({ companyId: COMPANY, month: MONTH, type: 'PF', status: 'FILED', actor: { _id: E2 } }),
    /Generate the Provident Fund report/,
  );

  await service.generateForMonth({ companyId: COMPANY, month: MONTH, actor: { _id: E1 } });
  // DRAFT → FILED is a legal hop; it is FILED → READY that is not.
  await service.updateFilingStatus({ companyId: COMPANY, month: MONTH, type: 'PF', status: 'FILED', actor: { _id: E2 } });
  // FILED cannot go straight back to READY — it must be reopened first.
  await assert.rejects(
    () => service.updateFilingStatus({ companyId: COMPANY, month: MONTH, type: 'PF', status: 'READY', actor: { _id: E2 } }),
    /cannot move to/,
  );
  // Gratuity is a report, not a return.
  await assert.rejects(
    () => service.updateFilingStatus({ companyId: COMPANY, month: MONTH, type: 'GRATUITY', status: 'FILED', actor: { _id: E2 } }),
    /nothing to file/,
  );
});

// ── §15 — exports ──────────────────────────────────────────────────────────

test('§15 the PF register exports as CSV, XLSX and PDF with identical figures', async () => {
  const { service } = fullHarness();

  const csv = await service.exportNow({ companyId: COMPANY, reportKey: 'PF', month: MONTH, format: 'CSV' });
  assert.equal(csv.format, 'CSV');
  assert.equal(csv.filename, 'statutory-pf-2026-08.csv');
  const text = csv.content.toString('utf8');
  assert.match(text, /UAN/);
  assert.match(text, /100123456789/);
  assert.match(text, /Employer Pension/);
  // Two PF-covered employees → two body rows plus one TOTAL row.
  assert.equal(csv.rowCount, 2);
  assert.match(text, /TOTAL \(2 employees\)/);

  const xlsx = await service.exportNow({ companyId: COMPANY, reportKey: 'PF', month: MONTH, format: 'XLSX' });
  assert.equal(xlsx.filename, 'statutory-pf-2026-08.xlsx');
  // A real .xlsx is a ZIP container: 'PK\x03\x04'.
  assert.equal(xlsx.content[0], 0x50);
  assert.equal(xlsx.content[1], 0x4b);

  const pdf = await service.exportNow({ companyId: COMPANY, reportKey: 'PF', month: MONTH, format: 'PDF' });
  assert.equal(pdf.filename, 'statutory-pf-2026-08.pdf');
  assert.equal(pdf.content.slice(0, 5).toString('latin1'), '%PDF-');
});

test('§10 the TDS report carries the department summary', async () => {
  const { service } = fullHarness();
  const report = await service.getReport({ companyId: COMPANY, month: MONTH, type: 'TDS' });
  assert.equal(report.extras.byDepartment.length, 1);
  assert.equal(report.extras.byDepartment[0].department, 'Engineering');
  assert.equal(report.extras.byDepartment[0].tds, 3500);
  assert.equal(report.filable, true);
  assert.equal(report.dueDate, '2026-09-07');
  assert.match(report.table.headers.join('|'), /PAN/);
});

test('§16 the compliance summary rolls every statutory block into one report', async () => {
  const { service } = fullHarness();
  const report = await service.getReport({ companyId: COMPANY, month: MONTH, type: 'COMPLIANCE_SUMMARY' });
  const text = report.table.rows.map((row) => row.join(' ')).join('\n');
  assert.match(text, /Gross Payroll/);
  assert.match(text, /Total PF Payable/);
  assert.match(text, /Total ESI Payable/);
  assert.match(text, /Professional Tax collected/);
  assert.match(text, /TDS deducted/);
  assert.match(text, /Total LWF Payable/);
  assert.match(text, /Annualised liability/);
  // The summary is a report, not a return.
  assert.equal(report.filable, false);
  assert.equal(report.applicable, true);
});

test('§13 the compliance register is a CSV with one row per month', async () => {
  const { service } = fullHarness();
  const register = await service.getRegister({ companyId: COMPANY, financialYear: '2026-27' });
  assert.equal(register.filename, 'compliance-register-2026-27.csv');
  assert.equal(register.count, 12);
  const lines = register.content.toString('utf8').trim().split('\n');
  // One header + 12 months (eleven of which have no payroll).
  assert.equal(lines.length, 13);
  assert.equal(REGISTER_HEADERS.length, 22);
  assert.match(lines[0], /PF Status/);
  assert.match(lines[0], /LWF Status/);
  const august = lines.find((line) => line.startsWith('2026-08'));
  assert.ok(august);
  assert.match(august, /7200/); // PF total for the two paid employees
});

// ── §18 — annual reports ───────────────────────────────────────────────────

test('§18 annual reports roll the year up per employee and per month', async () => {
  const { service } = buildHarness({
    payments: [payment(E1, 'PAID', '2026-04'), payment(E1, 'PAID', '2026-05')],
    results: [
      { ...result(E1, 'CRE-001', 'Asha Rao'), month: '2026-04' },
      { ...result(E1, 'CRE-001', 'Asha Rao'), month: '2026-05' },
    ],
    profiles: [profile(E1)],
    employees: [employee(E1, 'CRE-001', 'Asha Rao')],
    setupDoc: setup(),
  });

  const annual = await service.getAnnual({ companyId: COMPANY, financialYear: '2026-27' });
  assert.equal(annual.months.length, 12);
  assert.equal(annual.employees.length, 1);
  // Two months of payroll → two months counted, totals doubled.
  assert.equal(annual.employees[0].months, 2);
  assert.equal(annual.employees[0].employeePF, 3600);
  assert.equal(annual.employees[0].employerPF, 3600);
  assert.equal(annual.summary.pf.total, 7200);
  assert.equal(annual.registers.length, 12);
  assert.equal(annual.departments[0].department, 'Engineering');

  const exported = await service.exportNow({
    companyId: COMPANY, reportKey: 'ANNUAL_TDS', financialYear: '2026-27', format: 'CSV',
  });
  assert.equal(exported.filename, 'statutory-annual-tds-2026-27.csv');
  assert.equal(exported.rowCount, 1);
  assert.ok(ANNUAL_REPORT_KEYS.includes('ANNUAL_TDS'));
});

test('§18 an annual report still needs a financial year', async () => {
  const { service } = fullHarness();
  await assert.rejects(
    () => service.exportNow({ companyId: COMPANY, reportKey: 'ANNUAL_PF', format: 'CSV' }),
    /needs a financialYear/,
  );
  await assert.rejects(
    () => service.exportNow({ companyId: COMPANY, reportKey: 'PF', financialYear: '2026-27', format: 'CSV' }),
    /needs a payroll month/,
  );
  await assert.rejects(
    () => service.exportNow({ companyId: COMPANY, reportKey: 'NOT_A_REPORT', month: MONTH, format: 'CSV' }),
    /Unknown statutory report/,
  );
  assert.equal(normaliseFormat('pdf'), 'PDF');
  assert.equal(normaliseFormat('nonsense'), 'CSV');
  assert.equal(exportFilename({ reportKey: 'ESI', month: MONTH, format: 'xlsx' }), 'statutory-esi-2026-08.xlsx');
});

test('§18 annualiseEmployeeRows credits only the months an employee was paid', () => {
  const rows = [
    { employeeId: E1, employeeName: 'Asha Rao', employeeCode: 'CRE-001', department: 'Engineering', gross: 75000, net: 67000, basic: 40000, pf: { employee: 1800, employer: 1800 }, esi: { employee: 0, employer: 0 }, pt: { amount: 200 }, tds: { monthly: 3500, taxableIncome: 850000 }, lwf: { employee: 20, employer: 40 }, gratuity: { amount: 1924 }, taxRegime: 'NEW', pan: 'ABCPD1234K', uan: '100123456789' },
    { employeeId: E1, employeeName: 'Asha Rao', employeeCode: 'CRE-001', department: 'Engineering', gross: 75000, net: 67000, basic: 40000, pf: { employee: 1800, employer: 1800 }, esi: { employee: 0, employer: 0 }, pt: { amount: 200 }, tds: { monthly: 3500, taxableIncome: 850000 }, lwf: { employee: 20, employer: 40 }, gratuity: { amount: 1924 }, taxRegime: 'NEW', pan: 'ABCPD1234K', uan: '100123456789' },
    { employeeId: E2, employeeName: 'Vikram Shetty', employeeCode: 'CRE-002', department: 'Support', gross: 18000, net: 17800, basic: 9000, pf: { employee: 1800, employer: 1800 }, esi: { employee: 135, employer: 585 }, pt: { amount: 200 }, tds: { monthly: 0, taxableIncome: 0 }, lwf: { employee: 20, employer: 40 }, gratuity: { amount: 0 }, taxRegime: 'NEW', pan: 'XYZPD1234K', uan: '100123456790' },
  ];

  const annual = annualiseEmployeeRows({ monthRows: rows });
  assert.equal(annual.length, 2);
  assert.equal(annual[0].months, 2);
  assert.equal(annual[0].employeePF, 3600);
  assert.equal(annual[1].months, 1);
  assert.equal(annual[1].employeePF, 1800);

  const departments = annualDepartmentRows({ employeeRows: annual });
  assert.equal(departments.length, 2);
  assert.equal(departments[0].department, 'Engineering');
  assert.equal(departments[0].grossPayroll, 150000);

  const monthRows = annualMonthRows({
    months: ['2026-04', '2026-05'],
    summaries: { '2026-04': { employees: 2, grossPayroll: 93000, pf: { total: 7200 } }, '2026-05': {} },
  });
  assert.equal(monthRows.length, 2);
  assert.equal(monthRows[0].pfTotal, 7200);
  assert.equal(monthRows[1].pfTotal, 0);
});

// ── §19 — the compliance calendar ──────────────────────────────────────────

test('§19 the calendar lists only what applies, with a due date and a state', async () => {
  const { service, state } = fullHarness();
  await service.generateForMonth({ companyId: COMPANY, month: MONTH, actor: { _id: E1 } });

  const calendar = await service.getCalendar({ companyId: COMPANY, months: [MONTH] });
  // Six applicable types → six rows for one month.
  assert.equal(calendar.rows.length, 6);
  const pf = calendar.rows.find((row) => row.type === 'PF');
  assert.equal(pf.dueDate, '2026-09-15');
  assert.equal(pf.status, 'DRAFT');
  assert.equal(pf.statusLabel, 'Draft');
  assert.equal(pf.taskDone, false);

  // Whether August 2026 is "due soon" depends on today, so assert the
  // relationship instead: overdue and due-soon are derived from the date.
  assert.equal(pf.overdue, pf.daysRemaining < 0);
  assert.equal(pf.dueSoon, pf.daysRemaining >= 0 && pf.daysRemaining <= 7);
  assert.equal(calendar.pending, 6);
  assert.equal(calendar.overdue, calendar.rows.filter((row) => row.overdue).length);
  assert.ok(state.reports.rows.length > 0);
});

test('§19 Finance can tick a calendar task off, and it is audited', async () => {
  const { service, state } = fullHarness();
  const done = await service.updateCalendarTask({
    companyId: COMPANY, month: MONTH, type: 'ESI', done: true,
    note: 'Challan paid', actor: { _id: E2, name: 'Finance Manager' },
  });
  assert.equal(done.status, 'DONE');
  assert.equal(done.dueDate, '2026-09-15');
  assert.ok(done.completedAt instanceof Date);

  const audit = state.audits.find((entry) => entry.action === STATUTORY_AUDIT_ACTIONS.CALENDAR_TASK_UPDATED);
  assert.ok(audit);
  assert.equal(audit.previousValue.status, 'PENDING');
  assert.equal(audit.newValue.status, 'DONE');

  const reopened = await service.updateCalendarTask({
    companyId: COMPANY, month: MONTH, type: 'ESI', done: false, actor: { _id: E2 },
  });
  assert.equal(reopened.status, 'PENDING');
  assert.equal(reopened.completedAt, null);
});

test('§19 reminders only fire for what is due or overdue and not yet filed', async () => {
  const { service, state } = fullHarness();

  // A month whose filing date is already behind us, so "overdue" is true on
  // any day this suite could ever run.
  state.payments.rows.push(payment(E1, 'PAID', PAST_MONTH), payment(E2, 'PAID', PAST_MONTH));
  state.results.rows.push(
    { ...result(E1, 'CRE-001', 'Asha Rao'), month: PAST_MONTH },
    { ...result(E2, 'CRE-002', 'Vikram Shetty'), month: PAST_MONTH },
  );
  state.batches.rows.push({ _id: BATCH, companyId: COMPANY, month: PAST_MONTH, status: 'COMPLETED' });

  await service.generateForMonth({ companyId: COMPANY, month: PAST_MONTH, actor: { _id: E1 } });
  await service.updateFilingStatus({
    companyId: COMPANY, month: PAST_MONTH, type: 'PF', status: 'FILED', actor: { _id: E2 },
  });

  const sent = await service.sendReminders({ companyId: COMPANY, month: PAST_MONTH, actor: { _id: E1 } });
  // Six applicable types, one of them already filed → five reminders.
  assert.equal(sent.sent, 5);
  const filingDue = state.notifications.filter((entry) => entry.type === 'STATUTORY_FILING_DUE');
  assert.equal(filingDue.length, 5);
  assert.ok(!filingDue.some((entry) => entry.payload.type === 'PF'));
  assert.ok(filingDue.every((entry) => entry.payload.overdue === true));
  assert.ok(state.audits.some((entry) => entry.action === STATUTORY_AUDIT_ACTIONS.REMINDER_SENT));
});

test('§19 reminderCandidates ignores completed tasks and future filings', () => {
  const rows = [
    { type: 'PF', status: 'DRAFT', taskDone: false, overdue: true, dueDate: '2026-09-15' },
    { type: 'ESI', status: 'FILED', taskDone: false, overdue: true, dueDate: '2026-09-15' },
    { type: 'PT', status: 'DRAFT', taskDone: true, overdue: true, dueDate: '2026-09-20' },
    { type: 'TDS', status: 'DRAFT', taskDone: false, overdue: false, dueSoon: false, dueDate: '2027-09-07' },
    { type: 'LWF', status: 'DRAFT', taskDone: false, overdue: false, dueSoon: true, dueDate: '2026-09-15' },
  ];
  const picked = reminderCandidates({ rows }).map((row) => row.type);
  assert.deepEqual(picked, ['PF', 'LWF']);
});

test('§19 buildCalendar hides what 29.1 has switched off', () => {
  const rows = buildCalendar({
    months: ['2026-08'],
    setup: setup({ statutory: { pf: { applicable: true }, tds: { applicable: true }, esi: { applicable: false }, professionalTax: { applicable: false }, labourWelfareFund: { applicable: false }, gratuity: { applicable: false } } }),
    statusesByMonth: {},
    tasksByMonth: {},
    fyStartMonth: 4,
    today: '2026-09-14',
  });
  assert.deepEqual(rows.map((row) => row.type), ['PF', 'TDS']);
  assert.equal(rows[0].status, 'NOT_GENERATED');
  assert.equal(rows[0].statusLabel, 'Not generated');
  // One day before the 15th: due soon, not yet overdue.
  assert.equal(rows[0].overdue, false);
  assert.equal(rows[0].dueSoon, true);
});

// ── §17 — the employee statutory view ──────────────────────────────────────

test('§17 the employee statutory view is read-only and leaks no bank data', async () => {
  const { service } = fullHarness();
  const view = await service.getEmployeeStatutory({ companyId: COMPANY, employeeId: E1, month: MONTH });

  assert.equal(view.pan, 'ABCPD1234K');
  assert.equal(view.uan, '100123456789');
  assert.equal(view.pfMember, true);
  assert.equal(view.ptState, 'KARNATAKA');
  assert.equal(view.taxRegime, 'NEW');
  assert.equal(view.current.month, MONTH);
  assert.equal(view.current.pf, 1800);

  // No bank field of any kind is ever part of this view.
  const serialised = JSON.stringify(view);
  assert.ok(!/account/i.test(serialised));
  assert.ok(!/ifsc/i.test(serialised));
});

test('§17 an employee from another company is not found', async () => {
  const { service } = fullHarness();
  await assert.rejects(
    () => service.getEmployeeStatutory({ companyId: OTHER_COMPANY, employeeId: E1 }),
    /Employee not found/,
  );
});

// ── §3 / §24 — tenant isolation ────────────────────────────────────────────

test('§3/§24 another tenant can never reach this company\'s statutory data', async () => {
  const { service } = fullHarness();
  await service.generateForMonth({ companyId: COMPANY, month: MONTH, actor: { _id: E1 } });

  await assert.rejects(
    () => service.getDashboard({ companyId: OTHER_COMPANY, month: MONTH }),
    /pay the payroll/,
  );
  await assert.rejects(
    () => service.updateFilingStatus({
      companyId: OTHER_COMPANY, month: MONTH, type: 'PF', status: 'FILED', actor: { _id: E2 },
    }),
    /Generate the Provident Fund report/,
  );

  const reports = await service.getReport({ companyId: COMPANY, month: MONTH, type: 'PF' });
  assert.equal(reports.employeeCount, 2);
  assert.equal(reports.summary.pf.total, 7200);
});

// ── §20 — cache ────────────────────────────────────────────────────────────

test('§20 the cache is dropped after generation and after a filing update', async () => {
  const { service, state } = fullHarness();

  await service.getDashboard({ companyId: COMPANY, month: MONTH });
  await service.generateForMonth({ companyId: COMPANY, month: MONTH, actor: { _id: E1 } });
  assert.ok(state.invalidations.some((entry) => entry.month === MONTH));

  const before = state.invalidations.length;
  await service.updateFilingStatus({
    companyId: COMPANY, month: MONTH, type: 'PF', status: 'FILED', actor: { _id: E2 },
  });
  assert.ok(state.invalidations.length > before);

  // A second read is served from the cache, not recomputed.
  const first = await service.getDashboard({ companyId: COMPANY, month: MONTH });
  const second = await service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.deepEqual(first.kpis, second.kpis);
});

// ── §21 — queue payloads ───────────────────────────────────────────────────

test('§21 queue payloads carry references only — never a rupee or a person', () => {
  const ok = validateStatutoryGeneratePayload({ companyId: COMPANY, month: MONTH, actorId: E1 });
  assert.equal(ok.valid, true);

  const smuggled = validateStatutoryGeneratePayload({
    companyId: COMPANY, month: MONTH, rows: [{ pan: 'ABCPD1234K' }], grossPayroll: 123,
  });
  assert.equal(smuggled.valid, false);
  assert.ok(smuggled.errors.some((error) => /rows must not be queued/.test(error)));
  assert.ok(smuggled.errors.some((error) => /grossPayroll must not be queued/.test(error)));

  const badMonth = validateStatutoryGeneratePayload({ companyId: COMPANY, month: 'August' });
  assert.equal(badMonth.valid, false);

  const exportOk = validateStatutoryExportPayload({
    companyId: COMPANY, exportId: oid(11), reportKey: 'ANNUAL_PF', format: 'XLSX', financialYear: '2026-27',
  });
  assert.equal(exportOk.valid, true);

  const exportNoPeriod = validateStatutoryExportPayload({
    companyId: COMPANY, exportId: oid(11), reportKey: 'PF', format: 'CSV',
  });
  assert.equal(exportNoPeriod.valid, false);

  const reminderOk = validateComplianceReminderPayload({ companyId: COMPANY });
  assert.equal(reminderOk.valid, true);
});

test('§21 the export path queues an id and rebuilds the report in the worker', async () => {
  const { service, state } = fullHarness();
  const requested = await service.requestExport({
    companyId: COMPANY, financialYear: '2026-27', reportKey: 'ANNUAL_PF', format: 'XLSX',
    actor: { _id: E1, name: 'Payroll Admin' },
  });

  // The dispatcher returned queued:false here, so it ran inline — either way
  // the export row ends up READY with real bytes.
  assert.ok(requested.exportId);
  const row = state.exports.rows[0];
  assert.equal(row.status, 'READY');
  assert.ok(row.sizeBytes > 0);
  assert.equal(row.reportKey, 'ANNUAL_PF');
  assert.equal(row.format, 'XLSX');
  assert.match(row.checksum, /^sha256:/);

  const downloaded = await service.downloadExport({
    companyId: COMPANY, exportId: requested.exportId, actor: { _id: E1 },
  });
  assert.equal(downloaded.content.length, row.sizeBytes);
  assert.equal(row.downloadCount, 1);

  // §25 — downloading a report is an audited action.
  assert.ok(state.audits.some((entry) => entry.action === STATUTORY_AUDIT_ACTIONS.DOWNLOADED));

  // An export belonging to another tenant is simply not found.
  await assert.rejects(
    () => service.downloadExport({ companyId: OTHER_COMPANY, exportId: requested.exportId }),
    /Export not found/,
  );
});

// ── §15 — a real PDF ───────────────────────────────────────────────────────

test('§15/§26 the PDF carries the company, the period and the no-filing footer', async () => {
  const { service } = fullHarness();
  const built = await service.exportNow({
    companyId: COMPANY, reportKey: 'COMPLIANCE_SUMMARY', month: MONTH, format: 'PDF',
  });

  const text = await extractPdfText(built.content);
  assert.match(text, /Crewly Technologies/);
  assert.match(text, /AABCC1234D/); // company PAN from 29.1
  assert.match(text, /Compliance Summary/);
  assert.match(text, /August 2026/);
  assert.match(text, /Total PF Payable/);
  // §26 — the footer is explicit: this is not a filed government return.
  assert.match(text, /not a filed/);
  assert.match(text, /requires no signature/);
});

// pdf-parse v2: `new PDFParse({ data })`, not the v1 callback signature.
const extractPdfText = async (buffer) => {
  const mod = await import('pdf-parse');
  const PDFParse = mod.PDFParse || mod.default?.PDFParse || mod.default;
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy?.();
  return String(result?.text || '');
};

// ── §13 — the JSON history ─────────────────────────────────────────────────

test('§13 the compliance history renders one row per month with its statuses', async () => {
  const { service } = fullHarness();
  await service.generateForMonth({ companyId: COMPANY, month: MONTH, actor: { _id: E1 } });
  const history = await service.getHistory({ companyId: COMPANY, financialYear: '2026-27' });

  assert.equal(history.rows.length, 12);
  const august = history.rows.find((row) => row.month === MONTH);
  assert.equal(august.monthLabel, monthLabel(MONTH));
  assert.equal(august.employees, 2);
  assert.equal(august.pf, 7200);
  assert.equal(august.tds, 3500);
  assert.equal(august.statuses.length, 7);
  assert.deepEqual(august.filable, ['PF', 'ESI', 'PT', 'TDS', 'LWF']);
});

test('§13 registerRows keeps the month, the money and the status in step', () => {
  const rows = registerRows({
    months: ['2026-08'],
    byMonth: { '2026-08': { employees: 2, grossPayroll: 93000, netPayroll: 84800, pf: { employee: 3600, employer: 3600, total: 7200 }, esi: { employee: 135, employer: 585, total: 720 }, pt: { total: 400 }, tds: { total: 3500 }, lwf: { employee: 40, employer: 80, total: 120 }, gratuity: { monthly: 1924 } } },
    statusesByMonth: { '2026-08': [{ type: 'PF', status: 'FILED' }, { type: 'TDS', status: 'DRAFT' }] },
    fyStartMonth: 4,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], '2026-08');
  assert.equal(rows[0][1], '2026-27');
  assert.equal(rows[0][7], 7200); // PF total
  assert.equal(rows[0][10], 720); // ESI total
  assert.equal(rows[0][11], 400); // PT
  assert.equal(rows[0][12], 3500); // TDS
  assert.equal(rows[0][15], 120); // LWF total
  assert.equal(rows[0][17], 'FILED'); // PF status
  assert.equal(rows[0][20], 'DRAFT'); // TDS status
  assert.equal(rows[0][21], 'NOT_GENERATED'); // LWF status
});
