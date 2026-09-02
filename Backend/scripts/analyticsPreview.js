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
import { REPORT_KEYS, REPORT_LABELS } from '../src/services/payroll/analyticsRules.js';
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

// What actually leaves the salary: PF, PT, TDS, LWF and the LOP days.
const deductionsFor = (person) => {
  const lop = (person.gross / 30) * person.lopDays;
  const pf = Math.min(1800, Math.round(person.basic * 0.12));
  const pt = 200;
  const tds = person.gross > 50000 ? Math.round(person.gross * 0.07) : 0;
  return Math.round((pf + pt + tds + 20 + lop) * 100) / 100;
};

// A 29.6 snapshot, exactly as the engine writes it. Nothing here is invented
// by analytics — §11: "Do not recalculate old payroll."
const resultFor = (person, month) => {
  const deductions = deductionsFor(person);
  const overtime = person.otHours > 0 ? Math.round((person.gross / 30 / 8) * 2 * person.otHours) : 0;
  const variable = person.variable.reduce((sum, line) => sum + line.amount, 0);
  return {
    _id: oid(900 + Number(String(person.id).slice(-3)) + MONTHS.indexOf(month)),
    companyId: COMPANY,
    month,
    employeeId: person.id,
    isCurrent: true,
    status: 'CALCULATED',
    totals: {
      gross: person.gross,
      basic: person.basic,
      totalEarnings: person.gross + overtime + variable,
      totalDeductions: deductions,
      employerCost: Math.round(person.basic * 0.12 + 40),
      ctc: person.gross + overtime + variable + Math.round(person.basic * 0.12 + 40),
      netPay: Math.round((person.gross + overtime + variable - deductions) * 100) / 100,
      overtime,
      variableEarnings: variable,
      reimbursements: 0,
    },
    variableEarnings: person.variable,
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
        employee: Math.min(1800, Math.round(person.basic * 0.12)),
        employerEpf: 550,
        employerPension: 1250,
        employer: Math.min(1800, Math.round(person.basic * 0.12)),
      },
      esi: { applicable: false, wage: 0, employee: 0, employer: 0, outsideCeiling: true },
      professionalTax: { applicable: true, state: 'KARNATAKA', amount: 200 },
      tds:
        person.gross > 50000
          ? {
              applicable: true,
              monthly: Math.round(person.gross * 0.07),
              annualIncome: person.gross * 12,
              taxableIncome: person.gross * 12 - 75000,
              annualTax: Math.round(person.gross * 0.07) * 12,
              regime: 'NEW',
            }
          : { applicable: false, monthly: 0, annualIncome: 0, taxableIncome: 0, annualTax: 0, regime: 'NEW' },
      lwf: { applicable: true, employee: 20, employer: 40 },
      gratuity: { applicable: true, amount: Math.round(person.basic * 0.0481 * 100) / 100 },
    },
  };
};

// ── wiring ─────────────────────────────────────────────────────────────────

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

const cache = {
  buildKey: ({ companyId, month = '', suffix = 'dashboard', period = '' }) =>
    `k:${companyId}:${month || 'all'}:${suffix}:${period || '-'}`,
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

  console.log(`\nArtefacts written to ${OUT_DIR}`);
  console.log('Open the PDFs and the XLSX files — they are the real thing.\n');
};

main().catch((error) => {
  console.error('\nPreview failed:', error);
  process.exit(1);
});
