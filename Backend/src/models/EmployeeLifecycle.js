// 🧬 EmployeeLifecycle — current stage + dates + append-only event timeline
// Parallel record (User model untouched). One per employee per company.
import mongoose from 'mongoose';

export const LIFECYCLE_STAGES = ['PRE_JOINING', 'ONBOARDING', 'PROBATION', 'CONFIRMED', 'NOTICE_PERIOD', 'EXITED', 'ALUMNI'];

export const LIFECYCLE_EVENTS = [
  'JOINED', 'ONBOARDING_STARTED', 'PROBATION_STARTED', 'PROBATION_EXTENDED', 'CONFIRMED',
  'PROMOTED', 'TRANSFERRED', 'NOTICE_STARTED', 'EXITED', 'FNF_COMPLETED', 'ALUMNI_MARKED', 'NOTE_ADDED',
];

const eventSchema = new mongoose.Schema(
  {
    type: { type: String, default: 'NOTE_ADDED' },
    title: { type: String, default: '' },
    note: { type: String, default: '' },
    fromStage: { type: String, default: '' },
    toStage: { type: String, default: '' },
    meta: { type: Object, default: {} },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const employeeLifecycleSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    stage: { type: String, enum: LIFECYCLE_STAGES, default: 'ONBOARDING', index: true },
    joinedOn: { type: Date, default: null },
    probationEndsOn: { type: Date, default: null },
    confirmedOn: { type: Date, default: null },
    noticeStartedOn: { type: Date, default: null },
    noticeEndsOn: { type: Date, default: null },
    exitedOn: { type: Date, default: null },
    alumniSince: { type: Date, default: null },
    events: { type: [eventSchema], default: [] },
  },
  { timestamps: true }
);

employeeLifecycleSchema.index({ companyId: 1, user: 1 }, { unique: true });

export default mongoose.model('EmployeeLifecycle', employeeLifecycleSchema);
export { employeeLifecycleSchema };