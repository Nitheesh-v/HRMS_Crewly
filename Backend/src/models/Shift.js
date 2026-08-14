import mongoose from 'mongoose';

const { Schema } = mongoose;

export const SHIFT_TYPES = ['MORNING', 'GENERAL', 'EVENING', 'NIGHT', 'FLEXIBLE', 'CUSTOM'];

const shiftSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: SHIFT_TYPES, default: 'GENERAL' },
    startTime: { type: String, default: '09:00' },
    endTime: { type: String, default: '18:00' },
    breakMinutes: { type: Number, default: 60 },
    graceMinutes: { type: Number, default: 10 },
    overtimeEligible: { type: Boolean, default: false },
    overtimeRatePerHour: { type: Number, default: 0 }, // ₹/hr
    shiftAllowance: { type: Number, default: 0 },      // ₹/day
    nightAllowance: { type: Number, default: 0 },      // ₹/day for night shifts
    lateRule: {
      graceMinutes: { type: Number, default: 10 },
      maxLatePerMonth: { type: Number, default: 3 },
    },
    earlyCheckoutRule: {
      graceMinutes: { type: Number, default: 10 },
    },
    branch: { type: String, default: '', trim: true },
    departments: [{ type: Schema.Types.ObjectId, ref: 'Department' }],
    employees: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const Shift = mongoose.model('Shift', shiftSchema);
export default Shift;
export { shiftSchema };