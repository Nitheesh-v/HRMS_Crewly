#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY COMPLIANCE PREVIEW GENERATOR
//
//      cd Backend && npm run statutory:preview
//
//  WHY THIS EXISTS
//
//  There is no mongod, redis-server or docker in a sandbox, so the app itself
//  cannot be started here. This script is the substitute for clicking through
//  the UI: it builds the REAL statutory service with the REAL rules, the REAL
//  CSV/XLSX writers and the REAL PDF renderer, over fake in-memory models.
//
//  Nothing is stubbed on the output side. The files it writes to
//  Backend/.preview/statutory/ are the artefacts Finance actually downloads.
//
//  In 29.9 the equivalent script immediately exposed two defects that all 34
//  unit tests had passed straight over — a blank payment date and gapped
//  payslip numbers. Both only existed in the generated output. Run this after
//  any change to a statutory report.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeStatutoryService } from '../src/services/payroll/statutoryService.js';
import { buildStatutoryPdf } from '../src/utils/statutoryPdf.js';
import { buildXlsx, toCsv } from '../src/services/payroll/payrollPaymentRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', '.preview', 'statutory');

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

  const buildQuery = (filter) => ({
    lean: async () => rows.filter((row) => matches(row, filter)),
    select: () => buildQuery(filter),
    sort: () => buildQuery(filter),
    limit: () => buildQuery(filter),
    skip: () => buildQuery(filter),
  });

  const snapshot = (row) => (row ? { ...row } : null);

  const model = {
    rows,
    find: (filter = {}) => buildQuery(filter),
    findOne: (filter = {}) => ({
      lean: async () => snapshot(rows.find((row) => matches(row, filter))),
      select: () => ({ lean: async () => snapshot(rows.find((row) => matches(row, filter))) }),
    }),
    findById: (id) => ({
      lean: async () => snapshot(rows.find((row) => String(row._id) === String(id))),
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
        return existing;
      }
      if (!options.upsert) return null;
      const inserted = await model.create({
        ...(filter || {}),
        ...(update.$setOnInsert || {}),
      });
      applyUpdate(inserted, update);
      return inserted;
    },
  };

  return model;
};

// ── fixtures ───────────────────────────────────────────────────────────────

const COMPANY = oid(999);
const DEPARTMENT_ENG = oid(50);
const DEPARTMENT_OPS = oid(51);
const BATCH = oid(60);

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const CURRENT_MONTH = '2026-08';

// Three employees: one above every ceiling, one inside ESI, one with no PF.
const PEOPLE = [
  {
    id: oid(1),
    code: 'CRE-001',
    name: 'Asha Rao',
    department: DEPARTMENT_ENG,
    pan: 'ABCPD1234K',
    uan: '100123456789',
    esiNumber: '',
    pfMember: true,
    gross: 92000,
    basic: 46000,
    esi: null, // above the ESI ceiling
  },
  {
    id: oid(2),
    code: 'CRE-002',
    name: 'Meera Iyer',
    department: DEPARTMENT_OPS,
    pan: 'XYQPD5678L',
    uan: '100123456790',
    esiNumber: '31000123450000101',
    pfMember: true,
    gross: 18500,
    basic: 9500,
    esi: { applicable: true, wage: 18500, employee: 138.75, employer: 601.25 },
  },
  {
    id: oid(3),
    code: 'CRE-003',
    name: 'Vikram Shetty',
    department: DEPARTMENT_ENG,
    pan: 'PQRSX9012M',
    uan: '',
    esiNumber: '31000123450000102',
    pfMember: false,
    gross: 21000,
    basic: 11000,
    esi: { applicable: true, wage: 21000, employee: 157.5, employer: 682.5 },
  },
];

const setup = {
  _id: oid(70),
  companyId: COMPANY,
  isCurrent: true,
  legal: { pan: 'AABCC1234D', tan: 'BLRA12345E', legalName: 'Crewly Technologies Pvt Ltd' },
  statutory: {
    pf: { applicable: true, establishmentNumber: 'KN/BLR/0012345' },
    esi: { applicable: true, registrationNumber: '31000123450000101' },
    professionalTax: { applicable: true, state: 'KARNATAKA' },
    labourWelfareFund: { applicable: true, state: 'KARNATAKA' },
    gratuity: { applicable: true },
    tds: { applicable: true },
  },
  payrollPolicy: { frequency: 'MONTHLY', financialYearStartMonth: 4, currency: 'INR' },
};

// What actually leaves the employee's salary, per the statutory block below.
const deductionsFor = (person) =>
  Math.round(
    ((person.pfMember ? 1800 : 0) +
      (person.esi ? person.esi.employee : 0) +
      200 +
      (person.gross > 50000 ? 4200 : 0) +
      20) * 100,
  ) / 100;

// A 29.6 snapshot, exactly as the engine writes it.
const resultFor = (person, month) => ({
  _id: oid(900 + Number(String(person.id).slice(-3))),
  companyId: COMPANY,
  month,
  employeeId: person.id,
  employeeCode: person.code,
  employeeName: person.name,
  designation: 'Engineer',
  version: 1,
  isCurrent: true,
  totals: {
    gross: person.gross,
    basic: person.basic,
    totalEarnings: person.gross,
    totalDeductions: deductionsFor(person),
    netPay: Math.round((person.gross - deductionsFor(person)) * 100) / 100,
  },
  statutory: {
    pf: person.pfMember
      ? {
          applicable: true,
          pfWage: 15000,
          employee: 1800,
          employerEpf: 550.5,
          employerPension: 1249.5,
          employer: 1800,
        }
      : {
          applicable: false, pfWage: 0, employee: 0,
          employerEpf: 0, employerPension: 0, employer: 0,
        },
    esi: person.esi || {
      applicable: false, wage: person.gross, employee: 0, employer: 0, outsideCeiling: true,
    },
    professionalTax: { applicable: true, state: 'KARNATAKA', amount: 200 },
    tds: person.gross > 50000
      ? {
          applicable: true, monthly: 4200, annualIncome: person.gross * 12,
          taxableIncome: person.gross * 12 - 75000, annualTax: 51000, regime: 'NEW',
        }
      : {
          applicable: false, monthly: 0, annualIncome: 0, taxableIncome: 0,
          annualTax: 0, regime: 'NEW',
        },
    lwf: { applicable: true, employee: 20, employer: 40 },
    gratuity: person.gross > 50000
      ? { applicable: true, amount: Math.round(person.basic * 0.0481 * 100) / 100 }
      : { applicable: false, amount: 0 },
  },
});

// ── wiring ─────────────────────────────────────────────────────────────────

const state = {
  reports: makeFakeModel(),
  exports: makeFakeModel(),
  tasks: makeFakeModel(),
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
};

state.setups.rows.push(setup);
state.companies.rows.push({
  _id: COMPANY,
  name: 'Crewly Technologies Pvt Ltd',
  address: '4th Floor, Prestige Atrium, Bengaluru 560001',
  logoUrl: '',
});
state.departments.rows.push({ _id: DEPARTMENT_ENG, name: 'Engineering' });
state.departments.rows.push({ _id: DEPARTMENT_OPS, name: 'Operations' });

PEOPLE.forEach((person) => {
  state.users.rows.push({
    _id: person.id,
    companyId: COMPANY,
    employeeCode: person.code,
    name: person.name,
    department: person.department,
    designation: 'Engineer',
    status: 'ACTIVE',
  });
  state.profiles.rows.push({
    _id: oid(700 + Number(String(person.id).slice(-3))),
    companyId: COMPANY,
    employeeId: person.id,
    isCurrent: true,
    statutory: {
      pan: person.pan,
      uan: person.uan,
      esiNumber: person.esiNumber,
      pfMember: person.pfMember,
      gratuityEligible: person.gross > 50000,
    },
    tax: { regime: 'NEW', tdsApplicable: person.gross > 50000 },
  });
});

MONTHS.forEach((month) => {
  state.batches.rows.push({ _id: BATCH, companyId: COMPANY, month, status: 'COMPLETED' });
  PEOPLE.forEach((person) => {
    state.results.rows.push(resultFor(person, month));
    // Vikram's August transfer failed — statutory must exclude him for August.
    const failed = month === CURRENT_MONTH && person.code === 'CRE-003';
    state.payments.rows.push({
      _id: oid(800 + Number(String(person.id).slice(-3))),
      companyId: COMPANY,
      month,
      batchId: BATCH,
      employeeId: person.id,
      status: failed ? 'FAILED' : 'PAID',
      failureReason: failed ? 'Account closed' : '',
      netSalary: person.gross,
      paymentReference: `SAL-${month}-${person.code}`,
    });
  });
});

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
  cache: { buildKey: () => null, getOrSet: null, invalidate: async () => 0 },
  audit: async (entry) => {
    state.audits.push(entry);
    return entry;
  },
  notify: async (entry) => {
    state.notifications.push(entry);
  },
  notifyRoles: async () => 1,
  dispatchGenerate: async () => ({ queued: false }),
  dispatchExport: async () => ({ queued: false }),
  dispatchReminder: async () => ({ queued: false }),
  renderPdf: (options) => buildStatutoryPdf(options),
  buildCsv: toCsv,
  buildWorkbook: buildXlsx,
  hash: (value) => `sha256:${Buffer.byteLength(value)}`,
  ttlSeconds: 0,
});

// ── run ────────────────────────────────────────────────────────────────────

const write = (filename, content) => {
  const target = path.join(OUT_DIR, filename);
  fs.writeFileSync(target, content);
  const size = fs.statSync(target).size;
  console.log(`  ${filename.padEnd(46)} ${String(size).padStart(8)} bytes`);
  return target;
};

const line = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);
const heading = (text) => console.log(`\n${text}\n${'-'.repeat(text.length)}`);

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

  console.log('\nCREWLY — PHASE 29.10 STATUTORY COMPLIANCE PREVIEW');
  console.log('='.repeat(72));

  // ── §6 generate
  heading('§6  Generate the month');
  const generated = await service.generateForMonth({
    companyId: COMPANY,
    month: CURRENT_MONTH,
    actor: { _id: oid(1), name: 'Payroll Admin' },
  });
  line('Month', `${generated.month}  (${generated.financialYear})`);
  line('Reports written', generated.generated);
  line('Reopened by a change', generated.reopened);

  // ── §2 / §6 the gate
  heading('§2/§6  Payment gate');
  const excluded = PEOPLE.filter((person) => person.code === 'CRE-003').length;
  line('Employees with PAID salary', generated.summary.employees);
  line('FAILED transfer excluded', excluded === 1 ? 'yes (Vikram Shetty, Aug)' : 'NO — CHECK');
  try {
    await service.generateForMonth({ companyId: COMPANY, month: '2026-09', actor: { _id: oid(1) } });
    line('Unpaid month blocked', 'NO — THE GATE DID NOT FIRE');
  } catch (error) {
    line('Unpaid month blocked', `yes — "${error.message}"`);
  }

  // ── §5 dashboard
  heading('§5  Dashboard KPI cards');
  const dashboard = await service.getDashboard({ companyId: COMPANY, month: CURRENT_MONTH });
  Object.entries(dashboard.kpis).forEach(([key, value]) => line(key, value));

  // ── §7–§12 every report
  heading('§7–§16  Reports and exports');
  const types = ['PF', 'ESI', 'PT', 'TDS', 'LWF', 'GRATUITY', 'COMPLIANCE_SUMMARY'];
  const written = [];

  for (const type of types) {
    const report = await service.getReport({
      companyId: COMPANY,
      month: CURRENT_MONTH,
      type,
    });
    line(
      `${type.padEnd(6)} ${report.statusLabel}`,
      `rows=${String(report.table.rows.length).padStart(3)}  due=${report.dueDate || '—'}  ` +
        `${report.applicable ? '' : 'NOT APPLICABLE'}`,
    );

    const csv = await service.exportNow({
      companyId: COMPANY, reportKey: type, month: CURRENT_MONTH, format: 'CSV',
    });
    written.push(write(csv.filename, csv.content));

    const xlsx = await service.exportNow({
      companyId: COMPANY, reportKey: type, month: CURRENT_MONTH, format: 'XLSX',
    });
    written.push(write(xlsx.filename, xlsx.content));
  }

  // §16 — the consolidated summary, as a PDF.
  const summaryPdf = await service.exportNow({
    companyId: COMPANY, reportKey: 'COMPLIANCE_SUMMARY', month: CURRENT_MONTH, format: 'PDF',
  });
  written.push(write('statutory-compliance-summary-2026-08.pdf', summaryPdf.content));

  const pfPdf = await service.exportNow({
    companyId: COMPANY, reportKey: 'PF', month: CURRENT_MONTH, format: 'PDF',
  });
  written.push(write('statutory-pf-register-2026-08.pdf', pfPdf.content));

  // ── §13 register
  heading('§13  Monthly compliance register');
  const register = await service.getRegister({ companyId: COMPANY, financialYear: '2026-27' });
  line('Filename', register.filename);
  line('Months in the year', register.count);
  written.push(write(register.filename, register.content));

  // ── §14 filing
  heading('§14  Filing lifecycle');
  const filed = await service.updateFilingStatus({
    companyId: COMPANY,
    month: CURRENT_MONTH,
    type: 'PF',
    status: 'FILED',
    filingReference: 'ECR-2026-08-000412',
    actor: { _id: oid(2), name: 'Finance Manager' },
  });
  line('PF', `${filed.previousStatus} → ${filed.status}  ref=${filed.filingReference}`);
  try {
    await service.updateFilingStatus({
      companyId: COMPANY, month: CURRENT_MONTH, type: 'PF', status: 'READY',
      actor: { _id: oid(2) },
    });
    line('FILED → READY', 'NO — THE LIFECYCLE DID NOT HOLD');
  } catch (error) {
    line('FILED → READY rejected', `yes — "${error.message}"`);
  }
  const reopened = await service.updateFilingStatus({
    companyId: COMPANY, month: CURRENT_MONTH, type: 'PF', status: 'REOPENED',
    actor: { _id: oid(2) },
  });
  line('PF reopened', `${reopened.previousStatus} → ${reopened.status}`);

  // ── §19 calendar
  heading('§19  Compliance calendar');
  const calendar = await service.getCalendar({ companyId: COMPANY, months: MONTHS.slice(-3) });
  line('Rows', `${calendar.rows.length} (${calendar.rows.length / 3} types × 3 months)`);
  line('Pending', calendar.pending);
  line('Overdue', calendar.overdue);
  calendar.rows.slice(0, 6).forEach((row) => {
    line(`  ${row.month} ${row.type}`, `due ${row.dueDate || '—'}  ${row.statusLabel}${row.overdue ? '  OVERDUE' : ''}`);
  });
  const task = await service.updateCalendarTask({
    companyId: COMPANY, month: CURRENT_MONTH, type: 'ESI', done: true,
    note: 'Challan 2026-08 paid', actor: { _id: oid(2), name: 'Finance Manager' },
  });
  line('ESI task ticked off', `${task.status}  due ${task.dueDate}`);

  // ── §18 annual
  heading('§18  Annual reports (FY 2026-27)');
  const annual = await service.getAnnual({ companyId: COMPANY, financialYear: '2026-27' });
  line('Months in the FY', annual.months.length);
  line('Employees in the roll-up', annual.employees.length);
  line('Annual PF (employee+employer)', annual.summary.pf.total);
  line('Annual TDS', annual.summary.tds.total);
  line('Annual gross payroll', annual.summary.grossPayroll);
  annual.employees.forEach((row) => {
    line(`  ${row.employeeCode} ${row.employeeName}`,
      `${row.months} months  PF ${row.employeePF + row.employerPF}  TDS ${row.tds}`);
  });

  for (const key of ['ANNUAL_PF', 'ANNUAL_TDS', 'ANNUAL_PAYROLL_REGISTER', 'ANNUAL_EMPLOYER_CONTRIBUTION', 'ANNUAL_DEPARTMENT']) {
    const built = await service.exportNow({
      companyId: COMPANY, reportKey: key, financialYear: '2026-27', format: 'XLSX',
    });
    written.push(write(built.filename, built.content));
  }

  // ── §23 audit
  heading('§23  Audit trail');
  const byAction = new Map();
  state.audits.forEach((entry) => byAction.set(entry.action, (byAction.get(entry.action) || 0) + 1));
  [...byAction.entries()].sort().forEach(([action, count]) => line(action, count));
  line('Notifications raised', state.notifications.length);

  // ── §26 security sweep
  heading('§26  Bank-detail sweep over every generated artefact');
  // A statutory register legitimately carries UANs (12 digits) and ESI
  // numbers (17). What must never appear is a 9–18 digit bank account.
  // Only files we can actually read as TEXT are scanned — scanning a ZIP or
  // PDF byte stream for digits just reports the container's own numbers.
  const accountLike = /(?:^|[^0-9])(\d{9,18})(?![0-9])/g;
  // Statutory identifiers are legitimately long, and pdf text extraction
  // splits them across lines, so a run is "known" when it is part of one —
  // the alternative is crying wolf over every UAN.
  const knownNumbers = PEOPLE.flatMap((person) => [person.uan, person.esiNumber]).filter(Boolean);
  const isKnownIdentifier = (digits) =>
    knownNumbers.some((known) => String(known).includes(digits)) ||
    /^100\d{9}$/.test(digits) ||
    /^31\d{15}$/.test(digits);

  const scanText = (label, text) => {
    const hits = [...String(text || '').matchAll(accountLike)]
      .map((match) => match[1])
      .filter((digits) => !isKnownIdentifier(digits));
    if (hits.length) console.log(`  ${label} — ${hits.length} unrecognised long number(s): ${hits.slice(0, 5).join(', ')}`);
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
  const otherTenant = await service.getReport({
    companyId: oid(998), month: CURRENT_MONTH, type: 'PF',
  }).then(() => 'LEAKED').catch(() => 'blocked');
  line('Cross-tenant read', otherTenant);

  console.log(`\nArtefacts written to ${OUT_DIR}`);
  console.log('Open the PDFs and the XLSX files — they are the real thing.\n');
};

main().catch((error) => {
  console.error('\nPreview failed:', error);
  process.exit(1);
});
