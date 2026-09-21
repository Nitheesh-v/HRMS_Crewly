#!/usr/bin/env node
/**
 * PHASE 29.9 — Payslip preview generator
 *
 *   npm run payslip:preview
 *
 * Produces REAL artefacts with NO database, NO Redis, NO SMTP and NO worker:
 *
 *   Backend/.preview/payslip-PS-2026-08-000001.pdf   the actual PDFKit render
 *   Backend/.preview/payroll-register-2026-08.csv    the §4 register
 *   Backend/.preview/payslips-2026-08.zip            the §18 company archive
 *
 * Why this exists: the PDF layout (§8) is the part of a payslip that unit
 * tests cannot judge. Point this at a month of fake-but-realistic payroll
 * data and open the PDF — every section, every component, the masked account
 * and the "Company Contributions" block are on the page.
 *
 * The service is built with the REAL pdf renderer, the REAL ZIP writer and
 * the REAL rules module. Only the models are fakes, so what you see is what
 * a company would get.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { makePayslipService } from '../src/services/payroll/payslipService.js';
import { buildPayslipPdf } from '../src/utils/payslipPdf.js';
import { buildZip } from '../src/utils/minimalZip.js';
import { toCsv } from '../src/services/payroll/payrollPaymentRules.js';

// ── a fake model: just enough of Mongoose for the service ──────────────────

const oid = (seed) => `64b7f9c2e4b0a1b2c3d4e5${String(seed).padStart(3, '0')}`;

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = row?.[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if (condition.$in) return condition.$in.some((item) => String(item) === String(value));
      return String(value) === String(condition);
    }
    return String(value) === String(condition);
  });

const makeFakeModel = () => {
  const rows = [];
  let counter = 0;
  const query = (filter) => ({
    lean: async () => rows.filter((row) => matches(row, filter)),
    select: () => query(filter),
    sort: () => query(filter),
    limit: () => query(filter),
  });
  return {
    rows,
    find: (filter = {}) => query(filter),
    findOne: (filter = {}) => ({
      lean: async () => rows.find((row) => matches(row, filter)) || null,
      select: () => ({ lean: async () => rows.find((row) => matches(row, filter)) || null }),
    }),
    countDocuments: async (filter = {}) => rows.filter((row) => matches(row, filter)).length,
    findById: (id) => ({ lean: async () => rows.find((row) => String(row._id) === String(id)) || null }),
    async create(doc) {
      counter += 1;
      const row = { _id: oid(counter + 500), createdAt: new Date(), updatedAt: new Date(), ...doc };
      rows.push(row);
      return row;
    },
    async updateOne(filter, update = {}) {
      const row = rows.find((item) => matches(item, filter));
      if (!row) return { matchedCount: 0 };
      Object.entries(update.$set || {}).forEach(([key, value]) => {
        row[key] = value;
      });
      Object.entries(update.$inc || {}).forEach(([key, delta]) => {
        row[key] = Number(row[key] || 0) + Number(delta);
      });
      return { matchedCount: 1 };
    },
  };
};

// ── fixtures: three employees, one of them unpaid ──────────────────────────

const COMPANY = oid(6);
const MONTH = '2026-08';
const BATCH = oid(60);
const DEPARTMENT = oid(50);

const EMPLOYEES = [
  {
    id: oid(1),
    code: 'EMP001',
    name: 'Asha Rao',
    designation: 'Senior Engineer',
    netSalary: 74450,
    paid: true,
  },
  {
    id: oid(2),
    code: 'EMP002',
    name: 'Rahul Menon',
    designation: 'QA Engineer',
    netSalary: 58200,
    paid: true,
  },
  {
    id: oid(3),
    code: 'EMP003',
    name: 'Meera Iyer',
    designation: 'Product Designer',
    netSalary: 61800,
    // §1 — her transfer failed, so she gets NO payslip this month.
    paid: false,
  },
];

const resultFor = (employee) => ({
  _id: oid(900 + Number(String(employee.id).slice(-3))),
  companyId: COMPANY,
  month: MONTH,
  employeeId: employee.id,
  employeeCode: employee.code,
  employeeName: employee.name,
  designation: employee.designation,
  version: 1,
  isCurrent: true,
  earnings: [
    { name: 'Basic Salary', amount: 40000 },
    { name: 'House Rent Allowance', amount: 20000 },
    { name: 'Special Allowance', amount: 15000 },
    { name: 'Bonus', amount: 5000 },
  ],
  variableEarnings: [{ name: 'Performance Incentive', amount: 4000 }],
  reimbursements: [{ name: 'Travel Reimbursement', amount: 2000 }],
  deductions: [
    { name: 'Provident Fund', amount: 4800 },
    { name: 'Employee State Insurance', amount: 620 },
    { name: 'Professional Tax', amount: 200 },
    { name: 'TDS', amount: 2550 },
    { name: 'Loan Recovery', amount: 3000 },
  ],
  employerContributions: [
    { name: 'Employer PF', amount: 4800 },
    { name: 'Employer ESI', amount: 1690 },
    { name: 'Gratuity', amount: 3850 },
  ],
  attendance: {
    workingDays: 22,
    presentDays: 21,
    payableDays: 21.5,
    lopDays: 0.5,
    overtimeHours: 4,
  },
  totals: {
    grossSalary: 84000,
    totalEarnings: 84000,
    totalDeductions: 11170,
    netSalary: employee.netSalary,
  },
});

const run = async () => {
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

  EMPLOYEES.forEach((employee) => {
    PayrollResultModel.rows.push(resultFor(employee));
    EmployeePayrollProfileModel.rows.push({
      _id: oid(800 + Number(String(employee.id).slice(-3))),
      companyId: COMPANY,
      userId: employee.id,
      bank: {
        bankName: 'HDFC Bank',
        accountNumber: 'enc:123456789012',
        accountNumberMasked: 'XXXX4589',
        ifsc: 'HDFC0001234',
      },
      statutory: { uan: '100123456789', pan: 'ABCPR1234K' },
    });
    UserModel.rows.push({
      _id: employee.id,
      companyId: COMPANY,
      name: employee.name,
      employeeCode: employee.code,
      email: `${employee.code.toLowerCase()}@crewly.test`,
      status: 'ACTIVE',
      designation: employee.designation,
      department: DEPARTMENT,
      joiningDate: new Date('2024-04-01T00:00:00Z'),
    });
    PayrollPaymentModel.rows.push({
      _id: oid(700 + Number(String(employee.id).slice(-3))),
      companyId: COMPANY,
      month: MONTH,
      batchId: BATCH,
      employeeId: employee.id,
      employeeCode: employee.code,
      employeeName: employee.name,
      departmentName: 'Engineering',
      netSalary: employee.netSalary,
      paymentReference: `CREWLYSAL-${MONTH}-000${String(employee.id).slice(-1)}`,
      status: employee.paid ? 'PAID' : 'FAILED',
      // 29.8 stamps paidAt when finance confirms the payment — this is the
      // date the payslip must show (§6 / §13).
      paidAt: employee.paid ? new Date('2026-08-31T10:00:00Z') : null,
      bank: { bankName: 'HDFC Bank', accountNumberMasked: 'XXXX4589' },
    });
  });

  PayrollPaymentBatchModel.rows.push({
    _id: BATCH,
    companyId: COMPANY,
    month: MONTH,
    batchNumber: `SAL-${MONTH}-001`,
    status: 'PARTIALLY_PAID',
    paymentDate: new Date('2026-08-31T00:00:00Z'),
  });

  CompanyModel.rows.push({
    _id: COMPANY,
    name: 'Crewly Technologies',
    address: '2nd Floor, Prestige Atrium, MG Road, Bengaluru 560001',
    logoUrl: '',
  });

  PayrollSetupModel.rows.push({
    _id: oid(11),
    companyId: COMPANY,
    isCurrent: true,
    legalInfo: { pan: 'AABCC1234D', tan: 'BLRC12345E' },
    payrollPolicy: { frequency: 'MONTHLY', currency: 'INR' },
  });

  DepartmentModel.rows.push({ _id: DEPARTMENT, companyId: COMPANY, name: 'Engineering' });

  const notifications = [];
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
    cache: {}, // no Redis: reads go straight to the fake models
    audit: async () => null,
    notify: async (note) => notifications.push(note),
    mail: async () => ({ delivered: true, mode: 'MOCK' }),
    renderPdf: buildPayslipPdf, // the REAL renderer
    buildZip, // the REAL archive writer
    hash: (value) => `sha256:${String(value).length}`,
  });

  const actor = { _id: oid(12), name: 'Payroll Admin' };
  const generated = await service.generateForMonth({ companyId: COMPANY, month: MONTH, actor, queue: false });

  const outDir = path.resolve(process.cwd(), '.preview');
  await fs.mkdir(outDir, { recursive: true });

  // 1. one PDF — the one you want to look at
  const first = PayslipModel.rows[0];
  const pdfFile = path.join(outDir, `payslip-${first.payslipNumber}.pdf`);
  const { content: pdf } = await service.downloadPayslip({ companyId: COMPANY, payslipId: first._id, actor });
  await fs.writeFile(pdfFile, pdf);

  // 2. the §4 register
  const register = await service.getRegister({ companyId: COMPANY, month: MONTH });
  const registerFile = path.join(outDir, register.filename);
  await fs.writeFile(registerFile, register.content);

  // 3. the §18 company archive
  await service.requestBulkDownload({ companyId: COMPANY, month: MONTH, scope: 'COMPANY', actor, queue: false });
  const files = await service.listBulkFiles({ companyId: COMPANY, month: MONTH });
  const { content: zip } = await service.downloadBulkFile({ companyId: COMPANY, fileId: files[0]._id, actor });
  const zipFile = path.join(outDir, files[0].filename);
  await fs.writeFile(zipFile, zip);

  /* eslint-disable no-console */
  console.log('\nPhase 29.9 — payslip preview\n');
  console.log(`  month              ${MONTH}`);
  console.log(`  payments           ${generated.total} (1 failed on purpose)`);
  console.log(`  payslips created   ${generated.created}`);
  console.log(`  employees notified ${notifications.filter((n) => n.type === 'PAYSLIP_AVAILABLE').length}`);
  console.log('\nArtefacts:');
  console.log(`  PDF      ${pdfFile}  (${pdf.length} bytes)`);
  console.log(`  Register ${registerFile}  (${register.count} rows)`);
  console.log(`  ZIP      ${zipFile}  (${zip.length} bytes, ${files[0].total} files)`);
  console.log(
    `\n§1 gate: Meera Iyer's transfer FAILED, so she has no payslip — ` +
      `${PayslipModel.rows.some((row) => String(row.employeeId) === String(oid(3))) ? 'BROKEN' : 'confirmed'}`,
  );
  console.log(`§26 mask: the full account number appears in the register? ` +
    `${register.content.includes('123456789012') ? 'YES — BROKEN' : 'no'}\n`);
  /* eslint-enable no-console */
};

run().catch((error) => {
  /* eslint-disable no-console */
  console.error('Preview failed:', error);
  /* eslint-enable no-console */
  process.exit(1);
});
