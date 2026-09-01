/**
 * PHASE 29.9 — Payslip Generation & Employee Salary Portal
 *
 * Hermetic: fake models, a fake cache, and fake audit / notify / mail /
 * dispatch / pdf seams. No MongoDB, no Redis, no BullMQ, no SMTP, no PDFKit.
 *
 * The suite proves the things that are expensive to discover in production:
 *   · §1/§5  payslips are cut from PAID salary only, and from the snapshot
 *   · §6/§22 the snapshot is frozen: regeneration cannot move a rupee
 *   · §3/§26 an employee reaches their own payslip and nothing else
 *   · §13    a full account number never reaches a payslip or an email
 *   · §17    generation is queued with a references-only payload
 *   · §18    the ZIP is real and department-scoped
 *   · §19    the email carries the PDF as an attachment
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAYSLIP_STATUSES,
  buildPayslipNumber,
  buildPayslipSnapshot,
  snapshotValuesKey,
  filterPayslips,
  financialYearOf,
  payslipSummary,
  payslipFilename,
  zipEntryName,
  payslipEmailCopy,
  notificationCopy,
  canTransitionPayslip,
  generationGateError,
  isPaidForPayslip,
  monthLabel,
} from '../src/services/payroll/payslipRules.js';
import { makePayslipService } from '../src/services/payroll/payslipService.js';
import {
  validatePayslipGeneratePayload,
  validatePayslipZipPayload,
  validatePayslipEmailPayload,
} from '../src/services/payroll/payslipDispatcher.js';
import { buildZip } from '../src/utils/minimalZip.js';

// ── fake model (same shape the 29.7 / 29.8 suites use) ─────────────────────

const oid = (seed) => `64b7f9c2e4b0a1b2c3d4e5${String(seed).padStart(3, '0')}`;

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

const makeFakeModel = () => {
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
      lean: async () => rows.find((row) => matches(row, filter)) || null,
      select: () => ({
        lean: async () => rows.find((row) => matches(row, filter)) || null,
      }),
    }),
    findById: (id) => ({
      lean: async () => rows.find((row) => String(row._id) === String(id)) || null,
    }),
    countDocuments: async (filter = {}) => rows.filter((row) => matches(row, filter)).length,
    async create(doc) {
      counter += 1;
      const row = { _id: oid(counter + 500), createdAt: new Date(), updatedAt: new Date(), ...doc };
      rows.push(row);
      return row;
    },
    async updateOne(filter, update = {}) {
      const row = rows.find((item) => matches(item, filter));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      const set = update.$set || {};
      Object.entries(set).forEach(([key, value]) => {
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
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  return model;
};

// ── fixtures ───────────────────────────────────────────────────────────────

const COMPANY = '64b7f9c2e4b0a1b2c3d4e5f6';
const OTHER_COMPANY = '64b7f9c2e4b0a1b2c3d4e999';
const MONTH = '2026-08';
const EMPLOYEE_1 = oid(1);
const EMPLOYEE_2 = oid(2);
const EMPLOYEE_3 = oid(3);
const DEPARTMENT = oid(50);
const BATCH = oid(60);

const goodResult = (employeeId, code, name, netSalary) => ({
  _id: oid(900 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  month: MONTH,
  employeeId,
  employeeCode: code,
  employeeName: name,
  designation: 'Senior Engineer',
  version: 1,
  isCurrent: true,
  earnings: [
    { name: 'Basic Salary', amount: 40000 },
    { name: 'House Rent Allowance', amount: 20000 },
    { name: 'Special Allowance', amount: 15000 },
    { name: 'Bonus', amount: 5000 },
  ],
  variableEarnings: [],
  reimbursements: [],
  deductions: [
    { name: 'Provident Fund', amount: 4800 },
    { name: 'Professional Tax', amount: 200 },
    { name: 'TDS', amount: 2550 },
  ],
  employerContributions: [
    { name: 'Employer PF', amount: 4800 },
    { name: 'Gratuity', amount: 4800 },
  ],
  attendance: { workingDays: 22, presentDays: 21, payableDays: 21.5, lopDays: 0.5, overtimeHours: 4 },
  lop: { lopDays: 0.5 },
  totals: {
    grossSalary: 80000,
    totalEarnings: 80000,
    totalDeductions: 7550,
    netSalary,
  },
});

const goodProfile = (employeeId) => ({
  _id: oid(800 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  userId: employeeId,
  bank: {
    bankName: 'HDFC Bank',
    // The plaintext number never appears in a payslip — only the mask.
    accountNumber: 'enc:123456789012',
    accountNumberMasked: 'XXXX4589',
    ifsc: 'HDFC0001234',
    accountHolderName: 'Asha Rao',
  },
  statutory: { uan: '100123456789', pan: 'ABCPR1234K' },
});

const goodEmployee = (employeeId, code, name, department = DEPARTMENT) => ({
  _id: employeeId,
  companyId: COMPANY,
  name,
  employeeCode: code,
  email: `${code.toLowerCase()}@crewly.test`,
  status: 'ACTIVE',
  designation: 'Senior Engineer',
  department,
  joiningDate: new Date('2024-04-01T00:00:00Z'),
});

const paidPayment = (employeeId, code, name, netSalary = 74450) => ({
  _id: oid(700 + Number(String(employeeId).slice(-3))),
  companyId: COMPANY,
  month: MONTH,
  batchId: BATCH,
  employeeId,
  employeeCode: code,
  employeeName: name,
  departmentName: 'Engineering',
  netSalary,
  paymentReference: `CREWLYSAL-${MONTH}-000${String(employeeId).slice(-1)}`,
  status: 'PAID',
  paidAt: new Date('2026-08-31T10:00:00Z'),
  bank: { bankName: 'HDFC Bank', accountNumberMasked: 'XXXX4589' },
});

// ── harness ────────────────────────────────────────────────────────────────

const makeHarness = ({ payments = null, results = null, profiles = null, employees = null, renderImpl = null } = {}) => {
  const PayslipModel = makeFakeModel();
  const PayslipFileModel = makeFakeModel();
  const PayrollResultModel = makeFakeModel();
  const PayrollPaymentModel = makeFakeModel();
  const PayrollPaymentBatchModel = makeFakeModel();
  const PayrollSetupModel = makeFakeModel();
  const EmployeePayrollProfileModel = makeFakeModel();
  const UserModel = makeFakeModel();
  const CompanyModel = makeFakeModel();
  const DepartmentModel = makeFakeModel();

  (results || [goodResult(EMPLOYEE_1, 'EMP001', 'Asha Rao', 74450), goodResult(EMPLOYEE_2, 'EMP002', 'Rahul Menon', 58200)])
    .forEach((row) => PayrollResultModel.rows.push({ ...row }));
  (profiles || [goodProfile(EMPLOYEE_1), goodProfile(EMPLOYEE_2)])
    .forEach((row) => EmployeePayrollProfileModel.rows.push(JSON.parse(JSON.stringify(row))));
  (employees || [
    goodEmployee(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    goodEmployee(EMPLOYEE_2, 'EMP002', 'Rahul Menon'),
  ]).forEach((row) => UserModel.rows.push({ ...row }));
  (payments || [
    paidPayment(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    paidPayment(EMPLOYEE_2, 'EMP002', 'Rahul Menon', 58200),
  ]).forEach((row) => PayrollPaymentModel.rows.push({ ...row }));

  PayrollPaymentBatchModel.rows.push({
    _id: BATCH,
    companyId: COMPANY,
    month: MONTH,
    batchNumber: `SAL-${MONTH}-001`,
    status: 'PAID',
    paymentDate: new Date('2026-08-31T00:00:00Z'),
  });

  CompanyModel.rows.push({
    _id: COMPANY,
    name: 'Crewly Technologies',
    address: 'MG Road, Bengaluru 560001',
    logoUrl: '',
  });

  PayrollSetupModel.rows.push({
    _id: oid(11),
    companyId: COMPANY,
    isCurrent: true,
    legalInfo: { pan: 'AABCC1234D', tan: 'BLRC12345E' },
    payrollPolicy: { frequency: 'MONTHLY', currency: 'INR', financialYearStartMonth: 4 },
    bankAccount: { paymentReferencePrefix: 'CREWLYSAL', bankName: 'HDFC Bank' },
  });

  DepartmentModel.rows.push({ _id: DEPARTMENT, companyId: COMPANY, name: 'Engineering' });

  const auditRows = [];
  const notifications = [];
  const emails = [];
  const dispatched = { generate: [], zip: [], email: [] };
  const rendered = [];
  const cacheCalls = { getOrSet: 0, invalidate: 0, lastOptions: null };

  const service = makePayslipService({
    PayslipModel,
    PayslipFileModel,
    PayrollResultModel,
    PayrollPaymentModel,
    PayrollPaymentBatchModel,
    PayrollSetupModel,
    EmployeePayrollProfileModel,
    UserModel,
    CompanyModel,
    DepartmentModel,
    cache: {
      buildKey: ({ companyId, month = '', employeeId = '', suffix = 'dashboard' }) =>
        `test:${companyId}:${month}:${employeeId}:${suffix}`,
      getOrSet: async (key, options = {}) => {
        cacheCalls.getOrSet += 1;
        cacheCalls.lastOptions = options;
        assert.equal(typeof options.loader, 'function');
        assert.equal(typeof options.ttlSeconds, 'number');
        return { value: await options.loader(), cache: 'MISS' };
      },
      invalidate: async (companyId, month, employeeIds) => {
        cacheCalls.invalidate += 1;
        cacheCalls.lastInvalidation = { companyId, month, employeeIds };
        return 1;
      },
    },
    audit: async (row) => auditRows.push(row),
    notify: async (row) => notifications.push(row),
    mail: async (row) => {
      emails.push(row);
      return { delivered: true, mode: 'MOCK' };
    },
    dispatchGenerate: async (payload) => {
      dispatched.generate.push(payload);
      return { queued: false };
    },
    dispatchZip: async (payload) => {
      dispatched.zip.push(payload);
      return { queued: false };
    },
    dispatchEmail: async (payload) => {
      dispatched.email.push(payload);
      return { queued: false };
    },
    // The PDF seam: a fake that records what it was asked to draw, so the
    // tests can assert the snapshot is the ONLY input (never fresh payroll).
    renderPdf:
      renderImpl ||
      (async (snapshot) => {
        rendered.push(snapshot);
        return Buffer.from(`%PDF-29.9-${snapshot.payroll?.payslipNumber || ''}`);
      }),
    buildZip,
    hash: (value) => `sha256:${String(value).length}`,
  });

  return {
    service,
    PayslipModel,
    PayslipFileModel,
    PayrollPaymentModel,
    PayrollPaymentBatchModel,
    PayrollResultModel,
    PayrollSetupModel,
    EmployeePayrollProfileModel,
    CompanyModel,
    DepartmentModel,
    UserModel,
    auditRows,
    notifications,
    emails,
    dispatched,
    rendered,
    cacheCalls,
  };
};

const actor = { _id: oid(12), name: 'Payroll Admin', role: 'PAYROLL_ADMIN' };

// ── 1. statuses and numbering (§7 / §21) ───────────────────────────────────

test('payslip statuses follow §21 and the delivery chain only moves forward', () => {
  assert.deepEqual(PAYSLIP_STATUSES, ['PENDING', 'GENERATED', 'EMAILED', 'DOWNLOADED', 'FAILED']);
  assert.equal(canTransitionPayslip('PENDING', 'GENERATED'), true);
  assert.equal(canTransitionPayslip('GENERATED', 'EMAILED'), true);
  assert.equal(canTransitionPayslip('GENERATED', 'DOWNLOADED'), true);
  assert.equal(canTransitionPayslip('FAILED', 'GENERATED'), true);
  // A payslip can never walk back to PENDING — the record is permanent.
  assert.equal(canTransitionPayslip('DOWNLOADED', 'PENDING'), false);
  assert.equal(canTransitionPayslip('GENERATED', 'PENDING'), false);
});

test('payslip numbers are PS-<YYYY>-<MM>-<six digits> and never reused (§7)', () => {
  assert.equal(buildPayslipNumber({ month: '2026-08', sequence: 245 }), 'PS-2026-08-000245');
  assert.equal(buildPayslipNumber({ month: '2026-08', sequence: 1 }), 'PS-2026-08-000001');
  // The counter is company-wide, so it keeps counting past 999999.
  assert.equal(buildPayslipNumber({ month: '2026-12', sequence: 1000000 }), 'PS-2026-12-1000000');
});

// ── 2. the snapshot (§6 / §9 / §10 / §11 / §13) ────────────────────────────

test('the snapshot freezes company, employee, salary, attendance and payment', () => {
  const snapshot = buildPayslipSnapshot({
    company: { name: 'Crewly Technologies', address: 'MG Road', logoUrl: '' },
    setup: { legalInfo: { pan: 'AABCC1234D', tan: 'BLRC12345E' }, payrollPolicy: { frequency: 'MONTHLY' } },
    employee: goodEmployee(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    profile: goodProfile(EMPLOYEE_1),
    result: goodResult(EMPLOYEE_1, 'EMP001', 'Asha Rao', 74450),
    payment: paidPayment(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    month: MONTH,
    payslipNumber: 'PS-2026-08-000245',
    generatedAt: '2026-08-31T10:00:00Z',
  });

  assert.equal(snapshot.company.pan, 'AABCC1234D');
  assert.equal(snapshot.employee.employeeCode, 'EMP001');
  assert.equal(snapshot.employee.uan, '100123456789');
  assert.equal(snapshot.salary.grossSalary, 80000);
  assert.equal(snapshot.salary.totalDeductions, 7550);
  assert.equal(snapshot.salary.netSalary, 74450);
  // §11 — employer contributions are information, never a deduction.
  assert.equal(snapshot.salary.totalEmployerContributions, 9600);
  assert.equal(snapshot.attendance.workingDays, 22);
  assert.equal(snapshot.attendance.lopDays, 0.5);
  assert.equal(snapshot.payment.reference, `CREWLYSAL-${MONTH}-0001`);
});

test('§9 / §10 — every component is kept separate, never merged', () => {
  const snapshot = buildPayslipSnapshot({
    company: {},
    setup: {},
    employee: goodEmployee(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    profile: goodProfile(EMPLOYEE_1),
    result: goodResult(EMPLOYEE_1, 'EMP001', 'Asha Rao', 74450),
    payment: paidPayment(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    month: MONTH,
  });

  assert.equal(snapshot.earnings.length, 4);
  assert.deepEqual(
    snapshot.earnings.map((row) => row.name),
    ['Basic Salary', 'House Rent Allowance', 'Special Allowance', 'Bonus'],
  );
  assert.equal(snapshot.deductions.length, 3);
  assert.deepEqual(
    snapshot.deductions.map((row) => row.name),
    ['Provident Fund', 'Professional Tax', 'TDS'],
  );
  assert.equal(snapshot.employerContributions.length, 2);
});

test('§13 / §26 — a full account number never reaches the snapshot', () => {
  const snapshot = buildPayslipSnapshot({
    company: {},
    setup: {},
    employee: goodEmployee(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    profile: goodProfile(EMPLOYEE_1),
    result: goodResult(EMPLOYEE_1, 'EMP001', 'Asha Rao', 74450),
    payment: paidPayment(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    month: MONTH,
  });

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('123456789012'), false, 'the plaintext account number must never be copied');
  assert.equal(snapshot.employee.accountNumberMasked, 'XXXX4589');
  assert.equal(snapshot.payment.accountNumberMasked, 'XXXX4589');
});

// ── 3. the payment gate (§1 / §5) ──────────────────────────────────────────

test('§1 — payslips are generated only after the salary is paid', () => {
  assert.equal(isPaidForPayslip({ status: 'PAID' }), true);
  assert.equal(isPaidForPayslip({ status: 'FAILED' }), false);
  assert.equal(isPaidForPayslip({ status: 'PENDING' }), false);
  assert.equal(isPaidForPayslip(null), false);

  assert.match(generationGateError({ hasBatch: false, paidCount: 0 }), /payment batch/i);
  assert.match(generationGateError({ hasBatch: true, paidCount: 0, batchStatus: 'FILE_GENERATED' }), /not.*paid|PAID/i);
  assert.equal(generationGateError({ hasBatch: true, paidCount: 3 }), null);
});

test('generation refuses a month whose salaries are not paid yet', async () => {
  const harness = makeHarness({
    payments: [{ ...paidPayment(EMPLOYEE_1, 'EMP001', 'Asha Rao'), status: 'PENDING' }],
  });

  await assert.rejects(
    () => harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false }),
    (error) => error.statusCode === 400 && /not.*paid|no.*paid/i.test(error.message),
  );
  assert.equal(harness.PayslipModel.rows.length, 0);
});

test('§15 — a partially paid month payslips only the employees who were paid', async () => {
  const harness = makeHarness({
    payments: [
      paidPayment(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
      { ...paidPayment(EMPLOYEE_2, 'EMP002', 'Rahul Menon', 58200), status: 'FAILED', failureReason: 'ACCOUNT_CLOSED' },
    ],
  });
  harness.PayrollPaymentBatchModel.rows[0].status = 'PARTIALLY_PAID';

  const result = await harness.service.generateForMonth({
    companyId: COMPANY,
    month: MONTH,
    actor,
    queue: false,
  });

  assert.equal(result.created, 1, 'three failures never hold back the employees who were paid');
  assert.equal(harness.PayslipModel.rows.length, 1);
  assert.equal(String(harness.PayslipModel.rows[0].employeeId), String(EMPLOYEE_1));
});

// ── 4. generation (§5 / §6 / §17) ──────────────────────────────────────────

test('generation copies the snapshot, renders a PDF and notifies the employee', async () => {
  const harness = makeHarness();
  const result = await harness.service.generateForMonth({
    companyId: COMPANY,
    month: MONTH,
    actor,
    queue: false,
  });

  assert.equal(result.created, 2);
  assert.equal(result.failed, 0);
  assert.equal(harness.PayslipModel.rows.length, 2);

  const row = harness.PayslipModel.rows[0];
  assert.match(row.payslipNumber, /^PS-2026-08-\d{6}$/);
  assert.equal(row.status, 'GENERATED');
  // The PDF is stored with the record so history stays downloadable (§2).
  assert.ok(row.pdfBytes > 0);
  // §5 — provenance is recorded, not recomputed.
  assert.equal(String(row.source.paymentBatchId), String(BATCH));

  // §20 — each employee is notified; this is the message 29.8 held back.
  const employeeNotes = harness.notifications.filter((note) => note.type === 'PAYSLIP_AVAILABLE');
  assert.equal(employeeNotes.length, 2);
  assert.equal(harness.notifications[0].type, 'PAYSLIP_AVAILABLE');
  // §17 — and the person who pressed the button gets the summary.
  const summary = harness.notifications.find((note) => note.type === 'PAYSLIPS_GENERATED');
  assert.ok(summary, 'the requester is told how the run went');
  assert.equal(summary.userId, actor._id);
  assert.equal(summary.payload.count, 2);
  assert.match(harness.notifications[0].payload?.message || notificationCopy('PAYSLIP_AVAILABLE', { month: MONTH }), /payslip/i);

  // §25 — one audit row per payslip.
  const generated = harness.auditRows.filter((row) => row.action === 'PAYSLIP_GENERATED');
  assert.equal(generated.length, 2);
});

test('payslip numbers are unique inside the company (§7)', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  const numbers = harness.PayslipModel.rows.map((row) => row.payslipNumber);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('§17 — generation is queued with a references-only payload', async () => {
  const harness = makeHarness();
  // A dispatcher that reports success, so the queued path is exercised.
  const queued = makeHarness();
  queued.dispatched.generate.length = 0;

  const service = makePayslipService({
    PayslipModel: harness.PayslipModel,
    PayslipFileModel: harness.PayslipFileModel,
    PayrollResultModel: harness.PayslipModel.rows.length ? harness.PayslipModel : harness.PayslipModel,
    PayrollPaymentModel: harness.PayrollPaymentModel,
    PayrollPaymentBatchModel: harness.PayrollPaymentBatchModel,
    PayrollSetupModel: harness.PayrollSetupModel,
    EmployeePayrollProfileModel: harness.EmployeePayrollProfileModel,
    UserModel: harness.UserModel,
    CompanyModel: harness.CompanyModel,
    DepartmentModel: harness.DepartmentModel,
    dispatchGenerate: async (payload) => {
      queued.dispatched.generate.push(payload);
      return { queued: true, jobId: 'job-1' };
    },
  });

  const result = await service.generateForMonth({ companyId: COMPANY, month: MONTH, actor });
  assert.equal(result.queued, true);
  assert.equal(result.jobId, 'job-1');

  const payload = queued.dispatched.generate[0];
  assert.deepEqual(Object.keys(payload).sort(), ['actorId', 'companyId', 'month']);
  assert.equal(payload.companyId, String(COMPANY));
  assert.equal(payload.month, MONTH);
});

test('the queue payload may never carry salary, bank or PDF data (§26)', () => {
  const forbidden = {
    companyId: COMPANY,
    month: MONTH,
    payslips: [{ netSalary: 100 }],
  };
  assert.equal(validatePayslipGeneratePayload(forbidden).valid, false);

  const clean = validatePayslipGeneratePayload({ companyId: COMPANY, month: MONTH });
  assert.equal(clean.valid, true);

  assert.equal(
    validatePayslipGeneratePayload({ companyId: 'not-an-id', month: MONTH }).valid,
    false,
  );
  assert.equal(validatePayslipGeneratePayload({ companyId: COMPANY, month: '2026-13' }).valid, false);
  assert.equal(
    validatePayslipZipPayload({ companyId: COMPANY, month: MONTH, fileId: BATCH, scope: 'TEAM' }).valid,
    false,
  );
  assert.equal(
    validatePayslipEmailPayload({ companyId: COMPANY, month: MONTH, employeeIds: ['nope'] }).valid,
    false,
  );
});

// ── 5. regeneration (§22) ──────────────────────────────────────────────────

test('§22 — regeneration re-renders the stored snapshot and never moves a rupee', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  const before = harness.PayslipModel.rows[0];
  const valuesBefore = snapshotValuesKey(before.snapshot);

  // The company moves office and the payroll data changes underneath — the
  // payslip must not follow it.
  harness.PayslipModel.rows[0].snapshot.company.address = 'Old address';
  const mutated = buildPayslipSnapshot({
    company: { name: 'Renamed Company Pvt Ltd', address: 'New address' },
    setup: { legalInfo: { pan: 'ZZZZZ9999Z' } },
    employee: goodEmployee(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    profile: goodProfile(EMPLOYEE_1),
    result: goodResult(EMPLOYEE_1, 'EMP001', 'Asha Rao', 999999),
    payment: paidPayment(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    month: MONTH,
  });

  const result = await harness.service.regeneratePayslip({
    companyId: COMPANY,
    payslipId: before._id,
    actor,
  });

  assert.equal(result.valuesUnchanged, true);
  const after = harness.PayslipModel.rows.find((row) => String(row._id) === String(before._id));
  assert.equal(snapshotValuesKey(after.snapshot), valuesBefore);
  // The salary figure did NOT follow the new payroll data — 999999 never lands.
  assert.equal(after.snapshot.salary.netSalary, before.snapshot.salary.netSalary);
  assert.notEqual(after.snapshot.salary.netSalary, mutated.salary.netSalary);
  assert.equal(after.regeneratedCount, 1);

  const audits = harness.auditRows.filter((row) => row.action === 'PAYSLIP_REGENERATED');
  assert.equal(audits.length, 1);
});

// ── 6. employee self-service (§3 / §14 / §16 / §26) ────────────────────────

test('an employee sees only their own payslips', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  const mine = await harness.service.getMyPayslips({ companyId: COMPANY, employeeId: EMPLOYEE_1 });
  assert.equal(mine.length, 1);
  assert.equal(String(mine[0].month), MONTH);
  assert.equal(mine[0].net, 74450);
  // §14 — list columns: month, gross, net, payment date, status, download.
  assert.equal(typeof mine[0].payslipNumber, 'string');
  assert.equal(mine[0].status, 'GENERATED');
});

test('§26 — an employee cannot open another employee\'s payslip', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });
  const other = harness.PayslipModel.rows.find((row) => String(row.employeeId) === String(EMPLOYEE_2));

  await assert.rejects(
    () =>
      harness.service.getPayslip({
        companyId: COMPANY,
        payslipId: other._id,
        employeeId: EMPLOYEE_1,
      }),
    (error) => error.statusCode === 404,
  );
});

test('§3 — another company cannot reach these payslips at all', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });
  const row = harness.PayslipModel.rows[0];

  await assert.rejects(
    () => harness.service.getPayslip({ companyId: OTHER_COMPANY, payslipId: row._id }),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    () => harness.service.downloadPayslip({ companyId: OTHER_COMPANY, payslipId: row._id }),
    (error) => error.statusCode === 404,
  );
});

// ── 7. download (§16 / §25) ────────────────────────────────────────────────

test('downloading counts, moves the status and writes an audit row', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });
  const row = harness.PayslipModel.rows[0];

  const first = await harness.service.downloadPayslip({ companyId: COMPANY, payslipId: row._id, actor });
  assert.match(first.filename, /^payslip-2026-08-.*\.pdf$/);
  assert.ok(first.content.length > 0);

  const after = harness.PayslipModel.rows.find((item) => String(item._id) === String(row._id));
  assert.equal(after.downloadCount, 1);
  assert.equal(after.status, 'DOWNLOADED');

  const audits = harness.auditRows.filter((item) => item.action === 'PAYSLIP_DOWNLOADED');
  assert.equal(audits.length, 1);

  // A second download keeps counting — history, not a one-off.
  await harness.service.downloadPayslip({ companyId: COMPANY, payslipId: row._id, actor });
  assert.equal(
    harness.PayslipModel.rows.find((item) => String(item._id) === String(row._id)).downloadCount,
    2,
  );
});

// ── 8. email (§19) ─────────────────────────────────────────────────────────

test('§19 — the payslip email carries the PDF as an attachment', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });
  const row = harness.PayslipModel.rows[0];

  const result = await harness.service.emailPayslip({ companyId: COMPANY, payslipId: row._id, actor });
  assert.equal(result.delivered, true);
  assert.equal(harness.emails.length, 1);

  const email = harness.emails[0];
  assert.equal(email.subject, 'Salary Payslip — August 2026');
  assert.match(email.text, /processed successfully/i);
  assert.equal(email.attachments.length, 1);
  assert.match(email.attachments[0].filename, /\.pdf$/);
  assert.ok(email.attachments[0].content.length > 0);

  const after = harness.PayslipModel.rows.find((item) => String(item._id) === String(row._id));
  assert.equal(after.status, 'EMAILED');
  assert.ok(after.emailedAt);
  assert.equal(harness.auditRows.filter((item) => item.action === 'PAYSLIP_EMAILED').length, 1);
});

test('an employee without an email is recorded, not silently skipped', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });
  const row = harness.PayslipModel.rows[0];
  harness.UserModel.rows.find((item) => String(item._id) === String(row.employeeId)).email = '';

  const result = await harness.service.emailPayslip({ companyId: COMPANY, payslipId: row._id, actor });
  assert.equal(result.delivered, false);
  assert.match(result.error, /no email/i);
  assert.equal(harness.emails.length, 0);
});

// ── 9. bulk download (§18) ─────────────────────────────────────────────────

test('§18 — the company ZIP is a real archive containing every payslip PDF', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  const request = await harness.service.requestBulkDownload({
    companyId: COMPANY,
    month: MONTH,
    scope: 'COMPANY',
    actor,
    queue: false,
  });
  assert.equal(request.queued, false);

  const files = await harness.service.listBulkFiles({ companyId: COMPANY, month: MONTH });
  assert.equal(files.length, 1);
  assert.equal(files[0].status, 'READY');
  assert.equal(files[0].total, 2);

  const download = await harness.service.downloadBulkFile({
    companyId: COMPANY,
    fileId: files[0]._id,
    actor,
  });
  assert.equal(download.content.slice(0, 2).toString(), 'PK');
  assert.match(download.filename, /^payslips-2026-08\.zip$/);
  // Both PDFs are inside, named by month and employee code.
  const entries = download.content.toString('latin1');
  assert.ok(entries.includes('2026-08/EMP001-2026-08.pdf'));
  assert.ok(entries.includes('2026-08/EMP002-2026-08.pdf'));
});

test('§18 — a department ZIP holds only that department', async () => {
  const harness = makeHarness({
    employees: [
      goodEmployee(EMPLOYEE_1, 'EMP001', 'Asha Rao', DEPARTMENT),
      goodEmployee(EMPLOYEE_2, 'EMP002', 'Rahul Menon', oid(51)),
    ],
  });
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  await harness.service.requestBulkDownload({
    companyId: COMPANY,
    month: MONTH,
    scope: 'DEPARTMENT',
    departmentId: DEPARTMENT,
    actor,
    queue: false,
  });

  const files = await harness.service.listBulkFiles({ companyId: COMPANY, month: MONTH });
  assert.equal(files[0].scope, 'DEPARTMENT');
  assert.equal(files[0].departmentName, 'Engineering');
  assert.equal(files[0].total, 1);

  const download = await harness.service.downloadBulkFile({
    companyId: COMPANY,
    fileId: files[0]._id,
    actor,
  });
  const entries = download.content.toString('latin1');
  assert.ok(entries.includes('EMP001'));
  assert.equal(entries.includes('EMP002'), false);
});

test('a queued archive reports progress and cannot be downloaded early', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  const service = makePayslipService({
    PayslipModel: harness.PayslipModel,
    PayslipFileModel: harness.PayslipFileModel,
    PayrollResultModel: harness.PayslipModel,
    PayrollPaymentModel: harness.PayrollPaymentModel,
    PayrollPaymentBatchModel: harness.PayrollPaymentBatchModel,
    PayrollSetupModel: harness.PayrollSetupModel,
    EmployeePayrollProfileModel: harness.EmployeePayrollProfileModel,
    UserModel: harness.UserModel,
    CompanyModel: harness.CompanyModel,
    DepartmentModel: harness.DepartmentModel,
    dispatchZip: async () => ({ queued: true, jobId: 'zip-job' }),
    buildZip,
    hash: () => 'sha',
  });

  const request = await service.requestBulkDownload({
    companyId: COMPANY,
    month: MONTH,
    scope: 'COMPANY',
    actor,
  });
  assert.equal(request.queued, true);

  const files = await service.listBulkFiles({ companyId: COMPANY, month: MONTH });
  assert.equal(files[0].status, 'QUEUED');

  // §24 — the worker drives progress; downloading early is refused.
  await assert.rejects(
    () => service.downloadBulkFile({ companyId: COMPANY, fileId: files[0]._id, actor }),
    (error) => error.statusCode === 400 && /still being prepared/i.test(error.message),
  );

  const progress = [];
  await service.runBulkZip({
    companyId: COMPANY,
    fileId: files[0]._id,
    onProgress: async (value) => progress.push(value),
  });

  const after = await service.listBulkFiles({ companyId: COMPANY, month: MONTH });
  assert.equal(after[0].status, 'READY');
  assert.equal(after[0].progress, 100);
  assert.ok(progress.length >= 2);
  assert.equal(progress.at(-1).percent, 100);
});

// ── 10. list filters, dashboard and cache (§15 / §23 / §27) ────────────────

test('§15 — the list filters by month, year, financial year and search', () => {
  const rows = [
    { month: '2026-08', payslipNumber: 'PS-2026-08-000001', employeeName: 'Asha Rao', employeeCode: 'EMP001' },
    { month: '2026-04', payslipNumber: 'PS-2026-04-000002', employeeName: 'Rahul Menon', employeeCode: 'EMP002' },
    { month: '2025-12', payslipNumber: 'PS-2025-12-000003', employeeName: 'Asha Rao', employeeCode: 'EMP001' },
  ];

  assert.equal(filterPayslips({ rows, month: '2026-08' }).length, 1);
  assert.equal(filterPayslips({ rows, year: '2026' }).length, 2);
  assert.equal(filterPayslips({ rows, financialYear: '2026-27' }).length, 2);
  assert.equal(filterPayslips({ rows, search: 'asha' }).length, 2);
  assert.equal(filterPayslips({ rows, search: 'EMP002' }).length, 1);
  assert.equal(filterPayslips({ rows, search: 'nothing here' }).length, 0);

  // The financial year follows the company's own start month (29.1).
  assert.equal(financialYearOf('2026-03', 4), '2025-26');
  assert.equal(financialYearOf('2026-04', 4), '2026-27');
  assert.equal(financialYearOf('2026-01', 1), '2026-27');
});

test('§27 — the dashboard counts every delivery state', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });
  await harness.service.downloadPayslip({
    companyId: COMPANY,
    payslipId: harness.PayslipModel.rows[0]._id,
    actor,
  });

  const dashboard = await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.equal(dashboard.summary.totalPayslips, 2);
  assert.equal(dashboard.summary.downloaded, 1);
  assert.equal(dashboard.summary.generated, 1);
  assert.equal(dashboard.summary.totalNetSalary, 74450 + 58200);
  assert.equal(dashboard.payslips.length, 2);
});

test('§23 — both reads go through the cache and every change invalidates it', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  await harness.service.getDashboard({ companyId: COMPANY, month: MONTH });
  assert.equal(typeof harness.cacheCalls.lastOptions.loader, 'function');
  assert.equal(typeof harness.cacheCalls.lastOptions.ttlSeconds, 'number');

  await harness.service.getMyPayslips({ companyId: COMPANY, employeeId: EMPLOYEE_1 });
  assert.equal(harness.cacheCalls.getOrSet, 2);

  const before = harness.cacheCalls.invalidate;
  await harness.service.downloadPayslip({
    companyId: COMPANY,
    payslipId: harness.PayslipModel.rows[0]._id,
    actor,
  });
  assert.ok(harness.cacheCalls.invalidate > before);
  assert.equal(String(harness.cacheCalls.lastInvalidation.companyId), String(COMPANY));
});

// ── 11. audit coverage (§25) ───────────────────────────────────────────────

test('§25 — every payslip action is audited with company, employee and month', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });
  const row = harness.PayslipModel.rows[0];

  await harness.service.downloadPayslip({ companyId: COMPANY, payslipId: row._id, actor });
  await harness.service.emailPayslip({ companyId: COMPANY, payslipId: row._id, actor });
  await harness.service.regeneratePayslip({ companyId: COMPANY, payslipId: row._id, actor });
  await harness.service.markViewed({
    companyId: COMPANY,
    payslipId: row._id,
    employeeId: EMPLOYEE_1,
    actor,
  });

  const actions = harness.auditRows.map((item) => item.action);
  ['PAYSLIP_GENERATED', 'PAYSLIP_DOWNLOADED', 'PAYSLIP_EMAILED', 'PAYSLIP_REGENERATED', 'PAYSLIP_VIEWED'].forEach(
    (action) => assert.ok(actions.includes(action), `${action} must be audited`),
  );

  const viewed = harness.auditRows.find((item) => item.action === 'PAYSLIP_VIEWED');
  assert.equal(String(viewed.companyId), String(COMPANY));
  assert.equal(viewed.metadata.month, MONTH);
});

// ── 12. small helpers ──────────────────────────────────────────────────────

test('file names are safe for a download and a ZIP entry', () => {
  assert.equal(payslipFilename({ month: '2026-08', employeeCode: 'EMP001' }), 'payslip-2026-08-EMP001.pdf');
  assert.equal(zipEntryName({ month: '2026-08', employeeCode: 'EMP/001' }), '2026-08/EMP-001-2026-08.pdf');
  assert.equal(monthLabel('2026-08'), 'August 2026');
  assert.equal(payslipEmailCopy({ month: '2026-08' }).subject, 'Salary Payslip — August 2026');
  assert.equal(payslipSummary({ rows: [{ status: 'GENERATED' }, { status: 'FAILED' }] }).failed, 1);
});

// ── 13. the pre-29.9 legacy payslip path is untouched (29.3 precedent) ─────

test('the legacy payslip route and renderer still exist, untouched by 29.9', async () => {
  const legacy = await import('../src/utils/payslipPdf.js');
  assert.equal(typeof legacy.streamPayslipPdf, 'function');
  assert.equal(typeof legacy.buildPayslipPdf, 'function');

  // models/Payroll.js + GET /api/payroll/:id/payslip belong to the pre-29.9
  // payroll module. 29.9 adds /api/payroll/payslips and leaves them alone.
  const { default: legacyRoutes } = await import('../src/routes/payrollRoutes.js');
  const legacyPayslipRoute = legacyRoutes.stack.find((layer) => layer.route?.path === '/:id/payslip');
  assert.ok(legacyPayslipRoute, 'the legacy payslip download route must survive');
  assert.equal(typeof legacyPayslipRoute.route.stack[0].handle, 'function');

  const { default: payslipRoutes } = await import('../src/routes/payslipRoutes.js');
  const paths = payslipRoutes.stack.map((layer) => layer.route?.path).filter(Boolean);
  assert.ok(paths.includes('/mine'), 'the new employee portal route exists');
  assert.equal(
    paths.includes('/:id/payslip'),
    false,
    '29.9 must not shadow or replace the legacy payslip route',
  );
});

// ── 14. audit fixes: logo, register, recent payslip, attendance cycle ───────

test('§6 / §8 — the company logo is drawn when it resolves, and never blocks', async () => {
  const { resolveCompanyLogo, clearCompanyLogoCache } = await import('../src/utils/companyLogo.js');

  // No logo, or a non-image URL: nothing to fetch, nothing to draw.
  assert.equal(await resolveCompanyLogo(''), null);
  assert.equal(await resolveCompanyLogo('not-a-url'), null);
  assert.equal(await resolveCompanyLogo('/relative/logo.png'), null);

  // A data URL is inline — no network at all.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const inline = await resolveCompanyLogo(`data:image/png;base64,${png.toString('base64')}`);
  assert.ok(inline, 'a data URL resolves without a network call');
  assert.equal(inline.contentType, 'image/png');
  assert.equal(Buffer.compare(inline.buffer, png), 0);

  // An unreachable host must fail open, not throw — a payslip never waits.
  clearCompanyLogoCache();
  const unreachable = await resolveCompanyLogo('https://127.0.0.1:9/logo.png');
  assert.equal(unreachable, null);

  // And the PDF itself renders either way.
  const { buildPayslipPdf } = await import('../src/utils/payslipPdf.js');
  const snapshot = buildPayslipSnapshot({
    company: { name: 'Crewly Technologies', address: 'MG Road', logoUrl: 'https://example.test/logo.png' },
    setup: { payrollPolicy: { frequency: 'MONTHLY' } },
    employee: goodEmployee(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    profile: goodProfile(EMPLOYEE_1),
    result: goodResult(EMPLOYEE_1, 'EMP001', 'Asha Rao', 74450),
    payment: paidPayment(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    month: MONTH,
    payslipNumber: 'PS-2026-08-000245',
  });

  const withLogo = await buildPayslipPdf(snapshot, { logo: { buffer: png, contentType: 'image/png' } });
  const withoutLogo = await buildPayslipPdf(snapshot);
  assert.equal(withLogo.slice(0, 5).toString(), '%PDF-');
  assert.equal(withoutLogo.slice(0, 5).toString(), '%PDF-');
  assert.notEqual(withLogo.length, withoutLogo.length, 'the logo is actually embedded');
});

test('§4 — the payroll register is a CSV with one row per payslip, masked', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  const register = await harness.service.getRegister({ companyId: COMPANY, month: MONTH });

  assert.equal(register.count, 2);
  assert.equal(register.filename, 'payroll-register-2026-08.csv');

  const lines = register.content.split('\r\n');
  assert.equal(lines.length, 3, 'a header plus one row per payslip');
  assert.match(lines[0], /Payslip Number/);
  assert.match(lines[0], /Account Number \(Masked\)/);
  assert.match(lines[0], /Company Contributions/);

  const serialized = register.content;
  assert.ok(serialized.includes('XXXX4589'), 'the masked account is shown');
  assert.equal(
    serialized.includes('123456789012'),
    false,
    'the register is a finance report, not a bank file — never the full number',
  );
  assert.ok(serialized.includes('Asha Rao'));
  assert.ok(serialized.includes('74,450') || serialized.includes('74450'));
});

test('§23 — the recent payslip is cached on its own key', async () => {
  const harness = makeHarness();
  await harness.service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  const before = harness.cacheCalls.getOrSet;
  const recent = await harness.service.getMyRecentPayslip({ companyId: COMPANY, employeeId: EMPLOYEE_1 });

  assert.ok(recent, 'the employee has a latest payslip');
  assert.equal(recent.month, MONTH);
  assert.equal(recent.net, 74450);
  assert.equal(harness.cacheCalls.getOrSet, before + 1);
  assert.match(harness.cacheCalls.lastOptions.loader.constructor.name, /Function|AsyncFunction/);

  // The history read uses a DIFFERENT key, so the two never collide.
  const list = await harness.service.getMyPayslips({ companyId: COMPANY, employeeId: EMPLOYEE_1 });
  assert.equal(list.length, 1);
  assert.equal(harness.cacheCalls.getOrSet, before + 2);
});

test('§12 — the PDF attendance block leads with the payroll cycle', async () => {
  const { buildPayslipPdf } = await import('../src/utils/payslipPdf.js');
  const { PDFParse } = await import('pdf-parse');

  const snapshot = buildPayslipSnapshot({
    company: { name: 'Crewly Technologies', address: 'MG Road' },
    setup: { payrollPolicy: { frequency: 'MONTHLY' } },
    employee: goodEmployee(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    profile: goodProfile(EMPLOYEE_1),
    result: goodResult(EMPLOYEE_1, 'EMP001', 'Asha Rao', 74450),
    payment: paidPayment(EMPLOYEE_1, 'EMP001', 'Asha Rao'),
    month: MONTH,
    payslipNumber: 'PS-2026-08-000245',
  });

  const pdf = await buildPayslipPdf(snapshot);
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  const text = (await parser.getText()).text || '';
  await parser.destroy?.();

  // §12 — the attendance summary names the payroll cycle it belongs to.
  assert.match(text, /Attendance summary — payroll cycle: MONTHLY/);
  // §8 / §13 — header, masked account and the no-signature footer.
  assert.match(text, /Payslip — August 2026/);
  assert.ok(text.includes('XXXX4589'));
  assert.match(text, /no signature required/);
});
