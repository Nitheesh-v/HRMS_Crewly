import mongoose from 'mongoose';

export const NOTIFY_CATEGORIES = [
  'LEAVE', 'TASK', 'PROJECT', 'MEETING', 'ANNOUNCEMENT',
  'DOCUMENT', 'PAYROLL', 'BILLING', 'SUPPORT', 'SYSTEM',
];

const prefSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, alias: 'companyId' },
    // missing key = ON (default). Only explicit false mutes.
    inapp: { type: Map, of: Boolean, default: {} },
    email: { type: Map, of: Boolean, default: {} },
  },
  { timestamps: true }
);

const NotificationPref = mongoose.model('NotificationPref', prefSchema);
export default NotificationPref;