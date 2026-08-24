import mongoose from 'mongoose';

export const INTERVIEW_STATUSES = [
  'SCHEDULED',
  'RESCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];

export const ACTIVE_INTERVIEW_STATUSES = [
  'SCHEDULED',
  'RESCHEDULED',
  'IN_PROGRESS',
];

export const INTERVIEW_TYPES = ['ONLINE', 'ONSITE', 'PHONE'];

const roundSnapshotSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
      match: /^[A-Z0-9_]+$/,
      immutable: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
      immutable: true,
    },
    sequence: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
      immutable: true,
    },
    category: {
      type: String,
      required: true,
      enum: ['TECHNICAL', 'MANAGER', 'HR', 'CUSTOM'],
      immutable: true,
    },
  },
  { _id: false }
);

const rescheduleHistorySchema = new mongoose.Schema(
  {
    previousStartAt: { type: Date, required: true, immutable: true },
    previousEndAt: { type: Date, required: true, immutable: true },
    newStartAt: { type: Date, required: true, immutable: true },
    newEndAt: { type: Date, required: true, immutable: true },
    previousTimezone: { type: String, required: true, immutable: true },
    newTimezone: { type: String, required: true, immutable: true },
    previousInterviewers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      immutable: true,
    },
    newInterviewers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      immutable: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
      immutable: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    changedAt: { type: Date, required: true, immutable: true },
  },
  { _id: true }
);

const statusHistorySchema = new mongoose.Schema(
  {
    fromStatus: {
      type: String,
      enum: [...INTERVIEW_STATUSES, null],
      default: null,
      immutable: true,
    },
    toStatus: {
      type: String,
      enum: INTERVIEW_STATUSES,
      required: true,
      immutable: true,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
      immutable: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    changedAt: { type: Date, required: true, immutable: true },
  },
  { _id: true }
);

const interviewSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    interviewCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^INT-\d{6,}$/,
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
    requisition: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobRequisition',
      default: null,
      immutable: true,
    },
    round: { type: roundSnapshotSchema, required: true, immutable: true },
    activeRoundKey: {
      type: String,
      uppercase: true,
      trim: true,
      default: null,
    },
    scheduledStartAt: { type: Date, required: true, index: true },
    scheduledEndAt: { type: Date, required: true, index: true },
    timezone: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 100,
    },
    durationMinutes: { type: Number, required: true, min: 15, max: 480 },
    interviewType: { type: String, enum: INTERVIEW_TYPES, required: true },
    meetingLink: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
    location: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    candidateInstructions: {
      type: String,
      trim: true,
      maxlength: 3000,
      default: '',
    },
    internalNotes: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: '',
      select: false,
    },
    interviewers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length >= 1 &&
          values.length <= 10 &&
          new Set(values.map(String)).size === values.length,
        message: 'Choose between 1 and 10 unique interviewers',
      },
    },
    status: {
      type: String,
      enum: INTERVIEW_STATUSES,
      default: 'SCHEDULED',
      index: true,
    },
    cancellation: {
      reason: { type: String, trim: true, maxlength: 1000, default: '' },
      cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      cancelledAt: { type: Date, default: null },
    },
    rescheduleHistory: { type: [rescheduleHistorySchema], default: [] },
    statusHistory: { type: [statusHistorySchema], default: [] },
    notificationDispatch: {
      lastEvent: { type: String, default: '' },
      lastAttemptAt: { type: Date, default: null },
      candidate: {
        state: {
          type: String,
          enum: ['NOT_REQUESTED', 'DELIVERED', 'FAILED'],
          default: 'NOT_REQUESTED',
        },
        mode: { type: String, default: '' },
      },
      interviewers: [
        {
          _id: false,
          user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          emailState: {
            type: String,
            enum: ['NOT_REQUESTED', 'DELIVERED', 'FAILED'],
            default: 'NOT_REQUESTED',
          },
          emailMode: { type: String, default: '' },
          inAppRequested: { type: Boolean, default: false },
        },
      ],
    },
    reminderDispatch: {
      state: {
        type: String,
        enum: ['PENDING', 'CLAIMED', 'DELIVERED', 'FAILED', 'CANCELLED', 'NOT_REQUIRED'],
        default: 'PENDING',
        index: true,
      },
      dispatchAfter: { type: Date, default: null, index: true },
      claimedAt: { type: Date, default: null },
      dispatchedAt: { type: Date, default: null },
      attempts: { type: Number, default: 0, min: 0 },
      lastError: { type: String, default: '', maxlength: 300 },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true, optimisticConcurrency: true }
);

interviewSchema.index(
  { companyId: 1, interviewCode: 1 },
  { unique: true }
);
interviewSchema.index(
  { companyId: 1, candidate: 1, activeRoundKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeRoundKey: { $type: 'string' } },
  }
);
interviewSchema.index({ companyId: 1, interviewers: 1, scheduledStartAt: 1 });
interviewSchema.index({ companyId: 1, status: 1, scheduledStartAt: 1 });
interviewSchema.index({ companyId: 1, candidate: 1, scheduledStartAt: -1 });
interviewSchema.index({
  companyId: 1,
  'reminderDispatch.state': 1,
  'reminderDispatch.dispatchAfter': 1,
});

export default mongoose.model('Interview', interviewSchema);
