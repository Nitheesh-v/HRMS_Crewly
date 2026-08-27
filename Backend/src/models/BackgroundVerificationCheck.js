import mongoose from 'mongoose';
import { BGV_CHECK_CATEGORIES } from './BackgroundVerificationCheckType.js';

export const BGV_CHECK_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'AWAITING_CANDIDATE',
  'AWAITING_VERIFIER',
  'VERIFIED',
  'DISCREPANCY',
  'UNABLE_TO_VERIFY',
  'CANCELLED',
];

export const BGV_TERMINAL_CHECK_STATUSES = [
  'VERIFIED',
  'DISCREPANCY',
  'UNABLE_TO_VERIFY',
  'CANCELLED',
];

const backgroundVerificationCheckSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    case: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BackgroundVerificationCase',
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
    checkType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BackgroundVerificationCheckType',
      default: null,
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
      enum: BGV_CHECK_CATEGORIES,
      default: 'OTHER',
    },
    instructionsSnapshot: {
      type: String,
      default: '',
      maxlength: 2000,
    },
    required: { type: Boolean, default: true, immutable: true },
    displayOrder: { type: Number, default: 100, min: 0, max: 10000 },
    status: {
      type: String,
      enum: BGV_CHECK_STATUSES,
      default: 'NOT_STARTED',
      index: true,
    },
    claimedInformation: {
      type: String,
      default: '',
      maxlength: 4000,
    },
    verifiedInformation: {
      type: String,
      default: '',
      maxlength: 4000,
    },
    resultSummary: {
      type: String,
      default: '',
      maxlength: 2000,
    },
    discrepancy: {
      type: String,
      default: '',
      maxlength: 2000,
    },
    candidateComment: {
      type: String,
      default: '',
      maxlength: 2000,
    },
    hrComment: {
      type: String,
      default: '',
      maxlength: 2000,
    },
    source: {
      type: String,
      enum: ['INTERNAL', 'CANDIDATE', 'PROVIDER'],
      default: 'INTERNAL',
    },
    provider: {
      type: String,
      enum: ['INTERNAL'],
      default: 'INTERNAL',
    },
    requestedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    verifiedAt: { type: Date, default: null },
    evidenceDocumentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'CandidateDocument',
      },
    ],
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      validate: {
        validator: (value) => {
          try {
            return JSON.stringify(value || {}).length <= 8000;
          } catch {
            return false;
          }
        },
        message: 'Check metadata is too large',
      },
    },
  },
  { timestamps: true, versionKey: false }
);

backgroundVerificationCheckSchema.index(
  { companyId: 1, case: 1, code: 1 },
  { unique: true }
);
backgroundVerificationCheckSchema.index({
  companyId: 1,
  case: 1,
  status: 1,
  displayOrder: 1,
});

export default mongoose.model(
  'BackgroundVerificationCheck',
  backgroundVerificationCheckSchema
);
