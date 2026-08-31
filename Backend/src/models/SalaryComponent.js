// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.2 — SALARY COMPONENT (tenant-scoped, versioned)
//
//  A component is a BUILDING BLOCK only:
//
//      Salary Component (29.2) → Salary Structure (29.3) → Employee (29.4)
//
//  Nothing here stores an employee salary, a payroll run or a payslip.
//
//  TENANT ISOLATION (§4)
//    Every document carries companyId. Every index is companyId-first, so
//    no query can ever fan out across tenants. companyId is never accepted
//    from the client — the service takes it from req.companyId only.
//
//  HISTORICAL SAFETY (§21 / §24 / §58)
//    Components are never physically deleted once used: they are
//    deactivated (status = INACTIVE) and remain referenced by historical
//    records. When a USED component's calculation changes, the service
//    writes a NEW version (version + 1, isCurrent = true) and closes the
//    previous one (isCurrent = false, effectiveTo) instead of mutating it.
//
//  INDEXES (§56)
//    { companyId, code } unique   — tenant-level code uniqueness (§8)
//    { companyId, status }        — status filter (§26)
//    { companyId, category }      — type filter (§26)
//    { companyId, name }          — name search + duplicate detection (§7)
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import {
  CALCULATION_BASES,
  CALCULATION_TYPES,
  COMPONENT_CATEGORIES,
  COMPONENT_STATUS,
  TAXABILITY_TYPES,
  defaultSalaryComponent,
} from '../services/payroll/salaryComponentRules.js';

const { Schema } = mongoose;

const DEFAULTS = defaultSalaryComponent();

// Controlled formula step — whitelisted operators only, never an
// executable expression (§45). No eval() anywhere in the payroll stack.
const formulaOperationSchema = new Schema(
  {
    operator: {
      type: String,
      enum: ['ADD', 'SUBTRACT', 'MULTIPLY_BY', 'PERCENT_OF'],
      required: true,
    },
    componentCode: { type: String, trim: true, uppercase: true, default: '' },
    value: { type: Number, default: null },
  },
  { _id: false },
);

const salaryComponentSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    // ── identity (§7 / §8)
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    description: { type: String, trim: true, maxlength: 500, default: DEFAULTS.description },

    // ── classification (§5 / §19)
    category: {
      type: String,
      enum: COMPONENT_CATEGORIES,
      required: true,
      default: DEFAULTS.category,
    },

    // ── calculation (§10 / §12 / §13 / §14)
    calculationType: {
      type: String,
      enum: CALCULATION_TYPES,
      required: true,
      default: DEFAULTS.calculationType,
    },
    defaultAmount: { type: Number, default: null, min: 0 },
    percentage: { type: Number, default: null },
    calculationBase: {
      type: String,
      enum: [...CALCULATION_BASES, null],
      default: null,
    },
    dependsOnCode: { type: String, trim: true, uppercase: true, default: '' },
    formula: {
      base: { type: String, enum: CALCULATION_BASES, default: 'GROSS' },
      operations: { type: [formulaOperationSchema], default: undefined },
      _id: false,
    },

    // ── tax & statutory (§15–§18) — configuration flags only, no engine
    taxability: {
      type: String,
      enum: TAXABILITY_TYPES,
      default: DEFAULTS.taxability,
    },
    pfApplicable: { type: Boolean, default: false },
    esiApplicable: { type: Boolean, default: false },
    tdsApplicable: { type: Boolean, default: true },
    professionalTaxApplicable: { type: Boolean, default: false },

    // ── lifecycle (§20 / §33 / §34)
    status: { type: String, enum: COMPONENT_STATUS, default: 'ACTIVE', index: true },

    // ── versioning (§23 / §24)
    effectiveFrom: { type: Date, default: () => new Date() },
    effectiveTo: { type: Date, default: null },
    version: { type: Number, default: 1 },
    isCurrent: { type: Boolean, default: true, index: true },
    previousVersionId: { type: Schema.Types.ObjectId, ref: 'SalaryComponent', default: null },

    // ── provenance (§9 / §35)
    isSystemDefault: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Tenant-level code uniqueness (§8). Company A and Company B may both own
// "BONUS"; the same company may not.
salaryComponentSchema.index({ companyId: 1, code: 1 }, { unique: true });
salaryComponentSchema.index({ companyId: 1, status: 1 });
salaryComponentSchema.index({ companyId: 1, category: 1 });
salaryComponentSchema.index({ companyId: 1, name: 1 });
salaryComponentSchema.index({ companyId: 1, isCurrent: 1, version: -1 });

const SalaryComponent =
  mongoose.models.SalaryComponent || mongoose.model('SalaryComponent', salaryComponentSchema);

export default SalaryComponent;
