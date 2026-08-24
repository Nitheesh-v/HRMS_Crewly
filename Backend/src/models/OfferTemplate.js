import mongoose from 'mongoose';

const offerTemplateSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    content: { type: String, required: true, maxlength: 8000 },
    variables: [{ type: String, trim: true }],
    version: { type: Number, default: 1, min: 1 },
    isActive: { type: Boolean, default: true, index: true },
    isDefault: { type: Boolean, default: false },
    defaultKey: { type: String, default: null, select: false },
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

offerTemplateSchema.index({ companyId: 1, name: 1 }, { unique: true });
offerTemplateSchema.index(
  { companyId: 1, defaultKey: 1 },
  {
    unique: true,
    partialFilterExpression: { defaultKey: 'DEFAULT' },
  }
);

offerTemplateSchema.pre('validate', function setDefaultKey() {
  this.defaultKey = this.isActive && this.isDefault ? 'DEFAULT' : null;
});

export default mongoose.model('OfferTemplate', offerTemplateSchema);
