// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.8 — GENERATED BANK FILE / DOWNLOAD HISTORY (§12)
//
//  Every generation writes a NEW row. Nothing is ever overwritten or
//  "regenerated silently": history is append-only so the audit trail can show
//  which file finance actually downloaded.
//
//  CSV text lives in `content`; the XLSX binary lives in `binary`. A file is
//  rebuilt from Mongo by the worker, so the queue payload never carries an
//  account number.
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const { Schema } = mongoose;

const payrollPaymentFileSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    month: { type: String, required: true, trim: true },
    batchId: {
      type: Schema.Types.ObjectId,
      ref: 'PayrollPaymentBatch',
      required: true,
      index: true,
    },

    format: { type: String, enum: ['CSV', 'XLSX'], default: 'CSV' },

    status: {
      type: String,
      enum: ['QUEUED', 'PROCESSING', 'READY', 'FAILED'],
      default: 'QUEUED',
      index: true,
    },

    // CSV payload (text). Kept on the document so a download is one read.
    content: { type: String, default: '' },
    // XLSX payload (binary).
    binary: { type: Buffer, default: null },

    rowCount: { type: Number, default: 0 },
    // SHA-256 of the bytes — lets finance prove the downloaded file is the one
    // Crewly generated.
    checksum: { type: String, trim: true, default: '' },

    // §12 — download history.
    generatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    generatedByName: { type: String, trim: true, default: '' },
    generatedAt: { type: Date, default: null },
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },
    lastDownloadedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    // §20 — the BullMQ job that produced it, when Redis is configured.
    jobId: { type: String, trim: true, default: '' },
    queued: { type: Boolean, default: false },
    error: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

payrollPaymentFileSchema.index({ batchId: 1, createdAt: -1 });

const PayrollPaymentFile = mongoose.model('PayrollPaymentFile', payrollPaymentFileSchema);

export default PayrollPaymentFile;
