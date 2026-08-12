import { Schema, model } from 'mongoose';

const departmentSchema = new Schema(
  {
    name: { type: String, required: [true, 'Department name is required'], trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 200 },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  },
  { timestamps: true }
);

// Department name unique WITHIN a company (multi-tenant rule)

departmentSchema.index({ name: 1, companyId: 1 }, { unique: true });

const Department = model('Department', departmentSchema);
export default Department;