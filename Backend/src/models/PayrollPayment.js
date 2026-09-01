// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.8 — EMPLOYEE SALARY PAYMENT (§9)
//
//  One row per employee transaction inside a batch. The net salary is copied
//  from the 29.6 snapshot, never recomputed here.
//
//  SECURITY (§23) — the account number is an ENCRYPTED blob (AES-256-GCM,
//  same helper 29.4 uses) and is `select: false`, so it is never returned by
//  accident. Screens and JSON responses read `accountNumberMasked`. The only
//  code that ever decrypts it is the bank-file builder.
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const { Schema } = mongoose;

const bankSnapshotSchema = new Schema(
  {
    bankName: { type: String, trim: true, default: '' },
    accountHolderName: { type: String, trim: true, default: '' },
    ifsc: { type: String, trim: true, default: '' },
    accountNumberMasked: { type: String, trim: true, default: '' },
    accountNumberLast4: { type: String, trim: true, maxlength: 4, default: '' },
    // Encrypted copy of the profile value, taken when the batch was created so
    // the file stays reproducible even if the profile changes later.
    accountNumber: { type: String, trim: true, default: '', select: false },
  },
  { _id: false },
);

const payrollPaymentSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    month: { type: String, required: true, trim: true },

    batchId: {
      type: Schema.Types.ObjectId,
      ref: 'PayrollPaymentBatch',
      required: true,
      index: true,
    },

    employeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    employeeCode: { type: String, trim: true, default: '' },
    employeeName: { type: String, trim: true, default: '' },
    departmentName: { type: String, trim: true, default: '' },

    // §9 / §10 — the amount, copied from the approved snapshot.
    netSalary: { type: Number, default: 0 },

    // §11 — one reference per transaction, unique inside the company.
    paymentReference: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ['PENDING', 'PAID', 'FAILED'],
      default: 'PENDING',
      index: true,
    },

    // §14 — only set when status is FAILED.
    failureReason: { type: String, trim: true, default: '' },
    remarks: { type: String, trim: true, maxlength: 500, default: '' },

    paidAt: { type: Date, default: null },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    markedAt: { type: Date, default: null },
    markedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    bank: { type: bankSnapshotSchema, default: () => ({}) },

    // The snapshot this payment was priced from (§19 immutability).
    resultVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

// §11 — a reference identifies one transaction and must never repeat.
payrollPaymentSchema.index({ companyId: 1, paymentReference: 1 }, { unique: true });
payrollPaymentSchema.index({ companyId: 1, month: 1 });
payrollPaymentSchema.index({ batchId: 1, status: 1 });

const PayrollPayment = mongoose.model('PayrollPayment', payrollPaymentSchema);

export default PayrollPayment;
