// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.6 — PAYROLL RESULT (§18 / §19 — the immutable snapshot)
//
//  One document per company + month + employee + version.
//
//  EVERYTHING the engine produced is stored here: the earnings breakup, the
//  reimbursements, the deductions with their sources, the employer
//  contributions, the attendance figures and every intermediate total (§17).
//
//  IMMUTABILITY (§19): a recalculation writes version n+1 and marks it
//  current. Version n is never updated, never deleted, and stays readable —
//  August 2026 stays August 2026 even after the structure changes.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { PAYROLL_RESULT_STATUSES } from '../services/payroll/payrollEngineRules.js';

const { Schema } = mongoose;

const payrollResultSchema = new Schema(
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
    runId: { type: Schema.Types.ObjectId, ref: 'PayrollRun', default: null },
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },

    // §19 — the snapshot version. Only the highest version is current.
    version: { type: Number, default: 1 },
    isCurrent: { type: Boolean, default: true, index: true },

    status: {
      type: String,
      enum: PAYROLL_RESULT_STATUSES,
      default: 'CALCULATED',
      index: true,
    },

    // §22 — a failed employee never blocks the run; the reasons are kept.
    // (`errors` is a reserved Mongoose document property — hence `issues`.)
    issues: { type: [String], default: [] },
    warnings: { type: [String], default: [] },

    // §18 — employee identity as it was on the day of the run.
    employeeName: { type: String, default: '' },
    employeeCode: { type: String, default: '' },
    designation: { type: String, default: '' },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },

    structureId: { type: Schema.Types.ObjectId, default: null },
    structureName: { type: String, default: '' },

    // ── the snapshot itself (Mixed: a frozen copy, never recomputed)
    earnings: { type: Schema.Types.Mixed, default: [] },
    variableEarnings: { type: Schema.Types.Mixed, default: [] },
    overtime: { type: Schema.Types.Mixed, default: null },
    reimbursements: { type: Schema.Types.Mixed, default: [] },
    deductions: { type: Schema.Types.Mixed, default: [] },
    employerContributions: { type: Schema.Types.Mixed, default: [] },
    attendance: { type: Schema.Types.Mixed, default: null },
    statutory: { type: Schema.Types.Mixed, default: null },
    lop: { type: Schema.Types.Mixed, default: null },
    payable: { type: Schema.Types.Mixed, default: null },
    totals: { type: Schema.Types.Mixed, default: null },

    calculatedAt: { type: Date, default: null },
    calculatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

payrollResultSchema.index({ companyId: 1, month: 1, employeeId: 1, version: 1 }, { unique: true });
payrollResultSchema.index({ companyId: 1, month: 1, status: 1 });
payrollResultSchema.index({ companyId: 1, month: 1, isCurrent: 1 });

const PayrollResult =
  mongoose.models.PayrollResult || mongoose.model('PayrollResult', payrollResultSchema);

export default PayrollResult;
