// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.13 — PAYROLL ANALYTICS SETTING (§8)
//
//  Per-company configuration for the analytics module. It exists so company
//  choices live in the company's own document rather than in a constant in
//  the codebase.
//
//  Deliberately NOT part of PayrollSetup (29.1): that document is versioned
//  and its activation flow is load-bearing for every other payroll phase, so
//  a band change must not mint a new payroll-configuration version. This
//  collection holds presentation choices only — nothing here can change a
//  rupee.
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const { Schema } = mongoose;

const bandSchema = new Schema(
  {
    key: { type: String, trim: true, default: '' },
    label: { type: String, trim: true, required: true },
    // `max: null` = open-ended. The last band must have no ceiling, or a
    // salary above it is silently dropped from the distribution.
    min: { type: Number, default: 0, min: 0 },
    max: { type: Number, default: null },
  },
  { _id: false },
);

const payrollAnalyticsSettingSchema = new Schema(
  {
    // NOTE: no `index: true` here on purpose. The explicit unique index below
    // already covers this field, and declaring both makes Mongoose log a
    // "duplicate schema index" warning on every boot of the API and the
    // worker — twice per process.
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },

    // §8 — the salary bands the distribution chart and report use. Empty
    // means "use the default five", which is what normaliseSalaryBands does.
    salaryBands: { type: [bandSchema], default: () => [] },

    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

payrollAnalyticsSettingSchema.index({ companyId: 1 }, { unique: true });

const PayrollAnalyticsSetting =
  mongoose.models.PayrollAnalyticsSetting ||
  mongoose.model('PayrollAnalyticsSetting', payrollAnalyticsSettingSchema);

export default PayrollAnalyticsSetting;
