// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP (§6)
//
//  One row per company + employee + month. The `snapshot` sub-document is the
//  permanent financial record: it is written ONCE, from the immutable 29.6
//  payroll snapshot, and NEVER recomputed — not even when the PDF is
//  regenerated because the company moved office or changed its logo (§22).
//
//  The PDF is stored alongside it so a historical payslip can be re-downloaded
//  years later even if the company's details have changed since.
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const { Schema } = mongoose;

const lineSchema = new Schema(
  {
    name: { type: String, trim: true, default: '' },
    amount: { type: Number, default: 0 },
    code: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const snapshotSchema = new Schema(
  {
    company: {
      name: { type: String, default: '' },
      address: { type: String, default: '' },
      pan: { type: String, default: '' },
      tan: { type: String, default: '' },
      logoUrl: { type: String, default: '' },
    },
    employee: {
      employeeId: { type: String, default: '' },
      employeeCode: { type: String, trim: true, default: '' },
      name: { type: String, default: '' },
      department: { type: String, default: '' },
      designation: { type: String, default: '' },
      joiningDate: { type: Date, default: null },
      // §13 / §26 — masked at the source. The full number is never stored here.
      bankName: { type: String, default: '' },
      accountNumberMasked: { type: String, default: '' },
      uan: { type: String, default: '' },
      pan: { type: String, default: '' },
    },
    payroll: {
      month: { type: String, trim: true, default: '' },
      monthLabel: { type: String, default: '' },
      cycle: { type: String, default: 'MONTHLY' },
      paymentDate: { type: Date, default: null },
      payslipNumber: { type: String, trim: true, default: '' },
    },
    salary: {
      grossSalary: { type: Number, default: 0 },
      totalEarnings: { type: Number, default: 0 },
      totalReimbursements: { type: Number, default: 0 },
      totalDeductions: { type: Number, default: 0 },
      netSalary: { type: Number, default: 0 },
      totalEmployerContributions: { type: Number, default: 0 },
    },
    earnings: { type: [lineSchema], default: [] },
    variableEarnings: { type: [lineSchema], default: [] },
    reimbursements: { type: [lineSchema], default: [] },
    deductions: { type: [lineSchema], default: [] },
    employerContributions: { type: [lineSchema], default: [] },
    attendance: {
      workingDays: { type: Number, default: 0 },
      presentDays: { type: Number, default: 0 },
      paidDays: { type: Number, default: 0 },
      lopDays: { type: Number, default: 0 },
      overtimeHours: { type: Number, default: 0 },
    },
    payment: {
      paymentDate: { type: Date, default: null },
      method: { type: String, default: 'BANK_TRANSFER' },
      bankName: { type: String, default: '' },
      accountNumberMasked: { type: String, default: '' },
      reference: { type: String, default: '' },
    },
    generatedAt: { type: Date, default: null },
    snapshotVersion: { type: Number, default: 1 },
  },
  { _id: false },
);

const payslipSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },

    // §7 — unique inside the company, sequential, permanent, never reused.
    payslipNumber: { type: String, required: true, trim: true },
    sequence: { type: Number, default: 0 },

    // §21 — PENDING → GENERATED → EMAILED / DOWNLOADED, or FAILED.
    status: {
      type: String,
      enum: ['PENDING', 'GENERATED', 'EMAILED', 'DOWNLOADED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },

    // §6 — the frozen record. Never modified after creation.
    snapshot: { type: snapshotSchema, default: () => ({}) },

    // §2 — "Store PDF Snapshot": the rendered document, kept so history is
    // stable. `select: false` because it is the single largest field and is
    // only ever fetched by the download path.
    pdf: { type: Buffer, select: false, default: null },
    pdfBytes: { type: Number, default: 0 },
    pdfGeneratedAt: { type: Date, default: null },

    // §25 — delivery tracking.
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },
    emailedAt: { type: Date, default: null },
    emailedTo: { type: String, trim: true, default: '' },
    emailError: { type: String, default: '' },
    regeneratedCount: { type: Number, default: 0 },
    lastRegeneratedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },

    // §5 — proof of provenance: which payroll snapshot and which payment this
    // payslip was cut from.
    source: {
      payrollResultId: { type: Schema.Types.ObjectId, ref: 'PayrollResult', default: null },
      runVersion: { type: Number, default: 1 },
      paymentBatchId: { type: Schema.Types.ObjectId, ref: 'PayrollPaymentBatch', default: null },
      paymentId: { type: Schema.Types.ObjectId, ref: 'PayrollPayment', default: null },
    },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// One payslip per employee per month — regeneration UPDATES, it never inserts
// a second row for the same month.
payslipSchema.index({ companyId: 1, employeeId: 1, month: 1 }, { unique: true });
payslipSchema.index({ companyId: 1, month: 1, status: 1 });
payslipSchema.index({ companyId: 1, payslipNumber: 1 }, { unique: true });

const Payslip = mongoose.models.Payslip || mongoose.model('Payslip', payslipSchema);

export default Payslip;
