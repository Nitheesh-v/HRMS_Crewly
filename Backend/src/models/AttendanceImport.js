import { Schema, model } from 'mongoose';

/*
 * Phase 31.14 — attendance CSV import batches (HR/admin).
 *
 * UPLOAD/PASTE → PARSE → PREVIEW → VALIDATE → CONFIRM → IMPORT.
 * Preview mutates nothing; confirm ingests through the SAME
 * recordEvent state machine as every other source.
 *
 * INVARIANTS:
 * - fingerprint (sha256 of canonical content) is unique per
 *   tenant: re-uploading the same file returns the prior batch
 *   instead of duplicating events;
 * - CONFIRMING is an atomic claim: concurrent confirms of one
 *   batch converge on a single winner;
 * - the raw CSV is NEVER persisted — only bounded per-row
 *   outcomes (the payroll-grade audit trail) + counts;
 * - VALID_ROWS_ONLY with explicit per-row outcomes: a batch is
 *   never presented as fully successful while rows failed.
 */
export const ATTENDANCE_IMPORT_STATUS = ['DRAFT', 'CONFIRMING', 'CONFIRMED', 'FAILED'];

/*
 * 31.14 fix — the per-row outcome is the ONLY place the reason a row did not
 * import ever exists (the raw CSV is never persisted). Its paths must match
 * exactly what the import service writes and what the page renders. They did
 * not: the service wrote status/message/at while this schema declared
 * outcome/reason/occurredAt, so Mongoose's strict mode dropped every one of
 * them on the way in — and the batch kept only the line numbers. That is why
 * a failed import showed five blank outcome pills and no explanation.
 */
const importOutcomeSchema = new Schema(
  {
    line: { type: Number, required: true, min: 1 },
    employeeCode: { type: String, default: '' },
    eventType: { type: String, default: '' },
    // The event instant, written for IMPORTED rows.
    at: { type: Date, default: null },
    status: {
      type: String,
      enum: ['IMPORTED', 'SKIPPED', 'REJECTED'],
      required: true,
    },
    // Why a row was SKIPPED or REJECTED ('' when it imported).
    message: { type: String, default: '' },
  },
  { _id: false }
);

const attendanceImportSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    fingerprint: { type: String, required: true },
    status: {
      type: String,
      enum: ATTENDANCE_IMPORT_STATUS,
      default: 'DRAFT',
      index: true,
    },
    sourceLabel: { type: String, trim: true, maxlength: 80, default: '' },
    rowCount: { type: Number, default: 0, min: 0 },
    validCount: { type: Number, default: 0, min: 0 },
    invalidCount: { type: Number, default: 0, min: 0 },
    importedCount: { type: Number, default: 0, min: 0 },
    skippedCount: { type: Number, default: 0, min: 0 },
    // 31.14 fix — the service has always written this; without the path
    // Mongoose dropped it, so the page rendered "0 skipped,  rejected".
    rejectedCount: { type: Number, default: 0, min: 0 },
    // Affected YYYY-MM months (bounded: derived from valid rows).
    months: { type: [String], default: [] },
    outcomes: { type: [importOutcomeSchema], default: [] },
    confirmedAt: { type: Date, default: null },
    confirmedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

attendanceImportSchema.index({ companyId: 1, fingerprint: 1 }, { unique: true });
attendanceImportSchema.index({ companyId: 1, createdAt: -1 });

const AttendanceImport = model('AttendanceImport', attendanceImportSchema);
export default AttendanceImport;
