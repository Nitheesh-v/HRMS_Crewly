// ─────────────────────────────────────────────────────────────
// Candidate — a person in the hiring pipeline of one job.
//   currentStage: canonical Phase 27.8 pipeline stage
//   stage       : synchronized compatibility mirror for earlier recruitment code
//   offerStatus : NONE → SENT → ACCEPTED / DECLINED
// Convert creates the employee User account and copies the link
// into convertedUser (prevents double conversion).
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import { PIPELINE_STAGES } from './CandidatePipelineHistory.js';

export const LEGACY_CANDIDATE_STAGES = ['SCREENING', 'INTERVIEW', 'HIRED'];
export const CANDIDATE_STAGES = [
  ...PIPELINE_STAGES,
  ...LEGACY_CANDIDATE_STAGES,
];
export const OFFER_STATUS = ['NONE', 'SENT', 'ACCEPTED', 'DECLINED'];
export const CANDIDATE_SOURCES = ['INTERNAL', 'CAREER_PAGE'];
export const CANDIDATE_STATUSES = ['ACTIVE', 'ARCHIVED'];
export const CANDIDATE_APPLICATION_STATUSES = ['APPLIED'];

const candidateSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPosting', required: true },
    requisition: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobRequisition',
      default: null,
    },
    candidateCode: {
      type: String,
      uppercase: true,
      trim: true,
      maxlength: 30,
      default: '',
    },
    name: { type: String, required: [true, 'Candidate name is required'], trim: true, minlength: 2, maxlength: 100 },
    email: { type: String, required: [true, 'Candidate email is required'], lowercase: true, trim: true },
    phone: { type: String, trim: true, maxlength: 20, default: '' },
    location: { type: String, trim: true, maxlength: 120, default: '' },
    currentCompany: { type: String, trim: true, maxlength: 120, default: '' },
    currentJobTitle: { type: String, trim: true, maxlength: 120, default: '' },
    totalExperience: { type: Number, min: 0, max: 60, default: 0 },
    relevantExperience: { type: Number, min: 0, max: 60, default: 0 },
    expectedSalary: { type: Number, min: 0, max: 1000000000, default: null },
    noticePeriod: { type: Number, min: 0, max: 365, default: null },
    education: {
      degree: { type: String, trim: true, maxlength: 120, default: '' },
      institution: { type: String, trim: true, maxlength: 160, default: '' },
      graduationYear: { type: Number, min: 1950, max: 2200, default: null },
    },
    skills: [{ type: String, trim: true, maxlength: 50 }],
    links: {
      linkedIn: { type: String, trim: true, maxlength: 300, default: '' },
      github: { type: String, trim: true, maxlength: 300, default: '' },
      portfolio: { type: String, trim: true, maxlength: 300, default: '' },
    },
    source: { type: String, enum: CANDIDATE_SOURCES, default: 'INTERNAL', index: true },
    applicationDate: { type: Date, default: Date.now, index: true },
    applicationStatus: {
      type: String,
      enum: CANDIDATE_APPLICATION_STATUSES,
      default: 'APPLIED',
    },
    status: { type: String, enum: CANDIDATE_STATUSES, default: 'ACTIVE', index: true },
    consent: {
      acceptedAt: { type: Date, default: null },
      version: { type: String, trim: true, maxlength: 30, default: '' },
    },
    resumeLink: { type: String, trim: true, maxlength: 300, default: '' },
    currentStage: {
      type: String,
      enum: PIPELINE_STAGES,
      default: 'APPLIED',
      index: true,
    },
    stage: { type: String, enum: CANDIDATE_STAGES, default: 'APPLIED' },
    assignedRecruiter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    hiringManager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    // Offer letter tracking
    offerStatus: { type: String, enum: OFFER_STATUS, default: 'NONE' },
    offerSalary: { type: Number, min: 0, default: 0 },          // monthly CTC in ₹
    offerJoiningDate: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    convertedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Same email can't be added twice to the SAME job
candidateSchema.index({ job: 1, email: 1 }, { unique: true });
candidateSchema.index(
  { companyId: 1, candidateCode: 1 },
  {
    unique: true,
    partialFilterExpression: { candidateCode: { $gt: '' } },
  }
);
candidateSchema.index({ companyId: 1, applicationDate: -1 });
candidateSchema.index({ companyId: 1, job: 1, currentStage: 1, source: 1 });
candidateSchema.index({ companyId: 1, job: 1, stage: 1, source: 1 });

// A document save cannot leave the indexed canonical stage and compatibility mirror apart.
candidateSchema.pre('validate', function synchronizeCandidateStage() {
  const normalizedStage =
    ({ SCREENING: 'HR_SCREENING', INTERVIEW: 'INTERVIEW_1', HIRED: 'JOINED' })[
      this.stage
    ] || this.stage;

  if (
    this.isModified('currentStage') &&
    !(this.isNew && this.currentStage === 'APPLIED' && normalizedStage !== 'APPLIED')
  ) {
    this.stage = this.currentStage;
  } else if (this.isModified('stage')) {
    this.currentStage = normalizedStage;
    this.stage = normalizedStage;
  }
});

export default mongoose.model('Candidate', candidateSchema);
