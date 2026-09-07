// Phase 30.8 — verifier-created evidence for a verification activity.
// Separate from the candidate's BgvEvidenceFile (30.5) so provenance is
// unambiguous: these files were produced/collected BY the internal verifier
// (official response PDFs, public issuer-verification screenshots, field
// photos). Same private-storage posture: storageKey/checksum select:false,
// never a public URL, bytes only via the assignment-authorized download.

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const VERIFIER_EVIDENCE_STATUSES = ['ACTIVE', 'REMOVED'];

const bgvVerifierEvidenceFileSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    bgvOrder: { type: Schema.Types.ObjectId, ref: 'BgvOrder', required: true, index: true },
    bgvCollectionCase: { type: Schema.Types.ObjectId, ref: 'BgvCollectionCase', required: true },
    checkType: { type: String, required: true, uppercase: true, immutable: true },
    activitySeq: { type: Number, required: true, min: 1 },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', required: true },
    originalFileName: { type: String, required: true, trim: true, maxlength: 180 },
    mimeType: { type: String, required: true, maxlength: 120 },
    fileSize: { type: Number, required: true, min: 1 },
    storageProvider: { type: String, required: true, maxlength: 40 },
    storageKey: { type: String, required: true, trim: true, maxlength: 500, select: false },
    checksumSha256: { type: String, required: true, maxlength: 64, select: false },
    // Scan status stays honest: NOT_CONFIGURED without a scanner —
    // never a fake CLEAN.
    scanStatus: { type: String, default: 'NOT_CONFIGURED', maxlength: 30 },
    status: { type: String, enum: VERIFIER_EVIDENCE_STATUSES, default: 'ACTIVE', index: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);

bgvVerifierEvidenceFileSchema.index({ bgvOrder: 1, checkType: 1, activitySeq: 1 });

export default mongoose.model('BgvVerifierEvidenceFile', bgvVerifierEvidenceFileSchema);
