import mongoose from 'mongoose';

const { Schema } = mongoose;

export const DAY_KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const workScheduleSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    workingDays: { type: [String], default: ['MON', 'TUE', 'WED', 'THU', 'FRI'] },
    startTime: { type: String, default: '09:00' }, // HH:mm
    endTime: { type: String, default: '18:00' },
    breakMinutes: { type: Number, default: 60 },
    graceMinutes: { type: Number, default: 10 },
    minWorkingHours: { type: Number, default: 8 },
    halfDayHours: { type: Number, default: 4 },
    overtimeEligible: { type: Boolean, default: false },
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
    effectiveFrom: { type: Date, default: () => new Date() },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const WorkSchedule = mongoose.model('WorkSchedule', workScheduleSchema);
export default WorkSchedule;
export { workScheduleSchema };