import mongoose from 'mongoose';

export const SCORECARD_ROUND_CATEGORIES = [
  'TECHNICAL',
  'MANAGER',
  'HR',
  'CUSTOM',
];

const criterionSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
      match: /^[A-Z0-9_]+$/,
    },
    label: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    maxScore: {
      type: Number,
      required: true,
      min: 2,
      max: 100,
    },
    weight: {
      type: Number,
      min: 0.1,
      max: 20,
      default: 1,
    },
    required: {
      type: Boolean,
      default: true,
    },
    commentRequiredBelowScore: {
      type: Number,
      min: 1,
      max: 100,
      default: null,
    },
  },
  { _id: false }
);

const interviewScorecardTemplateSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
      match: /^[A-Z0-9_]+$/,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 150,
    },
    roundCategory: {
      type: String,
      enum: SCORECARD_ROUND_CATEGORIES,
      required: true,
      index: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      default: null,
      index: true,
    },
    criteria: {
      type: [criterionSchema],
      required: true,
      validate: [
        {
          validator: (values) =>
            Array.isArray(values) && values.length >= 1 && values.length <= 20,
          message: 'Scorecard must contain between 1 and 20 criteria',
        },
        {
          validator: (values) =>
            new Set((values || []).map((criterion) => criterion.key)).size ===
            (values || []).length,
          message: 'Scorecard criterion keys must be unique',
        },
        {
          validator: (values) =>
            (values || []).every(
              (criterion) =>
                criterion.commentRequiredBelowScore === null ||
                criterion.commentRequiredBelowScore <= criterion.maxScore
            ),
          message: 'Comment thresholds cannot exceed their criterion maximum score',
        },
      ],
    },
    version: {
      type: Number,
      min: 1,
      default: 1,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    isSystemDefault: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

interviewScorecardTemplateSchema.index(
  { companyId: 1, key: 1, job: 1 },
  { unique: true }
);
interviewScorecardTemplateSchema.index({
  companyId: 1,
  job: 1,
  roundCategory: 1,
  active: 1,
});

export default mongoose.model(
  'InterviewScorecardTemplate',
  interviewScorecardTemplateSchema
);
