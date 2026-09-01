// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — COMPLIANCE CALENDAR TASK (§19)
//
//  §19 calls the calendar "a tracking tool only". It is not a second source
//  of truth about whether a return was filed — StatutoryReport.status is.
//
//  This row exists so Finance can tick a filing off the calendar without
//  having to move the report's status, and so the reminder job can tell
//  "already handled" from "nobody has looked at it yet". Marking a report
//  FILED completes the matching task automatically.
//
//  The due date itself is NEVER stored from the client: it is computed by
//  statutoryRules.statutoryDueDate from the payroll month and the company's
//  financial-year start, so it cannot drift from the calendar that renders
//  it.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { STATUTORY_TYPES } from '../services/payroll/statutoryRules.js';

const { Schema } = mongoose;

const complianceCalendarTaskSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    month: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
    },

    type: { type: String, enum: STATUTORY_TYPES, required: true },

    // Derived, never accepted from a request — see the header.
    dueDate: { type: String, trim: true, default: '' },

    status: { type: String, enum: ['PENDING', 'DONE'], default: 'PENDING', index: true },

    completedAt: { type: Date, default: null },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    completedByName: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, maxlength: 300, default: '' },

    lastRemindedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

complianceCalendarTaskSchema.index({ companyId: 1, month: 1, type: 1 }, { unique: true });
complianceCalendarTaskSchema.index({ companyId: 1, dueDate: 1, status: 1 });

const ComplianceCalendarTask =
  mongoose.models.ComplianceCalendarTask ||
  mongoose.model('ComplianceCalendarTask', complianceCalendarTaskSchema);

export default ComplianceCalendarTask;
