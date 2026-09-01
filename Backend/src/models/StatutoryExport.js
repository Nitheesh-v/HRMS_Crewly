// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY EXPORT FILE (§18 / §21)
//
//  The queued path for the reports that are genuinely too big to build in a
//  request: an annual report over 12 monthly snapshots, or a PDF summary.
//
//  Same shape as 29.8's PayrollPaymentFile and 29.9's PayslipFile: a request
//  row with progress, a `binary` that is `select: false` so no list query can
//  ever drag megabytes of report out of Mongo by accident, and a checksum.
//
//  §21 — the job payload carries only this id. The worker rebuilds the report
//  from the 29.6 snapshots, so a stale or tampered payload cannot produce
//  another company's salary figures.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { EXPORT_FORMATS, REPORT_KEYS } from '../services/payroll/statutoryRules.js';

const { Schema } = mongoose;

const statutoryExportSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    // A monthly export carries `month`; an annual one carries the FY only.
    month: { type: String, trim: true, default: '' },
    financialYear: { type: String, trim: true, default: '' },

    reportKey: { type: String, enum: REPORT_KEYS, required: true },
    format: { type: String, enum: EXPORT_FORMATS, default: 'XLSX', index: true },

    filename: { type: String, trim: true, default: '' },

    status: {
      type: String,
      enum: ['QUEUED', 'PROCESSING', 'READY', 'FAILED'],
      default: 'QUEUED',
      index: true,
    },

    progress: { type: Number, min: 0, max: 100, default: 0 },
    processed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },

    // The file itself. `select: false` — only the download route asks for it.
    binary: { type: Buffer, default: null, select: false },
    sizeBytes: { type: Number, default: 0 },
    checksum: { type: String, trim: true, default: '' },

    rowCount: { type: Number, default: 0 },
    error: { type: String, trim: true, default: '' },

    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    requestedByName: { type: String, trim: true, default: '' },

    jobId: { type: String, trim: true, default: '' },
    queued: { type: Boolean, default: false },

    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

statutoryExportSchema.index({ companyId: 1, createdAt: -1 });
statutoryExportSchema.index({ companyId: 1, financialYear: 1, reportKey: 1 });

const StatutoryExport =
  mongoose.models.StatutoryExport || mongoose.model('StatutoryExport', statutoryExportSchema);

export default StatutoryExport;
