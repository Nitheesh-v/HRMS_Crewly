// Phase 30.6 — BGV verifier session (mirrors AdminSession semantics):
// server-side revocable sessions with expiry TTL. Deactivation revokes all
// verifier sessions; logout revokes the current one; every verifier-
// authorized request re-checks both the session row AND the account state.

import mongoose from 'mongoose';

const { Schema } = mongoose;

const bgvVerifierSessionSchema = new Schema(
  {
    verifier: {
      type: Schema.Types.ObjectId,
      ref: 'BgvVerifier',
      required: true,
      index: true,
    },
    sessionId: { type: String, required: true, unique: true, index: true },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

bgvVerifierSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
bgvVerifierSessionSchema.index({ verifier: 1, revokedAt: 1 });

export default mongoose.model('BgvVerifierSession', bgvVerifierSessionSchema);
