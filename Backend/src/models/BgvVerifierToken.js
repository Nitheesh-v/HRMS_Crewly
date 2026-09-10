// Phase 30.6 — BGV verifier one-time tokens (hash-only persistence).
//
// Purposes:
//  - SETUP:     Super-Admin-invited account setup (no temporary passwords).
//  - RESET:     self-service password recovery (generic responses).
//  - TWO_FACTOR: short-lived email OTP challenge (platform 2FA pattern).
//
// Invariants: raw values are sent exactly once for delivery; only sha256
// hashes persist; expiry + one-time use + revocation; raw values are never
// returned to Super Admin, never audited, never queued.

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const BGV_VERIFIER_TOKEN_PURPOSES = ['SETUP', 'RESET', 'TWO_FACTOR'];

const bgvVerifierTokenSchema = new Schema(
  {
    verifier: {
      type: Schema.Types.ObjectId,
      ref: 'BgvVerifier',
      required: true,
      index: true,
    },
    purpose: {
      type: String,
      enum: BGV_VERIFIER_TOKEN_PURPOSES,
      required: true,
    },
    tokenHash: { type: String, required: true, unique: true, select: false },
    // Indexed by the TTL index below (30.12: removed the duplicate
    // `index: true` that made mongoose declare {expiresAt:1} twice).
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    requestedIp: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false }
);

bgvVerifierTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('BgvVerifierToken', bgvVerifierTokenSchema);
