import mongoose from 'mongoose';
import {
  PRE_ONBOARDING_ALLOWED_MIME_TYPES,
  PRE_ONBOARDING_DOC_CATEGORIES,
} from './PreOnboardingDocumentRequirement.js';

export const CANDIDATE_DOC_REQUIREMENT_STATUSES = [
  'PENDING',
  'UPLOADED',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'RESUBMISSION_REQUIRED',
];

const candidateDocumentRequirementSchema = new mongoose.Schema(
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
    preOnboarding: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PreOnboarding',
      required: true,
      index: true,
      immutable: true,
    },
    requirement: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PreOnboardingDocumentRequirement',
      required: true,
      immutable: true,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 40,
      immutable: true,
    },
    nameSnapshot: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    descriptionSnapshot: {
      type: String,
      default: '',
      maxlength: 1000,
    },
    categorySnapshot: {
      type: String,
      enum: PRE_ONBOARDING_DOC_CATEGORIES,
      default: 'OTHER',
    },
    required: { type: Boolean, default: true, immutable: true },
    instructionsSnapshot: {
      type: String,
      default: '',
      maxlength: 2000,
    },
    fileRulesSnapshot: {
      allowedFileTypes: {
        type: [String],
        default: () => [...PRE_ONBOARDING_ALLOWED_MIME_TYPES],
      },
      maxFileSize: {
        type: Number,
        default: 5 * 1024 * 1024,
        min: 50 * 1024,
        max: 10 * 1024 * 1024,
      },
      requiresExpiryDate: { type: Boolean, default: false },
      requiresDocumentNumber: { type: Boolean, default: false },
    },
    displayOrder: { type: Number, default: 100, min: 0, max: 10000 },
    status: {
      type: String,
      enum: CANDIDATE_DOC_REQUIREMENT_STATUSES,
      default: 'PENDING',
      index: true,
    },
    activeDocument: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CandidateDocument',
      default: null,
    },
    rejectionReason: {
      type: String,
      default: '',
      maxlength: 1000,
    },
    verifiedAt: { type: Date, default: null },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lastUploadedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

candidateDocumentRequirementSchema.index(
  { companyId: 1, preOnboarding: 1, code: 1 },
  { unique: true }
);
candidateDocumentRequirementSchema.index({
  companyId: 1,
  candidate: 1,
  status: 1,
});
candidateDocumentRequirementSchema.index({
  companyId: 1,
  preOnboarding: 1,
  displayOrder: 1,
});

export default mongoose.model(
  'CandidateDocumentRequirement',
  candidateDocumentRequirementSchema
);
