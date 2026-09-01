// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.7 — PAYROLL EXPORT (§19 / §21)
//
//  A review export is a BullMQ job with a persisted result: the report is
//  built by the worker from the 29.6 snapshots (never recalculated) and the
//  CSV is stored here so HR/Finance can download it without re-running
//  anything.
//
//  The CSV is bounded (MAX_CONTENT_BYTES) — these are internal review
//  exports, not a data warehouse.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

const { Schema } = mongoose;

const payrollExportSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    reportKey: { type: String, required: true, trim: true },
    label: { type: String, trim: true, default: '' },

    // 'QUEUED' | 'PROCESSING' | 'READY' | 'FAILED'
    status: { type: String, default: 'QUEUED', index: true },
    content: { type: String, default: '' },
    rowCount: { type: Number, default: 0 },
    error: { type: String, default: '' },

    // §26 — the queue transport state (references only).
    queued: { type: Boolean, default: false },
    jobId: { type: String, default: '' },

    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

payrollExportSchema.index({ companyId: 1, month: 1, createdAt: -1 });

const PayrollExport =
  mongoose.models.PayrollExport || mongoose.model('PayrollExport', payrollExportSchema);

export default PayrollExport;
