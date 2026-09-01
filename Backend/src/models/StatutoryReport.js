// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY REPORT (the filing record, §6 / §13 / §14 / §25)
//
//  ONE document per company + month + type.
//
//  WHAT THIS STORES IS THE WORKFLOW, NOT THE NUMBERS.
//
//  The figures are always re-derived from the immutable 29.6 PayrollResult
//  snapshots. That is deliberate: the instant a payroll recalculation lands,
//  every statutory report already shows the new truth (§20). What cannot be
//  derived — who reviewed the return, which status it carries, who attested
//  that it was filed on the government portal and when — lives here.
//
//  `summary` is a frozen copy of the totals as they stood at generation time.
//  It exists so the audit trail can answer "what did Payroll Admin see when
//  they reviewed this?" — it is never used as a report's figures.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { FILING_STATUSES, STATUTORY_TYPES } from '../services/payroll/statutoryRules.js';

const { Schema } = mongoose;

const statutoryReportSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    month: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
    },

    // §3 — the financial year is stored alongside the month so an annual
    // report never has to guess which FY a month belongs to.
    financialYear: { type: String, trim: true, default: '', index: true },

    type: {
      type: String,
      enum: STATUTORY_TYPES,
      required: true,
      index: true,
    },

    // §14 — the filing lifecycle. Crewly never verifies a filing; a human
    // attests that it happened on the government portal.
    status: {
      type: String,
      enum: FILING_STATUSES,
      default: 'DRAFT',
      index: true,
    },

    // Frozen at generation time — see the file header.
    summary: { type: Schema.Types.Mixed, default: null },
    employeeCount: { type: Number, default: 0 },

    generatedAt: { type: Date, default: null },
    generatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    generatedByName: { type: String, trim: true, default: '' },

    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    // §14 — the attestation. A reference number is what finance types back
    // in from the portal; Crewly stores it, it never validates it.
    filedAt: { type: Date, default: null },
    filedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    filedByName: { type: String, trim: true, default: '' },
    filingReference: { type: String, trim: true, maxlength: 60, default: '' },
    filingRemarks: { type: String, trim: true, maxlength: 500, default: '' },
    reopenedAt: { type: Date, default: null },

    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },

    // Provenance: which snapshot version produced this, so an auditor can
    // walk from the return back to the payroll it came from.
    source: {
      resultVersion: { type: Number, default: 1 },
      cycle: { type: String, trim: true, default: 'MONTHLY' },
    },
  },
  { timestamps: true },
);

// §3 — one report per type per month per tenant. This is what makes
// regeneration idempotent and makes a second company's row unreachable.
statutoryReportSchema.index({ companyId: 1, month: 1, type: 1 }, { unique: true });
statutoryReportSchema.index({ companyId: 1, financialYear: 1, type: 1 });
statutoryReportSchema.index({ companyId: 1, month: 1, status: 1 });

const StatutoryReport =
  mongoose.models.StatutoryReport || mongoose.model('StatutoryReport', statutoryReportSchema);

export default StatutoryReport;
