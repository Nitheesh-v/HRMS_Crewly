// ─────────────────────────────────────────────────────────────
// Audit log — written automatically by the auditTrail middleware
// for every non-GET API call. createdAt has a TTL index: MongoDB
// auto-deletes entries older than 180 days (production hygiene).
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '' },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true },   // friendly label, e.g. "Created a user"
    method: { type: String, required: true },
    path: { type: String, required: true },
    statusCode: { type: Number, default: 200 },
    ip: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, expires: 180 * 24 * 60 * 60 }, // TTL 180 days
  },
  { versionKey: false }
);

export default mongoose.model('AuditLog', auditLogSchema);