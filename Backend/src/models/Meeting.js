import mongoose from 'mongoose';

export const MEETING_TYPES = ['COMPANY', 'DEPARTMENT', 'TEAM', 'PRIVATE'];
export const RECURRENCE = ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'];

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true, alias: 'companyId' },
    type: { type: String, enum: MEETING_TYPES, default: 'PRIVATE', index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true },
    link: { type: String, default: '' },
    recurrence: { type: String, enum: RECURRENCE, default: 'NONE' },
    recurrenceEnd: { type: Date, default: null },
    reminderMinutes: { type: Number, default: 15 },
    reminderSent: { type: Boolean, default: false },
    status: { type: String, enum: ['SCHEDULED', 'CANCELLED'], default: 'SCHEDULED', index: true },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },
  },
  { timestamps: true }
);

meetingSchema.index({ company: 1, startAt: 1 });

const Meeting = mongoose.model('Meeting', meetingSchema);
export default Meeting;