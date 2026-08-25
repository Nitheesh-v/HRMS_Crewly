import mongoose from 'mongoose';
import { CANDIDATE_DOC_REQUIREMENT_STATUSES } from './CandidateDocumentRequirement.js';

export const CANDIDATE_DOCUMENT_STATUSES = CANDIDATE_DOC_REQUIREMENT_STATUSES;
export const DOCUMENT_SCAN_STATUSES = [
  'NOT_CONFIGURED',
  'PENDING',
  'CLEAN',
  'REJECTED',
  'ERROR',
];
export const DOCUMENT_STORAGE_PROVIDERS = [
  'CLOUDINARY_AUTHENTICATED',
  'LOCAL_PRIVATE',
];

const candidateDocumentSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      index: true,
      immutable: true,
    },
    offer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OfferLetter',
      required: true,
      immutable: true,
    },
    preOnboarding: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PreOnboarding',
      required: true,
      index: true,
      immutable: true,
    },
    candidateRequirement: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CandidateDocumentRequirement',
      required: true,
      index: true,
      immutable: true,
    },
    requirementCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 40,
      immutable: true,
    },
    documentCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      immutable: true,
    },
    currentVersion: { type: Number, default: 1, min: 1 },
    status: {
      type: String,
      enum: CANDIDATE_DOCUMENT_STATUSES,
      default: 'UPLOADED',
      index: true,
    },
    activeVersion: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CandidateDocumentVersion',
      default: null,
    },
    documentNumberMasked: {
      type: String,
      default: '',
      maxlength: 40,
    },
    documentNumberFingerprint: {
      type: String,
      default: '',
      select: false,
      maxlength: 128,
    },
    expiryDate: { type: Date, default: null },
    uploadedAt: { type: Date, default: Date.now },
    submittedAt: { type: Date, default: null },
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
  },
  { timestamps: true, versionKey: false }
);

candidateDocumentSchema.index(
  { companyId: 1, documentCode: 1 },
  { unique: true }
);
candidateDocumentSchema.index({
  companyId: 1,
  preOnboarding: 1,
  requirementCode: 1,
});
candidateDocumentSchema.index({
  companyId: 1,
  candidate: 1,
  createdAt: -1,
});

export default mongoose.model('CandidateDocument', candidateDocumentSchema);
