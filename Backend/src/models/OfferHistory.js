import mongoose from 'mongoose';
import { OFFER_STATUSES } from './OfferLetter.js';

export const OFFER_HISTORY_ACTIONS = [
  'OFFER_CREATED',
  'OFFER_UPDATED',
  'OFFER_SUBMITTED',
  'OFFER_APPROVED',
  'OFFER_RETURNED',
  'OFFER_APPROVAL_INVALIDATED',
  'OFFER_SEND_FAILED',
  'OFFER_SENT',
  'OFFER_VIEWED',
  'OFFER_ACCEPTED',
  'OFFER_REJECTED',
  'OFFER_EXPIRED',
  'OFFER_WITHDRAWN',
  'OFFER_DOCUMENT_ACCESSED',
];

const offerHistorySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    offer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OfferLetter',
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
      immutable: true,
    },
    action: {
      type: String,
      enum: OFFER_HISTORY_ACTIONS,
      required: true,
      immutable: true,
    },
    fromStatus: { type: String, enum: [...OFFER_STATUSES, ''], default: '', immutable: true },
    toStatus: { type: String, enum: [...OFFER_STATUSES, ''], default: '', immutable: true },
    actorType: {
      type: String,
      enum: ['TENANT_USER', 'CANDIDATE', 'SYSTEM'],
      required: true,
      immutable: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      immutable: true,
    },
    actorNameSnapshot: { type: String, default: '', maxlength: 160, immutable: true },
    reason: { type: String, default: '', maxlength: 1000, immutable: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {}, immutable: true },
    eventAt: { type: Date, default: Date.now, index: true, immutable: true },
  },
  { timestamps: true, versionKey: false }
);

offerHistorySchema.index({ companyId: 1, offer: 1, eventAt: 1 });

const immutableError = () => {
  throw new Error('Offer history is immutable');
};
offerHistorySchema.pre('updateOne', immutableError);
offerHistorySchema.pre('updateMany', immutableError);
offerHistorySchema.pre('findOneAndUpdate', immutableError);
offerHistorySchema.pre('deleteOne', immutableError);
offerHistorySchema.pre('deleteMany', immutableError);
offerHistorySchema.pre('findOneAndDelete', immutableError);

export default mongoose.model('OfferHistory', offerHistorySchema);
