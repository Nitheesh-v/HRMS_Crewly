// ─────────────────────────────────────────────────────────────
// Job posting — an open position published by HR.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
  'TEMPORARY',
];
export const JOB_STATUS = ['OPEN', 'CLOSED'];
export const JOB_PUBLICATION_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'PAUSED',
  'ARCHIVED',
];
export const JOB_WORK_MODES = ['ONSITE', 'HYBRID', 'REMOTE'];
export const JOB_EXPERIENCE_LEVELS = ['FRESHER', 'EXPERIENCED'];

const jobPostingSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    jobCode: {
      type: String,
      uppercase: true,
      trim: true,
      maxlength: 30,
      default: '',
    },
    title: { type: String, required: [true, 'Job title is required'], trim: true, minlength: 2, maxlength: 120 },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    location: { type: String, trim: true, maxlength: 80, default: 'On-site' },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'FULL_TIME' },
    openings: { type: Number, min: 1, max: 500, default: 1 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    team: { type: String, trim: true, maxlength: 80, default: '' },
    workMode: { type: String, enum: JOB_WORK_MODES, default: 'ONSITE' },
    experienceLevel: {
      type: String,
      enum: JOB_EXPERIENCE_LEVELS,
      default: 'EXPERIENCED',
    },
    minExperience: { type: Number, min: 0, max: 60, default: 0 },
    maxExperience: { type: Number, min: 0, max: 60, default: 0 },
    requiredSkills: { type: [String], default: [] },
    preferredSkills: { type: [String], default: [] },
    educationRequirements: {
      type: [{ type: String, trim: true, maxlength: 200 }],
      default: [],
      validate: {
        validator: (value) => !Array.isArray(value) || value.length <= 20,
        message: 'Education requirements cannot contain more than 20 entries',
      },
    },
    maxNoticePeriod: { type: Number, min: 0, max: 365, default: 30 },
    salaryMin: { type: Number, min: 0, default: null },
    salaryMax: { type: Number, min: 0, default: null },
    hiringBudget: { type: Number, min: 0, default: null },
    hiringReason: {
      type: String,
      enum: ['NEW_POSITION', 'REPLACEMENT', 'EXPANSION', 'SEASONAL', 'OTHER'],
      default: 'NEW_POSITION',
    },
    hiringReasonDetails: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    priority: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      default: 'MEDIUM',
    },
    expectedJoiningDate: { type: Date, default: null },
    sourceRequisition: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobRequisition',
      default: null,
    },
    sourceRequisitionNumber: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 30,
      default: '',
    },
    publicationStatus: {
      type: String,
      enum: JOB_PUBLICATION_STATUSES,
      default: 'DRAFT',
      index: true,
    },
    publishedAt: {
      type: Date,
      default: null,
      index: true,
    },
    applicationDeadline: {
      type: Date,
      default: null,
      index: true,
    },
    publicSalaryVisible: {
      type: Boolean,
      default: false,
    },
    status: { type: String, enum: JOB_STATUS, default: 'OPEN' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

jobPostingSchema.index(
  { companyId: 1, sourceRequisition: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourceRequisition: { $type: 'objectId' },
    },
  }
);
jobPostingSchema.index(
  { companyId: 1, jobCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      jobCode: { $gt: '' },
    },
  }
);
jobPostingSchema.index({
  companyId: 1,
  publicationStatus: 1,
  status: 1,
  publishedAt: -1,
});

export default mongoose.model('JobPosting', jobPostingSchema);
