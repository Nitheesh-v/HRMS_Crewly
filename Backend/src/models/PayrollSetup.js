// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.1 — COMPANY PAYROLL SETUP (tenant configuration)
//
//  ONE current configuration document per company (§36). Enforced by a
//  partial unique index on { companyId } where isCurrent = true.
//
//  WHAT THIS IS  : "How does this company run payroll?"       (§44)
//  WHAT THIS IS NOT:
//    · employee salary structures / components  → later phases
//    · a payroll run / payslip                  → later phases
//
//  Versioning readiness (§23): every document carries configVersion,
//  effectiveFrom / effectiveTo and isCurrent. Phase 29.1 keeps a single
//  current document and bumps configVersion on every change; a future
//  phase can start writing effective-dated rows WITHOUT a redesign
//  (close the previous row with effectiveTo + isCurrent:false, insert
//  the new row) because the shape and the index already allow it.
//
//  Security (§17 / §42):
//    · bankAccount.accountNumber is stored ENCRYPTED (AES-256-GCM via
//      utils/fieldEncryption) and declared select:false so it can never
//      leak through an accidental .find() projection.
//    · bankAccount.accountNumberLast4 is mirrored in the clear for
//      masked display only. The full number is never logged.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import {
  BANK_ACCOUNT_TYPES,
  LOP_POLICY_BASIS,
  OVERTIME_BASIS,
  PAYMENT_DATE_TYPES,
  PAYROLL_CYCLE_TYPES,
  PAYROLL_FREQUENCIES,
  PAYROLL_SETUP_STATUS,
  WEEKEND_POLICY_TYPES,
  defaultPayrollSetupConfiguration,
} from '../services/payroll/payrollSetupRules.js';

const { Schema } = mongoose;

const DEFAULTS = defaultPayrollSetupConfiguration();

const bankSubSchema = new Schema(
  {
    bankName: { type: String, trim: true, maxlength: 120, default: '' },
    accountHolderName: { type: String, trim: true, maxlength: 120, default: '' },
    // Encrypted at rest, hidden from every default query (§17).
    accountNumber: { type: String, trim: true, default: '', select: false },
    // Masked display mirror — never the full number (e.g. "XXXX XXXX 4589").
    accountNumberLast4: { type: String, trim: true, maxlength: 4, default: '' },
    accountNumberMasked: { type: String, trim: true, maxlength: 40, default: '' },
    ifsc: { type: String, trim: true, maxlength: 11, default: '' },
    branch: { type: String, trim: true, maxlength: 120, default: '' },
    accountType: {
      type: String,
      enum: BANK_ACCOUNT_TYPES,
      default: DEFAULTS.bankAccount.accountType,
    },
    paymentReferencePrefix: { type: String, trim: true, maxlength: 20, default: '' },
  },
  { _id: false },
);

const payrollSetupSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: PAYROLL_SETUP_STATUS,
      default: 'DRAFT',
      index: true,
    },

    // STEP 1 — Company & legal information (§6). Only the payroll-specific
    // additions live here; name/address exist on Company and are reused as
    // defaults by the service, never duplicated as the source of truth.
    legal: {
      legalName: { type: String, trim: true, maxlength: 160, default: '' },
      pan: { type: String, trim: true, maxlength: 10, default: '' },
      tan: { type: String, trim: true, maxlength: 10, default: '' },
      gst: { type: String, trim: true, maxlength: 15, default: '' },
      cin: { type: String, trim: true, maxlength: 21, default: '' },
      addressLine: { type: String, trim: true, maxlength: 160, default: '' },
      city: { type: String, trim: true, maxlength: 60, default: '' },
      state: { type: String, trim: true, maxlength: 60, default: '' },
      pincode: { type: String, trim: true, maxlength: 10, default: '' },
      country: { type: String, trim: true, maxlength: 60, default: DEFAULTS.legal.country },
    },

    // STEP 2 — Statutory configuration (§8). Applicability flags ONLY.
    // No rates, ceilings or formulas — the engine decides those later (§10).
    statutory: {
      pf: {
        applicable: { type: Boolean, default: false },
        establishmentNumber: { type: String, trim: true, maxlength: 30, default: '' },
        registrationDate: { type: Date, default: null },
      },
      esi: {
        applicable: { type: Boolean, default: false },
        registrationNumber: { type: String, trim: true, maxlength: 20, default: '' },
      },
      professionalTax: {
        applicable: { type: Boolean, default: false },
        state: { type: String, trim: true, maxlength: 60, default: '' },
      },
      labourWelfareFund: {
        applicable: { type: Boolean, default: false },
        state: { type: String, trim: true, maxlength: 60, default: '' },
      },
      gratuity: {
        applicable: { type: Boolean, default: false },
      },
      tds: {
        applicable: { type: Boolean, default: false },
      },
    },

    // STEP 3 — Payroll policy (§11–§15).
    payrollPolicy: {
      frequency: {
        type: String,
        enum: PAYROLL_FREQUENCIES,
        default: DEFAULTS.payrollPolicy.frequency,
      },
      cycleType: {
        type: String,
        enum: PAYROLL_CYCLE_TYPES,
        default: DEFAULTS.payrollPolicy.cycleType,
      },
      cycleStartDay: { type: Number, min: 1, max: 31, default: DEFAULTS.payrollPolicy.cycleStartDay },
      cycleEndDay: { type: Number, min: 1, max: 31, default: DEFAULTS.payrollPolicy.cycleEndDay },
      paymentDateType: {
        type: String,
        enum: PAYMENT_DATE_TYPES,
        default: DEFAULTS.payrollPolicy.paymentDateType,
      },
      paymentDayOfMonth: {
        type: Number,
        min: 1,
        max: 31,
        default: DEFAULTS.payrollPolicy.paymentDayOfMonth,
      },
      // 0 = same month, 1 = following month ("5th of following month").
      paymentMonthOffset: { type: Number, min: 0, max: 1, default: 0 },
      currency: { type: String, trim: true, maxlength: 3, default: DEFAULTS.payrollPolicy.currency },
      // April→March for India; company-driven, never globally hardcoded (§11).
      financialYearStartMonth: {
        type: Number,
        min: 1,
        max: 12,
        default: DEFAULTS.payrollPolicy.financialYearStartMonth,
      },
      weekendPolicy: {
        type: {
          type: String,
          enum: WEEKEND_POLICY_TYPES,
          default: DEFAULTS.payrollPolicy.weekendPolicy.type,
        },
        // Working days (scheduleEngine.DAY_KEYS vocabulary) for CUSTOM.
        customWorkingDays: { type: [String], default: [] },
      },
      lopPolicy: {
        basis: { type: String, enum: LOP_POLICY_BASIS, default: DEFAULTS.payrollPolicy.lopPolicy.basis },
      },
      overtimePolicy: {
        enabled: { type: Boolean, default: false },
        basis: { type: String, enum: OVERTIME_BASIS, default: DEFAULTS.payrollPolicy.overtimePolicy.basis },
        multiplier: { type: Number, min: 1, max: 5, default: 1 },
      },
      // §15 — configuration only; the lock engine arrives with the
      // payroll run phases.
      processingDeadlineDay: { type: Number, min: 1, max: 31, default: DEFAULTS.payrollPolicy.processingDeadlineDay },
      lockRequiresReopen: { type: Boolean, default: true },
    },

    // STEP 4 — Company salary payment bank account (§16).
    // Crewly never moves money (§18): this is configuration only.
    bankAccount: { type: bankSubSchema, default: () => ({ ...DEFAULTS.bankAccount }) },

    // Wizard progress (§31) — resume-friendly.
    setup: {
      currentStep: { type: Number, min: 1, max: 5, default: 1 },
      completedSections: { type: [String], default: [] },
      // Sections the administrator has explicitly saved at least once —
      // untouched defaults must not read as "completed" (§30).
      savedSections: { type: [String], default: [] },
      lastSavedAt: { type: Date, default: null },
    },

    activation: {
      activatedAt: { type: Date, default: null },
      activatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      suspendedAt: { type: Date, default: null },
      suspendedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      suspendReason: { type: String, trim: true, maxlength: 300, default: '' },
    },

    // Optimistic concurrency + versioning readiness (§23, §35).
    configVersion: { type: Number, default: 1, min: 1 },
    effectiveFrom: { type: Date, default: () => new Date() },
    effectiveTo: { type: Date, default: null },
    isCurrent: { type: Boolean, default: true, index: true },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// One CURRENT configuration per tenant. Historical rows (future phases)
// carry isCurrent:false and are therefore outside this constraint.
payrollSetupSchema.index(
  { companyId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } },
);

payrollSetupSchema.index({ companyId: 1, configVersion: -1 });

const PayrollSetup = mongoose.model('PayrollSetup', payrollSetupSchema);

export default PayrollSetup;
