import mongoose from 'mongoose';

export const PRE_ONBOARDING_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'ACTION_REQUIRED',
  'UNDER_REVIEW',
  'COMPLETED',
  'READY_TO_JOIN',
  'WITHDRAWN',
];

export const ACTIVE_PRE_ONBOARDING_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'ACTION_REQUIRED',
  'UNDER_REVIEW',
  'COMPLETED',
  'READY_TO_JOIN',
];

const preOnboardingSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    preOnboardingCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
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
      index: true,
      immutable: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      required: true,
      index: true,
      immutable: true,
    },
    requisition: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobRequisition',
      default: null,
      immutable: true,
    },
    status: {
      type: String,
      enum: PRE_ONBOARDING_STATUSES,
      default: 'NOT_STARTED',
      index: true,
    },
    activeKey: { type: String, default: 'ACTIVE', select: false },
    candidateSnapshot: {
      name: { type: String, required: true, maxlength: 160 },
      email: { type: String, required: true, maxlength: 254 },
      candidateCode: { type: String, required: true, maxlength: 40 },
      phone: { type: String, default: '', maxlength: 40 },
    },
    offerSnapshot: {
      offerId: { type: mongoose.Schema.Types.ObjectId, required: true },
      offerCode: { type: String, required: true, maxlength: 40 },
      joiningDate: { type: Date, required: true },
      designation: { type: String, default: '', maxlength: 180 },
      departmentName: { type: String, default: '', maxlength: 160 },
      location: { type: String, default: '', maxlength: 240 },
      employmentType: { type: String, default: '', maxlength: 40 },
      workMode: { type: String, default: '', maxlength: 40 },
    },
    jobSnapshot: {
      title: { type: String, required: true, maxlength: 180 },
      jobCode: { type: String, default: '', maxlength: 40 },
    },
    companySnapshot: {
      name: { type: String, required: true, maxlength: 180 },
      address: { type: String, default: '', maxlength: 1000 },
    },
    startedAt: { type: Date, default: null },
    invitedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    readyToJoinAt: { type: Date, default: null },
    readyToJoinBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    withdrawnAt: { type: Date, default: null },
    withdrawalReason: { type: String, default: '', maxlength: 1000 },
    requiredDocumentCount: { type: Number, default: 0, min: 0 },
    verifiedRequiredDocumentCount: { type: Number, default: 0, min: 0 },
    invite: {
      lastSentAt: { type: Date, default: null },
      mode: { type: String, enum: ['SMTP', 'MOCK', null], default: null },
      lastError: { type: String, default: '', maxlength: 500 },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true, versionKey: false }
);

preOnboardingSchema.index({ companyId: 1, preOnboardingCode: 1 }, { unique: true });
preOnboardingSchema.index(
  { companyId: 1, candidate: 1, activeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeKey: 'ACTIVE' },
  }
);
preOnboardingSchema.index(
  { companyId: 1, offer: 1, activeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeKey: 'ACTIVE' },
  }
);
preOnboardingSchema.index({ companyId: 1, status: 1, createdAt: -1 });
preOnboardingSchema.index({ companyId: 1, 'offerSnapshot.joiningDate': 1 });

preOnboardingSchema.pre('validate', function normalizeActiveKey() {
  this.activeKey = ACTIVE_PRE_ONBOARDING_STATUSES.includes(this.status)
    ? 'ACTIVE'
    : null;
});

export default mongoose.model('PreOnboarding', preOnboardingSchema);
