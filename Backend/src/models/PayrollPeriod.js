// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.5 — PAYROLL PERIOD (§6)
//
//  One row per company per payroll month. The cycle boundaries come from the
//  company's 29.1 Payroll Setup and are COPIED here so the month stays
//  reproducible even if the setup changes later.
//
//  TENANT ISOLATION (§3): companyId first on every index.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { PERIOD_STATUSES } from '../services/payroll/monthlyInputRules.js';

const { Schema } = mongoose;

const payrollPeriodSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    // 'YYYY-MM'
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    financialYear: { type: String, trim: true, default: '' },

    cycleStart: { type: String, default: '' },
    cycleEnd: { type: String, default: '' },
    workingDays: { type: Number, default: 0 },

    status: {
      type: String,
      enum: PERIOD_STATUSES,
      default: 'DRAFT',
      index: true,
    },

    // §7 — when the automatic data was last pulled in.
    attendanceImportedAt: { type: Date, default: null },
    leaveImportedAt: { type: Date, default: null },

    validatedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reopenedAt: { type: Date, default: null },
    sentToPayrollAt: { type: Date, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// One period per company per month (§3 / §6).
payrollPeriodSchema.index({ companyId: 1, month: 1 }, { unique: true });
payrollPeriodSchema.index({ companyId: 1, status: 1 });

const PayrollPeriod =
  mongoose.models.PayrollPeriod || mongoose.model('PayrollPeriod', payrollPeriodSchema);

export default PayrollPeriod;
