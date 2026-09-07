// Phase 30.9 — BGV ADDITIONAL INFORMATION REQUEST.
//
// One document per request; a check may accumulate many over time —
// requests are never overwritten or deleted (history preserved). The
// request belongs to ONE check of ONE case; it carries no candidate PII
// beyond references (message/response text are bounded, verifier-supplied
// or candidate-supplied clarifications rendered as escaped text).
//
// Status transitions are conditional (atomic): OPEN → CANDIDATE_RESPONDED
// (explicit candidate POST only) → RESOLVED (current verifier), or
// OPEN → CANCELLED (current verifier). Nothing here creates consent,
// charges, conclusions, rejections, or pipeline movement.

import mongoose from 'mongoose';
import {
  INFO_REQUEST_CATEGORIES,
  INFO_REQUEST_STATUSES,
} from '../services/bgv/bgvInfoRequestRules.js';

const { Schema } = mongoose;

const ALL_CATEGORIES = Object.values(INFO_REQUEST_CATEGORIES).flat();

const bgvInfoRequestSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true, immutable: true },
    bgvOrder: { type: Schema.Types.ObjectId, ref: 'BgvOrder', required: true, index: true, immutable: true },
    bgvCollectionCase: { type: Schema.Types.ObjectId, ref: 'BgvCollectionCase', required: true, immutable: true },
    candidate: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true, immutable: true },
    checkType: { type: String, required: true, uppercase: true, immutable: true },
    category: { type: String, enum: ALL_CATEGORIES, required: true, immutable: true },
    // Response kind snapshot at creation (registry may evolve safely).
    responseKind: { type: String, enum: ['FILE', 'TEXT', 'REFERENCE_RECORD'], required: true, immutable: true },
    evidenceCategory: { type: String, default: null, immutable: true },
    message: { type: String, default: '', maxlength: 500 },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', required: true, immutable: true },
    status: { type: String, enum: INFO_REQUEST_STATUSES, default: 'OPEN', index: true },
    requestedAt: { type: Date, default: Date.now },
    // Candidate response (explicit POST only; GET never submits).
    response: {
      text: { type: String, default: '', maxlength: 1000 },
      submittedAt: { type: Date, default: null },
      referenceRecordAdded: { type: Boolean, default: false },
      fileCount: { type: Number, default: 0, min: 0 },
    },
    respondedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', default: null },
    // Portal token record used for the candidate notification (traceability
    // only — hashes live on the token model, never raw values here).
    portalTokenRecord: { type: Schema.Types.ObjectId, ref: 'BgvConsentAccessToken', default: null },
  },
  { timestamps: true, versionKey: false }
);

bgvInfoRequestSchema.index({ bgvOrder: 1, checkType: 1, status: 1 });

export default mongoose.model('BgvInfoRequest', bgvInfoRequestSchema);
