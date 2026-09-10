// Phase 30.6 — internal Crewly/Infolexus BGV verifier principal.
//
// SECURITY DOMAIN: a verifier is an INTERNAL operational principal, NOT a
// tenant User/Employee and NOT a platform administrator. Verifiers live in
// their own collection with their own session + token collections and a
// dedicated JWT principal type, so:
//   - tenant `protect` rejects verifier tokens before any DB lookup,
//   - `superAdminSession` can never see a verifier (role check on User),
//   - verifier routes reject tenant/platform tokens.
// Specializations only mark ELIGIBILITY for future 30.7 assignment — they
// grant zero candidate/evidence access by themselves.

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const { Schema } = mongoose;

// The ONLY approved Phase 30 specializations.
export const BGV_VERIFIER_SPECIALIZATIONS = [
  'IDENTITY',
  'ADDRESS',
  'EDUCATION',
  'EMPLOYMENT',
  'REFERENCE',
];

export const BGV_VERIFIER_STATUSES = ['INVITED', 'ACTIVE', 'DEACTIVATED'];

const bgvVerifierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      maxlength: 160,
      index: true,
    },
    // bcrypt hash only — select:false, never returned or logged.
    passwordHash: { type: String, default: null, select: false },
    specializations: {
      type: [String],
      default: [],
      validate: {
        validator: (list) =>
          Array.isArray(list) &&
          list.length >= 1 &&
          list.every((entry) => BGV_VERIFIER_SPECIALIZATIONS.includes(entry)),
        message: 'Only the five approved BGV specializations are allowed',
      },
    },
    status: {
      type: String,
      enum: BGV_VERIFIER_STATUSES,
      default: 'INVITED',
      index: true,
    },
    // Optional email-OTP 2FA (same posture as platform admins).
    twoFactorEnabled: { type: Boolean, default: false },
    setupCompletedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    deactivatedAt: { type: Date, default: null },
    deactivatedReason: { type: String, default: '', maxlength: 200 },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false }
);

bgvVerifierSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(String(candidate || ''), this.passwordHash);
};

bgvVerifierSchema.methods.hashPassword = async function hashPassword(plain) {
  this.passwordHash = await bcrypt.hash(String(plain), 10);
  return this.passwordHash;
};

export default mongoose.model('BgvVerifier', bgvVerifierSchema);
