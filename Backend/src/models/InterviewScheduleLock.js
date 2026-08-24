import mongoose from 'mongoose';

const interviewScheduleLockSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      unique: true,
      index: true,
    },
    ownerToken: {
      type: String,
      required: true,
      maxlength: 100,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true, versionKey: false }
);

interviewScheduleLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('InterviewScheduleLock', interviewScheduleLockSchema);
