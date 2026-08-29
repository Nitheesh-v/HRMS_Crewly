import mongoose from 'mongoose';
import {
  CANDIDATE_DOCUMENT_STATUSES,
  DOCUMENT_SCAN_STATUSES,
  DOCUMENT_STORAGE_PROVIDERS,
} from './CandidateDocument.js';

const candidateDocumentVersionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    candidateDocument: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CandidateDocument',
      required: true,
      index: true,
      immutable: true,
    },
    preOnboarding: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PreOnboarding',
      required: true,
      index: true,
      immutable: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      immutable: true,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
    },
    isActive: { type: Boolean, default: true, index: true },
    originalFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    mimeType: {
      type: String,
      required: true,
      maxlength: 120,
    },
    fileSize: {
      type: Number,
      required: true,
      min: 1,
      max: 10 * 1024 * 1024,
    },
    storageProvider: {
      type: String,
      enum: DOCUMENT_STORAGE_PROVIDERS,
      required: true,
    },
    storageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
      select: false,
    },
    checksumSha256: {
      type: String,
      required: true,
      lowercase: true,
      maxlength: 64,
      select: false,
    },
    scanStatus: {
      type: String,
      enum: DOCUMENT_SCAN_STATUSES,
      default: 'NOT_CONFIGURED',
    },
    scanCheckedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: CANDIDATE_DOCUMENT_STATUSES,
      default: 'UPLOADED',
    },
    uploadedByType: {
      type: String,
      enum: ['CANDIDATE', 'TENANT_USER', 'SYSTEM'],
      default: 'CANDIDATE',
      immutable: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: { type: Date, default: null },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    rejectionReason: {
      type: String,
      default: '',
      maxlength: 1000,
    },
    documentNumberMasked: {
      type: String,
      default: '',
      maxlength: 40,
    },
    expiryDate: { type: Date, default: null },
    uploadedAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
    // Phase 28.6 — background document processing infrastructure
    // (28.4-style lease fields). This is EXECUTION state, kept
    // separate from the business `status` and the security
    // `scanStatus`: processing success never verifies a document.
    processingStatus: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'PROCESSED', 'PROCESSING_FAILED'],
      default: 'PENDING',
      index: true,
    },
    processingVersion: { type: Number, default: 1, min: 1 },
    processingAttempts: { type: Number, default: 0, min: 0 },
    processingLastError: { type: String, default: '', maxlength: 200 },
    processingLeaseId: { type: String, default: '', select: false },
    processingLeaseExpiresAt: { type: Date, default: null, select: false },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

// Stale-lease scan for reconciliation (28.4 pattern).
candidateDocumentVersionSchema.index({
  companyId: 1,
  processingStatus: 1,
  processingLeaseExpiresAt: 1,
});

candidateDocumentVersionSchema.index(
  { companyId: 1, candidateDocument: 1, version: 1 },
  { unique: true }
);
candidateDocumentVersionSchema.index({
  companyId: 1,
  candidateDocument: 1,
  isActive: 1,
});

export default mongoose.model(
  'CandidateDocumentVersion',
  candidateDocumentVersionSchema
);
