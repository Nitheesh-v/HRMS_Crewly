// Phase 30.7 — CHECK-LEVEL assignment of internal BGV verifiers.
//
// This is the Phase-30 pipeline assignment layer (BgvOrder → BgvCollectionCase
// → BgvVerifier). It is intentionally separate from the legacy 27.15
// BackgroundVerificationCase.assignedVerifier (tenant-User, case-level, old
// flow) — that record is untouched.
//
// Security invariants:
//  - ONE CURRENT assignment per (bgvOrder, checkType): partial unique index.
//  - Authorization to candidate data = CURRENT assignment + ACTIVE verifier
//    + matching specialization; history never grants access.
//  - No candidate PII copied here — everything resolves through the
//    authoritative BgvOrder / BgvCollectionCase / BgvEvidenceFile records.
//  - Workflow state (ASSIGNED/IN_PROGRESS) is operational only; verification
//    conclusions belong to Phase 30.8 and live nowhere in this model.

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const BGV_ASSIGNMENT_STATUSES = ['ASSIGNED', 'IN_PROGRESS'];

export const BGV_ASSIGNMENT_ACTIONS = [
  'ASSIGNED',
  'REASSIGNED',
  'UNASSIGNED',
  'STARTED',
];

const assignmentHistorySchema = new Schema(
  {
    action: { type: String, enum: BGV_ASSIGNMENT_ACTIONS, required: true },
    verifierFrom: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', default: null },
    verifierTo: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', default: null },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // platform operator
    at: { type: Date, default: Date.now },
    reason: { type: String, default: '', maxlength: 300 },
  },
  { _id: false }
);

const bgvCheckAssignmentSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    bgvOrder: {
      type: Schema.Types.ObjectId,
      ref: 'BgvOrder',
      required: true,
      index: true,
      immutable: true,
    },
    candidate: {
      type: Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      immutable: true,
    },
    checkType: { type: String, required: true, uppercase: true, immutable: true },
    verifier: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', default: null, index: true },
    status: {
      type: String,
      enum: BGV_ASSIGNMENT_STATUSES,
      default: 'ASSIGNED',
    },
    // 'CURRENT' while this row is the authoritative assignment, null after
    // a future terminal transition — the partial unique index guarantees a
    // single current primary verifier per check.
    activeKey: { type: String, default: 'CURRENT', select: false },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignedAt: { type: Date, default: Date.now },
    startedAt: { type: Date, default: null },
    history: { type: [assignmentHistorySchema], default: [] },
  },
  { timestamps: true, versionKey: false }
);

// One authoritative current assignment per purchased check.
bgvCheckAssignmentSchema.index(
  { bgvOrder: 1, checkType: 1, activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: 'CURRENT' } }
);

bgvCheckAssignmentSchema.pre('validate', function normalizeActiveKey() {
  if (this.activeKey === null) this.activeKey = null;
});

export default mongoose.model('BgvCheckAssignment', bgvCheckAssignmentSchema);
