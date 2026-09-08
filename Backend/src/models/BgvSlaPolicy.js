import mongoose from 'mongoose';

const { Schema } = mongoose;

// Phase 30.11 — platform BGV SLA policy (single operations document).
//
//  - Internal Crewly/Infolexus operating targets only; tenant HR never reads
//    or writes this (platform permission bgv-operations:manage).
//  - NO seeded defaults: an absent document means SLA_NOT_CONFIGURED and the
//    dashboard says so explicitly.
//  - Exactly the five Phase 30 check types; validation lives in
//    bgvSlaRules.validateSlaPolicy (reused by the PUT route).

// Fixed singleton key: concurrent upserts converge on ONE document
// (unique index) instead of racing duplicates.
export const BGV_SLA_POLICY_KEY = 'BGV_SLA_POLICY';

const bgvSlaPolicySchema = new Schema(
  {
    key: { type: String, required: true, default: BGV_SLA_POLICY_KEY, immutable: true },
    // Hours per check type; missing key = unconfigured for that check.
    targets: {
      IDENTITY: { type: Number, min: 1, max: 720 },
      ADDRESS: { type: Number, min: 1, max: 720 },
      EDUCATION: { type: Number, min: 1, max: 720 },
      EMPLOYMENT: { type: Number, min: 1, max: 720 },
      REFERENCE: { type: Number, min: 1, max: 720 },
    },
    dueSoonHours: { type: Number, default: 24, min: 1, max: 168 },
    // Candidate-wait (30.9) intervals are excluded from accountable time.
    pauseOnCandidateWait: { type: Boolean, default: true },
    // Optional age target for UNASSIGNED checks (null = show age only).
    unassignedTargetHours: { type: Number, default: null, min: 1, max: 720 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedAt: { type: Date, default: null },
  },
  { versionKey: false }
);

// One policy document for the platform (fixed key, upsert semantics in service).
bgvSlaPolicySchema.index({ key: 1 }, { unique: true });

export default mongoose.model('BgvSlaPolicy', bgvSlaPolicySchema);
