// 🎯 PerformanceCycle — one appraisal round (e.g. "H2 2026")
import mongoose from 'mongoose';

export const CYCLE_PHASES = ['GOAL_SETTING', 'ACTIVE', 'SELF_REVIEW', 'REVIEW', 'CLOSED'];

// How the round is assessed. The three the product actually runs — a plain
// annual review, a 360 that also collects peer input, and a goal-check-in.
// Nothing here changes the scoring weights; it is a label the cycle carries so
// the round can be read back later without guessing.
export const CYCLE_METHODOLOGIES = ['STANDARD', 'THREE_SIXTY', 'OKR'];

const performanceCycleSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    startDate: { type: String, default: '' }, // 'YYYY-MM-DD'
    endDate: { type: String, default: '' },
    status: { type: String, enum: CYCLE_PHASES, default: 'GOAL_SETTING', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },

    /* The shape of the round. All optional: a cycle created before these
       existed is still valid, and the API never invents a date for one. */
    methodology: { type: String, enum: CYCLE_METHODOLOGIES, default: 'STANDARD' },
    selfReviewDueAt: { type: String, default: '' }, // 'YYYY-MM-DD'
    managerReviewDueAt: { type: String, default: '' },
    calibrationDueAt: { type: String, default: '' },

    /* Enrollment decisions taken at creation time and then true for the rest
       of the round — re-running enroll must not quietly pull in the people
       the admin deliberately left out. */
    excludeProbation: { type: Boolean, default: false },
    notifyParticipants: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('PerformanceCycle', performanceCycleSchema);
export { performanceCycleSchema };