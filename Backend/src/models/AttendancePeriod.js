// ─────────────────────────────────────────────────────────────
// Phase 31.11 — AttendancePeriod (month control record).
//
// ONE row per company per attendance month. Owns the ATTENDANCE
// lifecycle ONLY (OPEN → FINALIZED → SENT_TO_PAYROLL, REOPENED) —
// it never mirrors or transitions PayrollPeriod, which owns the
// payroll-input lifecycle in 29.5. Readiness is derived, never
// stored. Version history is embedded (months finalize rarely;
// the array stays tiny) while per-employee facts live in
// AttendancePayrollSnapshot.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const { Schema } = mongoose;

const versionHistorySchema = new Schema(
  {
    version: { type: Number, required: true },
    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    fingerprint: { type: String, default: '' },
    // Frozen month aggregates for the history UI (counts only).
    summary: { type: Schema.Types.Mixed, default: null },
    sentToPayrollAt: { type: Date, default: null },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reopenedAt: { type: Date, default: null },
    reopenedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reopenReason: { type: String, default: '' },
  },
  { _id: false },
);

const attendancePeriodSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    // 'YYYY-MM'
    month: { type: String, required: true, trim: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },

    status: {
      type: String,
      enum: ['OPEN', 'FINALIZING', 'FINALIZED', 'SENT_TO_PAYROLL', 'REOPENED'],
      default: 'OPEN',
      index: true,
    },

    currentVersion: { type: Number, default: 0 },

    // Atomic finalization claim (concurrency guard): the version
    // being built plus who/when claimed it. A stale FINALIZING
    // claim (crash) is resumable by re-claiming the same version.
    claimedVersion: { type: Number, default: null },
    claimedAt: { type: Date, default: null },
    claimedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    lastSyncError: { type: String, default: '' },
    syncedEmployees: { type: Number, default: 0 },

    versions: { type: [versionHistorySchema], default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// One attendance month-control per company per month.
attendancePeriodSchema.index({ companyId: 1, month: 1 }, { unique: true });
attendancePeriodSchema.index({ companyId: 1, status: 1 });

const AttendancePeriod =
  mongoose.models.AttendancePeriod ||
  mongoose.model('AttendancePeriod', attendancePeriodSchema);

export default AttendancePeriod;
