// ─────────────────────────────────────────────────────────────
// Payment — one record per checkout attempt (Razorpay or TEST).
// PENDING → SUCCESS (subscription upgraded) or FAILED.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    payer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    plan: { type: String, enum: ['BASIC', 'PRO', 'ENTERPRISE'], required: true },
    months: { type: Number, enum: [1, 12], default: 1 },
    amount: { type: Number, required: true },          // ₹ (rupees, not paise)
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'PENDING' },
    orderId: { type: String, default: '' },            // gateway order id (or mock id)
    gatewayPaymentId: { type: String, default: '' },   // gateway payment id
    gateway: { type: String, default: 'razorpay' },    // 'razorpay' | 'mock'
  },
  { timestamps: true }
);

export default mongoose.model('Payment', paymentSchema);