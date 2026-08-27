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
  },
  { timestamps: true, versionKey: false }
);

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
