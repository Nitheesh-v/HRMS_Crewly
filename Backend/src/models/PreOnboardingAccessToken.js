import mongoose from 'mongoose';

const preOnboardingAccessTokenSchema = new mongoose.Schema(
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
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
      immutable: true,
    },
    capability: {
      type: String,
      enum: ['PRE_ONBOARDING_PORTAL'],
      default: 'PRE_ONBOARDING_PORTAL',
      immutable: true,
    },
    activeKey: { type: String, default: 'ACTIVE', select: false },
    expiresAt: { type: Date, required: true, index: true, immutable: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: '', maxlength: 200 },
    lastViewedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0, min: 0 },
    issuedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
  },
  { timestamps: true, versionKey: false }
);

preOnboardingAccessTokenSchema.index(
  { preOnboarding: 1, activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: 'ACTIVE' } }
);

preOnboardingAccessTokenSchema.pre('validate', function normalizeActiveKey() {
  this.activeKey = this.revokedAt ? null : 'ACTIVE';
});

export default mongoose.model(
  'PreOnboardingAccessToken',
  preOnboardingAccessTokenSchema
);
