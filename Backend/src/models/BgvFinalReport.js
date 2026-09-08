import mongoose from 'mongoose';

const { Schema } = mongoose;

// Phase 30.10 — FINAL BGV REPORT (immutable, versioned snapshot).
//
//  - GENERATED ≠ RELEASED: the PDF may exist internally before any tenant
//    can see it; an authorized platform QA actor explicitly releases it.
//  - The snapshot is frozen at generation time. Later verifier/QA/source
//    mutations NEVER rewrite it — a correction reissues a NEW version.
//  - Only customer-safe facts are snapshotted (masked identifiers, approved
//    conclusions, methods, discrepancies). No QA discussion, no tokens, no
//    payment data, no raw evidence bytes.

export const BGV_REPORT_STATUSES = ['GENERATED', 'RELEASED', 'SUPERSEDED'];

const reportCheckSchema = new Schema(
  {
    checkType: { type: String, required: true, uppercase: true },
    conclusion: { type: String, required: true, maxlength: 40 },
    revision: { type: Number, required: true, min: 1 },
    methods: { type: [String], default: [] },
    discrepancies: [
      {
        _id: false,
        field: { type: String, maxlength: 80 },
        severity: { type: String, enum: ['INFO', 'MINOR', 'MAJOR'], default: 'INFO' },
        explanation: { type: String, maxlength: 1000 },
      },
    ],
    completionNote: { type: String, default: '', maxlength: 1000 },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const bgvFinalReportSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true, immutable: true },
    bgvOrder: { type: Schema.Types.ObjectId, ref: 'BgvOrder', required: true, index: true, immutable: true },
    candidate: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true, immutable: true },
    orderCode: { type: String, required: true, immutable: true },
    // Readable unique reference, e.g. BGVRPT-000123 (TenantSequence-backed).
    reportNumber: { type: String, required: true, immutable: true },
    version: { type: Number, default: 1, min: 1, immutable: true },
    status: { type: String, enum: BGV_REPORT_STATUSES, default: 'GENERATED' },

    // Frozen at generation; the tenant PDF/view render ONLY from this object.
    snapshot: {
      generatedAt: { type: Date, required: true },
      tenantName: { type: String, default: '' },
      candidateName: { type: String, default: '' },
      // Safe identity context only (masked display values from 30.5).
      identity: [{ _id: false, documentType: { type: String }, identifierMasked: { type: String } }],
      checks: { type: [reportCheckSchema], default: [] },
      overallOutcome: { type: String, enum: ['CLEAR', 'CLEAR_WITH_DISCREPANCIES', 'HOLD'], required: true },
      disclaimer: { type: String, required: true },
    },

    release: {
      releasedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      releasedAt: { type: Date, default: null },
    },

    pdf: {
      status: { type: String, enum: ['NONE', 'GENERATED', 'FAILED'], default: 'NONE' },
      storageProvider: { type: String, default: '' },
      storageKey: { type: String, default: '', select: false },
      fileName: { type: String, default: '' },
      checksumSha256: { type: String, default: '' },
      sizeBytes: { type: Number, default: 0 },
      generatedAt: { type: Date, default: null },
    },

    // Append-only operational trail (safe metadata only).
    history: [
      {
        _id: false,
        action: { type: String, required: true },
        actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        at: { type: Date, default: Date.now },
        metadata: { type: Schema.Types.Mixed, default: () => ({}) },
      },
    ],
  },
  { timestamps: true, versionKey: false }
);

// One report version per order; double-click cannot create duplicates.
bgvFinalReportSchema.index({ bgvOrder: 1, version: 1 }, { unique: true });

export default mongoose.model('BgvFinalReport', bgvFinalReportSchema);
