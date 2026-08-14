import mongoose from 'mongoose';

const { Schema } = mongoose;

// HISTORY IS SACRED — we never overwrite; we close (effectiveTo) + insert a new row.
const shiftAssignmentSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    shift: { type: Schema.Types.ObjectId, ref: 'Shift', required: true },
    schedule: { type: Schema.Types.ObjectId, ref: 'WorkSchedule', default: null },
    scope: { type: String, enum: ['EMPLOYEE', 'DEPARTMENT'], default: 'EMPLOYEE' },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    department: { type: Schema.Types.ObjectId, ref: 'Department', default: null, index: true },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null }, // null = currently active
    prevShift: { type: Schema.Types.ObjectId, ref: 'Shift', default: null },
    reason: { type: String, default: '' },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

shiftAssignmentSchema.index({ companyId: 1, user: 1, effectiveFrom: -1 });

const ShiftAssignment = mongoose.model('ShiftAssignment', shiftAssignmentSchema);
export default ShiftAssignment;
export { shiftAssignmentSchema };