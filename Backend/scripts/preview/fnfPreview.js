#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT PREVIEW GENERATOR
//
//      cd Backend && npm run fnf:preview
//
//  WHY THIS EXISTS
//
//  There is no mongod, redis-server or docker in a sandbox, so the app itself
//  cannot be started here. This script is the substitute for clicking through
//  the UI: it builds the REAL settlement service with the REAL rules, the REAL
//  CSV/XLSX writers and the REAL PDF renderer, over fake in-memory models.
//
//  Nothing is stubbed on the output side. The files it writes to
//  Backend/.preview/fnf/ are the artefacts HR, Finance and the employee
//  actually download.
//
//  In 29.9 and 29.10 the equivalent script exposed defects every unit test
//  had passed straight over (a blank payment date, gapped payslip numbers, a
//  rounded EPF split, a wrapping UAN). All of them existed only in the
//  generated output. Run this after any change to a settlement figure or the
//  F&F statement.
//
//  WHAT IT PRINTS AT THE END
//    · the §7 check — payable days must follow the last working day
//    · the §12 check — notice buyout / waiver / completion
//    · the §11 check — earnings minus recoveries equals the net settlement
//    · the §3 check  — the register must carry no other company's row
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFnfService } from '../src/services/payroll/fnfService.js';
import { buildFnfStatementPdf } from '../src/utils/fnfPdf.js';
import { buildXlsx, toCsv } from '../src/services/payroll/payrollPaymentRules.js';
import { LEAVE_TYPES } from '../src/utils/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', '.preview', 'fnf');

// ── fake model ─────────────────────────────────────────────────────────────

const oid = (seed) => `64b7f9c2e4b0a1b2c3d4e${String(seed).padStart(3, '0')}`;

const pathValue = (row, key) =>
  String(key).split('.').reduce((value, part) => (value == null ? undefined : value[part]), row);

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = pathValue(row, key);
    if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
      if (condition.$in) return condition.$in.some((item) => String(item) === String(value));
      if (condition.$ne !== undefined) return String(value) !== String(condition.$ne);
      if (condition.$gte !== undefined && !(String(value) >= String(condition.$gte))) return false;
      if (condition.$lte !== undefined && !(String(value) <= String(condition.$lte))) return false;
      if ('$gte' in condition || '$lte' in condition) return true;
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
    const parts = key.split('.');
    if (parts.length === 1) row[key] = Number(row[key] || 0) + Number(delta);
    else {
      row[parts[0]] = { ...(row[parts[0]] || {}) };
      row[parts[0]][parts[1]] = Number(row[parts[0]][parts[1]] || 0) + Number(delta);
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
        found.sort((a, b) =>
          direction === -1
            ? String(b[field]).localeCompare(String(a[field]))
            : String(a[field]).localeCompare(String(b[field])),
        );
      }
      return found.map((row) => ({ ...row }));
    },
    select: () => buildQuery(filter, sortKey),
    sort: (spec) => {
      const field = Object.keys(spec || {})[0];
      return buildQuery(filter, field ? [field, spec[field]] : sortKey);
    },
    limit: () => buildQuery(filter, sortKey),
  });

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
        select: () => chain,
        sort: () => chain,
        then: (resolve, reject) =>
          (async () => {
            const found = rows.find((row) => matches(row, filter));
            return found ? asDocument(found) : null;
          })().then(resolve, reject),
        catch: (reject) => chain.then(undefined, reject),
      };
      return chain;
    },
    findById: (id) => ({
      lean: async () => {
        const found = rows.find((row) => String(row._id) === String(id));
        return found ? { ...found } : null;
      },
    }),
    countDocuments: async (filter = {}) => rows.filter((row) => matches(row, filter)).length,
    async create(doc) {
      counter += 1;
      const row = { _id: oid(counter + 500), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...doc };
      rows.push(row);
      return asDocument(row);
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
  };

  return model;
};

// ── fixtures ───────────────────────────────────────────────────────────────

const COMPANY = oid(999);
const DEPARTMENT_ENG = oid(50);
const DEPARTMENT_OPS = oid(51);
const MONTH = '2026-08';

// Three exits, three different stories.
const PEOPLE = [
  {
    id: oid(1),
    code: 'CRE-001',
    name: 'Meera Iyer',
    department: DEPARTMENT_ENG,
    designation: 'Senior Engineer',
    joiningDate: '2019-06-03',
    resignationDate: '2026-06-18',
    lastWorkingDate: '2026-08-18',
    gross: 62000,
    basic: 31000,
    noticePeriodDays: 60,
    decision: 'COMPLETED',
    usedEarnedLeave: 4,
    gratuityEligible: true,
    assets: [{ name: 'MacBook Pro 14', category: 'LAPTOP' }],
    extraPayables: [],
    extraRecoveries: [],
    note: 'full notice served, 8 unused earned-leave days, 7 years of service',
  },
  {
    id: oid(2),
    code: 'CRE-002',
    name: 'Vikram Shetty',
    department: DEPARTMENT_OPS,
    designation: 'Operations Executive',
    joiningDate: '2023-02-01',
    resignationDate: '2026-08-01',
    lastWorkingDate: '2026-08-12',
    gross: 45000,
    basic: 22000,
    noticePeriodDays: 60,
    decision: 'BUYOUT',
    usedEarnedLeave: 12,
    gratuityEligible: true,
    assets: [{ name: 'Dell Latitude 5420', category: 'LAPTOP' }, { name: 'Zebra Scanner', category: 'OTHER' }],
    extraPayables: [{ type: 'PERFORMANCE_BONUS', amount: 20000, note: 'Q2 performance bonus' }],
    extraRecoveries: [{ type: 'ASSET', amount: 12000, reason: 'Laptop not returned' }],
    note: '12 days of a 60-day notice → buyout, plus an asset recovery',
  },
  {
    id: oid(3),
    code: 'CRE-003',
    name: 'Asha Rao',
    department: DEPARTMENT_ENG,
    designation: 'Engineering Manager',
    joiningDate: '2016-04-11',
    resignationDate: '2026-07-01',
    lastWorkingDate: '2026-08-31',
    gross: 98000,
    basic: 49000,
    noticePeriodDays: 90,
    decision: 'WAIVED',
    usedEarnedLeave: 2,
    gratuityEligible: true,
    assets: [],
    extraPayables: [{ type: 'INCENTIVE', amount: 45000, note: 'Retention incentive' }],
    extraRecoveries: [{ type: 'CAFETERIA', amount: 850, reason: 'Cafeteria dues' }],
    note: 'served the full month, notice waived, 10 years of service',
  },
];

const state = {
  settlements: makeFakeModel(),
  files: makeFakeModel({ status: 'QUEUED' }),
  resignations: makeFakeModel(),
  assets: makeFakeModel(),
  leaves: makeFakeModel(),
  results: makeFakeModel(),
  periods: makeFakeModel(),
  setups: makeFakeModel(),
  profiles: makeFakeModel(),
  users: makeFakeModel(),
  companies: makeFakeModel(),
  departments: makeFakeModel(),
  audits: [],
  notifications: [],
};

state.companies.rows.push({
  _id: COMPANY,
  name: 'Crewly Technologies Pvt Ltd',
  address: '4th Floor, Prestige Atrium, Bengaluru 560001',
  logoUrl: '',
});
state.departments.rows.push({ _id: DEPARTMENT_ENG, name: 'Engineering' });
state.departments.rows.push({ _id: DEPARTMENT_OPS, name: 'Operations' });
state.periods.rows.push({ _id: oid(70), companyId: COMPANY, month: MONTH, workingDays: 31, status: 'LOCKED' });

PEOPLE.forEach((person, index) => {
  state.users.rows.push({
    _id: person.id,
    companyId: COMPANY,
    employeeCode: person.code,
    name: person.name,
    email: `${person.code.toLowerCase()}@crewly.test`,
    department: person.department,
    designation: person.designation,
    joiningDate: new Date(`${person.joiningDate}T00:00:00Z`),
    status: 'ACTIVE',
  });

  state.resignations.rows.push({
    _id: oid(80 + index),
    companyId: COMPANY,
    user: person.id,
    status: 'APPROVED',
    reason: 'Moving on to a new opportunity',
    lastWorkingDate: new Date(`${person.lastWorkingDate}T00:00:00Z`),
    createdAt: new Date(`${person.resignationDate}T00:00:00Z`),
    decidedAt: new Date(`${person.resignationDate}T00:00:00Z`),
  });

  state.profiles.rows.push({
    _id: oid(700 + index),
    companyId: COMPANY,
    employeeId: person.id,
    isCurrent: true,
    monthlyGross: person.gross,
    statutory: {
      pan: 'ABCPD1234K',
      uan: '100123456789',
      esiNumber: '',
      pfMember: true,
      gratuityEligible: person.gratuityEligible,
    },
    tax: { regime: 'NEW', tdsApplicable: true },
  });

  state.results.rows.push({
    _id: oid(900 + index),
    companyId: COMPANY,
    month: MONTH,
    employeeId: person.id,
    isCurrent: true,
    totals: {
      gross: person.gross,
      basic: person.basic,
      totalEarnings: person.gross,
      totalDeductions: 8000,
      netPay: person.gross - 8000,
    },
    attendance: { workingDays: 31, paidDays: 31, lopDays: 0 },
  });

  if (person.usedEarnedLeave > 0) {
    state.leaves.rows.push({
      _id: oid(710 + index),
      companyId: COMPANY,
      user: person.id,
      type: 'EARNED',
      days: person.usedEarnedLeave,
      status: 'APPROVED',
      startDate: '2026-03-04',
    });
  }

  (person.assets || []).forEach((asset, assetIndex) => {
    state.assets.rows.push({
      _id: oid(720 + index * 10 + assetIndex),
      companyId: COMPANY,
      name: asset.name,
      category: asset.category,
      currentHolder: person.id,
    });
  });
});

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
  async invalidate(companyId) {
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

const service = makeFnfService({
  FinalSettlementModel: state.settlements,
  FinalSettlementFileModel: state.files,
  ResignationModel: state.resignations,
  AssetModel: state.assets,
  LeaveModel: state.leaves,
  PayrollResultModel: state.results,
  PayrollPeriodModel: state.periods,
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
  notify: async ({ userId, type }) => state.notifications.push({ userId, type }),
  notifyRoles: async ({ permission, type }) => {
    state.notifications.push({ userId: `permission:${permission}`, type });
    return 1;
  },
  renderPdf: async (options) => buildFnfStatementPdf(options),
  buildCsv: toCsv,
  buildWorkbook: buildXlsx,
  hash: (value) => `sha256:${Buffer.byteLength(value)}`,
  leaveQuota: Object.keys(LEAVE_TYPES).reduce((acc, key) => {
    acc[key] = LEAVE_TYPES[key]?.yearly ?? 12;
    return acc;
  }, {}),
  ttlSeconds: 60,
});

// ── run the workflow ───────────────────────────────────────────────────────

const payrollActor = { _id: oid(13), name: 'Priya Payroll' };
const hrActor = { _id: oid(11), name: 'Hriday HR' };
const financeActor = { _id: oid(12), name: 'Farah Finance' };

const money0 = (value) => Number(value || 0);
const inrText = (value) =>
  `Rs ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const run = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const created = [];
  for (const person of PEOPLE) {
    const settlement = await service.createSettlement({
      companyId: COMPANY,
      employeeId: person.id,
      resignationId: state.resignations.rows.find((row) => String(row.user) === String(person.id))?._id,
      month: MONTH,
      noticePeriodDays: person.noticePeriodDays,
      noticeDecision: person.decision,
      actor: payrollActor,
    });

    await service.recalculate({ companyId: COMPANY, settlementId: settlement.settlementId, actor: payrollActor });

    if (person.extraPayables.length || person.extraRecoveries.length) {
      await service.updateItems({
        companyId: COMPANY,
        settlementId: settlement.settlementId,
        payables: person.extraPayables,
        recoveries: person.extraRecoveries,
        actor: payrollActor,
      });
    }

    await service.hrReview({
      companyId: COMPANY,
      settlementId: settlement.settlementId,
      checklist: {
        attendanceVerified: true,
        leaveVerified: true,
        assetClearanceCompleted: true,
        noticeDecisionCompleted: true,
      },
      complete: true,
      actor: hrActor,
    });

    await service.financeDecision({
      companyId: COMPANY,
      settlementId: settlement.settlementId,
      action: 'APPROVE',
      remarks: 'Reviewed and approved',
      actor: financeActor,
    });

    await service.markPaid({
      companyId: COMPANY,
      settlementId: settlement.settlementId,
      paidAt: '2026-09-05',
      reference: `NEFT-${person.code}`,
      method: 'Bank Transfer',
      actor: financeActor,
    });

    const statement = await service.requestStatement({
      companyId: COMPANY,
      settlementId: settlement.settlementId,
      actor: payrollActor,
    });

    const detail = await service.getSettlement({ companyId: COMPANY, settlementId: settlement.settlementId });
    created.push({ person, settlement, detail, statement });
  }

  // ── artefacts ────────────────────────────────────────────────────────────
  const written = [];
  for (const { person, settlement, detail } of created) {
    const file = await service.downloadStatement({
      companyId: COMPANY,
      settlementId: settlement.settlementId,
      actor: payrollActor,
    });
    const target = path.join(OUT_DIR, file.filename);
    fs.writeFileSync(target, file.content);
    written.push({ path: target, label: `F&F statement — ${person.name}` });
    detail.statementBytes = file.content.length;
  }

  const csv = await service.getRegister({ companyId: COMPANY, month: MONTH, format: 'CSV' });
  const csvPath = path.join(OUT_DIR, csv.filename);
  fs.writeFileSync(csvPath, csv.content);
  written.push({ path: csvPath, label: 'Settlement register (CSV)' });

  const xlsx = await service.getRegister({ companyId: COMPANY, month: MONTH, format: 'XLSX' });
  const xlsxPath = path.join(OUT_DIR, xlsx.filename);
  fs.writeFileSync(xlsxPath, xlsx.content);
  written.push({ path: xlsxPath, label: 'Settlement register (XLSX)' });

  // ── report ───────────────────────────────────────────────────────────────
  console.log('');
  console.log('  PHASE 29.11 — FINAL SETTLEMENT PREVIEW');
  console.log('  ' + '─'.repeat(74));

  for (const { person, detail } of created) {
    const pending = detail.earnings?.pendingSalary || {};
    const leave = detail.earnings?.leaveEncashment || {};
    const gratuity = detail.earnings?.gratuity || {};
    const notice = detail.recoveries?.notice || {};
    console.log('');
    console.log(`  ${person.name} (${person.code}) — ${detail.settlementNumber}`);
    console.log(`    ${person.note}`);
    console.log(`    last working day   ${person.lastWorkingDate}   status ${detail.statusLabel}`);
    console.log(`    payable days       ${pending.payableDays} of ${pending.workingDays} @ ${inrText(pending.dailyRate)}/day`);
    console.log(`    pending salary     ${inrText(pending.amount)}`);
    console.log(`    leave encashment   ${leave.encashedDays} day(s)  ${inrText(leave.amount)}`);
    console.log(`    gratuity           ${gratuity.eligible ? `${gratuity.creditedYears} yr  ${inrText(gratuity.amount)}` : `not payable — ${gratuity.reason}`}`);
    const noticeLabel = `    notice (${notice.decision})`.padEnd(26);
    console.log(`${noticeLabel}${notice.shortfallDays} shortfall day(s)  ${inrText(notice.amount)}${notice.waived ? '  [waived]' : ''}`);
    const others = (detail.recoveries?.items || []).map((item) => `${item.label} ${inrText(item.amount)}`).join(', ');
    if (others) console.log(`    other recoveries   ${others}`);
    const netLabel = money0(detail.totals?.netSettlement) < 0 ? 'NET RECOVERABLE   ' : 'NET SETTLEMENT    ';
    console.log(`    ${netLabel} ${inrText(detail.totals?.netSettlement)}`);
  }

  console.log('');
  console.log('  ' + '─'.repeat(74));
  console.log('  CHECKS');
  console.log('  ' + '─'.repeat(74));

  const checks = [];

  // §7 — the last working day decides the payable days.
  const meera = created[0].detail;
  const vikram = created[1].detail;
  const asha = created[2].detail;
  checks.push([
    '§7  payable days follow the last working day (18 / 12 / 31)',
    meera.earnings.pendingSalary.payableDays === 18
      && vikram.earnings.pendingSalary.payableDays === 12
      && asha.earnings.pendingSalary.payableDays === 31,
    `${meera.earnings.pendingSalary.payableDays} / ${vikram.earnings.pendingSalary.payableDays} / ${asha.earnings.pendingSalary.payableDays}`,
  ]);

  // §12 — three notice decisions, three outcomes.
  checks.push([
    '§12 completed notice recovers nothing, buyout does, waiver is recorded',
    money0(meera.recoveries.notice.amount) === 0
      && money0(vikram.recoveries.notice.amount) > 0
      && money0(asha.recoveries.notice.amount) === 0
      && asha.recoveries.notice.waived === true,
    `${inrText(meera.recoveries.notice.amount)} / ${inrText(vikram.recoveries.notice.amount)} / waived=${asha.recoveries.notice.waived}`,
  ]);

  // §10 — gratuity needs five years.
  checks.push([
    '§10 gratuity needs five years (7y yes, 3y no, 10y yes)',
    meera.earnings.gratuity.eligible === true
      && vikram.earnings.gratuity.eligible === false
      && asha.earnings.gratuity.eligible === true,
    `${inrText(meera.earnings.gratuity.amount)} / not payable / ${inrText(asha.earnings.gratuity.amount)}`,
  ]);

  // §11 — the arithmetic has to close.
  const balanced = created.every(({ detail }) => {
    const expected = Math.round(
      (money0(detail.totals.totalEarnings) - money0(detail.totals.totalRecoveries)) * 100,
    ) / 100;
    return Math.abs(expected - money0(detail.totals.netSettlement)) < 0.01;
  });
  checks.push([
    '§11 earnings − recoveries = net settlement, for every employee',
    balanced,
    created.map(({ detail }) => inrText(detail.totals.netSettlement)).join('  '),
  ]);

  // §3 — the register carries this company's rows only.
  const otherCompany = await service.getRegister({ companyId: oid(998), month: MONTH });
  checks.push(['§3  another company reads an empty register', otherCompany.rows === 0, `${otherCompany.rows} rows`]);

  // §23 — every action is audited.
  const actions = new Set(state.audits.map((entry) => entry.action));
  checks.push([
    '§23 every stage is audited (create / calculate / review / approve / pay)',
    ['created', 'calculated', 'hr reviewed', 'approved by finance', 'marked paid'].every((fragment) =>
      [...actions].some((action) => String(action).toLowerCase().includes(fragment)),
    ),
    `${state.audits.length} audit entries`,
  ]);

  // §22 — the employee is told when it is paid.
  checks.push([
    '§22 the employee is notified on payment',
    state.notifications.some((entry) => entry.type === 'FNF_SETTLEMENT_PAID'),
    `${state.notifications.filter((entry) => entry.type === 'FNF_SETTLEMENT_PAID').length} payment notifications`,
  ]);

  checks.forEach(([label, ok, detailText]) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (detailText) console.log(`        ${detailText}`);
  });

  console.log('');
  console.log('  ARTEFACTS');
  written.forEach(({ path: filePath, label }) => {
    const size = fs.statSync(filePath).size;
    console.log(`    ${label.padEnd(34)} ${path.relative(path.join(__dirname, '..'), filePath)}  (${size} bytes)`);
  });

  const failed = checks.filter(([, ok]) => !ok);
  console.log('');
  console.log(`  ${failed.length ? `${failed.length} CHECK(S) FAILED` : 'All checks passed.'}`);
  console.log('');
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  console.error('\n  fnf:preview failed:', error?.message || error);
  console.error(error?.stack || '');
  process.exit(1);
});
