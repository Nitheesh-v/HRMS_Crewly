// ─────────────────────────────────────────────────────────────
// Phase 27.1 — Job Requisition
// An INTERNAL hiring request raised by a Manager / Team Lead.
// It is NOT a public job. HR converts an APPROVED requisition
// into a Job Opening (Phase 27.3).
//
// Lifecycle:
//   DRAFT → PENDING_HR → APPROVED | REJECTED | SENT_BACK → CLOSED
//   SENT_BACK → PENDING_HR (requester edits and resubmits)
//
// Tenant rule: companyId is always taken from req.companyId.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

export const REQUISITION_STATUS = [
  'DRAFT',
  'SUBMITTED',
  'PENDING_HR',
  'APPROVED',
  'REJECTED',
  'SENT_BACK',
  'CLOSED',
];

export const HIRING_TYPES = ['FRESHER', 'EXPERIENCED', 'BOTH'];

export const REQUISITION_PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export const REQUISITION_EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
];

export const WORK_MODES = ['ONSITE', 'HYBRID', 'REMOTE'];

export const HIRING_REASONS = [
  'NEW_POSITION',
  'REPLACEMENT',
  'BACKFILL',
  'EXPANSION',
  'PROJECT_BASED',
  'OTHER',
];

const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    fromStatus: { type: String, default: '' },
    toStatus: { type: String, default: '' },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '' },
    actorRole: { type: String, default: '' },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const jobRequisitionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    // Human readable reference, e.g. JR-2026-0007
    code: { type: String, trim: true, uppercase: true, default: '' },

    requester: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    requesterRole: { type: String, default: '' },

    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
      index: true,
    },
    team: { type: String, trim: true, maxlength: 80, default: '' },

    position: {
      type: String,
      required: [true, 'Position is required'],
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    designation: { type: String, trim: true, maxlength: 100, default: '' },

    openings: { type: Number, min: 1, max: 500, default: 1 },

    hiringType: { type: String, enum: HIRING_TYPES, default: 'EXPERIENCED' },
    minExperience: { type: Number, min: 0, max: 50, default: 0 },
    maxExperience: { type: Number, min: 0, max: 50, default: 0 },

    requiredSkills: [{ type: String, trim: true, maxlength: 40 }],
    preferredSkills: [{ type: String, trim: true, maxlength: 40 }],

    hiringReason: { type: String, enum: HIRING_REASONS, default: 'NEW_POSITION' },
    reasonNote: { type: String, trim: true, maxlength: 500, default: '' },

    priority: { type: String, enum: REQUISITION_PRIORITY, default: 'MEDIUM' },

    expectedJoiningDate: { type: Date, default: null },

    // Monthly or annual is a company convention — stored as plain numbers.
    minSalary: { type: Number, min: 0, default: 0 },
    maxSalary: { type: Number, min: 0, default: 0 },
    hiringBudget: { type: Number, min: 0, default: 0 },

    employmentType: {
      type: String,
      enum: REQUISITION_EMPLOYMENT_TYPES,
      default: 'FULL_TIME',
    },
    workMode: { type: String, enum: WORK_MODES, default: 'ONSITE' },
    location: { type: String, trim: true, maxlength: 100, default: '' },

    additionalRequirements: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },

    status: { type: String, enum: REQUISITION_STATUS, default: 'DRAFT', index: true },

    submittedAt: { type: Date, default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decisionReason: { type: String, trim: true, maxlength: 500, default: '' },

    // Set in Phase 27.3 when HR creates the job from this requisition.
    jobOpening: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      default: null,
    },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

jobRequisitionSchema.index({ companyId: 1, status: 1, createdAt: -1 });
jobRequisitionSchema.index({ companyId: 1, requester: 1, createdAt: -1 });
jobRequisitionSchema.index({ companyId: 1, code: 1 }, { unique: true, sparse: true });

export default mongoose.model('JobRequisition', jobRequisitionSchema);
