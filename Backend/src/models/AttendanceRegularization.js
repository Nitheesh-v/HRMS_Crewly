import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────
// Phase 31.5 — AttendanceRegularization.
//
// Controlled attendance correction / exception explanation.
// CORE LAW: original AttendanceEvents are NEVER edited — an
// APPROVED request writes an overlay onto the daily Attendance
// projection (effective facts), leaving recorded punches intact.
//
// proposal: what the employee claims the effective facts are.
// originalSnapshot: recorded facts at submit (stays interpretable
// even if attendance evolves later). No PII beyond refs, never
// any geolocation.
// ─────────────────────────────────────────────────────────────

export const REGULARIZATION_TYPE = Object.freeze([
  'MISSED_CLOCK_IN',
  'MISSED_CLOCK_OUT',
  'CLOCK_IN_TIME_CORRECTION',
  'CLOCK_OUT_TIME_CORRECTION',
  'BREAK_CORRECTION',
  'WORK_MODE_CORRECTION',
  'LATE_EXPLANATION',
  'EARLY_EXIT_EXPLANATION',
  'SHORT_HOURS_EXPLANATION',
  'GEOFENCE_EXPLANATION',
]);

export const REGULARIZATION_STATUS = Object.freeze([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);

const breakInterval = new mongoose.Schema(
  {
    start: { type: Date, default: null },
    end: { type: Date, default: null },
  },
  { _id: false },
);

const regularizationSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Company-local attendance day ('YYYY-MM-DD').
    attendanceDate: { type: String, required: true },
    type: { type: String, enum: [...REGULARIZATION_TYPE], required: true },
    status: {
      type: String,
      enum: [...REGULARIZATION_STATUS],
      default: 'PENDING',
      index: true,
    },
    reason: { type: String, required: true, trim: true, maxlength: 300 },

    // Employee-proposed effective facts (only the fields relevant
    // to `type` are set; validated by the pure rules module).
    proposal: {
      correctedIn: { type: Date, default: null },
      correctedOut: { type: Date, default: null },
      breaks: { type: [breakInterval], default: undefined },
      workMode: { type: String, default: null },
    },

    // Recorded facts at submit time (read-only history anchor).
    originalSnapshot: {
      firstIn: { type: Date, default: null },
      lastOut: { type: Date, default: null },
      breaks: { type: [breakInterval], default: undefined },
      workMode: { type: String, default: null },
      workedMinutes: { type: Number, default: null },
      breakMinutes: { type: Number, default: null },
      status: { type: String, default: null },
      eventIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceEvent' }],
      policyExceptions: { type: [String], default: undefined },
    },

    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewReason: { type: String, default: null, trim: true, maxlength: 300 },
    decidedAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    // Set when the approved overlay has been written to the daily
    // projection (retry-safe application marker, §18).
    appliedAt: { type: Date, default: null },
    // True when HR/Admin approved a work-mode change without a
    // covering 31.4 request (audited human override).
    authorizationOverride: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Review queue: company's pending requests, oldest first.
regularizationSchema.index({ companyId: 1, status: 1, createdAt: 1 });
// Mine / duplicate / rebuild lookup: employee's day requests.
regularizationSchema.index({ companyId: 1, user: 1, attendanceDate: 1 });

const AttendanceRegularization = mongoose.model(
  'AttendanceRegularization',
  regularizationSchema,
);

export default AttendanceRegularization;
