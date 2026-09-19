import mongoose from 'mongoose';

export const TASK_STATUS = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'BLOCKED'];
export const TASK_PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const commentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, default: 'file' },
    url: { type: String, default: '' }, // '' for 32.8 private rows
    publicId: { type: String, default: null },
    resourceType: { type: String, default: 'raw' },
    size: { type: Number, default: 0 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Phase 32.8 — private storage reference for NEW attachments (see
    // models/Document.js note). Delivery:
    // GET /api/tasks/:id/attachments/:attachmentId/file (task-visibility
    // gated). Keys inside subdocuments are select:false too.
    storageProvider: { type: String, default: '' },
    storageKey: { type: String, default: '', select: false },
  },
  { timestamps: true }
);

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true, alias: 'companyId' },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    priority: { type: String, enum: TASK_PRIORITY, default: 'MEDIUM' },
    status: { type: String, enum: TASK_STATUS, default: 'TODO', index: true },
    dueDate: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewNote: { type: String, default: '' },
    comments: [commentSchema],
    attachments: [attachmentSchema],
  },
  { timestamps: true }
);

taskSchema.index({ company: 1, status: 1 });

const Task = mongoose.model('Task', taskSchema);
export default Task;