// ─────────────────────────────────────────────────────────────
// Phase 31.11 — AttendancePayrollSnapshot (immutable payroll facts).
//
// One document per company + month + employee + version: the frozen
// attendance facts payroll is allowed to consume. Versions NEVER
// mutate — a reopen + re-finalize writes version N+1 and flips
// isCurrent (the 29.6 PayrollResult pattern). TIME FACTS ONLY: no
// salary, no rates, no amounts, no bank data, no reasons, no GPS —
// employeeId + day/unit measurements + leave/holiday references.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const { Schema } = mongoose;

// Compact frozen day (traceability for "which facts did payroll
// consume" — no names, no reasons, no money).
const snapshotDaySchema = new Schema(
  {
    date: { type: String, required: true },
    bucket: { type: String, default: '' },
    worked: { type: Number, default: 0 },
    leave: { type: Number, default: 0 },
    absent: { type: Number, default: 0 },
    workMode: { type: String, default: null },
    workedMinutes: { type: Number, default: 0 },
    breakMinutes: { type: Number, default: 0 },
    lateMinutes: { type: Number, default: 0 },
    earlyMinutes: { type: Number, default: 0 },
    exceptions: { type: [String], default: [] },
    approvedOtMinutes: { type: Number, default: 0 },
    compOffDays: { type: Number, default: 0 },
    leaveType: { type: String, default: null },
    leaveId: { type: String, default: null },
    holiday: { type: Boolean, default: false },
    weeklyOff: { type: Boolean, default: false },
    regularized: { type: Boolean, default: false },
    scheduledWorkingDay: { type: Boolean, default: false },
    overnightScheduled: { type: Boolean, default: false },
  },
  { _id: false },
);

const attendancePayrollSnapshotSchema = new Schema(
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
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },

    // Snapshot version. Only the highest version is current.
    version: { type: Number, default: 1 },
    isCurrent: { type: Boolean, default: true, index: true },

    // Attendance policy reference (meaning anchor, not a copy).
    policyId: { type: Schema.Types.ObjectId, ref: 'AttendancePolicy', default: null },
    policyVersion: { type: Number, default: 0 },
    policyConfigVersion: { type: Number, default: 0 },

    // ── Frozen aggregates (all time/day facts, no money) ──
    scheduledWorkingDays: { type: Number, default: 0 },
    scopedDays: { type: Number, default: 0 },
    preJoiningDays: { type: Number, default: 0 },
    postExitDays: { type: Number, default: 0 },
    equivalents: {
      worked: { type: Number, default: 0 },
      leave: { type: Number, default: 0 },
      absent: { type: Number, default: 0 },
    },
    dayCounts: {
      present: { type: Number, default: 0 },
      halfDay: { type: Number, default: 0 },
      absent: { type: Number, default: 0 },
      leave: { type: Number, default: 0 },
      holiday: { type: Number, default: 0 },
      weeklyOff: { type: Number, default: 0 },
      unresolved: { type: Number, default: 0 },
    },
    leaveUnitsByType: {
      CASUAL: { type: Number, default: 0 },
      SICK: { type: Number, default: 0 },
      EARNED: { type: Number, default: 0 },
      OTHER: { type: Number, default: 0 },
    },
    leaveIds: { type: [String], default: [] },
    workedMinutes: { type: Number, default: 0 },
    breakMinutes: { type: Number, default: 0 },
    lateDays: { type: Number, default: 0 },
    earlyExitDays: { type: Number, default: 0 },
    approvedOtMinutes: { type: Number, default: 0 },
    compOffDays: { type: Number, default: 0 },
    workedOnHolidayDays: { type: Number, default: 0 },
    workedOnWeeklyOffDays: { type: Number, default: 0 },
    overnightScheduledDays: { type: Number, default: 0 },
    regularizedDays: { type: Number, default: 0 },

    days: { type: [snapshotDaySchema], default: [] },

    // Deterministic integrity hash over the canonical facts.
    fingerprint: { type: String, default: '' },

    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

attendancePayrollSnapshotSchema.index(
  { companyId: 1, month: 1, employeeId: 1, version: 1 },
  { unique: true },
);
attendancePayrollSnapshotSchema.index({ companyId: 1, month: 1, isCurrent: 1 });
attendancePayrollSnapshotSchema.index({ companyId: 1, employeeId: 1, month: 1 });

const AttendancePayrollSnapshot =
  mongoose.models.AttendancePayrollSnapshot ||
  mongoose.model('AttendancePayrollSnapshot', attendancePayrollSnapshotSchema);

export default AttendancePayrollSnapshot;
