import mongoose from 'mongoose';

export const PROJECT_STATUS = ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
export const PROJECT_PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true, alias: 'companyId' },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    teamLeads: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    priority: { type: String, enum: PROJECT_PRIORITY, default: 'MEDIUM' },
    status: { type: String, enum: PROJECT_STATUS, default: 'NOT_STARTED', index: true },
  },
  { timestamps: true }
);

projectSchema.index({ company: 1, status: 1 });

const Project = mongoose.model('Project', projectSchema);
export default Project;