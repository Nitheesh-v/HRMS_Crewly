import { Schema, model } from 'mongoose';
import { LEAVE_TYPES, LEAVE_STATUS } from '../utils/constants.js';

const leaveSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.keys(LEAVE_TYPES), required: true },
    startDate: { type: String, required: true }, // 'YYYY-MM-DD'
    endDate: { type: String, required: true },   // 'YYYY-MM-DD'
    days: { type: Number, required: true },      // working days (Sat/Sun excluded)
    reason: { type: String, required: true, trim: true, maxlength: 300 },

    status: { type: String, enum: LEAVE_STATUS, default: 'PENDING', index: true },
    approver: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approverNote: { type: String, trim: true, maxlength: 300 },
    decidedAt: { type: Date },
  },
  { timestamps: true }
);

leaveSchema.index({ companyId: 1, status: 1 });

const Leave = model('Leave', leaveSchema);
export default Leave;