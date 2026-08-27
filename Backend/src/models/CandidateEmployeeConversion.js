import mongoose from 'mongoose';

export const CONVERSION_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
];

const candidateEmployeeConversionSchema = new mongoose.Schema(
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
      immutable: true,
    },
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: CONVERSION_STATUSES,
      default: 'PENDING',
      index: true,
    },
    employeeCode: { type: String, default: '', maxlength: 30 },
    accountSetupStatus: {
      type: String,
      enum: ['PENDING', 'SENT', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
    },
    onboardingStarted: { type: Boolean, default: false },
    lifecycleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmployeeLifecycle',
      default: null,
    },
    failureCategory: { type: String, default: '', maxlength: 120 },
    failureMessage: { type: String, default: '', maxlength: 500 },
    snapshot: {
      candidateName: { type: String, default: '' },
      candidateEmail: { type: String, default: '' },
      offerCode: { type: String, default: '' },
      preOnboardingCode: { type: String, default: '' },
      designation: { type: String, default: '' },
      joiningDate: { type: Date, default: null },
    },
    convertedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    convertedAt: { type: Date, default: null },
    claimKey: { type: String, default: null, select: false },
  },
  { timestamps: true, versionKey: false }
);

candidateEmployeeConversionSchema.index(
  { companyId: 1, candidate: 1 },
  { unique: true }
);
candidateEmployeeConversionSchema.index(
  { companyId: 1, employee: 1 },
  {
    unique: true,
    partialFilterExpression: { employee: { $type: 'objectId' } },
  }
);

export default mongoose.model(
  'CandidateEmployeeConversion',
  candidateEmployeeConversionSchema
);
