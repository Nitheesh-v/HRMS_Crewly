import mongoose from 'mongoose';

const { Schema } = mongoose;

export const HOLIDAY_TYPES = ['COMPANY', 'BRANCH', 'DEPARTMENT', 'OPTIONAL', 'PUBLIC'];

const holidaySchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: HOLIDAY_TYPES, default: 'COMPANY', index: true },
    date: { type: Date, required: true, index: true },
    endDate: { type: Date, default: null }, // multi-day holiday (normalized = date on write)
    description: { type: String, default: '' },
    branch: { type: String, default: '', trim: true }, // free-text (no Branch model yet)
    departments: [{ type: Schema.Types.ObjectId, ref: 'Department' }],
    applicableEmployees: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    isOptional: { type: Boolean, default: false },
    optionalPicks: [{ type: Schema.Types.ObjectId, ref: 'User' }], // employees who chose it
    recurringYearly: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

holidaySchema.pre('validate', function normalize() {
  if (!this.endDate) this.endDate = this.date;
  if (this.isOptional) this.type = 'OPTIONAL';
});
holidaySchema.index({ companyId: 1, date: 1, isActive: 1 });

const Holiday = mongoose.model('Holiday', holidaySchema);
export default Holiday;
export { holidaySchema };