// ─────────────────────────────────────────────────────────────
// Payment — one record per checkout attempt (Razorpay or TEST).
// PENDING → SUCCESS (subscription upgraded) or FAILED.
// ─────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    payer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    plan: {
      type: String,
      enum: ["BASIC", "PRO", "ENTERPRISE"],
      required: true,
    },
    months: { type: Number, enum: [1, 12], default: 1 },
    billingCycle: {
  type: String,
  enum: ['MONTHLY', 'YEARLY'],
  default: 'MONTHLY',
},

    couponCode: {
      type: String,
      default: '',
      uppercase: true,
      trim: true,
    },

    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    originalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    
    amount: { type: Number, required: true }, // ₹ (rupees, not paise)
    currency: { type: String, default: "INR" },
    status: {
      type: String,
enum: [
  'PENDING',
  'SUCCESS',
  'FAILED',
  'REFUNDED',
],
      default: "PENDING",
    },
    orderId: { type: String, default: "" }, // gateway order id (or mock id)
    gatewayPaymentId: { type: String, default: "" }, // gateway payment id
    gateway: { type: String, default: "razorpay" }, // 'razorpay' | 'mock'
    refundedAmount: {
  type: Number,
  default: 0,
},

refundedAt: {
  type: Date,
  default: null,
},

failureReason: {
  type: String,
  default: '',
},
  },
  { timestamps: true },
);


paymentSchema.index({
  companyId: 1,
  createdAt: -1,
});

paymentSchema.index({
  status: 1,
  createdAt: -1,
});
export default mongoose.model("Payment", paymentSchema);
