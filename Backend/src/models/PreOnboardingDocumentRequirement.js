import mongoose from 'mongoose';

export const PRE_ONBOARDING_DOC_CATEGORIES = [
  'IDENTITY',
  'ADDRESS',
  'EDUCATION',
  'EMPLOYMENT',
  'FINANCE',
  'TAX',
  'PHOTO',
  'OTHER',
];

export const PRE_ONBOARDING_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
];

const preOnboardingDocumentRequirementSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 40,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 1000,
    },
    category: {
      type: String,
      enum: PRE_ONBOARDING_DOC_CATEGORIES,
      default: 'OTHER',
      index: true,
    },
    required: { type: Boolean, default: true },
    active: { type: Boolean, default: true, index: true },
    allowedFileTypes: {
      type: [String],
      default: () => [...PRE_ONBOARDING_ALLOWED_MIME_TYPES],
      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length > 0 &&
          values.every((value) => PRE_ONBOARDING_ALLOWED_MIME_TYPES.includes(value)),
        message: 'One or more allowed file types are not supported',
      },
    },
    maxFileSize: {
      type: Number,
      default: 5 * 1024 * 1024,
      min: 50 * 1024,
      max: 10 * 1024 * 1024,
    },
    instructions: {
      type: String,
      default: '',
      trim: true,
      maxlength: 2000,
    },
    requiresExpiryDate: { type: Boolean, default: false },
    requiresDocumentNumber: { type: Boolean, default: false },
    displayOrder: { type: Number, default: 100, min: 0, max: 10000 },
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

preOnboardingDocumentRequirementSchema.index(
  { companyId: 1, code: 1 },
  { unique: true }
);
preOnboardingDocumentRequirementSchema.index({
  companyId: 1,
  active: 1,
  displayOrder: 1,
});

export default mongoose.model(
  'PreOnboardingDocumentRequirement',
  preOnboardingDocumentRequirementSchema
);
