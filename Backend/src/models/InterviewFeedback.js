import mongoose from 'mongoose';

export const INTERVIEW_FEEDBACK_STATUSES = ['DRAFT', 'SUBMITTED', 'LOCKED'];
export const INTERVIEW_RECOMMENDATIONS = [
  'STRONG_HIRE',
  'HIRE',
  'NEXT_ROUND',
  'HOLD',
  'NO_HIRE',
];

const criterionSnapshotSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, immutable: true },
    label: { type: String, required: true, immutable: true },
    description: { type: String, default: '', immutable: true },
    maxScore: { type: Number, required: true, immutable: true },
    weight: { type: Number, required: true, immutable: true },
    required: { type: Boolean, default: true, immutable: true },
    commentRequiredBelowScore: {
      type: Number,
      default: null,
      immutable: true,
    },
  },
  { _id: false }
);

const templateSnapshotSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, immutable: true },
    name: { type: String, required: true, immutable: true },
    roundCategory: { type: String, required: true, immutable: true },
    version: { type: Number, required: true, immutable: true },
    criteria: {
      type: [criterionSnapshotSchema],
      required: true,
      immutable: true,
    },
  },
  { _id: false }
);

const ratingSchema = new mongoose.Schema(
  {
    criterionKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 80,
    },
    criterionLabel: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    score: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
    },
    maxScore: {
      type: Number,
      required: true,
      min: 2,
      max: 100,
    },
    weight: {
      type: Number,
      required: true,
      min: 0.1,
      max: 20,
    },
    comment: {
      type: String,
      trim: true,
      maxlength: 1500,
      default: '',
    },
  },
  { _id: false }
);

const interviewFeedbackSchema = new mongoose.Schema(
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
    interview: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Interview',
      required: true,
      index: true,
      immutable: true,
    },
    interviewer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
      immutable: true,
    },
    scorecardTemplate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InterviewScorecardTemplate',
      default: null,
      immutable: true,
    },
    templateSnapshot: {
      type: templateSnapshotSchema,
      required: true,
      immutable: true,
    },
    ratings: {
      type: [ratingSchema],
      default: [],
      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length <= 20 &&
          new Set(values.map((rating) => rating.criterionKey)).size === values.length,
        message: 'Feedback ratings must use unique scorecard criteria',
      },
    },
    overallScore: {
      type: Number,
      min: 0,
      max: 10,
      default: null,
    },
    maxOverallScore: {
      type: Number,
      min: 10,
      max: 10,
      default: 10,
    },
    strengths: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: '',
    },
    concerns: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: '',
    },
    privateNotes: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: '',
      select: false,
    },
    recommendation: {
      type: String,
      enum: ['', ...INTERVIEW_RECOMMENDATIONS],
      default: '',
    },
    status: {
      type: String,
      enum: INTERVIEW_FEEDBACK_STATUSES,
      default: 'DRAFT',
      index: true,
    },
    submittedAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastEditedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true, optimisticConcurrency: true }
);

interviewFeedbackSchema.index(
  { companyId: 1, interview: 1, interviewer: 1 },
  { unique: true }
);
interviewFeedbackSchema.index({
  companyId: 1,
  candidate: 1,
  status: 1,
  submittedAt: -1,
});
interviewFeedbackSchema.index({ companyId: 1, job: 1, status: 1 });

const rejectPhysicalDeletion = () => {
  throw new Error('Interview feedback records cannot be physically deleted');
};

interviewFeedbackSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  rejectPhysicalDeletion
);

export default mongoose.model('InterviewFeedback', interviewFeedbackSchema);
