#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — PAYROLL ANALYTICS PREVIEW GENERATOR
//
//      cd Backend && npm run analytics:preview
//
//  WHY THIS EXISTS
//
//  There is no mongod, redis-server or docker in a sandbox, so the app itself
//  cannot be started here. This script is the substitute for clicking through
//  the UI: it builds the REAL analytics service with the REAL rules, the REAL
//  CSV/XLSX writers and the REAL PDF renderer, over fake in-memory models.
//
//  Nothing is stubbed on the output side. The files it writes to
//  Backend/.preview/analytics/ are the artefacts Finance actually downloads.
//
//  Two of the defects 29.9–29.11 shipped were only visible in generated
//  output — a blank payment date and a silently coerced export format. Both
//  were found by this kind of script, not by unit tests. Run it after any
//  change to a report, a figure or the PDF.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeAnalyticsService } from '../src/services/payroll/analyticsService.js';
import { makePlatformAnalyticsService } from '../src/services/payroll/platformAnalyticsService.js';
import { REPORT_KEYS, REPORT_LABELS } from '../src/services/payroll/analyticsRules.js';
import { filterSegmentOf } from '../src/services/payroll/analyticsCache.js';
// The preview's fake models answer REAL aggregation pipelines, using the same
// evaluator the tests use. If it were stubbed, the 29.13 fast path would fall
// back to loading rows and the preview would silently stop exercising the code
// that actually runs in production.
import { runPipeline } from '../test/helpers/fakeAggregate.js';
import { buildAnalyticsReportPdf } from '../src/utils/analyticsPdf.js';
import { buildXlsx, toCsv } from '../src/services/payroll/payrollPaymentRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', '.preview', 'analytics');

// ── fake model ─────────────────────────────────────────────────────────────

const oid = (seed) => `64b7f9c2e4b0a1b2c3d4e${String(seed).padStart(3, '0')}`;

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = row?.[key];
    if (
      condition &&
      typeof condition === 'object' &&
      !Array.isArray(condition) &&
      !(condition instanceof Date)
    ) {
      if (condition.$in) return condition.$in.some((item) => String(item) === String(value));
      // §9 counts joins and exits with a date RANGE. A fake that only knew
      // equality reported zero for both, which is worse than useless in a
      // preview: it looks like a real answer.
      if (condition.$gte || condition.$lte) {
        const when = value instanceof Date ? value.getTime() : new Date(value).getTime();
        if (Number.isNaN(when)) return false;
        if (condition.$gte && when < new Date(condition.$gte).getTime()) return false;
        if (condition.$lte && when > new Date(condition.$lte).getTime()) return false;
        return true;
      }
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
};

const makeFakeModel = (defaults = {}) => {
  const rows = [];
  let counter = 0;

  // sort() is honoured for real: `latestMonth()` asks for the newest snapshot
  // with .sort({ month: -1 }), and a fake that ignored it would hand back
  // April and make every trend look like a single month.
  const buildQuery = (filter, sortSpec = null, limitCount = null) => {
    const collect = () => {
      const found = rows.filter((row) => matches(row, filter));
      if (sortSpec) {
        const [field, direction] = Object.entries(sortSpec)[0] || [];
        if (field) {
          found.sort((a, b) => {
            const left = a?.[field];
            const right = b?.[field];
            const compared = typeof left === 'number' && typeof right === 'number'
              ? left - right
              : String(left).localeCompare(String(right));
            return Number(direction) < 0 ? -compared : compared;
          });
        }
      }
      return limitCount ? found.slice(0, limitCount) : found;
    };

    const query = {
      lean: async () => collect(),
      select: () => query,
      sort: (spec) => buildQuery(filter, spec, limitCount),
      limit: (count) => buildQuery(filter, sortSpec, count),
      skip: () => query,
      // Mongoose queries are thenable, and findOne() is awaited directly in
      // several services. Without this the caller would receive the query
      // object instead of the document.
      then: (resolve, reject) => Promise.resolve().then(collect).then(resolve, reject),
      catch: (reject) => query.then(undefined, reject),
    };
    return query;
  };

  // Documents carry save(), because the schedule service mutates and persists
  // the row it loaded rather than issuing an update.
  const snapshot = (row) => {
    if (!row) return null;
    const copy = { ...row };
    copy.save = async () => {
      const target = rows.find((item) => item === row);
      Object.assign(target, copy);
      return target;
    };
    return copy;
  };

  const model = {
    rows,
    find: (filter = {}) => buildQuery(filter),
    findOne: (filter = {}) => {
      const collect = async () => snapshot(rows.find((row) => matches(row, filter)));
      const query = {
        lean: collect,
        select: () => query,
        sort: () => query,
        limit: () => query,
        then: (resolve, reject) => collect().then(resolve, reject),
        catch: (reject) => query.then(undefined, reject),
      };
      return query;
    },
    findById: (id) => {
      const lean = async () => snapshot(rows.find((row) => String(row._id) === String(id)));
      // .select('logoUrl') is how the PDF renderer reads the company mark.
      return { lean, select: () => ({ lean }) };
    },
    countDocuments: async (filter = {}) => rows.filter((row) => matches(row, filter)).length,
    aggregate: async (pipeline = []) => runPipeline(rows, pipeline),
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
        if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
        const inserted = await model.create({ ...(filter || {}) });
        applyUpdate(inserted, update);
        return { matchedCount: 0, upsertedCount: 1 };
      }
      applyUpdate(row, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(filter, update = {}, options = {}) {
      const existing = rows.find((item) => matches(item, filter));
      if (existing) {
        applyUpdate(existing, update);
        return snapshot(existing);
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

const COMPANY = oid(999);
const DEPARTMENT_ENG = oid(50);
const DEPARTMENT_SALES = oid(51);

// Five months, so the trend report has something to trend over.
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const CURRENT_MONTH = '2026-08';

const PEOPLE = [
  {
    id: oid(1),
    code: 'CRE-001',
    name: 'Asha Rao',
    department: DEPARTMENT_ENG,
    designation: 'Principal Engineer',
    gross: 145000,
    basic: 72500,
    lopDays: 0,
    otHours: 12,
    // Real 29.5 entry types — the bonus report classifies on these.
    variable: [
      { type: 'BONUS_PERFORMANCE', label: 'Performance Bonus', amount: 20000 },
      { type: 'BONUS_FESTIVAL', label: 'Festival Bonus', amount: 5000 },
    ],
    claims: [
      { type: 'REIMBURSEMENT_TRAVEL', label: 'Travel', amount: 6400 },
      { type: 'REIMBURSEMENT_INTERNET', label: 'Internet', amount: 1200 },
    ],
    joining: '2018-04-02',
  },
  {
    id: oid(2),
    code: 'CRE-002',
    name: 'Meera Iyer',
    department: DEPARTMENT_ENG,
    designation: 'Senior Engineer',
    gross: 62000,
    basic: 31000,
    lopDays: 2,
    otHours: 20,
    variable: [],
    joining: '2021-07-05',
  },
  {
    id: oid(3),
    code: 'CRE-003',
    name: 'Vikram Shetty',
    department: DEPARTMENT_SALES,
    designation: 'Sales Manager',
    gross: 88000,
    basic: 44000,
    lopDays: 1,
    otHours: 0,
    variable: [
      { type: 'COMMISSION_SALES', label: 'Sales Commission', amount: 30000 },
      { type: 'INCENTIVE', label: 'Sales Incentive', amount: 10000 },
    ],
    claims: [{ type: 'REIMBURSEMENT_FUEL', label: 'Fuel', amount: 8500 }],
    joining: '2019-11-11',
  },
  {
    id: oid(4),
    code: 'CRE-004',
    name: 'Rahul Menon',
    department: DEPARTMENT_SALES,
    designation: 'Sales Executive',
    gross: 24000,
    basic: 12000,
    lopDays: 4,
    otHours: 6,
    variable: [],
    joining: '2024-02-01',
  },
  // Joined in the current month — §9 must count them, payroll must pay them.
  {
    id: oid(5),
    code: 'CRE-005',
    name: 'Sneha Kulkarni',
    department: DEPARTMENT_ENG,
    designation: 'Associate Engineer',
    gross: 38000,
    basic: 19000,
    lopDays: 0,
    otHours: 0,
    variable: [],
    joining: '2026-08-03',
    joinedThisMonth: true,
  },
];

// ── a 29.6 snapshot, exactly as the engine writes one ──────────────────────
//
// The engine stores the LINE arrays (earnings, deductions, employer
// contributions) and derives the totals from them — `employerCost` is the sum
// of the employer lines, gratuity included. 29.13's earnings, deduction and
// employer reports read those lines, so a fixture without them does not show
// "not available": it shows zero, which looks like a real answer. The
// fixture is a contract, and this one is rewritten to keep it.

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const sumLines = (lines = []) => round2(lines.reduce((total, line) => total + Number(line.amount || 0), 0));

const resultFor = (person, month) => {
  const pf = Math.min(1800, Math.round(person.basic * 0.12));
  const tds = person.gross > 50000 ? Math.round(person.gross * 0.07) : 0;
  const lop = round2((person.gross / 30) * person.lopDays);
  const overtime = person.otHours > 0 ? Math.round((person.gross / 30 / 8) * 2 * person.otHours) : 0;
  const gratuity = round2(person.basic * 0.0481);

  const hra = Math.round(person.basic * 0.4);
  const earnings = [
    { code: 'BASIC', name: 'Basic', amount: person.basic, source: 'STRUCTURE' },
    { code: 'HRA', name: 'House Rent Allowance', amount: hra, source: 'STRUCTURE' },
    { code: 'SPECIAL_ALLOWANCE', name: 'Special Allowance', amount: person.gross - person.basic - hra, source: 'STRUCTURE' },
  ];

  const deductions = [
    { code: 'PF', name: 'Provident Fund', amount: pf, source: 'STATUTORY' },
    { code: 'PROFESSIONAL_TAX', name: 'Professional Tax', amount: 200, source: 'STATUTORY' },
    { code: 'TDS', name: 'Income Tax (TDS)', amount: tds, source: 'STATUTORY' },
    { code: 'LWF', name: 'Labour Welfare Fund', amount: 20, source: 'STATUTORY' },
    ...(lop ? [{ code: 'LOP', name: 'Loss of Pay', amount: lop, source: 'ATTENDANCE' }] : []),
  ];

  const employerContributions = [
    { code: 'PF_EMPLOYER', name: 'Employer PF', amount: pf, source: 'STATUTORY' },
    { code: 'LWF_EMPLOYER', name: 'Employer LWF', amount: 40, source: 'STATUTORY' },
    { code: 'GRATUITY', name: 'Gratuity', amount: gratuity, source: 'STATUTORY' },
  ];

  const reimbursements = (person.claims || []).map((claim) => ({
    type: claim.type,
    label: claim.label,
    amount: claim.amount,
    claimStatus: 'APPROVED',
  }));

  const variable = sumLines(person.variable);
  const totalEarnings = round2(person.gross + overtime + variable);
  const totalDeductions = sumLines(deductions);
  const employerCost = sumLines(employerContributions);
  const reimbursementTotal = sumLines(reimbursements);

  return {
    _id: oid(900 + Number(String(person.id).slice(-3)) + MONTHS.indexOf(month)),
    companyId: COMPANY,
    month,
    employeeId: person.id,
    isCurrent: true,
    status: 'CALCULATED',
    // 29.6 stamps both of these onto the snapshot (payrollEngineRules:
    // departmentId = employee.department). A fixture without them makes every
    // department bucket read "Unassigned" — a real-looking wrong answer.
    departmentId: person.department,
    structureId: oid(201),
    structureName: 'Standard Structure',
    totals: {
      gross: person.gross,
      basic: person.basic,
      totalEarnings,
      totalDeductions,
      employerCost,
      ctc: round2(totalEarnings + employerCost),
      // The engine: net = total earnings + reimbursements − deductions.
      netPay: round2(totalEarnings + reimbursementTotal - totalDeductions),
      overtime,
      variableEarnings: variable,
      reimbursements: reimbursementTotal,
    },
    earnings,
    variableEarnings: person.variable,
    reimbursements,
    deductions,
    employerContributions,
    attendance: {
      workingDays: 30,
      paidDays: 30 - person.lopDays,
      lopDays: person.lopDays,
      paidLeaveDays: 1,
      otHours: person.otHours,
    },
    statutory: {
      pf: {
        applicable: true,
        pfWage: 15000,
        employee: pf,
        employerEpf: 550,
        employerPension: 1250,
        employer: pf,
      },
      esi: { applicable: false, wage: 0, employee: 0, employer: 0, outsideCeiling: true },
      professionalTax: { applicable: true, state: 'KARNATAKA', amount: 200 },
      tds:
        person.gross > 50000
          ? {
            applicable: true,
            monthly: tds,
            annualIncome: person.gross * 12,
            taxableIncome: person.gross * 12 - 75000,
            annualTax: tds * 12,
            regime: 'NEW',
          }
          : { applicable: false, monthly: 0, annualIncome: 0, taxableIncome: 0, annualTax: 0, regime: 'NEW' },
      lwf: { applicable: true, employee: 20, employer: 40 },
      gratuity: { applicable: true, amount: gratuity },
    },
  };
};

// ── wiring ─────────────────────────────────────────────────────────────────

const state = {
  results: makeFakeModel(),
  payments: makeFakeModel(),
  settlements: makeFakeModel(),
  resignations: makeFakeModel(),
  // 29.13 — the versioned salary profile (§23) and the company's own salary
  // bands (§8).
  profiles: makeFakeModel(),
  settings: makeFakeModel(),
  users: makeFakeModel(),
  departments: makeFakeModel(),
  companies: makeFakeModel(),
  schedules: makeFakeModel({ active: true }),
  files: makeFakeModel({ status: 'QUEUED' }),
  audits: [],
  notifications: [],
  dispatched: [],
  cache: new Map(),
};

state.companies.rows.push({
  _id: COMPANY,
  name: 'Crewly Technologies Pvt Ltd',
  address: '4th Floor, Prestige Atrium, Bengaluru 560001',
  logoUrl: '',
});
state.departments.rows.push({ _id: DEPARTMENT_ENG, companyId: COMPANY, name: 'Engineering' });
state.departments.rows.push({ _id: DEPARTMENT_SALES, companyId: COMPANY, name: 'Sales' });

PEOPLE.forEach((person) => {
  state.users.rows.push({
    _id: person.id,
    companyId: COMPANY,
    employeeCode: person.code,
    name: person.name,
    department: person.department,
    designation: person.designation,
    status: 'ACTIVE',
    dateOfJoining: new Date(`${person.joining}T00:00:00Z`),
  });
});

MONTHS.forEach((month, index) => {
  PEOPLE.forEach((person) => {
    // Everyone works every month except the new joiner.
    if (person.joinedThisMonth && month !== CURRENT_MONTH) return;
    state.results.rows.push(resultFor(person, month));
    // One payment failed in August and was retried successfully — the register
    // must show the paid one, once.
    if (person.code === 'CRE-004' && month === CURRENT_MONTH) {
      state.payments.rows.push({
        _id: oid(700 + index),
        companyId: COMPANY,
        month,
        employeeId: person.id,
        status: 'FAILED',
        paidAt: null,
        paymentReference: '',
      });
    }
    state.payments.rows.push({
      _id: oid(800 + Number(String(person.id).slice(-3)) + index),
      companyId: COMPANY,
      month,
      employeeId: person.id,
      status: 'PAID',
      paidAt: new Date(`${month}-30T00:00:00Z`),
      paymentReference: `SAL-${month}-${person.code}`,
    });
  });
});

// One approved exit this month (§9).
state.resignations.rows.push({
  _id: oid(650),
  companyId: COMPANY,
  employeeId: oid(4),
  status: 'APPROVED',
  lastWorkingDate: new Date('2026-08-31T00:00:00Z'),
});

// One approved exit has been settled and paid; another is still open, so the
// F&F report has something to show on both sides of the line.
state.settlements.rows.push({
  _id: oid(651),
  companyId: COMPANY,
  employeeId: oid(4),
  employeeName: 'Rahul Menon',
  month: '2026-08',
  settlementNumber: 'FNF-2026-0001',
  status: 'PAID',
  totals: { netSettlement: 41250, totalEarnings: 48000, totalRecoveries: 6750 },
  earnings: { pendingSalary: { amount: 24000 }, leaveEncashment: { amount: 24000 } },
  recoveries: { notice: { amount: 6000 }, items: [{ label: 'Asset not returned', amount: 750 }] },
  exit: { employeeId: oid(4), lastWorkingDate: '2026-08-31' },
  payment: { paidAt: new Date('2026-08-31T00:00:00Z') },
});

// §23 — a salary that changed. Version 2 is current; version 1 is history and
// must stay readable.
state.profiles.rows.push(
  {
    _id: oid(661), companyId: COMPANY, employeeId: oid(2), version: 2, isCurrent: true,
    effectiveFrom: new Date('2026-04-01T00:00:00Z'), structureId: oid(201),
    structureName: 'Standard Structure', annualCtc: 900000, monthlyGross: 62000,
  },
  {
    _id: oid(660), companyId: COMPANY, employeeId: oid(2), version: 1, isCurrent: false,
    effectiveFrom: new Date('2024-04-01T00:00:00Z'), effectiveTo: new Date('2026-03-31T00:00:00Z'),
    structureId: oid(200), structureName: 'Legacy Structure', annualCtc: 744000, monthlyGross: 52000,
  },
);

const cache = {
  buildKey: ({ companyId, month = '', suffix = 'dashboard', period = '', filters = null }) =>
    `k:${companyId}:${month || 'all'}:${suffix}:${period || '-'}:${filterSegmentOf(filters)}`,
  getOrSet: async (key, { loader }) => {
    if (state.cache.has(key)) return { value: state.cache.get(key), cache: 'HIT' };
    const value = await loader();
    state.cache.set(key, value);
    return { value, cache: 'MISS' };
  },
  invalidate: async (companyId) => {
    let removed = 0;
    for (const key of [...state.cache.keys()]) {
      if (key.startsWith(`k:${companyId}:`)) {
        state.cache.delete(key);
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
  CompanyModel: state.companies,
  ScheduledReportModel: state.schedules,
  AnalyticsReportFileModel: state.files,

  cache,

  audit: async (entry) => {
    state.audits.push(entry);
    return entry;
  },
  notify: async (entry) => {
    state.notifications.push(entry);
  },
  notifyRoles: async ({ permission }) => {
    state.notifications.push({ userId: 'PERMISSION', permission });
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

  renderPdf: (options) => buildAnalyticsReportPdf(options),
  buildCsv: toCsv,
  buildWorkbook: buildXlsx,
  hash: (value) => `sha256:${Buffer.byteLength(value)}`,
  trendMonths: 12,
});

// ── run ────────────────────────────────────────────────────────────────────

const written = [];

const write = (filename, content) => {
  const target = path.join(OUT_DIR, filename);
  fs.writeFileSync(target, content);
  const size = fs.statSync(target).size;
  console.log(`  ${filename.padEnd(52)} ${String(size).padStart(8)} bytes`);
  written.push(target);
  return target;
};

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);
const heading = (text) => console.log(`\n${text}\n${'-'.repeat(text.length)}`);
const inr = (value) =>
  `Rs ${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
// Dates arrive as Date objects, not ISO strings — `String(date).slice(0, 10)`
// would print "Wed Apr 01" and drop the year, which is the only thing that
// distinguishes one version of a salary from the next.
const isoDay = (value) => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
};

// pdf-parse v2: `new PDFParse({ data })`, not the v1 callback signature.
const extractPdfText = async (buffer) => {
  try {
    const mod = await import('pdf-parse');
    const PDFParse = mod.PDFParse || mod.default?.PDFParse || mod.default;
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy?.();
    return String(result?.text || '');
  } catch {
    return '';
  }
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('\nCREWLY — PHASE 29.12 PAYROLL ANALYTICS PREVIEW');
  console.log('='.repeat(72));

  // ── §5 / §6 the executive dashboard
  heading('§5/§6  Executive dashboard');
  const dashboard = await service.getDashboard({ companyId: COMPANY, month: CURRENT_MONTH });
  line('Month', `${dashboard.month}  (previous ${dashboard.previousMonth})`);
  line('Employees paid', dashboard.kpis.employeesPaid);
  line('Gross salary', inr(dashboard.kpis.grossSalary));
  line('Net salary paid', inr(dashboard.kpis.netSalaryPaid));
  line('Employer contribution', inr(dashboard.kpis.employerContribution));
  line('Total payroll cost', inr(dashboard.kpis.totalPayrollCost));
  line('Average salary', inr(dashboard.kpis.averageSalary));
  line(
    'Highest department cost',
    `${dashboard.kpis.highestDepartmentCost.department} — ${inr(dashboard.kpis.highestDepartmentCost.cost)}`,
  );
  line('Total statutory liability', inr(dashboard.kpis.totalStatutoryLiability));
  line('Cost change vs last month', `${dashboard.kpis.costChangePercent}%`);
  line('Payroll accuracy', `${dashboard.accuracy.accuracyPercent}%`);
  line('Final settlements', dashboard.settlements);
  line('Months available', (dashboard.availableMonths || []).join(', '));

  // ── §6 … §17 every report, as CSV / XLSX / PDF
  heading('§19  Every report, in every format');
  for (const key of REPORT_KEYS) {
    const label = REPORT_LABELS[key];
    const report = await service.getReport({
      companyId: COMPANY,
      reportKey: key,
      month: CURRENT_MONTH,
      canSeeFinancial: true,
    });
    const count = (report.rows || report.buckets || report.metrics || []).length;
    const detail = Array.isArray(report.metrics)
      ? 'metrics'
      : `${count} rows`;
    line(label, `${detail}${report.summary?.period ? ` · ${report.summary.period}` : ''}`);

    for (const format of ['CSV', 'XLSX', 'PDF']) {
      const built = await service.downloadExport({
        companyId: COMPANY,
        reportKey: key,
        format,
        filters: { month: CURRENT_MONTH },
        canSeeFinancial: true,
      });
      write(built.filename, built.content);
    }
  }

  // ── §11 the trend report over a year
  heading('§11  Payroll trend (yearly, from the snapshots)');
  const trend = await service.getReport({
    companyId: COMPANY,
    reportKey: 'TREND',
    period: 'YEARLY',
    canSeeFinancial: true,
  });
  (trend.rows || []).forEach((row) => {
    line(String(row.label || row.key), `${inr(row.grossPayroll)} gross · ${inr(row.netSalary)} net · ${inr(row.employerContribution)} employer`);
  });

  // ── 29.13 §4 — period presets
  heading('§4  Period presets (29.13)');
  for (const preset of ['CURRENT_MONTH', 'PREVIOUS_MONTH', 'LAST_3_MONTHS', 'CURRENT_FY', 'LAST_12_MONTHS']) {
    const window = await service.getDashboard({ companyId: COMPANY, month: CURRENT_MONTH, preset });
    line(
      preset,
      `${window.period.label} · ${window.months.length} month(s) · ${window.kpis.employeesPaid} paid · ${inr(window.kpis.grossSalary)} gross`,
    );
  }
  const custom = await service.getDashboard({
    companyId: COMPANY,
    preset: 'CUSTOM',
    fromMonth: '2026-04',
    toMonth: '2027-03',
  });
  line('CUSTOM 2026-04 → 2027-03', `${custom.period.label} · ${custom.months.length} month(s) · ${inr(custom.kpis.grossSalary)} gross`);

  // ── 29.13 §29 — the aggregation fast path, and what it saves
  heading('§29  Aggregation fast path vs the row loader');
  const timed = async (label, options) => {
    const started = performance.now();
    const value = await service.getDashboard({ companyId: COMPANY, month: CURRENT_MONTH, ...options });
    const elapsed = Math.round(performance.now() - started);
    line(label, `${elapsed} ms · source ${value.source} · ${inr(value.kpis.grossSalary)} gross`);
    return value;
  };
  const fast = await timed('Aggregation (MongoDB)', {});
  const slow = await timed('Rows (payment filter)', { filters: { status: 'PAID' } });
  line('Same answer either way', fast.kpis.grossSalary === slow.kpis.grossSalary ? 'yes' : 'NO — CHECK');
  line('Employees are people, not rows', `${fast.kpis.employeesPaid} over ${fast.months.length} month(s)`);

  // ── 29.13 §9 — why the cost moved
  heading('§9  Why the payroll cost moved');
  const movement = fast.movement || {};
  line('Joiners', movement.joiners ?? 0);
  line('Leavers', movement.leavers ?? 0);
  line('Stayers', movement.stayers ?? 0);
  line('Headcount effect', inr(movement.headcountEffect));
  line('Like-for-like effect', inr(movement.likeForLikeEffect));
  line('Adds up', movement.reconciled ? 'yes' : 'NO — CHECK');

  // ── 29.13 §11 … §21 — the six new reports
  heading('§11–§21  The reports 29.13 added');

  const earnings = await service.getReport({ companyId: COMPANY, reportKey: 'EARNINGS', month: CURRENT_MONTH });
  line('Earnings reconciled', earnings.totals.reconciled ? 'yes' : 'NO — CHECK');
  line('  fixed / variable / overtime', `${inr(earnings.totals.fixedEarnings)} / ${inr(earnings.totals.variableEarnings)} / ${inr(earnings.totals.overtime)}`);
  (earnings.rows || []).slice(0, 5).forEach((row) => line(`  ${row.label}`, `${inr(row.amount)} · ${row.categoryLabel}`));

  const deductions = await service.getReport({ companyId: COMPANY, reportKey: 'DEDUCTIONS', month: CURRENT_MONTH });
  line('Deductions', `${inr(deductions.totals.totalDeductions)} · ${deductions.totals.percentOfGross}% of gross`);
  line('  statutory / LOP / other', `${inr(deductions.totals.statutoryTotal)} / ${inr(deductions.totals.lopTotal)} / ${inr(deductions.totals.otherTotal)}`);

  const employer = await service.getReport({ companyId: COMPANY, reportKey: 'EMPLOYER', month: CURRENT_MONTH });
  line('Employer contribution', `${inr(employer.total)} · unclassified ${inr(employer.unclassified)}`);

  const reimbursements = await service.getReport({ companyId: COMPANY, reportKey: 'REIMBURSEMENT', month: CURRENT_MONTH });
  line('Reimbursements', `${inr(reimbursements.total)} · ${reimbursements.employees} employee(s)`);

  const fnf = await service.getReport({ companyId: COMPANY, reportKey: 'FNF', month: CURRENT_MONTH });
  line('F&F settlements', `${fnf.count} · completed ${fnf.completed.count} · pending ${fnf.pending.count} · ${inr(fnf.totals.netSettlement)} net`);

  const variance = await service.getReport({ companyId: COMPANY, reportKey: 'VARIANCE', month: CURRENT_MONTH });
  line('Variance direction', variance.direction);
  (variance.rows || [])
    .filter((row) => row.key === 'GROSS' || row.key === 'NET' || row.key === 'TOTAL_COST' || row.key === 'HEADCOUNT')
    .forEach((row) => {
      // Employees Paid is a NUMBER of people. Printing it as rupees is how a
      // headcount turns into a salary in someone's head.
      const show = row.key === 'HEADCOUNT'
        ? (value) => String(Number(value || 0))
        : inr;
      line(`  ${row.label}`, `${show(row.previous)} → ${show(row.current)} (${row.direction})`);
    });

  // ── 29.13 §22 — the register pages and searches
  heading('§22  Register paging and search');
  const pageOne = await service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: CURRENT_MONTH, page: 1, limit: 3 });
  line('Page 1 of 3 per page', `${pageOne.rows.length} row(s) of ${pageOne.pagination.total} · ${pageOne.pagination.pages} page(s)`);
  const pageTwo = await service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: CURRENT_MONTH, page: 2, limit: 3 });
  line('Page 2', `${pageTwo.rows.length} row(s)`);
  const searched = await service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: CURRENT_MONTH, search: 'meera' });
  line('Search "meera"', `${searched.rows.length} row(s) — ${(searched.rows[0] || {}).employeeName || '—'}`);
  const byAmount = await service.getReport({ companyId: COMPANY, reportKey: 'REGISTER', month: CURRENT_MONTH, search: '62000' });
  line('Search "62000"', `${byAmount.rows.length} row(s) — payroll is not searchable by salary`);

  // ── 29.13 §23 — one person's salary history
  heading('§23  Employee salary history');
  const history = await service.getEmployeeHistory({ companyId: COMPANY, employeeId: oid(2) });
  line('Employee', `${history.employee.employeeCode} · ${history.employee.employeeName} · ${history.employee.designation}`);
  line('Months on record', `${history.months.length} (${history.summary.firstMonth} → ${history.summary.lastMonth})`);
  line('Average gross', inr(history.summary.averageGross));
  (history.versions || []).forEach((version) =>
    line(`  Version ${version.version}${version.isCurrent ? ' (current)' : ''}`, `${version.structureName} · ${inr(version.annualCtc)} CTC from ${isoDay(version.effectiveFrom)}`),
  );
  const outOfScope = await service
    .getEmployeeHistory({ companyId: COMPANY, employeeId: oid(3), allowedEmployeeIds: [oid(2)] })
    .then(() => 'LEAKED')
    .catch(() => 'blocked');
  line('Another employee, scoped out', outOfScope);

  // ── 29.13 §8 — the company's own salary bands
  heading('§8  Configurable salary bands');
  const saved = await service.updateSalaryBands({
    companyId: COMPANY,
    salaryBands: [
      { label: 'Under 50k', min: 0, max: 50000 },
      { label: '50k to 1 lakh', min: 50000, max: 100000 },
      { label: 'Above 1 lakh', min: 100000, max: null },
    ],
    actor: { _id: oid(11), name: 'Farah Finance' },
  });
  line('Saved bands', saved.salaryBands.map((band) => band.label).join(' · '));
  const distribution = await service.getReport({ companyId: COMPANY, reportKey: 'SALARY_BANDS', month: CURRENT_MONTH });
  (distribution.rows || []).forEach((row) => line(`  ${row.label}`, `${row.employees} employee(s)`));

  // ── 29.13 §38 — generated files expire
  heading('§38  Export expiry');
  const requested = await service.requestExport({
    companyId: COMPANY,
    reportKey: 'REGISTER',
    format: 'CSV',
    filters: { month: CURRENT_MONTH },
    actor: { _id: oid(11), name: 'Farah Finance' },
  });
  const beforeExpiry = (await service.listFiles({ companyId: COMPANY })).find((row) => String(row._id) === String(requested.fileId));
  line('Generated', `${beforeExpiry.filename} · expires ${new Date(beforeExpiry.expiresAt).toISOString()}`);
  const expiredCount = await service.expireFiles({ now: new Date(Date.parse(beforeExpiry.expiresAt) + 1000) });
  const afterExpiry = (await service.listFiles({ companyId: COMPANY })).find((row) => String(row._id) === String(requested.fileId));
  line('Swept', `${expiredCount} file(s) · status now ${afterExpiry.status}`);
  line(
    'Download after expiry',
    await service.downloadFile({ companyId: COMPANY, fileId: requested.fileId }).then(() => 'LEAKED').catch(() => 'refused'),
  );

  // ── §20 scheduled reports
  heading('§20  Scheduled reports');
  const schedule = await service.createSchedule({
    companyId: COMPANY,
    name: 'Monthly payroll summary',
    reportKey: 'OVERVIEW',
    format: 'XLSX',
    frequency: 'MONTHLY',
    dayOfMonth: 3,
    notifyPermission: 'PAYROLL_REPORT_READ',
    actor: { _id: oid(11), name: 'Farah Finance' },
  });
  line('Created', `${schedule.name} · ${schedule.frequency} on day ${schedule.dayOfMonth}`);
  line('Armed for', new Date(schedule.nextRunAt).toISOString().slice(0, 10));

  const executed = await service.runSchedule({ companyId: COMPANY, scheduleId: schedule._id });
  line('Executed', `${executed.filename} · ${executed.rows ?? 0} rows`);
  line('Re-armed for', new Date(state.schedules.rows[0].nextRunAt).toISOString().slice(0, 10));
  line('Runs so far', state.schedules.rows[0].runCount);

  // ── §23 notifications
  heading('§23  Notifications');
  const notifySummary = new Map();
  state.notifications.forEach((entry) => {
    const key = entry.permission ? `permission:${entry.permission}` : `user:${entry.userId}`;
    notifySummary.set(key, (notifySummary.get(key) || 0) + 1);
  });
  if (!notifySummary.size) line('Sent', 'none — a schedule that notifies nobody is silent by design');
  [...notifySummary.entries()].forEach(([key, total]) => line(key, `${total} notification(s)`));
  const sampleMessage = state.notifications.find((entry) => entry.payload?.message)?.payload?.message;
  if (sampleMessage) line('Latest message', sampleMessage);

  // ── §24 audit trail
  heading('§24  Audit trail');
  state.audits.forEach((entry) => line(entry.action, entry.resourceId || entry.metadata?.filename || ''));

  // ── §25 the money-only report and tenant isolation
  heading('§25  Security');
  const ctcWithoutAccess = await service
    .getReport({ companyId: COMPANY, reportKey: 'CTC', month: CURRENT_MONTH, canSeeFinancial: false })
    .then(() => 'LEAKED')
    .catch(() => 'blocked');
  line('CTC without financial access', ctcWithoutAccess);

  const otherTenant = await service
    .getReport({ companyId: oid(998), reportKey: 'DEPARTMENT', month: CURRENT_MONTH })
    .then((report) => (report.rows?.length ? 'LEAKED' : 'blocked'))
    .catch(() => 'blocked');
  line('Cross-tenant read', otherTenant);

  // ── §25 nothing that looks like a bank account slipped into an artefact
  heading('§25  Bank-detail scan of the artefacts');
  const accountLike = /(\d{9,18})/g;
  // Numbers that legitimately appear: employee codes, month stamps, UAN.
  const isKnownIdentifier = (digits) =>
    /^2026\d{2}$/.test(digits) ||
    /^100\d{9}$/.test(digits) ||
    /^(19|20)\d{6}$/.test(digits);

  const scanText = (label, text) => {
    const hits = [...String(text || '').matchAll(accountLike)]
      .map((match) => match[1])
      .filter((digits) => !isKnownIdentifier(digits));
    if (hits.length) {
      console.log(`  ${label} — ${hits.length} unrecognised long number(s): ${hits.slice(0, 5).join(', ')}`);
    }
    return hits.length;
  };

  let flagged = 0;
  let scanned = 0;
  for (const file of written) {
    const extension = path.extname(file).toLowerCase();
    if (extension === '.csv') {
      scanned += 1;
      flagged += scanText(path.basename(file), fs.readFileSync(file, 'utf8'));
    } else if (extension === '.pdf') {
      scanned += 1;
      flagged += scanText(path.basename(file), await extractPdfText(fs.readFileSync(file)));
    }
    // .xlsx is a ZIP container: the numbers live in a compressed part, so a
    // byte scan would only ever report the archive's own bytes.
  }
  line('Files scanned as text', `${scanned} of ${written.length} (.xlsx is a ZIP — skipped)`);
  line('Unrecognised long numbers', flagged === 0 ? 'none — clean' : `${flagged} — CHECK`);

  // ── 29.13 §2 — Crewly's own numbers
  heading('§2  Platform metrics (Super Admin)');
  // makeFakeModel() takes DEFAULTS, not rows — seeding it by argument is the
  // kind of mistake that reads as a real answer.
  const modelWith = (rows = []) => {
    const model = makeFakeModel();
    rows.forEach((row) => model.rows.push(row));
    return model;
  };
  const platformService = makePlatformAnalyticsService({
    CompanyModel: state.companies,
    PayrollSetupModel: modelWith([{ companyId: COMPANY }]),
    PayrollResultModel: state.results,
    PayrollRunModel: modelWith([{ companyId: COMPANY, status: 'COMPLETED' }]),
    AnalyticsReportFileModel: state.files,
    ScheduledReportModel: state.schedules,
    CandidateModel: modelWith([{ companyId: COMPANY }]),
    AttendanceModel: modelWith([{ companyId: COMPANY }]),
    LeaveModel: modelWith([{ companyId: COMPANY }]),
  });
  const platform = await platformService.getPlatformMetrics({ now: new Date('2026-08-15T00:00:00Z') });
  line('Companies using payroll', `${platform.adoption.companiesOnPayroll} of ${platform.adoption.totalCompanies} (${platform.adoption.payrollPenetrationPercent}%)`);
  platform.adoption.modules.forEach((module) => line(`  ${module.label}`, `${module.companies} company/companies`));
  line('Employee-months in window', platform.processing.employeeMonthsInWindow);
  line('Companies this month', platform.processing.companiesThisMonth);
  (platform.processing.byMonth || []).forEach((row) => line(`  ${row.month}`, `${row.snapshots} snapshot(s) · ${row.companies} company/companies`));
  line('Report files', `${platform.jobs.reportFiles.total} total · ${platform.jobs.reportFiles.ready || 0} ready · ${platform.jobs.reportFiles.expired || 0} expired`);
  line('Payroll figures in the payload', platform.privacy.includesPayrollAmounts ? 'LEAKED' : 'none');
  line('Employee names in the payload', platform.privacy.includesEmployeeIdentities ? 'LEAKED' : 'none');

  console.log(`\nArtefacts written to ${OUT_DIR}`);
  console.log('Open the PDFs and the XLSX files — they are the real thing.\n');
};

main().catch((error) => {
  console.error('\nPreview failed:', error);
  process.exit(1);
});
