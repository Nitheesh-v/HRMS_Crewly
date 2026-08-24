import mongoose from 'mongoose';

const tenantSequenceSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    value: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

tenantSequenceSchema.index(
  { companyId: 1, key: 1 },
  { unique: true }
);

export default mongoose.model('TenantSequence', tenantSequenceSchema);
