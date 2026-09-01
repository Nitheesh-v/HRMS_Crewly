// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.6 — PAYROLL RUN (§20 / §26 / §27)
//
//  One document per company + month. It is the CONTROL RECORD for a
//  calculation run: who started it, how far it got, and what the outcome was.
//  The numbers themselves live in PayrollResult (the §18/§19 snapshot).
//
//  Re-running a month never destroys history: the run keeps a counter and the
//  results are versioned (§19 — historical payroll is immutable).
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { PAYROLL_RUN_STATUSES } from '../services/payroll/payrollEngineRules.js';

const { Schema } = mongoose;

const payrollRunSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    // 'YYYY-MM'
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },

    status: {
      type: String,
      enum: PAYROLL_RUN_STATUSES,
      default: 'DRAFT',
      index: true,
    },

    // §27 — the progress tracker reads exactly these three numbers.
    progress: {
      total: { type: Number, default: 0 },
      processed: { type: Number, default: 0 },
      calculated: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      currentEmployeeName: { type: String, default: '' },
      percent: { type: Number, default: 0 },
    },

    // §23 — the dashboard KPIs are persisted with the run so a completed
    // month never has to be recounted.
    summary: {
      totalEmployees: { type: Number, default: 0 },
      calculated: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      grossPayroll: { type: Number, default: 0 },
      netPayroll: { type: Number, default: 0 },
      employerCost: { type: Number, default: 0 },
      totalReimbursements: { type: Number, default: 0 },
      totalDeductions: { type: Number, default: 0 },
      ctc: { type: Number, default: 0 },
    },

    // §6 — the cycle is copied from 29.1 at run time (never joined live).
    cycle: {
      financialYear: { type: String, default: '' },
      cycleStart: { type: String, default: '' },
      cycleEnd: { type: String, default: '' },
      workingDays: { type: Number, default: 0 },
      currency: { type: String, default: 'INR' },
    },

    // How many times this month has been calculated (§21 — recalculation).
    runCount: { type: Number, default: 0 },
    // The version stamped on the results this run produced.
    version: { type: Number, default: 0 },

    // 'FULL' | 'RECALCULATE' | 'RECALCULATE_EMPLOYEE'
    trigger: { type: String, default: 'FULL' },

    // §26 — queue transport state (references only, never PII).
    jobId: { type: String, default: '' },
    queued: { type: Boolean, default: false },

    lastError: { type: String, default: '' },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },

    startedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    finishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

payrollRunSchema.index({ companyId: 1, month: 1 }, { unique: true });

const PayrollRun =
  mongoose.models.PayrollRun || mongoose.model('PayrollRun', payrollRunSchema);

export default PayrollRun;
