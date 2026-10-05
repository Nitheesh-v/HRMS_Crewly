// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST MODEL
//
//  A presence-domain WFH request. Distinct from the Phase 31.4
//  `AttendanceWorkModeRequest` which authorises a CLOCK_IN under a
//  non-office mode; this model authorises a *presence* work-location
//  value (`wfh`) for one or more calendar days. It NEVER writes to
//  Attendance, Leave, or Payroll.
//
//  Schema
//  ──────
//    companyId   — tenant scope (every query must include it)
//    userId      — the requesting employee (server-derived at the edge)
//    location    — frozen to 'wfh' (presence-domain requestable location)
//    startDate   — YYYY-MM-DD, inclusive (Leave-style day key)
//    endDate     — YYYY-MM-DD, inclusive; same-or-after startDate
//    status      — pending | approved | rejected | cancelled
//    requestedAt — Date set on creation
//    requestedBy — ObjectId; the employee (== userId)
//    reviewedAt  — Date set on decide
//    reviewedBy  — ObjectId; the reviewer (manager / HR / admin)
//    decisionNote — optional, plain text, ≤300 chars
//    cancelledAt — Date set on cancel
//    cancelledBy — ObjectId; the actor (may be the owner or a reviewer)
//
//  Indexes (spec §46)
//  ──────────────────
//    · {companyId:1, userId:1, startDate:1, endDate:1} — overlap query
//    · {companyId:1, status:1, requestedAt:1}         — review queue
//    · {companyId:1, status:1, startDate:1, endDate:1} — per-day active lookup
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

export const WORK_LOCATION_REQUEST_STATUS = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);

const { Schema } = mongoose;

const workLocationRequestSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: [true, 'companyId is required'],
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      index: true,
    },
    // The only requestable presence work-location is 'wfh' (spec §7).
    // 'office' and 'remote' do not require approval at the presence
    // layer — they are direct self-declarations.
    location: {
      type: String,
      enum: ['wfh'],
      required: [true, 'location is required'],
      immutable: true,
    },
    startDate: { type: String, required: [true, 'startDate is required'] },
    endDate: { type: String, required: [true, 'endDate is required'] },
    status: {
      type: String,
      enum: [...WORK_LOCATION_REQUEST_STATUS],
      default: 'pending',
      index: true,
    },
    requestedAt: { type: Date, default: () => new Date() },
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: { type: Date, default: null },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    decisionNote: { type: String, default: null, trim: true, maxlength: 300 },
    cancelledAt: { type: Date, default: null },
    cancelledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

// Phase 37.5 §46 — overlap query for the same employee.
workLocationRequestSchema.index({
  companyId: 1,
  userId: 1,
  startDate: 1,
  endDate: 1,
});

// Review queue (PENDING only; oldest first).
workLocationRequestSchema.index({
  companyId: 1,
  status: 1,
  requestedAt: 1,
});

// Per-day active lookup (e.g. "is there an APPROVED request for user X
// covering YYYY-MM-DD?"). The service does the actual $lte / $gte at
// the query layer; this index is the read path.
workLocationRequestSchema.index({
  companyId: 1,
  status: 1,
  startDate: 1,
  endDate: 1,
});

const WorkLocationRequest = mongoose.model(
  'WorkLocationRequest',
  workLocationRequestSchema,
);

export default WorkLocationRequest;
