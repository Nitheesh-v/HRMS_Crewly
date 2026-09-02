// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT FILE (§17 / §21)
//
//  The F&F statement PDF and the bulk settlement register are built in the
//  background. This record is the artefact: status, progress and the finished
//  bytes. It mirrors PayslipFile (29.9) and StatutoryExport (29.10) so all
//  three background producers behave the same way for the UI.
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const { Schema } = mongoose;

const finalSettlementFileSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    month: { type: String, trim: true, default: '' },

    // STATEMENT — one F&F PDF. REGISTER — the bulk CSV/XLSX export.
    kind: { type: String, enum: ['STATEMENT', 'REGISTER'], default: 'STATEMENT' },
    settlementId: { type: Schema.Types.ObjectId, ref: 'FinalSettlement', default: null },
    format: { type: String, enum: ['PDF', 'CSV', 'XLSX'], default: 'PDF' },

    filename: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: ['QUEUED', 'PROCESSING', 'READY', 'FAILED'],
      default: 'QUEUED',
      index: true,
    },

    progress: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },

    // The artefact. `select: false` — fetched only by the download route.
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

finalSettlementFileSchema.index({ companyId: 1, month: 1, createdAt: -1 });
finalSettlementFileSchema.index({ companyId: 1, settlementId: 1, kind: 1 });

const FinalSettlementFile =
  mongoose.models.FinalSettlementFile ||
  mongoose.model('FinalSettlementFile', finalSettlementFileSchema);

export default FinalSettlementFile;
