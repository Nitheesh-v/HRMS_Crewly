// Phase 30.8 — BGV CHECK VERIFICATION (workbench state per assigned check).
//
// Separate document from BgvCheckAssignment (30.7) but the same
// one-CURRENT-row-per-(bgvOrder, checkType) pattern with a partial unique
// index. The assignment says WHO may work; this record holds the work:
//
//  - `state` is OPERATIONAL (IN_PROGRESS / AWAITING_THIRD_PARTY /
//    SUBMITTED). It is deliberately NOT the verification conclusion.
//  - `activities` is append-only verification attempt history (atomic
//    $push, monotonic seq). Attempts are never silently overwritten or
//    deleted; an attempt outcome is never the final conclusion.
//  - `discrepancies` are structured findings — never hiring decisions
//    (no reject flags, no pipeline effects).
//  - `conclusion` is written once via a conditional update (submission
//    lock). Conclusions are BGV findings for human HR/QA review; nothing
//    here mutates candidate.currentStage or marks a BGV case CLEAR.

import mongoose from 'mongoose';

const { Schema } = mongoose;

// Phase 30.9 adds AWAITING_CANDIDATE: an additional-information request is
// open. Operational only — never a conclusion.
export const BGV_CHECK_VERIFICATION_STATES = ['IN_PROGRESS', 'AWAITING_THIRD_PARTY', 'AWAITING_CANDIDATE', 'QA_RETURNED', 'SUBMITTED'];

export const BGV_CHECK_CONCLUSIONS = [
  'VERIFIED',
  'VERIFIED_WITH_DISCREPANCY',
  'UNABLE_TO_VERIFY',
  'INCONCLUSIVE',
  'CANCELLED',
];

const activitySchema = new Schema(
  {
    seq: { type: Number, required: true, min: 1 },
    method: { type: String, required: true, maxlength: 60 },
    outcome: { type: String, required: true, maxlength: 40 },
    verifier: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', required: true },
    at: { type: Date, default: Date.now },
    // Sanitized structured observations (schema-enforced upstream).
    observations: { type: Schema.Types.Mixed, default: () => ({}) },
    notes: { type: String, default: '', maxlength: 2000 },
    // Optional private verifier evidence attached to this activity.
    evidenceFile: { type: Schema.Types.ObjectId, ref: 'BgvVerifierEvidenceFile', default: null },
  },
  { _id: false }
);

const discrepancySchema = new Schema(
  {
    field: { type: String, required: true, maxlength: 80 },
    candidateClaimed: { type: String, required: true, maxlength: 300 },
    sourceConfirmed: { type: String, required: true, maxlength: 300 },
    severity: { type: String, enum: ['INFO', 'MINOR', 'MAJOR'], default: 'INFO' },
    explanation: { type: String, required: true, maxlength: 1000 },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const conclusionSchema = new Schema(
  {
    value: { type: String, enum: BGV_CHECK_CONCLUSIONS, required: true },
    reason: { type: String, default: '', maxlength: 1000 },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // set for platform CANCELLED
    submittedByVerifier: { type: Schema.Types.ObjectId, ref: 'BgvVerifier', default: null },
    submittedAt: { type: Date, default: Date.now },
    activityCountAtSubmission: { type: Number, default: 0 },
  },
  { _id: false }
);

const bgvCheckVerificationSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true, immutable: true },
    bgvOrder: { type: Schema.Types.ObjectId, ref: 'BgvOrder', required: true, index: true, immutable: true },
    candidate: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true, immutable: true },
    checkType: { type: String, required: true, uppercase: true, immutable: true },
    state: { type: String, enum: BGV_CHECK_VERIFICATION_STATES, default: 'IN_PROGRESS' },
    activities: { type: [activitySchema], default: [] },
    discrepancies: { type: [discrepancySchema], default: [] },
    conclusion: { type: conclusionSchema, default: null },
    // Phase 30.10 — immutable finding revisions + QA lifecycle.
    // Every verifier (re)submissionmission appends ONE entry; v1 is never
    // overwritten. `conclusion` always mirrorss the latest submission.
    submissions: {
      type: [
        new Schema(
          {
            revision: { type: Number, required: true, min: 1 },
            conclusion: { type: conclusionSchema, required: true },
            discrepancyCountAtSubmission: { type: Number, default: 0 },
            submittedAt: { type: Date, default: Date.now },
            qa: {
              status: { type: String, enum: ['PENDING', 'APPROVED', 'RETURNED'], default: 'PENDING' },
              reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
              reviewedAt: { type: Date, default: null },
              returnReason: { type: String, default: '', maxlength: 500 },
            },
          },
          { _id: false }
        )
      ],
      default: [],
    },
    // Convenience mirror of submissions[length-1] (kept atomic by the service).
    qa: {
      status: { type: String, enum: ['NONE', 'PENDING', 'APPROVED', 'RETURNED'], default: 'NONE' },
      currentRevision: { type: Number, default: 0 },
      reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      reviewedAt: { type: Date, default: null },
      returnReason: { type: String, default: '', maxlength: 500 },
    },
    activeKey: { type: String, default: 'CURRENT', select: false },
  },
  { timestamps: true, versionKey: false }
);

bgvCheckVerificationSchema.index(
  { bgvOrder: 1, checkType: 1, activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: 'CURRENT' } }
);

export default mongoose.model('BgvCheckVerification', bgvCheckVerificationSchema);
