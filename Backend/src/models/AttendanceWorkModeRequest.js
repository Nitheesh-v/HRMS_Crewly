import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────
// Phase 31.4 — AttendanceWorkModeRequest.
//
// Authorization workflow for non-office work (WFH, FIELD,
// CLIENT_SITE, BUSINESS_TRAVEL). A request NEVER creates
// attendance, NEVER marks Present, NEVER touches payroll — it
// only authorizes a CLOCK_IN under that mode for its dates.
//
// Conventions mirrored from Leave.js: tenant scope, `user` link,
// 'YYYY-MM-DD' day strings, PENDING/APPROVED/REJECTED/CANCELLED
// vocabulary. Zero middleware (model hooks stay out of 31.x).
// ─────────────────────────────────────────────────────────────

export const WORK_MODE_REQUEST_STATUS = Object.freeze([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);

export const WORK_MODE_REQUEST_PORTION = Object.freeze([
  'FULL_DAY',
  'FIRST_HALF',
  'SECOND_HALF',
]);

const workModeRequestSchema = new mongoose.Schema(
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
    // Requestable non-office modes only — OFFICE is the normal
    // attendance mode and is never requested. Values reuse the
    // Phase 31.1 WORK_MODE vocabulary (no second vocabulary).
    mode: {
      type: String,
      enum: ['WFH', 'FIELD', 'CLIENT_SITE', 'BUSINESS_TRAVEL'],
      required: true,
    },
    // Day strings in company calendar ('YYYY-MM-DD', Leave-style).
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    dayPortion: {
      type: String,
      enum: [...WORK_MODE_REQUEST_PORTION],
      default: 'FULL_DAY',
    },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    // Optional neutral display label: client/site name for
    // CLIENT_SITE, destination for BUSINESS_TRAVEL, purpose site
    // for FIELD. Never an address, never coordinates.
    placeLabel: { type: String, default: null, trim: true, maxlength: 120 },

    status: {
      type: String,
      enum: [...WORK_MODE_REQUEST_STATUS],
      default: 'PENDING',
      index: true,
    },
    approver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewReason: { type: String, default: null, trim: true, maxlength: 300 },
    decidedAt: { type: Date, default: null },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Approver queue: company's pending requests, oldest first.
workModeRequestSchema.index({ companyId: 1, status: 1, createdAt: 1 });
// Mine / overlap / authorization match: employee's requests by day.
workModeRequestSchema.index({ companyId: 1, user: 1, startDate: 1 });

const AttendanceWorkModeRequest = mongoose.model(
  'AttendanceWorkModeRequest',
  workModeRequestSchema,
);

export default AttendanceWorkModeRequest;
