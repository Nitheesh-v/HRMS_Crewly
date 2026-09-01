// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.3 — SALARY STRUCTURE TEMPLATE (tenant-scoped, versioned)
//
//  A structure is a REUSABLE TEMPLATE: it says how a salary is divided into
//  the components created in Phase 29.2. It is never an employee salary.
//
//      Salary Component (29.2) → Salary Structure (29.3) → Employee (29.4)
//
//  WHY "TEMPLATE" IN THE MODEL NAME
//    models/SalaryStructure.js already exists: it is the legacy PER-EMPLOYEE
//    monthly salary row (user + basic + hra + allowances + pfPercent +
//    professionalTax) used by PayrollPage and payrollController. Phase 29.3
//    must not break it, so this phase owns a separate model and collection.
//    The product-facing name stays "Salary Structure".
//
//  TENANT ISOLATION (§3)
//    Every document carries companyId and every index is companyId-first.
//    companyId is never accepted from the client — the service takes it from
//    req.companyId only. Codes are unique WITHIN a company, so two companies
//    may both own "SE-2026".
//
//  VERSIONING (§12) — never overwrite history
//    When a structure that already has history is reconfigured, the service
//    closes the current row (isCurrent: false, effectiveTo) and writes a new
//    version. Old payroll snapshots keep pointing at the old version.
//
//  INDEXES (§21)
//    { companyId, code } unique · { companyId, status } · { companyId, departmentId }
//    { companyId, isCurrent, version }
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import {
  CALCULATION_METHODS,
  STRUCTURE_STATUSES,
  defaultSalaryStructure,
} from '../services/payroll/salaryStructureRules.js';

const { Schema } = mongoose;

const DEFAULTS = defaultSalaryStructure();

// One line of the structure: which component, how it is calculated here, and
// its display order (§11).
const structureItemSchema = new Schema(
  {
    componentCode: { type: String, required: true, trim: true, uppercase: true },
    calculationMethod: {
      type: String,
      enum: CALCULATION_METHODS,
      required: true,
      default: 'FIXED_AMOUNT',
    },
    // null for REMAINING — the engine derives it.
    value: { type: Number, default: null },
    order: { type: Number, default: 0 },
  },
  { _id: false },
);

const salaryStructureTemplateSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    // ── identity (§6A)
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    description: { type: String, trim: true, maxlength: 500, default: DEFAULTS.description },

    // ── optional scoping (§6A)
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    designation: { type: String, trim: true, maxlength: 80, default: '' },

    // ── the structure itself (§6B/C/D)
    items: { type: [structureItemSchema], default: [] },

    // ── lifecycle (§5 / §14)
    status: {
      type: String,
      enum: STRUCTURE_STATUSES,
      default: 'DRAFT',
      index: true,
    },

    // ── versioning (§12)
    effectiveFrom: { type: Date, default: () => new Date() },
    effectiveTo: { type: Date, default: null },
    version: { type: Number, default: 1 },
    isCurrent: { type: Boolean, default: true, index: true },
    previousVersionId: {
      type: Schema.Types.ObjectId,
      ref: 'SalaryStructureTemplate',
      default: null,
    },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Tenant-level code uniqueness (§3)
salaryStructureTemplateSchema.index({ companyId: 1, code: 1 }, { unique: true });
salaryStructureTemplateSchema.index({ companyId: 1, status: 1 });
salaryStructureTemplateSchema.index({ companyId: 1, departmentId: 1 });
salaryStructureTemplateSchema.index({ companyId: 1, isCurrent: 1, version: -1 });

const SalaryStructureTemplate =
  mongoose.models.SalaryStructureTemplate ||
  mongoose.model('SalaryStructureTemplate', salaryStructureTemplateSchema);

export default SalaryStructureTemplate;
