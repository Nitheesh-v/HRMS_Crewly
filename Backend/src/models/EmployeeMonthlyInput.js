// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.5 — EMPLOYEE MONTHLY INPUT (§9 / §18)
//
//  Per company + month + employee. Holds:
//    · `auto`    — attendance / leave / shift figures imported READ-ONLY
//    · `entries` — HR's manual variable pay (§8), each categorized (§13)
//    · `status`  — PENDING / READY / ERROR / LOCKED
//
//  It never stores a computed salary — that is the 29.6 engine (§26).
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import {
  CLAIM_STATUSES,
  ENTRY_SOURCES,
  ENTRY_TYPES,
  INPUT_STATUSES,
} from '../services/payroll/monthlyInputRules.js';

const { Schema } = mongoose;

const entrySchema = new Schema(
  {
    entryId: { type: String, required: true },
    type: { type: String, enum: ENTRY_TYPES, required: true },
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, trim: true, maxlength: 200, default: '' },
    effectiveMonth: { type: String, trim: true, default: '' },
    claimDate: { type: String, trim: true, default: '' },
    remarks: { type: String, trim: true, maxlength: 300, default: '' },
    // §16 — a rejected claim never reaches payroll.
    claimStatus: { type: String, enum: CLAIM_STATUSES, default: 'APPROVED' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    source: { type: String, enum: ENTRY_SOURCES, default: 'MANUAL' },
  },
  { _id: false, timestamps: false },
);

// §7 — imported, never typed by HR.
const autoSchema = new Schema(
  {
    workingDays: { type: Number, default: 0 },
    presentDays: { type: Number, default: 0 },
    absentDays: { type: Number, default: 0 },
    lateMarks: { type: Number, default: 0 },
    halfDays: { type: Number, default: 0 },
    paidLeaveDays: { type: Number, default: 0 },
    // §7 — where the paid days came from (casual / sick / earned / other).
    leaveBreakdown: {
      type: new Schema(
        {
          CASUAL: { type: Number, default: 0 },
          SICK: { type: Number, default: 0 },
          EARNED: { type: Number, default: 0 },
          OTHER: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    lopDays: { type: Number, default: 0 },
    lopHours: { type: Number, default: 0 }, // §14 — future hourly LOP
    lopSource: { type: String, default: 'ATTENDANCE' },
    // §14 — the leave records behind the LOP days, so the UI can point at them.
    lopLeaveIds: { type: [String], default: [] },
    otMinutes: { type: Number, default: 0 },
    otHours: { type: Number, default: 0 },
    // §15 — a READ of 29.1 shown as a preview. No amount is ever stored here.
    otPolicy: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          basis: { type: String, default: 'HOURLY' },
          multiplier: { type: Number, default: 1 },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    nightShiftCount: { type: Number, default: 0 },
    weekendShiftCount: { type: Number, default: 0 },
    holidayShiftCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const employeeMonthlyInputSchema = new Schema(
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
    periodId: { type: Schema.Types.ObjectId, ref: 'PayrollPeriod', default: null },
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },

    auto: { type: autoSchema, default: () => ({}) },
    entries: { type: [entrySchema], default: [] },

    // §19 — last validation run.
    issues: { type: [String], default: [] },
    status: { type: String, enum: INPUT_STATUSES, default: 'PENDING', index: true },

    remarks: { type: String, trim: true, maxlength: 500, default: '' },
    lockedAt: { type: Date, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

employeeMonthlyInputSchema.index({ companyId: 1, month: 1, employeeId: 1 }, { unique: true });
employeeMonthlyInputSchema.index({ companyId: 1, month: 1, status: 1 });

const EmployeeMonthlyInput =
  mongoose.models.EmployeeMonthlyInput ||
  mongoose.model('EmployeeMonthlyInput', employeeMonthlyInputSchema);

export default EmployeeMonthlyInput;
