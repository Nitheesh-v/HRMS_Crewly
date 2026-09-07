// Phase 30.4 — candidate BGV consent invitation token.
//
// Mirrors the proven OfferAccessToken security pattern with PURPOSE
// ISOLATION: this collection authorizes ONLY the public BGV consent portal.
// Its tokens can never resolve as offer / pre-onboarding / password-reset /
// account-setup tokens (separate collections, separate routes).
//
// Invariants:
//  - The RAW token is never persisted: only its sha256 hash (select:false).
//  - One ACTIVE token per BGV order (partial unique activeKey index) —
//    resend/reissue revokes the previous link (rotation).
//  - GET views increment counters only; decisions are POST-only and stored
//    as an atomic null -> CONSENTED/DECLINED claim with consent provenance.
//  - A completed decision is never invalidated by resend (service rule).

import mongoose from 'mongoose';
import { BGV_CONSENT_PURPOSE } from '../services/bgv/bgvConsentRules.js';

const { Schema } = mongoose;

const bgvConsentAccessTokenSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    candidate: {
      type: Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      immutable: true,
    },
    // Commercial-ready Phase 30.3 order this invitation belongs to.
    bgvOrder: {
      type: Schema.Types.ObjectId,
      ref: 'BgvOrder',
      required: true,
      index: true,
      immutable: true,
    },
    // Purpose-scoped: resolution logic also asserts this constant.
    purpose: { type: String, default: BGV_CONSENT_PURPOSE, immutable: true },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
      immutable: true,
    },
    activeKey: { type: String, default: 'ACTIVE', select: false },
    expiresAt: { type: Date, required: true, index: true, immutable: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: '', maxlength: 200 },
    // Scanner-safe GET telemetry (views never record a decision).
    lastViewedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0, min: 0 },
    // Explicit candidate decision (POST only).
    finalDecision: {
      type: String,
      enum: ['CONSENTED', 'DECLINED', null],
      default: null,
    },
    decidedAt: { type: Date, default: null },
    // Consent provenance: what wording + which checks were accepted.
    consentVersion: { type: String, default: '' },
    consentTextHash: { type: String, default: '' },
    checksSnapshot: [
      {
        _id: false,
        type: { type: String },
        name: { type: String },
      },
    ],
    orderCode: { type: String, default: '' },
    issuedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
  },
  { timestamps: true, versionKey: false }
);

// One ACTIVE invitation per BGV order; reissue revokes then re-creates.
bgvConsentAccessTokenSchema.index(
  { bgvOrder: 1, activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: 'ACTIVE' } }
);
bgvConsentAccessTokenSchema.pre('validate', function normalizeActiveKey() {
  this.activeKey = this.revokedAt ? null : 'ACTIVE';
});

export default mongoose.model('BgvConsentAccessToken', bgvConsentAccessTokenSchema);
