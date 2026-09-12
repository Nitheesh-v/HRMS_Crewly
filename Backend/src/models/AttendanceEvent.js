import { Schema, model } from 'mongoose';

import {
  EVENT_SOURCE,
  EVENT_TYPE,
  WORK_MODE,
} from '../services/attendance/attendancePolicyRules.js';

/*
 * Phase 31.2 — immutable attendance event ledger.
 *
 * RAW FACTS ONLY: one document per punch action (CLOCK_IN, BREAK_START,
 * BREAK_END, CLOCK_OUT). Derived state (live presence, durations, daily
 * outcome) lives on the Attendance projection, never here.
 *
 * IMMUTABILITY: events are factual history. They are created once and
 * never edited or deleted through any tenant endpoint — future
 * regularization (31.5) corrects derived attendance while preserving
 * this evidence. The guards below make accidental mutation loud.
 *
 * IDEMPOTENCY: `requestId` carries the client's opaque idempotency key.
 * The unique sparse index turns a retried request into a replay lookup
 * instead of a duplicate fact. No TTL — the key rides the permanent fact.
 */
const attendanceEventSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Session day-key 'YYYY-MM-DD' in company/policy timezone, taken from
    // the CLOCK_IN moment. Clocks-out after midnight stay on this session.
    date: { type: String, required: true },
    // 1-based per-session sequence, assigned by the control record's CAS
    // counter. Unique + ordered; gaps are harmless (never reused).
    seq: { type: Number, required: true, min: 1 },
    type: {
      type: String,
      enum: Object.values(EVENT_TYPE),
      required: true,
    },
    // Authoritative server time of the punch. Never client-supplied.
    at: { type: Date, required: true },
    // Attendance fact captured at CLOCK_IN (31.1 policy decides which
    // modes are enabled). Null on break/out events.
    workMode: {
      type: String,
      enum: Object.values(WORK_MODE),
      default: null,
    },
    // Server-decided. 31.2 serves WEB only; other 31.1 sources are
    // vocabulary for future phases, never client-selectable here.
    source: {
      type: String,
      enum: Object.values(EVENT_SOURCE),
      default: EVENT_SOURCE.WEB,
    },
    // Opaque client idempotency key. Null when the client sent none.
    requestId: { type: String, default: null },
  },
  { timestamps: true },
);

// Double-insert backstop: one fact per sequence slot.
attendanceEventSchema.index(
  { companyId: 1, user: 1, date: 1, seq: 1 },
  { unique: true },
);

// Idempotent replay lookup, isolated per tenant + employee.
attendanceEventSchema.index(
  { companyId: 1, user: 1, requestId: 1 },
  { unique: true, sparse: true },
);

// Open-session + recent-day lookups across dates.
attendanceEventSchema.index({ companyId: 1, user: 1, at: 1 });

// ── Immutability guards ──────────────────────────────────────
// There is intentionally no update/delete path for events. If future
// code attempts one, fail loudly instead of rewriting history.
const refuseMutation = (operation) => () => {
  throw new Error(`AttendanceEvent is immutable: ${operation} is not allowed`);
};

attendanceEventSchema.pre('updateOne', refuseMutation('updateOne'));
attendanceEventSchema.pre('updateMany', refuseMutation('updateMany'));
attendanceEventSchema.pre('findOneAndUpdate', refuseMutation('findOneAndUpdate'));
attendanceEventSchema.pre('findOneAndReplace', refuseMutation('findOneAndReplace'));
attendanceEventSchema.pre('deleteOne', refuseMutation('deleteOne'));
attendanceEventSchema.pre('deleteMany', refuseMutation('deleteMany'));
attendanceEventSchema.pre('findOneAndDelete', refuseMutation('findOneAndDelete'));
attendanceEventSchema.pre('save', function refuseResave(next) {
  if (!this.isNew) {
    return next(new Error('AttendanceEvent is immutable: re-saving is not allowed'));
  }
  return next();
});

const AttendanceEvent = model('AttendanceEvent', attendanceEventSchema);

export default AttendanceEvent;
