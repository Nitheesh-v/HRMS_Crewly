import mongoose from 'mongoose';

const { Schema } = mongoose;

// Coordination metadata only. Queue membership remains authoritative in HelpdeskQueue.
const helpdeskAuthorizationFenceSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
    },
    queueId: {
      type: Schema.Types.ObjectId,
      ref: 'HelpdeskQueue',
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    writeVersion: { type: Number, required: true, default: 0, min: 0, select: false },
  },
  { timestamps: true, versionKey: false },
);

helpdeskAuthorizationFenceSchema.index(
  { companyId: 1, queueId: 1, userId: 1 },
  { unique: true, name: 'helpdesk_authorization_fence_unique' },
);

export default mongoose.model('HelpdeskAuthorizationFence', helpdeskAuthorizationFenceSchema);
