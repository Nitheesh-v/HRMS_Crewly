// ─────────────────────────────────────────────────────────────
// In-app notification — the 🔔 bell feed. readAt null = unread.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, default: 'SYSTEM' }, // USER | EXIT | BILLING | LEAVE | SYSTEM | ATTENDANCE
    title: { type: String, required: true, maxlength: 120 },
    message: { type: String, default: '', maxlength: 300 },
    link: { type: String, default: '' },       // frontend route, e.g. /app/payroll
    // 31.13: idempotency key for worker-delivered reminders. Null for
    // legacy/sync notifications; unique per company when present.
    eventKey: { type: String, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Perf: exact filter+sort support (no equivalent compound existed).
// - { user, readAt } → unreadCount + markAllRead filter { user, readAt: null }.
// - { user, createdAt } → myNotifications find({ user }).sort(-createdAt).limit(20).
notificationSchema.index({ user: 1, readAt: 1 });
notificationSchema.index({ user: 1, createdAt: -1 });

// 31.13: dedupe — one durable record per logical reminder event.
// Partial: legacy docs (eventKey null) are untouched.
notificationSchema.index(
  { companyId: 1, eventKey: 1 },
  { unique: true, partialFilterExpression: { eventKey: { $ne: null } } }
);

export default mongoose.model('Notification', notificationSchema);