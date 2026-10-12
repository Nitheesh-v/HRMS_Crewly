// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 38 — PROFILE CHANGE REQUEST MODEL
//
//  One document = one employee's proposal to change one or more fields of
//  their own employee profile, plus the decision that was made about it.
//
//  It is deliberately NOT the employee record. Nothing here is authoritative:
//  the User document stays the only source of truth, and a request becomes a
//  real change only when a reviewer approves it (services/profile/
//  profileChangeService.js applies the values then).
//
//  SCHEMA
//  ──────
//    companyId     — tenant scope. Every query filters on it, first.
//    employeeId    — the employee the request belongs to (server-derived).
//    employeeName  — display snapshot so the review queue never needs a join
//    employeeCode  — display snapshot (may be empty)
//    changes[]     — the diff: field · label · from · to (+ raw copies)
//    pendingFields — the same field names, kept ONLY so a partial unique
//                    index can promise "one pending request per field"
//    status        — pending | approved | rejected | cancelled
//    reason        — why the employee asked (≤300 chars, employee text)
//    decisionNote  — the reviewer's note (≤300 chars, reviewer text)
//    requestedAt / requestedBy
//    reviewedAt / reviewedBy
//    appliedAt     — set when the approved values landed on the User doc
//    cancelledAt / cancelledBy
//
//  WHY `_fromRaw` / `_toRaw` EXIST
//  ───────────────────────────────
//  `from`/`to` are DISPLAY strings (bank numbers are masked). Applying a
//  change needs the real values, and comparing "has the profile moved since
//  this was submitted?" needs the real previous value. Both raw copies live
//  here and are excluded from every serialized response by
//  serializeChangeRequest() — the only door to the wire.
//
//  INDEXES
//  ───────
//    · { companyId, employeeId, status, requestedAt:-1 }  — "my requests"
//    · { companyId, status, requestedAt:1 }               — review queue
//    · { companyId, employeeId, pendingFields } UNIQUE,
//      partial on status:'pending'                          — one open request
//      per field, enforced by the database, not by a hopeful read-then-write
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

export const PROFILE_CHANGE_STATUS = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);

const { Schema } = mongoose;

const changeItemSchema = new Schema(
  {
    field: { type: String, required: true, trim: true },
    label: { type: String, default: '', trim: true },
    // Human-readable snapshot, masked for sensitive fields.
    from: { type: String, default: '' },
    to: { type: String, default: '' },
    // Raw values used to apply (and to detect drift). Never serialized.
    _fromRaw: { type: Schema.Types.Mixed, default: null },
    _toRaw: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const profileChangeRequestSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: [true, 'companyId is required'],
      index: true,
    },
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'employeeId is required'],
      index: true,
    },
    employeeName: { type: String, default: '', trim: true, maxlength: 60 },
    employeeCode: { type: String, default: '', trim: true, maxlength: 20 },

    changes: {
      type: [changeItemSchema],
      validate: {
        validator: (rows) => Array.isArray(rows) && rows.length > 0,
        message: 'a request must contain at least one change',
      },
    },
    // Duplicated field names for the partial unique index below.
    pendingFields: { type: [String], default: [] },

    status: {
      type: String,
      enum: [...PROFILE_CHANGE_STATUS],
      default: 'pending',
      index: true,
    },

    reason: { type: String, default: '', trim: true, maxlength: 300 },
    decisionNote: { type: String, default: '', trim: true, maxlength: 300 },

    requestedAt: { type: Date, default: () => new Date() },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    // Set once the approved values have been written to the employee record.
    appliedAt: { type: Date, default: null },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// "My requests" — newest first, tenant + owner scoped.
profileChangeRequestSchema.index({
  companyId: 1,
  employeeId: 1,
  status: 1,
  requestedAt: -1,
});

// Review queue — oldest pending first.
profileChangeRequestSchema.index({ companyId: 1, status: 1, requestedAt: 1 });

// One OPEN request per (company, employee, field). The partial filter means
// decided requests stop occupying the slot, so the employee may ask again
// after a rejection without any cleanup job.
profileChangeRequestSchema.index(
  { companyId: 1, employeeId: 1, pendingFields: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
  },
);

const ProfileChangeRequest =
  mongoose.models.ProfileChangeRequest ||
  mongoose.model('ProfileChangeRequest', profileChangeRequestSchema);

export default ProfileChangeRequest;
export { profileChangeRequestSchema };
