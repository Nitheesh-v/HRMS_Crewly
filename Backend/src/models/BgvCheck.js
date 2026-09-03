// ============================================================
//  PHASE 30.1 — BGV CHECK FRAMEWORK · BgvCheck model
//
//  One individually trackable check (Identity / Address /
//  Education / Employment / Court record) per case per type:
//  owned by ONE internal verifier, SLA-tracked, with per-entry
//  status and evidence. This layer ADDS to the 27.15 case flow
//  (BackgroundVerificationCase/Check stay authoritative for the
//  hiring pipeline); it never changes their contracts.
//
//  Entries: EMPLOYMENT/EDUCATION checks may carry several
//  entries (two past employers, two degrees). Every check has
//  at least one entry so handling is uniform.
//
//  Sensitive data: no raw document numbers in 30.1 (guarded at
//  the service layer). Evidence lives in private storage only.
// ============================================================

import mongoose from 'mongoose';
import {
  BGV_CHECK_TYPES,
  BGV_CHECK_STATUSES,
  BGV_EVIDENCE_KINDS,
} from '../services/bgv/bgvCheckRules.js';

export const BGV_CHECK_ENTRY_STATUSES = BGV_CHECK_STATUSES;

const evidenceSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: BGV_EVIDENCE_KINDS, required: true },
    // Private storage reference — NEVER a public URL.
    fileUrl: { type: String, default: '', maxlength: 300 },
    storageProvider: {
      type: String,
      enum: ['', 'CLOUDINARY_AUTHENTICATED', 'LOCAL_PRIVATE'],
      default: '',
    },
    storageKey: { type: String, default: '', maxlength: 200 },
    filename: { type: String, default: '', maxlength: 160 },
    mime: { type: String, default: '', maxlength: 120 },
    sizeBytes: { type: Number, default: 0, min: 0 },
    note: { type: String, default: '', maxlength: 2000 },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    addedAt: { type: Date, default: () => new Date() },
  },
  { _id: true, timestamps: false, versionKey: false }
);

const entrySchema = new mongoose.Schema(
  {
    // Stable id within the check (uuid) — addressed by the API.
    entryKey: { type: String, required: true, maxlength: 40 },
    label: { type: String, default: '', maxlength: 200 },
    // Structured snapshot of what the candidate claimed for this
    // entry; the owning sub-phase (30.2-30.6) defines the shape.
    claim: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: BGV_CHECK_STATUSES, default: 'PENDING' },
    resultSummary: { type: String, default: '', maxlength: 2000 },
    discrepancyNote: { type: String, default: '', maxlength: 2000 },
    evidence: [evidenceSchema],
  },
  { _id: false, timestamps: true }
);

const bgvCheckSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    bgvCaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BackgroundVerificationCase',
      required: true,
      immutable: true,
    },
    candidateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      immutable: true,
    },
    checkType: { type: String, enum: BGV_CHECK_TYPES, required: true, immutable: true },
    status: { type: String, enum: BGV_CHECK_STATUSES, default: 'PENDING', index: true },
    isRequired: { type: Boolean, default: true },

    entries: [entrySchema],

    assignedVerifierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    sla: {
      initiatedAt: { type: Date, default: () => new Date() },
      dueAt: { type: Date, default: null },
      extendedOnce: { type: Boolean, default: false },
      extensionReason: { type: String, default: '', maxlength: 500 },
      extensionDays: { type: Number, default: 0, min: 0, max: 90 },
    },

    // Follow-up trail. 30.1 stores the fields; the 30.3 request
    // engine populates attempts and drives auto-UTV.
    followUp: {
      emailAttempts: { type: Number, default: 0, min: 0 },
      callAttempts: { type: Number, default: 0, min: 0 },
      lastFollowUpAt: { type: Date, default: null },
      nextFollowUpAt: { type: Date, default: null },
      closedReason: { type: String, default: '', maxlength: 200 },
    },

    resultSummary: { type: String, default: '', maxlength: 2000 },
    discrepancyNote: { type: String, default: '', maxlength: 2000 },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false }
);

// SKIPPED is only meaningful for optional checks (schema-level
// backstop; the pure rules enforce the full machine).
bgvCheckSchema.pre('validate', function guardSkipped(doc) {
  if (this.isModified('status') && this.status === 'SKIPPED' && this.isRequired) {
    this.invalidate('status', 'Required BGV checks cannot be skipped');
  }
  return doc;
});

// Tenant-first compound indexes, all explicit (spec).
bgvCheckSchema.index({ companyId: 1, bgvCaseId: 1 });
bgvCheckSchema.index({ companyId: 1, candidateId: 1, checkType: 1 });
bgvCheckSchema.index({ companyId: 1, assignedVerifierId: 1, status: 1 });
bgvCheckSchema.index({ companyId: 1, status: 1, 'sla.dueAt': 1 });
bgvCheckSchema.index({ companyId: 1, checkType: 1, status: 1 });
// Uniqueness: one BgvCheck per case per check type.
bgvCheckSchema.index({ companyId: 1, bgvCaseId: 1, checkType: 1 }, { unique: true });

export default mongoose.model('BgvCheck', bgvCheckSchema);
