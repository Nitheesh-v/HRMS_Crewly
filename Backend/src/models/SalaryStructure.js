import { Schema, model } from 'mongoose';

// Per-employee monthly salary setup (managed by HR / Company Admin)
const salaryStructureSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    basic: { type: Number, default: 0, min: 0 },        // monthly ₹
    hra: { type: Number, default: 0, min: 0 },          // monthly ₹
    allowances: { type: Number, default: 0, min: 0 },   // monthly ₹
    pfPercent: { type: Number, default: 12, min: 0, max: 12 }, // employee PF share (0 = off)
    professionalTax: { type: Number, default: 0, min: 0 },     // fixed monthly ₹ (e.g. 200 TN)
  },
  { timestamps: true }
);

const SalaryStructure = model('SalaryStructure', salaryStructureSchema);
export default SalaryStructure;