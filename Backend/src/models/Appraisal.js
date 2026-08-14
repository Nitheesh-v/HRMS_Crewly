// ⭐ Appraisal — one employee's record inside one cycle
import mongoose from 'mongoose';

const goalSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    kpi: { type: String, default: '', trim: true },   // measurable target, e.g. "ship 6 features"
    weight: { type: Number, default: 0, min: 0, max: 100 },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    note: { type: String, default: '' },
  },
  { _id: true }
);

const reviewSchema = new mongoose.Schema(
  {
    rating: { type: Number, min: 1, max: 5, default: null },
    feedback: { type: String, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: null },
  },
  { _id: false }
);

export const APPRAISAL_STATUS = ['GOALS', 'IN_PROGRESS', 'SELF_SUBMITTED', 'TL_DONE', 'MGR_DONE', 'CLOSED'];

const appraisalSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: 'PerformanceCycle', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    goals: { type: [goalSchema], default: [] },
    selfReview: {
      summary: { type: String, default: '' },
      rating: { type: Number, min: 1, max: 5, default: null },
      submittedAt: { type: Date, default: null },
    },
    tlReview: { type: reviewSchema, default: () => ({}) },
    mgrReview: { type: reviewSchema, default: () => ({}) },
    finalRating: { type: Number, default: null },
    status: { type: String, enum: APPRAISAL_STATUS, default: 'GOALS' },
  },
  { timestamps: true }
);

appraisalSchema.index({ companyId: 1, cycle: 1, user: 1 }, { unique: true });

export default mongoose.model('Appraisal', appraisalSchema);
export { appraisalSchema };