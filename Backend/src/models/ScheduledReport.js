// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — SCHEDULED REPORT (§20 / §22)
//
//  "Monthly Payroll Summary, every month, to Finance" is a standing
//  instruction, not a click. This is the record of it.
//
//  Two decisions worth stating:
//
//   · the schedule owns `nextRunAt` IN MONGO, not only in BullMQ. A delayed
//     job survives a Redis restart; a schedule that only lived in the queue
//     would not, and a CFO would simply stop receiving their report.
//   · recipients are resolved by PERMISSION at run time, never stored as a
//     frozen user list. People join and leave; "whoever can approve payment
//     this month" is the thing the schedule actually means (§22).
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const { Schema } = mongoose;

const scheduledReportSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    reportKey: { type: String, required: true, trim: true, uppercase: true },
    format: { type: String, enum: ['CSV', 'XLSX', 'PDF'], default: 'XLSX' },
    period: { type: String, enum: ['MONTHLY', 'QUARTERLY', 'YEARLY'], default: 'MONTHLY' },

    frequency: {
      type: String,
      enum: ['MONTHLY', 'QUARTERLY', 'YEARLY'],
      default: 'MONTHLY',
      index: true,
    },
    // §20 — run on the Nth of the period. Clamped to the end of a short month.
    dayOfMonth: { type: Number, default: 1, min: 1, max: 31 },

    // §18 — the same filters the report screen offers, frozen with the
    // schedule. An empty department means "all departments".
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    designation: { type: String, trim: true, default: '' },
    employeeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    // §22 — who is told when it lands. A permission, so the audience stays
    // correct as people come and go.
    notifyPermission: { type: String, trim: true, default: '' },

    active: { type: Boolean, default: true, index: true },

    nextRunAt: { type: Date, default: null, index: true },
    lastRunAt: { type: Date, default: null },
    lastRunStatus: { type: String, enum: ['SUCCESS', 'FAILED', ''], default: '' },
    lastFileId: { type: Schema.Types.ObjectId, ref: 'AnalyticsReportFile', default: null },
    // The name of the last file it produced, so the UI can download it without
    // a second lookup.
    lastFilename: { type: String, default: '' },
    lastError: { type: String, default: '' },
    runCount: { type: Number, default: 0 },

    jobId: { type: String, default: '' },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true },
);

// One active schedule per company + report + frequency + filters: the same
// report for the same audience is a duplicate, and a CFO does not want two.
scheduledReportSchema.index({ companyId: 1, reportKey: 1, frequency: 1, departmentId: 1 });
scheduledReportSchema.index({ companyId: 1, active: 1, nextRunAt: 1 });

const ScheduledReport =
  mongoose.models.ScheduledReport || mongoose.model('ScheduledReport', scheduledReportSchema);

export default ScheduledReport;
