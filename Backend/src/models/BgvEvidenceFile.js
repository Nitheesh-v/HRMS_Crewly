// Phase 30.5 — candidate BGV evidence file (private, versioned).
//
// Mirrors the proven CandidateDocument/Version security architecture:
//  - storageKey / checksum are select:false (never leak through normal
//    reads, APIs, or logs).
//  - scanStatus stays honest: without a configured scanner it remains
//    NOT_CONFIGURED — it is NEVER converted to a fake CLEAN.
//  - Replacement before final submission creates a NEW version and marks
//    the previous one inactive (history is preserved, never overwritten).
//  - There is no public URL: bytes are only served through the
//    token-authorized download endpoint after server-side relationship
//    resolution.

import mongoose from 'mongoose';
import {
  DOCUMENT_SCAN_STATUSES,
  DOCUMENT_STORAGE_PROVIDERS,
} from './CandidateDocument.js';

const { Schema } = mongoose;

// Evidence categories map 1:1 onto purchased checks (service-enforced).
export const BGV_EVIDENCE_CATEGORIES = [
  'IDENTITY_DOCUMENT',
  'IDENTITY_SELFIE',
  'ADDRESS_PROOF',
  'EDUCATION_CERTIFICATE',
  'EMPLOYMENT_EVIDENCE',
];

export const BGV_EVIDENCE_FILE_STATUSES = ['ACTIVE', 'REPLACED', 'REMOVED'];

const bgvEvidenceFileSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    bgvCollectionCase: {
      type: Schema.Types.ObjectId,
      ref: 'BgvCollectionCase',
      required: true,
      index: true,
      immutable: true,
    },
    bgvOrder: {
      type: Schema.Types.ObjectId,
      ref: 'BgvOrder',
      required: true,
      index: true,
      immutable: true,
    },
    candidate: {
      type: Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      immutable: true,
    },
    // Which purchased check this evidence belongs to (IDENTITY, ADDRESS,
    // EDUCATION, EMPLOYMENT) — uploads for unpurchased checks are rejected.
    checkType: { type: String, required: true, uppercase: true, immutable: true },
    category: {
      type: String,
      enum: BGV_EVIDENCE_CATEGORIES,
      required: true,
      immutable: true,
    },
    // Repeatable-record link (education/employment entry _id) or null.
    recordId: { type: String, default: null, maxlength: 64, immutable: true },
    // Phase 30.9 — when this version was uploaded as a candidate response
    // to an additional-information request (controlled resubmission).
    bgvInfoRequest: { type: Schema.Types.ObjectId, ref: 'BgvInfoRequest', default: null },
    version: { type: Number, required: true, min: 1, immutable: true },
    isActive: { type: Boolean, default: true, index: true },
    status: {
      type: String,
      enum: BGV_EVIDENCE_FILE_STATUSES,
      default: 'ACTIVE',
      index: true,
    },
    originalFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    mimeType: { type: String, required: true, maxlength: 120 },
    fileSize: { type: Number, required: true, min: 1, max: 10 * 1024 * 1024 },
    storageProvider: {
      type: String,
      enum: DOCUMENT_STORAGE_PROVIDERS,
      required: true,
    },
    // Private storage reference — NEVER returned by normal queries.
    storageKey: { type: String, required: true, trim: true, maxlength: 500, select: false },
    checksumSha256: {
      type: String,
      required: true,
      lowercase: true,
      maxlength: 64,
      select: false,
    },
    // Honest malware posture: NOT_CONFIGURED stays NOT_CONFIGURED.
    scanStatus: {
      type: String,
      enum: DOCUMENT_SCAN_STATUSES,
      default: 'NOT_CONFIGURED',
    },
    scanCheckedAt: { type: Date, default: null },
    uploadedAt: { type: Date, default: Date.now },
    replacedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

bgvEvidenceFileSchema.index({ bgvCollectionCase: 1, category: 1, recordId: 1, isActive: 1 });

export default mongoose.model('BgvEvidenceFile', bgvEvidenceFileSchema);
