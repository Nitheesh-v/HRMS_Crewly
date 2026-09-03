import mongoose from 'mongoose';
import { BGV_TRIGGER_STAGES } from './BackgroundVerificationSettings.js';

export const BGV_CASE_STATUSES = [
  'DRAFT',
  'NOT_STARTED',
  'IN_PROGRESS',
  'AWAITING_CANDIDATE',
  'AWAITING_VERIFIER',
  'REVIEW_REQUIRED',
  'COMPLETED',
  'CANCELLED',
];

export const BGV_OVERALL_OUTCOMES = [
  '',
  'CLEAR',
  'CLEAR_WITH_DISCREPANCIES',
  'HOLD',
  'CANCELLED',
];

export const BGV_CONSENT_STATUSES = [
  'NOT_REQUESTED',
  'REQUESTED',
  'GRANTED',
  'DECLINED',
];

export const ACTIVE_BGV_CASE_STATUSES = [
  'DRAFT',
  'NOT_STARTED',
  'IN_PROGRESS',
  'AWAITING_CANDIDATE',
  'AWAITING_VERIFIER',
  'REVIEW_REQUIRED',
  'COMPLETED',
];

const backgroundVerificationCaseSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    caseCode: {
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
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      required: true,
      index: true,
      immutable: true,
    },
    offer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OfferLetter',
      default: null,
    },
    preOnboarding: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PreOnboarding',
      default: null,
    },
    // Phase 30.1 — verification-input snapshot taken at case start.
    // Fed to BgvCheck entry seeding now; consumed by 30.2 (identity),
    // 30.4 (employment emails), 30.5 (college emails), 30.6 (court
    // jurisdictions). All values here are candidate-claimed data —
    // verification is what changes status, never the claim.
    addressHistory: [
      {
        kind: { type: String, enum: ['PERMANENT', 'CURRENT', 'PREVIOUS'], default: 'PREVIOUS' },
        line: { type: String, default: '', maxlength: 300 },
        city: { type: String, default: '', maxlength: 120 },
        district: { type: String, default: '', maxlength: 120 },
        state: { type: String, default: '', maxlength: 120 },
        pinCode: { type: String, default: '', maxlength: 10 },
        fromDate: { type: Date, default: null },
        toDate: { type: Date, default: null },
      },
    ],
    fatherName: { type: String, default: '', maxlength: 160 },
    pastEmployers: [
      {
        orgName: { type: String, default: '', maxlength: 160 },
        hrEmail: { type: String, default: '', maxlength: 254 },
        hrPhone: { type: String, default: '', maxlength: 24 },
        designation: { type: String, default: '', maxlength: 120 },
        employeeId: { type: String, default: '', maxlength: 60 },
        fromDate: { type: Date, default: null },
        toDate: { type: Date, default: null },
        salaryVisibleOk: { type: Boolean, default: false },
      },
    ],
    education: [
      {
        institution: { type: String, default: '', maxlength: 200 },
        university: { type: String, default: '', maxlength: 200 },
        rollNumber: { type: String, default: '', maxlength: 80 },
        yearOfPassing: { type: Number, default: null },
        degree: { type: String, default: '', maxlength: 120 },
      },
    ],
    status: {
      type: String,
      enum: BGV_CASE_STATUSES,
      default: 'NOT_STARTED',
      index: true,
    },
    activeKey: { type: String, default: 'ACTIVE', select: false },
    triggerStage: {
      type: String,
      enum: BGV_TRIGGER_STAGES,
      default: 'PRE_JOINING',
      immutable: true,
    },
    provider: {
      type: String,
      enum: ['INTERNAL'],
      default: 'INTERNAL',
      immutable: true,
    },
    providerReference: {
      type: String,
      default: '',
      maxlength: 200,
      select: false,
    },
    candidateSnapshot: {
      name: { type: String, required: true, maxlength: 160 },
      email: { type: String, required: true, maxlength: 254 },
      candidateCode: { type: String, default: '', maxlength: 40 },
      phone: { type: String, default: '', maxlength: 40 },
    },
    jobSnapshot: {
      title: { type: String, default: '', maxlength: 180 },
      jobCode: { type: String, default: '', maxlength: 40 },
    },
    consent: {
      required: { type: Boolean, default: true },
      status: {
        type: String,
        enum: BGV_CONSENT_STATUSES,
        default: 'NOT_REQUESTED',
      },
      requestedAt: { type: Date, default: null },
      respondedAt: { type: Date, default: null },
      note: { type: String, default: '', maxlength: 500 },
    },
    requiredCheckCount: { type: Number, default: 0, min: 0 },
    verifiedRequiredCount: { type: Number, default: 0, min: 0 },
    discrepancyCount: { type: Number, default: 0, min: 0 },
    overallOutcome: {
      type: String,
      enum: BGV_OVERALL_OUTCOMES,
      default: '',
    },
    assignedVerifier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    startedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: { type: Date, default: null },
    reviewComment: { type: String, default: '', maxlength: 2000 },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: '', maxlength: 1000 },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Phase 28.6 — provider execution infrastructure (adapter-ready).
    // Idempotency: one logical submission per case; the worker claims
    // providerReference with set-if-empty before calling the provider.
    // No provider credentials ever live here or in the queue.
    providerSubmission: {
      providerRequestId: { type: String, default: '', maxlength: 200, select: false },
      submittedAt: { type: Date, default: null },
    },
    polling: {
      status: {
        type: String,
        enum: ['NOT_APPLICABLE', 'POLLING', 'STOPPED'],
        default: 'NOT_APPLICABLE',
      },
      attempts: { type: Number, default: 0, min: 0 },
      nextPollAt: { type: Date, default: null, select: false },
      stopReason: { type: String, default: '', maxlength: 120 },
    },
  },
  { timestamps: true, versionKey: false }
);

// Due-poll scan for reconciliation (external providers only).
backgroundVerificationCaseSchema.index({
  companyId: 1,
  'polling.status': 1,
  'polling.nextPollAt': 1,
});

backgroundVerificationCaseSchema.index(
  { companyId: 1, caseCode: 1 },
  { unique: true }
);
backgroundVerificationCaseSchema.index(
  { companyId: 1, candidate: 1, activeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeKey: 'ACTIVE' },
  }
);
backgroundVerificationCaseSchema.index({
  companyId: 1,
  status: 1,
  createdAt: -1,
});

backgroundVerificationCaseSchema.pre('validate', function normalizeActiveKey() {
  this.activeKey = ACTIVE_BGV_CASE_STATUSES.includes(this.status)
    ? 'ACTIVE'
    : null;
});

export default mongoose.model(
  'BackgroundVerificationCase',
  backgroundVerificationCaseSchema
);
