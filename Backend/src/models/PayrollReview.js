// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.7 — PAYROLL REVIEW (§6 / §12 / §14 / §15)
//
//  One document per company + payroll month. It owns the REVIEW lifecycle,
//  not the numbers: those live in the 29.6 PayrollResult snapshots, which
//  this phase reads and never recalculates (§21).
//
//  What lives here:
//    · status          — the §6 state machine
//    · checklist       — the §11 HR review checklist
//    · employeeReviews — per-employee review state (§8 / §18)
//    · remarks         — the §15 chronological discussion (append-only)
//    · approvals       — who locked, submitted, approved, rejected, reopened
//
//  Separation of duties is enforced in the service + routes, never assumed
//  from a role name (§4).
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { REVIEW_STATUSES } from '../services/payroll/payrollReviewRules.js';

const { Schema } = mongoose;

const remarkSchema = new Schema(
  {
    // §15 — who said it, in which capacity, and when. Never overwritten.
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    role: { type: String, trim: true, maxlength: 60, default: '' },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    authorName: { type: String, trim: true, default: '' },
    // 'HR' | 'FINANCE' | 'SYSTEM'
    channel: { type: String, trim: true, default: 'HR' },
    statusAtTime: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const employeeReviewSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // 'PENDING' | 'REVIEWED'
    state: { type: String, enum: ['PENDING', 'REVIEWED'], default: 'PENDING' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    // §18 — verification ticks that never touch a salary value.
    bankVerified: { type: Boolean, default: false },
    panVerified: { type: Boolean, default: false },
    // §10 — the validation result captured at review time.
    // (`errors` is a reserved Mongoose document property — hence `issues`.)
    issues: { type: Schema.Types.Mixed, default: [] },
    note: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { _id: false },
);

const payrollReviewSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },

    status: {
      type: String,
      enum: REVIEW_STATUSES,
      default: 'CALCULATED',
      index: true,
    },

    // The 29.6 run this review is looking at (snapshot version).
    runId: { type: Schema.Types.ObjectId, ref: 'PayrollRun', default: null },
    runVersion: { type: Number, default: 0 },

    // §11 — HR cannot lock until every box is ticked.
    checklist: { type: Schema.Types.Mixed, default: () => ({}) },

    // §8 / §18 — one row per employee in the reviewed run.
    employeeReviews: { type: [employeeReviewSchema], default: [] },

    // §15 — append-only discussion thread.
    remarks: { type: [remarkSchema], default: [] },

    // §12 / §13 / §14 — who did what, and why.
    lockedAt: { type: Date, default: null },
    lockedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, trim: true, maxlength: 1000, default: '' },
    reopenedAt: { type: Date, default: null },
    reopenedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reopenReason: { type: String, trim: true, maxlength: 1000, default: '' },

    // How many times this month has been locked (§13 — reopen leaves a trace).
    lockCount: { type: Number, default: 0 },

    // §7 / §16 — cached review KPIs, refreshed by the service.
    kpis: { type: Schema.Types.Mixed, default: null },
    summary: { type: Schema.Types.Mixed, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

payrollReviewSchema.index({ companyId: 1, month: 1 }, { unique: true });
payrollReviewSchema.index({ companyId: 1, status: 1 });

const PayrollReview =
  mongoose.models.PayrollReview || mongoose.model('PayrollReview', payrollReviewSchema);

export default PayrollReview;
