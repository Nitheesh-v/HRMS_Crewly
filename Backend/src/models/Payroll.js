import { Schema, model } from 'mongoose';

// One document per employee per month ('YYYY-MM'), unique enforced
const payrollSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    month: { type: String, required: true },

    workingDays: { type: Number, default: 0 },
    presentDays: { type: Number, default: 0 },   // HALF_DAY counts as 0.5
    paidLeaveDays: { type: Number, default: 0 }, // approved leaves (paid)
    absentDays: { type: Number, default: 0 },    // loss-of-pay days

    earnings: {
      basic: { type: Number, default: 0 },
      hra: { type: Number, default: 0 },
      allowances: { type: Number, default: 0 },
      gross: { type: Number, default: 0 },
    },
    deductions: {
      pf: { type: Number, default: 0 },
      professionalTax: { type: Number, default: 0 },
      attendanceDeduction: { type: Number, default: 0 }, // LOP deduction
      total: { type: Number, default: 0 },
    },
    netPay: { type: Number, default: 0 },

    status: { type: String, enum: ['GENERATED', 'PAID'], default: 'GENERATED' },
    generatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

payrollSchema.index({ user: 1, month: 1 }, { unique: true });
payrollSchema.index({ companyId: 1, month: 1 });

const Payroll = model('Payroll', payrollSchema);
export default Payroll;