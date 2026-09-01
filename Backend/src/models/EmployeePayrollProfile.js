// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.4 — EMPLOYEE PAYROLL PROFILE (tenant-scoped, versioned)
//
//  The bridge between HR and Payroll: what an employee is paid and how they
//  are paid. It is NOT a monthly payroll run and NOT a payslip (§25).
//
//  TENANT ISOLATION (§3)
//    Every document carries companyId, every index is companyId-first, and
//    companyId is only ever taken from req.companyId.
//
//  VERSIONING (§15 / §16)
//    A salary revision never overwrites: the service closes the current row
//    (isCurrent: false, effectiveTo) and writes the new version. Salary
//    history is the version chain.
//
//  SECURITY (§24)
//    bank.accountNumber is ENCRYPTED (AES-256-GCM via utils/fieldEncryption)
//    and declared select:false so no query can leak it by accident. Only
//    accountNumberLast4 / accountNumberMasked are stored in the clear.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import {
  ACCOUNT_TYPES,
  EMPLOYMENT_TYPES,
  PAYROLL_STATUSES,
  PAY_GROUPS,
  PAYMENT_METHODS,
  RESIDENTIAL_STATUSES,
  TAX_REGIMES,
  defaultEmployeePayroll,
} from '../services/payroll/employeePayrollRules.js';

const { Schema } = mongoose;

const DEFAULTS = defaultEmployeePayroll();

const bankSchema = new Schema(
  {
    bankName: { type: String, trim: true, maxlength: 120, default: '' },
    accountHolderName: { type: String, trim: true, maxlength: 120, default: '' },
    // Encrypted at rest, hidden from every default query (§10 / §24).
    accountNumber: { type: String, trim: true, default: '', select: false },
    accountNumberLast4: { type: String, trim: true, maxlength: 4, default: '' },
    accountNumberMasked: { type: String, trim: true, maxlength: 40, default: '' },
    ifsc: { type: String, trim: true, maxlength: 11, default: '' },
    branch: { type: String, trim: true, maxlength: 120, default: '' },
    accountType: { type: String, enum: ACCOUNT_TYPES, default: DEFAULTS.bank.accountType },
    paymentMethod: {
      type: String,
      enum: PAYMENT_METHODS,
      default: DEFAULTS.bank.paymentMethod,
    },
  },
  { _id: false },
);

const statutorySchema = new Schema(
  {
    pan: { type: String, trim: true, uppercase: true, maxlength: 10, default: '' },
    aadhaar: { type: String, trim: true, maxlength: 12, default: '' },
    uan: { type: String, trim: true, maxlength: 12, default: '' },
    esiNumber: { type: String, trim: true, maxlength: 17, default: '' },
    pfMember: { type: Boolean, default: false },
    gratuityEligible: { type: Boolean, default: false },
  },
  { _id: false },
);

const taxSchema = new Schema(
  {
    regime: { type: String, enum: TAX_REGIMES, default: DEFAULTS.tax.regime },
    tdsApplicable: { type: Boolean, default: DEFAULTS.tax.tdsApplicable },
    panVerified: { type: Boolean, default: false },
    declarationStatus: { type: String, trim: true, maxlength: 30, default: 'PENDING' },
    residentialStatus: {
      type: String,
      enum: RESIDENTIAL_STATUSES,
      default: DEFAULTS.tax.residentialStatus,
    },
  },
  { _id: false },
);

const employeePayrollProfileSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // ── §7 / §8 — salary information
    structureId: {
      type: Schema.Types.ObjectId,
      ref: 'SalaryStructureTemplate',
      default: null,
    },
    structureName: { type: String, trim: true, maxlength: 80, default: '' },
    annualCtc: { type: Number, default: 0, min: 0 },
    monthlyGross: { type: Number, default: 0, min: 0 },
    designation: { type: String, trim: true, maxlength: 80, default: '' },
    employmentType: {
      type: String,
      enum: EMPLOYMENT_TYPES,
      default: DEFAULTS.employmentType,
      index: true,
    },
    payGroup: { type: String, enum: PAY_GROUPS, default: DEFAULTS.payGroup },

    // ── §14
    payrollStatus: {
      type: String,
      enum: PAYROLL_STATUSES,
      default: 'DRAFT',
      index: true,
    },

    // ── §6B / §6C / §6D
    bank: { type: bankSchema, default: () => ({ ...DEFAULTS.bank }) },
    statutory: { type: statutorySchema, default: () => ({ ...DEFAULTS.statutory }) },
    tax: { type: taxSchema, default: () => ({ ...DEFAULTS.tax }) },

    // Snapshot of the §9 preview at save time — display only, never the engine.
    breakdown: { type: Schema.Types.Mixed, default: null },

    // ── §15 — versioning
    effectiveFrom: { type: Date, default: () => new Date() },
    effectiveTo: { type: Date, default: null },
    version: { type: Number, default: 1 },
    isCurrent: { type: Boolean, default: true, index: true },
    previousVersionId: {
      type: Schema.Types.ObjectId,
      ref: 'EmployeePayrollProfile',
      default: null,
    },

    activatedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// §23 — one CURRENT payroll profile per employee, per company.
employeePayrollProfileSchema.index(
  { companyId: 1, employeeId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } },
);
employeePayrollProfileSchema.index({ companyId: 1, payrollStatus: 1 });
employeePayrollProfileSchema.index({ companyId: 1, structureId: 1 });
employeePayrollProfileSchema.index({ companyId: 1, employeeId: 1, version: -1 });

const EmployeePayrollProfile =
  mongoose.models.EmployeePayrollProfile ||
  mongoose.model('EmployeePayrollProfile', employeePayrollProfileSchema);

export default EmployeePayrollProfile;
