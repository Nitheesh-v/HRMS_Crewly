import mongoose from 'mongoose';

export const BGV_CHECK_CATEGORIES = [
  'IDENTITY',
  'ADDRESS',
  'EDUCATION',
  'EMPLOYMENT',
  'REFERENCE',
  'CRIMINAL',
  'OTHER',
];

const backgroundVerificationCheckTypeSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 40,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 1000,
    },
    category: {
      type: String,
      enum: BGV_CHECK_CATEGORIES,
      default: 'OTHER',
      index: true,
    },
    required: { type: Boolean, default: true },
    active: { type: Boolean, default: true, index: true },
    displayOrder: { type: Number, default: 100, min: 0, max: 10000 },
    instructions: {
      type: String,
      default: '',
      trim: true,
      maxlength: 2000,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true, versionKey: false }
);

backgroundVerificationCheckTypeSchema.index(
  { companyId: 1, code: 1 },
  { unique: true }
);
backgroundVerificationCheckTypeSchema.index({
  companyId: 1,
  active: 1,
  displayOrder: 1,
});

export default mongoose.model(
  'BackgroundVerificationCheckType',
  backgroundVerificationCheckTypeSchema
);
