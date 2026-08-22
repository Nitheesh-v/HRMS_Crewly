import mongoose from 'mongoose';

export const POSITIVE_PIPELINE_STAGES = [
  'APPLIED',
  'ATS_SCREENING',
  'HR_SCREENING',
  'SHORTLISTED',
  'INTERVIEW_1',
  'INTERVIEW_2',
  'INTERVIEW_3',
  'MANAGER_ROUND',
  'HR_FINAL',
  'FINAL_REVIEW',
  'SELECTED',
  'OFFER',
  'OFFER_ACCEPTED',
  'PRE_ONBOARDING',
  'JOINED',
];

export const DISPOSITION_PIPELINE_STAGES = [
  'REJECTED',
  'HOLD',
  'WITHDRAWN',
];

export const PIPELINE_STAGES = [
  ...POSITIVE_PIPELINE_STAGES,
  ...DISPOSITION_PIPELINE_STAGES,
];

const immutableRef = (ref, indexed = false) => ({
  type: mongoose.Schema.Types.ObjectId,
  ref,
  required: true,
  immutable: true,
  ...(indexed ? { index: true } : {}),
});

const candidatePipelineHistorySchema = new mongoose.Schema(
  {
    companyId: immutableRef('Company', true),
    candidateId: immutableRef('Candidate', true),
    jobPostingId: immutableRef('JobPosting', true),
    fromStage: {
      type: String,
      enum: PIPELINE_STAGES,
      required: true,
      immutable: true,
    },
    toStage: {
      type: String,
      enum: PIPELINE_STAGES,
      required: true,
      immutable: true,
    },
    actor: immutableRef('User'),
    reason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
      immutable: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      immutable: true,
      validate: {
        validator: (value) => {
          try {
            return JSON.stringify(value || {}).length <= 10000;
          } catch {
            return false;
          }
        },
        message: 'Pipeline metadata is too large or invalid',
      },
    },
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
      index: true,
    },
  },
  { versionKey: false, timestamps: false }
);

candidatePipelineHistorySchema.index({
  companyId: 1,
  candidateId: 1,
  createdAt: -1,
});
candidatePipelineHistorySchema.index({
  companyId: 1,
  jobPostingId: 1,
  toStage: 1,
});

const rejectMutation = () => {
  throw new Error('Candidate pipeline history is immutable');
};

candidatePipelineHistorySchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'],
  rejectMutation
);
candidatePipelineHistorySchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  rejectMutation
);

export default mongoose.model(
  'CandidatePipelineHistory',
  candidatePipelineHistorySchema
);
