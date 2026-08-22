import mongoose from 'mongoose';

export const CANDIDATE_HISTORY_ACTIONS = [
  'CANDIDATE_APPLIED',
  'APPLICATION_CONFIRMATION_SENT',
  'APPLICATION_CONFIRMATION_FAILED',
  'RESUME_PARSE_STARTED',
  'RESUME_PARSED',
  'RESUME_PARSE_FAILED',
  'RESUME_REPROCESS_REQUESTED',
  'ATS_PROCESSED',
  'ATS_REPROCESSED',
];

const candidateHistorySchema = new mongoose.Schema(
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
    action: {
      type: String,
      enum: CANDIDATE_HISTORY_ACTIONS,
      required: true,
    },
    source: {
      type: String,
      enum: ['CAREER_PAGE', 'INTERNAL', 'RESUME_PARSER', 'ATS_ENGINE'],
      default: 'CAREER_PAGE',
    },
    actorType: {
      type: String,
      enum: ['PUBLIC_CANDIDATE', 'TENANT_USER', 'SYSTEM'],
      default: 'SYSTEM',
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    eventAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true, versionKey: false }
);

candidateHistorySchema.index({ companyId: 1, candidate: 1, eventAt: -1 });

export default mongoose.model('CandidateHistory', candidateHistorySchema);
