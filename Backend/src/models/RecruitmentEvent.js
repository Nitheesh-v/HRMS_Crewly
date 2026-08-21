// ─────────────────────────────────────────────────────────────
// Phase 27.23 — Recruitment audit stream.
// A dedicated, queryable history for the hiring lifecycle
// (requisition → job → candidate → interview → offer → employee).
// AuditLog stays the generic API audit; this one is entity-centric.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

export const RECRUITMENT_ENTITY_TYPES = [
  'REQUISITION',
  'JOB',
  'CANDIDATE',
  'APPLICATION',
  'RESUME',
  'ATS',
  'INTERVIEW',
  'FEEDBACK',
  'OFFER',
  'DOCUMENT',
  'EMPLOYEE',
];

const recruitmentEventSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    action: { type: String, required: true, uppercase: true, trim: true },

    entityType: { type: String, enum: RECRUITMENT_ENTITY_TYPES, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    entityCode: { type: String, default: '', trim: true },

    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '' },
    actorRole: { type: String, default: '' },

    // "SYSTEM" for queue workers, "CANDIDATE" for public actions.
    actorKind: {
      type: String,
      enum: ['USER', 'SYSTEM', 'CANDIDATE'],
      default: 'USER',
    },

    previousState: { type: mongoose.Schema.Types.Mixed, default: null },
    newState: { type: mongoose.Schema.Types.Mixed, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);

recruitmentEventSchema.index({ companyId: 1, entityType: 1, entityId: 1, createdAt: -1 });
recruitmentEventSchema.index({ companyId: 1, action: 1, createdAt: -1 });

export default mongoose.model('RecruitmentEvent', recruitmentEventSchema);
