// ─────────────────────────────────────────────────────────────
// Resignation — submitted by an employee, decided by HR.
// PENDING → APPROVED / REJECTED, or WITHDRAWN by the employee.
// On APPROVED the user account auto-deactivates after the
// last working date (lazy sweep in exitController — no cron).
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

export const RESIGNATION_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'];

const resignationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: [true, 'Reason is required'], trim: true, minlength: 10, maxlength: 500 },
    lastWorkingDate: { type: Date, required: [true, 'Last working date is required'] },
    status: { type: String, enum: RESIGNATION_STATUS, default: 'PENDING' },
    decisionNote: { type: String, trim: true, maxlength: 300, default: '' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('Resignation', resignationSchema);