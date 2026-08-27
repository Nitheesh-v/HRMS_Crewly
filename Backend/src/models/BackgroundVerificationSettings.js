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
