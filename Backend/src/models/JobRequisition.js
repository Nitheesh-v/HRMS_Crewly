import mongoose from 'mongoose';

export const REQUISITION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'PENDING_HR',
  'APPROVED',
  'REJECTED',
  'SENT_BACK',
  'CANCELLED',
  'FULFILLED',
];

export const REQUISITION_PRIORITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
];

export const REQUISITION_EXPERIENCE_LEVELS = [
  'FRESHER',
  'EXPERIENCED',
];

export const REQUISITION_EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
  'TEMPORARY',
];

export const REQUISITION_WORK_MODES = [
  'ONSITE',
  'HYBRID',
  'REMOTE',
];

export const REQUISITION_HIRING_REASONS = [
  'NEW_POSITION',
  'REPLACEMENT',
  'EXPANSION',
  'SEASONAL',
  'OTHER',
];

const historySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    fromStatus: {
      type: String,
      enum: ['', ...REQUISITION_STATUSES],
      default: '',
    },
    toStatus: {
      type: String,
      enum: REQUISITION_STATUSES,
      required: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    actorName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 80,
    },
    actorRole: {
      type: String,
      default: '',
      trim: true,
      maxlength: 50,
    },
    comment: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    changedFields: {
      type: [String],
      default: [],
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const jobRequisitionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    requisitionNumber: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: true,
      index: true,
    },
    team: {
      type: String,
      default: '',
      trim: true,
      maxlength: 80,
    },
    position: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    openings: {
      type: Number,
      default: 1,
      min: 1,
      max: 500,
    },
    experienceLevel: {
      type: String,
      enum: REQUISITION_EXPERIENCE_LEVELS,
      default: 'EXPERIENCED',
    },
    minExperience: {
      type: Number,
      default: 0,
      min: 0,
      max: 60,
    },
    maxExperience: {
      type: Number,
      default: 0,
      min: 0,
      max: 60,
    },
    requiredSkills: {
      type: [String],
      default: [],
    },
    preferredSkills: {
      type: [String],
      default: [],
    },
    salaryMin: {
      type: Number,
      default: null,
      min: 0,
    },
    salaryMax: {
      type: Number,
      default: null,
      min: 0,
    },
    hiringBudget: {
      type: Number,
      default: null,
      min: 0,
    },
    employmentType: {
      type: String,
      enum: REQUISITION_EMPLOYMENT_TYPES,
      default: 'FULL_TIME',
    },
    workMode: {
      type: String,
      enum: REQUISITION_WORK_MODES,
      default: 'ONSITE',
    },
    location: {
      type: String,
      default: '',
      trim: true,
      maxlength: 120,
    },
    hiringReason: {
      type: String,
      enum: REQUISITION_HIRING_REASONS,
      default: 'NEW_POSITION',
    },
    hiringReasonDetails: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    priority: {
      type: String,
      enum: REQUISITION_PRIORITIES,
      default: 'MEDIUM',
    },
    expectedJoiningDate: {
      type: Date,
      default: null,
    },
    requester: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: REQUISITION_STATUSES,
      default: 'DRAFT',
      index: true,
    },
    submittedAt: {
      type: Date,
      default: null,
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    history: {
      type: [historySchema],
      default: [],
    },
  },
  { timestamps: true }
);

jobRequisitionSchema.index(
  { companyId: 1, requisitionNumber: 1 },
  { unique: true }
);
jobRequisitionSchema.index({ companyId: 1, status: 1, createdAt: -1 });
jobRequisitionSchema.index({ companyId: 1, requester: 1, createdAt: -1 });
jobRequisitionSchema.index({ companyId: 1, department: 1, status: 1 });

export default mongoose.model('JobRequisition', jobRequisitionSchema);
