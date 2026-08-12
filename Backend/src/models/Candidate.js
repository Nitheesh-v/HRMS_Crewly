// ─────────────────────────────────────────────────────────────
// Candidate — a person in the hiring pipeline of one job.
//   stage       : APPLIED → SCREENING → INTERVIEW → OFFER → HIRED / REJECTED
//   offerStatus : NONE → SENT → ACCEPTED / DECLINED
// Convert creates the employee User account and copies the link
// into convertedUser (prevents double conversion).
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

export const CANDIDATE_STAGES = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'];
export const OFFER_STATUS = ['NONE', 'SENT', 'ACCEPTED', 'DECLINED'];

const candidateSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPosting', required: true },
    name: { type: String, required: [true, 'Candidate name is required'], trim: true, minlength: 2, maxlength: 60 },
    email: { type: String, required: [true, 'Candidate email is required'], lowercase: true, trim: true },
    phone: { type: String, trim: true, maxlength: 15, default: '' },
    resumeLink: { type: String, trim: true, maxlength: 300, default: '' },
    stage: { type: String, enum: CANDIDATE_STAGES, default: 'APPLIED' },
    // Offer letter tracking
    offerStatus: { type: String, enum: OFFER_STATUS, default: 'NONE' },
    offerSalary: { type: Number, min: 0, default: 0 },          // monthly CTC in ₹
    offerJoiningDate: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    convertedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Same email can't be added twice to the SAME job
candidateSchema.index({ job: 1, email: 1 }, { unique: true });

export default mongoose.model('Candidate', candidateSchema);