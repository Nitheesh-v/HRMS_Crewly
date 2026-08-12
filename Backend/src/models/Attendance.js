import { Schema, model } from 'mongoose';

/*
 * ONE document per employee per day.
 * ABSENT is intentionally NOT stored — absence = no record for that working day.
 * (Computed at report time. Saves storage across thousands of tenants. 💡)
 */
const attendanceSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true }, // 'YYYY-MM-DD' company-local day
    punchIn: { type: Date },
    punchOut: { type: Date },
    workMinutes: { type: Number, default: 0 },
    status: { type: String, enum: ['PRESENT', 'LATE', 'HALF_DAY'], default: 'PRESENT' },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true }); // no double punch
attendanceSchema.index({ companyId: 1, date: 1 });              // fast daily company view

const Attendance = model('Attendance', attendanceSchema);
export default Attendance;