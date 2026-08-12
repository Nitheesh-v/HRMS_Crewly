// ─────────────────────────────────────────────────────────────
// Subscription — one per company. Plan limits are enforced by
// userController (employee count) and tenantMiddleware (expiry).
// Plans: TRIAL → BASIC / PRO / ENTERPRISE (upgraded via billing).
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
    plan: { type: String, enum: ['TRIAL', 'BASIC', 'PRO', 'ENTERPRISE'], default: 'TRIAL' },
    status: { type: String, enum: ['ACTIVE', 'EXPIRING_SOON', 'EXPIRED'], default: 'ACTIVE' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    limits: {
      employees: { type: Number, default: 10 },
      storageMB: { type: Number, default: 512 },
    },
  },
  { timestamps: true }
);

export default mongoose.model('Subscription', subscriptionSchema);