// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.8 — PAYROLL PAYMENT BATCH (§6)
//
//  The parent record for every salary payment of one month. Created only from
//  an APPROVED payroll (§2 / §5) — the service enforces that, not the UI.
//
//  A batch is a PREPARATION record. Crewly never moves money: the batch
//  produces a file that finance uploads to their own bank portal (§1).
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const { Schema } = mongoose;

const excludedSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    employeeCode: { type: String, trim: true, default: '' },
    employeeName: { type: String, trim: true, default: '' },
    // §7 — why this employee is not in the file. Codes, never free text, so
    // the UI can explain them in the company's language.
    errors: { type: [String], default: [] },
    messages: { type: [String], default: [] },
  },
  { _id: false },
);

const payrollPaymentBatchSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    month: { type: String, required: true, trim: true }, // 2026-08
    // §6 — the cycle is copied from the 29.1 setup at creation time so a later
    // configuration change cannot rewrite payment history.
    cycle: { type: String, trim: true, default: '' },
    currency: { type: String, trim: true, maxlength: 3, default: 'INR' },

    // §6 — unique inside one company.
    batchNumber: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: [
        'DRAFT',
        'READY',
        'FILE_GENERATED',
        'DOWNLOADED',
        'PROCESSING',
        'PAID',
        'PARTIALLY_PAID',
        'FAILED',
        'CANCELLED',
      ],
      default: 'DRAFT',
      index: true,
    },

    paymentDate: { type: Date, default: null },

    // §16 — a retry batch points at the batch it is finishing, and counts up.
    sourceBatchId: { type: Schema.Types.ObjectId, ref: 'PayrollPaymentBatch', default: null },
    attempt: { type: Number, default: 1 },

    // §11 — the prefix is copied from 29.1 when the batch is created.
    paymentReferencePrefix: { type: String, trim: true, default: 'SAL' },

    // §6 — summary block. Denormalised so the list screen never recounts.
    summary: { type: Schema.Types.Mixed, default: {} },

    // §7 — employees excluded by validation, with the reason. They are never
    // written into the bank file.
    excluded: { type: [excludedSchema], default: [] },

    // §2 — proof the payroll was approved before money was prepared.
    approval: {
      reviewId: { type: Schema.Types.ObjectId, ref: 'PayrollReview', default: null },
      approvedAt: { type: Date, default: null },
      approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      runVersion: { type: Number, default: 1 },
    },

    // §13 — why finance cancelled or failed the whole batch.
    remarks: { type: String, trim: true, maxlength: 2000, default: '' },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// §6 — batch numbers are unique per company; one original batch per month.
payrollPaymentBatchSchema.index({ companyId: 1, batchNumber: 1 }, { unique: true });
payrollPaymentBatchSchema.index({ companyId: 1, month: 1 });
payrollPaymentBatchSchema.index({ companyId: 1, status: 1 });

const PayrollPaymentBatch = mongoose.model('PayrollPaymentBatch', payrollPaymentBatchSchema);

export default PayrollPaymentBatch;
