import mongoose from 'mongoose';

export const RESUME_STORAGE_PROVIDERS = [
  'CLOUDINARY_AUTHENTICATED',
  'LOCAL_PRIVATE',
];
export const RESUME_STATUSES = ['UPLOADED', 'QUARANTINED', 'DELETED'];
export const RESUME_SCAN_STATUSES = [
  'NOT_CONFIGURED',
  'PENDING',
  'CLEAN',
  'REJECTED',
  'ERROR',
];
export const RESUME_PARSING_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'RETRY_PENDING',
  'UNSUPPORTED',
  'REVIEW_REQUIRED',
  // Legacy Phase 27.5 values remain readable during rolling upgrades.
  'NOT_REQUESTED',
  'PARSING_PENDING',
  'PARSING',
  'PARSED',
];

const candidateResumeSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      index: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      required: true,
      index: true,
    },
    storageProvider: {
      type: String,
      enum: RESUME_STORAGE_PROVIDERS,
      required: true,
    },
    storageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
      select: false,
    },
    originalFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    mimeType: {
      type: String,
      enum: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      required: true,
    },
    fileSize: {
      type: Number,
      required: true,
      min: 1,
      max: 10 * 1024 * 1024,
    },
    checksumSha256: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 64,
      default: '',
      select: false,
    },
    status: {
      type: String,
      enum: RESUME_STATUSES,
      default: 'UPLOADED',
      index: true,
    },
    scanStatus: {
      type: String,
      enum: RESUME_SCAN_STATUSES,
      default: 'NOT_CONFIGURED',
    },
    scanCheckedAt: {
      type: Date,
      default: null,
    },
    parsingStatus: {
      type: String,
      enum: RESUME_PARSING_STATUSES,
      default: 'PENDING',
      index: true,
    },
    parserVersion: {
      type: String,
      trim: true,
      maxlength: 50,
      default: '',
    },
    parsingAttempts: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    parsingRequestedAt: {
      type: Date,
      default: Date.now,
    },
    lastReprocessRequestedAt: {
      type: Date,
      default: null,
    },
    parsingStartedAt: {
      type: Date,
      default: null,
    },
    parsingCompletedAt: {
      type: Date,
      default: null,
    },
    processingLeaseId: {
      type: String,
      maxlength: 100,
      default: '',
      select: false,
    },
    processingLeaseExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

candidateResumeSchema.index(
  { companyId: 1, candidate: 1 },
  { unique: true }
);
candidateResumeSchema.index({ companyId: 1, job: 1, uploadedAt: -1 });
candidateResumeSchema.index({
  parsingStatus: 1,
  processingLeaseExpiresAt: 1,
  parsingRequestedAt: 1,
});

export default mongoose.model('CandidateResume', candidateResumeSchema);
