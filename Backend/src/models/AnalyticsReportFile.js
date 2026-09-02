// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — ANALYTICS REPORT FILE (§19 / §22)
//
//  A large export or a scheduled report is built in the background. This
//  record is the artefact: which report, which filters, what format, and the
//  finished bytes. It mirrors StatutoryExport (29.10) and FinalSettlementFile
//  (29.11) so every background producer in the payroll module behaves the
//  same way for the UI.
//
//  The filters are STORED, not just used: a file opened three weeks later must
//  still be describable ("department payroll for August, Engineering only"),
//  which is also what the audit trail records.
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const { Schema } = mongoose;

const analyticsReportFileSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    reportKey: { type: String, required: true, trim: true, uppercase: true },
    format: { type: String, enum: ['CSV', 'XLSX', 'PDF'], default: 'XLSX' },
    period: { type: String, enum: ['MONTHLY', 'QUARTERLY', 'YEARLY'], default: 'MONTHLY' },

    // Copied from the request so the file explains itself later.
    month: { type: String, trim: true, default: '' },
    financialYear: { type: String, trim: true, default: '' },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    designation: { type: String, trim: true, default: '' },
    employeeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // The §18 filter on payment status (PAID / PENDING / FAILED), kept
    // separate from the file's own `status` below.
    paymentStatus: { type: String, trim: true, default: '' },

    filename: { type: String, trim: true, default: '' },
    rowCount: { type: Number, default: 0 },
    status: {
      type: String,
      // §38 — EXPIRED is a real state, not a missing file: a payroll
      // spreadsheet that has been sitting in the database for three weeks is
      // a liability, and the UI has to be able to say so rather than spin.
      enum: ['QUEUED', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED'],
      default: 'QUEUED',
      index: true,
    },

    progress: { type: Number, default: 0 },

    // §3 / §25 — the requester's row scope, captured when the export was
    // asked for. A background job must never be able to widen it.
    scopeEmployeeIds: { type: [Schema.Types.ObjectId], default: null },

    // §24 — a scheduled run knows why it exists; an ad-hoc export does not.
    scheduledReportId: { type: Schema.Types.ObjectId, ref: 'ScheduledReport', default: null },

    // The artefact. `select: false` — fetched only by the download route.
    binary: { type: Buffer, select: false, default: null },
    sizeBytes: { type: Number, default: 0 },
    checksum: { type: String, default: '' },
    error: { type: String, default: '' },

    jobId: { type: String, default: '' },
    queued: { type: Boolean, default: false },

    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    requestedByName: { type: String, default: '' },
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // §38 — "Do not keep temporary sensitive payroll files forever." Set when
    // the file is built; the sweeper drops the bytes and flips the status.
    expiresAt: { type: Date, default: null, index: true },
    expiredAt: { type: Date, default: null },
  },
  { timestamps: true },
);

analyticsReportFileSchema.index({ companyId: 1, createdAt: -1 });
analyticsReportFileSchema.index({ companyId: 1, reportKey: 1, month: 1 });
analyticsReportFileSchema.index({ companyId: 1, scheduledReportId: 1 });
// The sweeper's query: ready files whose time has come.
analyticsReportFileSchema.index({ status: 1, expiresAt: 1 });

const AnalyticsReportFile =
  mongoose.models.AnalyticsReportFile ||
  mongoose.model('AnalyticsReportFile', analyticsReportFileSchema);

export default AnalyticsReportFile;
