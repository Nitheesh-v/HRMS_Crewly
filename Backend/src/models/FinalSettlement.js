// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT (F&F)
//
//  One document per employee exit. It is the employee's LAST payroll record
//  and the only place the Full & Final amount is defined.
//
//  TENANT ISOLATION (§3 / §24)
//    companyId leads every index and is only ever taken from req.companyId.
//    One settlement per employee per resignation — a second settlement cannot
//    be opened for an exit that already has one.
//
//  §6 — the exit information is COPIED here from the Resignation module, not
//  linked and re-read: a settlement signed off in March must still show the
//  last working day that was in force in March.
//
//  IMMUTABILITY (§14)
//    CLOSED is terminal. The only transition out is an audited REOPEN, and
//    every status change appends to `history` — nothing is overwritten.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { SETTLEMENT_STATUSES } from '../services/payroll/fnfRules.js';

const { Schema } = mongoose;

const exitSchema = new Schema(
  {
    // §6 — every field here comes from the existing Exit module.
    resignationId: { type: Schema.Types.ObjectId, ref: 'Resignation', default: null },
    employeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    resignationDate: { type: String, default: '' },
    lastWorkingDate: { type: String, default: '' },
    reason: { type: String, default: '' },
    exitReason: { type: String, default: '' },
    noticePeriodDays: { type: Number, default: 60 },
    servedDays: { type: Number, default: 0 },
    // §12 — COMPLETED | BUYOUT | WAIVED.
    noticeDecision: { type: String, enum: ['COMPLETED', 'BUYOUT', 'WAIVED'], default: 'COMPLETED' },
    joiningDate: { type: String, default: '' },
  },
  { _id: false },
);

const earningsSchema = new Schema(
  {
    // §7 — the prorated salary, with the arithmetic that produced it.
    pendingSalary: {
      monthlyGross: { type: Number, default: 0 },
      workingDays: { type: Number, default: 0 },
      payableDays: { type: Number, default: 0 },
      dailyRate: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
    },
    // §8 — leave encashment, shown transparently.
    leaveEncashment: {
      leaveType: { type: String, default: 'EARNED' },
      unusedDays: { type: Number, default: 0 },
      encashedDays: { type: Number, default: 0 },
      capped: { type: Boolean, default: false },
      maxDays: { type: Number, default: 30 },
      dailyRate: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
    },
    // §10 / §11 — gratuity payable on exit.
    gratuity: {
      eligible: { type: Boolean, default: false },
      yearsOfService: { type: Number, default: 0 },
      creditedYears: { type: Number, default: 0 },
      monthlyBasic: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
      reason: { type: String, default: '' },
    },
    // §10 — the configurable additional payables.
    additional: { type: Schema.Types.Mixed, default: [] },
  },
  { _id: false },
);

const recoveriesSchema = new Schema(
  {
    // §9 / §12 — the notice recovery is computed, the rest are entered.
    notice: {
      decision: { type: String, default: 'COMPLETED' },
      noticePeriodDays: { type: Number, default: 0 },
      servedDays: { type: Number, default: 0 },
      shortfallDays: { type: Number, default: 0 },
      dailyRate: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
      waived: { type: Boolean, default: false },
      note: { type: String, default: '' },
    },
    items: { type: Schema.Types.Mixed, default: [] },
  },
  { _id: false },
);

// §13 — assets are read from the Exit/Asset module and only the SUMMARY is
// kept: Crewly never manages assets here, it records what was outstanding at
// the moment the settlement was calculated.
const assetSchema = new Schema(
  {
    assetId: { type: String, default: '' },
    name: { type: String, default: '' },
    category: { type: String, default: '' },
    status: { type: String, default: 'PENDING' }, // RETURNED | PENDING | DAMAGED
  },
  { _id: false },
);

const historySchema = new Schema(
  {
    status: { type: String, default: '' },
    previousStatus: { type: String, default: '' },
    remarks: { type: String, default: '' },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    at: { type: Date, default: null },
  },
  { _id: false },
);

const finalSettlementSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // §17 — a permanent, sequential settlement number.
    settlementNumber: { type: String, required: true, trim: true, index: true },
    sequence: { type: Number, default: 1 },

    // §3 — one company, one payroll month, one financial year.
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    financialYear: { type: String, trim: true, default: '' },

    status: {
      type: String,
      enum: SETTLEMENT_STATUSES,
      default: 'DRAFT',
      index: true,
    },

    // §6 — frozen copies, never re-read from the Exit module afterwards.
    exit: { type: exitSchema, default: () => ({}) },

    earnings: { type: earningsSchema, default: () => ({}) },
    recoveries: { type: recoveriesSchema, default: () => ({}) },

    // §11 — the Full & Final amount lives here and nowhere else.
    totals: { type: Schema.Types.Mixed, default: null },

    // §15 — the HR review checklist.
    checklist: {
      attendanceVerified: { type: Boolean, default: false },
      leaveVerified: { type: Boolean, default: false },
      assetClearanceCompleted: { type: Boolean, default: false },
      noticeDecisionCompleted: { type: Boolean, default: false },
    },

    // §13 — what the employee still holds.
    assets: { type: [assetSchema], default: [] },
    // §8 — the leave balance the encashment was computed from.
    leaveBalance: { type: Schema.Types.Mixed, default: null },

    // §16 — Finance's decision, with remarks.
    approval: {
      hrReviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      hrReviewedByName: { type: String, default: '' },
      hrReviewedAt: { type: Date, default: null },
      financeBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      financeByName: { type: String, default: '' },
      financeAt: { type: Date, default: null },
      financeRemarks: { type: String, default: '' },
    },

    // §5 — payment closes the loop.
    payment: {
      paidAt: { type: String, default: '' },
      reference: { type: String, default: '' },
      method: { type: String, default: 'Bank Transfer' },
      paidBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      paidByName: { type: String, default: '' },
    },

    // §17 / §21 — the generated F&F statement.
    statement: {
      fileId: { type: Schema.Types.ObjectId, ref: 'FinalSettlementFile', default: null },
      generatedAt: { type: Date, default: null },
      downloadCount: { type: Number, default: 0 },
      lastDownloadedAt: { type: Date, default: null },
    },

    // §23 — every status change, in order.
    history: { type: [historySchema], default: [] },

    calculatedAt: { type: Date, default: null },
    calculatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    calculatedByName: { type: String, default: '' },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

finalSettlementSchema.index({ companyId: 1, month: 1, status: 1 });
finalSettlementSchema.index({ companyId: 1, employeeId: 1 });
finalSettlementSchema.index({ companyId: 1, settlementNumber: 1 }, { unique: true });
// One settlement per exit (§5) — a resignation cannot be settled twice.
finalSettlementSchema.index(
  { companyId: 1, 'exit.resignationId': 1 },
  { unique: true, partialFilterExpression: { 'exit.resignationId': { $type: 'objectId' } } },
);

const FinalSettlement =
  mongoose.models.FinalSettlement || mongoose.model('FinalSettlement', finalSettlementSchema);

export default FinalSettlement;
