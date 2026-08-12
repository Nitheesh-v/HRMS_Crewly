// ─────────────────────────────────────────────────────────────
// Job posting — an open position published by HR.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'];
export const JOB_STATUS = ['OPEN', 'CLOSED'];

const jobPostingSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    title: { type: String, required: [true, 'Job title is required'], trim: true, minlength: 3, maxlength: 100 },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    location: { type: String, trim: true, maxlength: 80, default: 'On-site' },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'FULL_TIME' },
    openings: { type: Number, min: 1, max: 500, default: 1 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    status: { type: String, enum: JOB_STATUS, default: 'OPEN' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

export default mongoose.model('JobPosting', jobPostingSchema);