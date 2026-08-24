import mongoose from 'mongoose';

export const CANDIDATE_DECISIONS = ['SELECTED', 'REJECTED', 'HOLD'];
export const CANDIDATE_DECISION_STATUSES = [
  'PENDING',
  'STAGE_CHANGED',
  'COMPLETED',
  'FAILED',
];
export const CANDIDATE_DECISION_REASON_CATEGORIES = [
  'BEST_FIT',
  'ROLE_ALIGNMENT',
  'INTERVIEW_EVIDENCE',
  'SKILLS_MISMATCH',
  'INTERVIEW_PERFORMANCE',
  'ROLE_EXPECTATIONS',
  'POSITION_CLOSED',
  'COMPENSATION_EXPECTATIONS',
  'POSITION_PAUSED',
  'AWAITING_APPROVAL',
  'CANDIDATE_AVAILABILITY',
  'ADDITIONAL_REVIEW',
  'OTHER',
];

const candidateDecisionSchema = new mongoose.Schema(
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
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      required: true,
      index: true,
      immutable: true,
    },
    decision: {
      type: String,
      enum: CANDIDATE_DECISIONS,
      required: true,
      immutable: true,
    },
    sourceStage: {
      type: String,
      enum: ['FINAL_REVIEW'],
      required: true,
      immutable: true,
    },
    reasonCategory: {
      type: String,
      enum: CANDIDATE_DECISION_REASON_CATEGORIES,
      required: true,
      immutable: true,
    },
    comment: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
      immutable: true,
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: CANDIDATE_DECISION_STATUSES,
      default: 'PENDING',
      index: true,
    },
    activeOperationKey: {
      type: String,
      default: 'FINAL_DECISION',
    },
    pipelineHistory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CandidatePipelineHistory',
      default: null,
    },
    candidateHistory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CandidateHistory',
      default: null,
    },
    claimToken: {
      type: String,
      default: '',
      select: false,
    },
    claimedAt: {
      type: Date,
      default: null,
      select: false,
    },
    failureCode: {
      type: String,
      trim: true,
      maxlength: 100,
      default: '',
    },
  },
  { timestamps: true, optimisticConcurrency: true }
);

candidateDecisionSchema.index(
  { companyId: 1, candidate: 1, activeOperationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeOperationKey: { $type: 'string' } },
  }
);
candidateDecisionSchema.index({
  companyId: 1,
  candidate: 1,
  decidedAt: -1,
});
candidateDecisionSchema.index({
  companyId: 1,
  job: 1,
  decision: 1,
  decidedAt: -1,
});

export default mongoose.model('CandidateDecision', candidateDecisionSchema);
