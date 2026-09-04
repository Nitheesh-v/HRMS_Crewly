import mongoose from 'mongoose';

export const BGV_TRIGGER_STAGES = ['PRE_OFFER', 'POST_OFFER', 'PRE_JOINING'];

const backgroundVerificationSettingsSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    enabled: { type: Boolean, default: true },
    triggerStage: {
      type: String,
      enum: BGV_TRIGGER_STAGES,
      default: 'PRE_JOINING',
    },
    provider: {
      type: String,
      enum: ['INTERNAL'],
      default: 'INTERNAL',
    },
    // Phase 30.1 — per-check-type framework configuration for the
    // Verifier Workbench. Shape: { IDENTITY: { required, slaDays }, ... }.
    // Missing types default to required: true with a 10-day SLA (the
    // pure rules module applies the defaults; Mixed keeps lean reads
    // plain-object and the service whitelists keys on update).
    checkConfig: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Field-visit geo evidence may appear in AUDIT rows (reduced
    // precision) by default; tenants may turn it off.
    fieldVisitGeoInAudit: { type: Boolean, default: true },
    consentRequired: { type: Boolean, default: true },
    bgvRequiredBeforeConversion: { type: Boolean, default: false },
    bgvRequiredBeforeJoining: { type: Boolean, default: false },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

export default mongoose.model(
  'BackgroundVerificationSettings',
  backgroundVerificationSettingsSchema
);
