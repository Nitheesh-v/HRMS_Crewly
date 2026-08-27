import mongoose from 'mongoose';
import { PRE_ONBOARDING_STATUSES } from './PreOnboarding.js';

export const PRE_ONBOARDING_HISTORY_ACTIONS = [
  'PRE_ONBOARDING_STARTED',
  'PRE_ONBOARDING_INVITED',
  'DOCUMENT_UPLOADED',
  'DOCUMENT_RESUBMITTED',
  'DOCUMENT_UNDER_REVIEW',
  'DOCUMENT_VERIFIED',
  'DOCUMENT_REJECTED',
  'DOCUMENT_RESUBMISSION_REQUIRED',
  'PRE_ONBOARDING_STATUS_UPDATED',
  'PRE_ONBOARDING_COMPLETED',
  'PRE_ONBOARDING_READY',
  'PRE_ONBOARDING_WITHDRAWN',
  'DOCUMENT_ACCESSED',
];

const preOnboardingHistorySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    preOnboarding: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PreOnboarding',
      required: true,
      index: true,
      immutable: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      immutable: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      required: true,
      immutable: true,
    },
    action: {
      type: String,
      enum: PRE_ONBOARDING_HISTORY_ACTIONS,
      required: true,
      immutable: true,
    },
    previousStatus: {
      type: String,
      enum: [...PRE_ONBOARDING_STATUSES, ''],
      default: '',
      immutable: true,
    },
    newStatus: {
      type: String,
      enum: [...PRE_ONBOARDING_STATUSES, ''],
      default: '',
      immutable: true,
    },
    actorType: {
      type: String,
      enum: ['TENANT_USER', 'PUBLIC_CANDIDATE', 'SYSTEM'],
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
        message: 'History metadata is too large or invalid',
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

preOnboardingHistorySchema.index({
  companyId: 1,
  preOnboarding: 1,
  createdAt: -1,
});

const rejectMutation = () => {
  throw new Error('Pre-onboarding history is immutable');
};

preOnboardingHistorySchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'],
  rejectMutation
);
preOnboardingHistorySchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  rejectMutation
);

export default mongoose.model('PreOnboardingHistory', preOnboardingHistorySchema);
