import mongoose from 'mongoose';

export const INVOICE_STATUS = [
  'DRAFT',
  'OPEN',
  'PAID',
  'FAILED',
  'VOID',
  'REFUNDED',
];

const invoiceSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      default: null,
    },

    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      default: null,
    },

    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    plan: {
      type: String,
      enum: ['BASIC', 'PRO', 'ENTERPRISE'],
      required: true,
    },

    billingCycle: {
      type: String,
      enum: ['MONTHLY', 'YEARLY'],
      default: 'MONTHLY',
    },

    subtotal: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },

    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
    },

    status: {
      type: String,
      enum: INVOICE_STATUS,
      default: 'OPEN',
      index: true,
    },

    billingPeriod: {
      start: {
        type: Date,
        default: null,
      },

      end: {
        type: Date,
        default: null,
      },
    },

    paymentStatus: {
      type: String,
      enum: [
        'PENDING',
        'PAID',
        'FAILED',
        'REFUNDED',
      ],
      default: 'PENDING',
      index: true,
    },

    paymentReference: {
      type: String,
      default: '',
    },

    dueDate: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    gatewayReference: { type: String, default: '' },

    notes: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true }
);

invoiceSchema.index({
  companyId: 1,
  createdAt: -1,
});

invoiceSchema.index({
  status: 1,
  dueDate: 1,
});

export default mongoose.model('Invoice', invoiceSchema);
export { invoiceSchema };