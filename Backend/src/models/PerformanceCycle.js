// 🎯 PerformanceCycle — one appraisal round (e.g. "H2 2026")
import mongoose from 'mongoose';

export const CYCLE_PHASES = ['GOAL_SETTING', 'ACTIVE', 'SELF_REVIEW', 'REVIEW', 'CLOSED'];

const performanceCycleSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    startDate: { type: String, default: '' }, // 'YYYY-MM-DD'
    endDate: { type: String, default: '' },
    status: { type: String, enum: CYCLE_PHASES, default: 'GOAL_SETTING', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('PerformanceCycle', performanceCycleSchema);
export { performanceCycleSchema };