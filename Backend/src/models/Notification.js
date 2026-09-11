// ─────────────────────────────────────────────────────────────
// In-app notification — the 🔔 bell feed. readAt null = unread.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, default: 'SYSTEM' }, // USER | EXIT | BILLING | LEAVE | SYSTEM
    title: { type: String, required: true, maxlength: 120 },
    message: { type: String, default: '', maxlength: 300 },
    link: { type: String, default: '' },       // frontend route, e.g. /app/payroll
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Perf: exact filter+sort support (no equivalent compound existed).
// - { user, readAt } → unreadCount + markAllRead filter { user, readAt: null }.
// - { user, createdAt } → myNotifications find({ user }).sort(-createdAt).limit(20).
notificationSchema.index({ user: 1, readAt: 1 });
notificationSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);