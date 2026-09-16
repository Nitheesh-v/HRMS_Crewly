// ─────────────────────────────────────────────────────────────
// Phase 31.8 — tenant overtime / comp-off request.
//
// ONE live request (PENDING or APPROVED) per company + employee +
// day, enforced by a partial unique index — the Mongo-authoritative
// double-claim guard (§17). REJECTED/CANCELLED rows stay as history
// and free the day for a fresh request.
//
// Recorded/eligible minutes are backend-computed snapshots for
// historical reference; approved minutes are the human decision.
// TIME ONLY — no rate, no amount, ever. An APPROVED COMP_OFF row
// IS the comp-off entitlement (days) consumed by Leave balances;
// no second ledger exists.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const { Schema } = mongoose;

export const OVERTIME_REQUEST_TYPES = ['OVERTIME', 'COMP_OFF'];
export const OVERTIME_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
export const OVERTIME_CALENDAR_CONTEXTS = ['WORK_DAY', 'WEEKLY_OFF', 'HOLIDAY'];

const calendarSnapshotSchema = new Schema(
  {
    primary: { type: String, enum: OVERTIME_CALENDAR_CONTEXTS, default: 'WORK_DAY' },
    alsoWeeklyOff: { type: Boolean, default: false },
    holidayName: { type: String, default: null },
    holidayType: { type: String, default: null },
    nonWorkingDayWorked: { type: Boolean, default: false },
  },
  { _id: false },
);

const scheduleSnapshotSchema = new Schema(
  {
    scheduledStartAt: { type: Date, default: null },
    scheduledEndAt: { type: Date, default: null },
    scheduledMinutes: { type: Number, default: null },
    shiftName: { type: String, default: null },
    scheduleName: { type: String, default: null },
  },
  { _id: false },
);

const attendanceOvertimeRequestSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // The day's control row when one exists (eligibility always
    // needs recorded work facts, so this is set at submit).
    attendance: {
      type: Schema.Types.ObjectId,
      ref: 'Attendance',
      default: null,
    },
    attendanceDate: {
      type: String,
      required: true,
      trim: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'attendanceDate must be YYYY-MM-DD'],
    },
    type: {
      type: String,
      enum: OVERTIME_REQUEST_TYPES,
      required: true,
    },
    status: {
      type: String,
      enum: OVERTIME_REQUEST_STATUSES,
      default: 'PENDING',
      index: true,
    },
    // Backend-computed at submit (snapshot for history).
    recordedMinutes: { type: Number, default: 0, min: 0 },
    eligibleMinutes: { type: Number, default: 0, min: 0 },
    // Employee's ask (<= eligible, enforced backend-side).
    requestedMinutes: { type: Number, required: true, min: 1 },
    // Reviewer's decision (<= requested/eligible, set on approve).
    approvedMinutes: { type: Number, default: null, min: 1 },
    // COMP_OFF approvals only: whole days credited (>= 1).
    compOffDays: { type: Number, default: null, min: 1 },
    // 31.7 calendar meaning at decision time (Weekly-Off/Holiday
    // context is never lost after approval).
    calendar: { type: calendarSnapshotSchema, default: () => ({}) },
    // Schedule the extra was measured against (null minutes for
    // weekly-off/holiday days, which need no schedule).
    schedule: { type: scheduleSnapshotSchema, default: () => ({}) },
    // Policy that produced the eligibility (history stays
    // interpretable after later policy versions).
    policyId: { type: Schema.Types.ObjectId, ref: 'AttendancePolicy', default: null },
    policyVersion: { type: Number, default: null },
    minimumExtraMinutes: { type: Number, default: null },
    compOffMinutesPerDay: { type: Number, default: null },

    reason: { type: String, required: true, trim: true, maxlength: 300 },
    reviewReason: { type: String, trim: true, maxlength: 300, default: '' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Double-claim guard: at most one live request per day. Concurrent
// submits race here (11000 → conflict), never in Redis.
attendanceOvertimeRequestSchema.index(
  { companyId: 1, user: 1, attendanceDate: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['PENDING', 'APPROVED'] } } },
);
attendanceOvertimeRequestSchema.index({ companyId: 1, status: 1, createdAt: 1 });
attendanceOvertimeRequestSchema.index({ companyId: 1, user: 1, status: 1 });

const AttendanceOvertimeRequest =
  mongoose.models.AttendanceOvertimeRequest ||
  mongoose.model('AttendanceOvertimeRequest', attendanceOvertimeRequestSchema);

export default AttendanceOvertimeRequest;
