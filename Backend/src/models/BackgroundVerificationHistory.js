import mongoose from 'mongoose';
import { BGV_CASE_STATUSES, BGV_CONSENT_STATUSES } from './BackgroundVerificationCase.js';
import { BGV_CHECK_STATUSES } from './BackgroundVerificationCheck.js';

export const BGV_HISTORY_ACTIONS = [
  'BGV_CASE_CREATED',
  'BGV_STARTED',
  'BGV_CONSENT_REQUESTED',
  'BGV_CONSENT_UPDATED',
  'BGV_CHECK_STARTED',
  'BGV_INFORMATION_REQUESTED',
  'BGV_CHECK_VERIFIED',
  'BGV_DISCREPANCY_RECORDED',
  'BGV_CHECK_UNABLE_TO_VERIFY',
  'BGV_ASSIGNED',
  'BGV_REVIEW_REQUIRED',
  'BGV_REVIEWED',
  'BGV_COMPLETED',
  'BGV_CANCELLED',
];

const backgroundVerificationHistorySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    case: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BackgroundVerificationCase',
      required: true,
      index: true,
      immutable: true,
    },
    check: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BackgroundVerificationCheck',
      default: null,
      immutable: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      immutable: true,
    },
    action: {
      type: String,
      enum: BGV_HISTORY_ACTIONS,
      required: true,
      immutable: true,
    },
    // RCA (2026-09-05): consent transitions (NOT_REQUESTED -> REQUESTED etc.)
    // are recorded as history rows, so consent statuses must be valid here;
    // previously Start BGV crashed with a ValidationError when consent was
    // required. Additive enum extension — no migration needed.
    previousStatus: {
      type: String,
      enum: [...BGV_CASE_STATUSES, ...BGV_CHECK_STATUSES, ...BGV_CONSENT_STATUSES, ''],
      default: '',
      immutable: true,
    },
    newStatus: {
      type: String,
      enum: [...BGV_CASE_STATUSES, ...BGV_CHECK_STATUSES, ...BGV_CONSENT_STATUSES, ''],
      default: '',
      immutable: true,
    },
    actorType: {
      type: String,
      enum: ['TENANT_USER', 'PUBLIC_CANDIDATE', 'SYSTEM', 'PROVIDER'],
      default: 'SYSTEM',
      immutable: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      immutable: true,
    },
    reason: {
      type: String,
      default: '',
      maxlength: 1000,
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
        message: 'History metadata is too large',
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

backgroundVerificationHistorySchema.index({
  companyId: 1,
  case: 1,
  createdAt: -1,
});

const rejectMutation = () => {
  throw new Error('Background verification history is immutable');
};

backgroundVerificationHistorySchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'],
  rejectMutation
);
backgroundVerificationHistorySchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  rejectMutation
);

export default mongoose.model(
  'BackgroundVerificationHistory',
  backgroundVerificationHistorySchema
);
