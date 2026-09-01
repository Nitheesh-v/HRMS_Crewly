// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP BULK FILE (§18)
//
//  Bulk download (department ZIP or entire-company ZIP) is built in the
//  background. This record is the artefact: status, progress and the finished
//  archive. It mirrors PayrollPaymentFile (29.8) and PayrollExport (29.7) so
//  the three background producers behave the same way for the UI.
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const { Schema } = mongoose;

const payslipFileSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },

    // §18 — COMPANY or DEPARTMENT.
    scope: { type: String, enum: ['COMPANY', 'DEPARTMENT'], default: 'COMPANY' },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    departmentName: { type: String, trim: true, default: '' },

    filename: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: ['QUEUED', 'PROCESSING', 'READY', 'FAILED'],
      default: 'QUEUED',
      index: true,
    },

    // §24 — live progress for large companies.
    progress: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },

    // The archive. `select: false` — it is fetched only by the download route.
    binary: { type: Buffer, select: false, default: null },
    sizeBytes: { type: Number, default: 0 },
    checksum: { type: String, default: '' },
    error: { type: String, default: '' },

    jobId: { type: String, default: '' },
    queued: { type: Boolean, default: false },

    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    requestedByName: { type: String, default: '' },
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

payslipFileSchema.index({ companyId: 1, month: 1, createdAt: -1 });

const PayslipFile = mongoose.models.PayslipFile || mongoose.model('PayslipFile', payslipFileSchema);

export default PayslipFile;
