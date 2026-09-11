// ─────────────────────────────────────────────────────────────
// Phase 31.1 — tenant attendance policy (configuration, not punches).
//
// ONE authoritative current policy per company (partial unique index
// on { companyId } where isCurrent = true — the Phase 29.1 pattern).
// Lifecycle: DRAFT → ACTIVE → ARCHIVED (on replace). Old versions are
// never mutated, so historical attendance can never be silently
// reinterpreted by today's rules. No punches, no money, no coordinates.
//
// Time (minutes) and eligibility live here. Salary math lives in Payroll.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

export const ATTENDANCE_POLICY_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

export const LOCATION_ENFORCEMENT = ['DISABLED', 'OPTIONAL', 'REQUIRED'];

const attendancePolicySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },

    // IANA zone used to evaluate business-day boundaries (e.g. shift
    // windows). Defaults from Company.timezone at draft creation.
    timezone: {
      type: String,
      default: 'Asia/Kolkata',
      trim: true,
      maxlength: 64,
    },

    status: {
      type: String,
      enum: ATTENDANCE_POLICY_STATUSES,
      default: 'DRAFT',
      index: true,
    },

    // Monotonic per company. Assigned at activation only.
    version: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Optimistic concurrency for draft edits (29.1 pattern).
    configVersion: {
      type: Number,
      default: 1,
      min: 1,
    },

    isCurrent: {
      type: Boolean,
      default: false,
      index: true,
    },

    effectiveFrom: {
      type: Date,
      default: null,
    },

    effectiveTo: {
      type: Date,
      default: null,
    },

    // Work-day thresholds — integer MINUTES. Invariant (pure rules):
    // 0 <= halfDayMinutes < fullDayMinutes.
    thresholds: {
      fullDayMinutes: { type: Number, default: 480, min: 0 },
      halfDayMinutes: { type: Number, default: 240, min: 0 },
    },

    // Bounded non-negative integer minutes.
    grace: {
      lateInMinutes: { type: Number, default: 15, min: 0 },
      earlyOutMinutes: { type: Number, default: 15, min: 0 },
    },

    // Break configuration only — 31.1 builds no break punching.
    breaks: {
      enabled: { type: Boolean, default: true },
      // true = break time counts toward worked minutes.
      includeInWorkedTime: { type: Boolean, default: false },
      // Daily cap applied when breaks are included; null = uncapped.
      dailyLimitMinutes: { type: Number, default: null, min: 0 },
    },

    // Missing punches are NEVER invented here. Incomplete days stay
    // identifiable exceptions until a later workflow (31.5/31.7) resolves
    // them; these fields only configure that future treatment.
    missingPunch: {
      keepUnresolved: { type: Boolean, default: true },
      allowRegularization: { type: Boolean, default: true },
      regularizationWindowDays: { type: Number, default: 7, min: 0 },
    },

    // Overtime TIME/ELIGIBILITY only. No rates, no amounts — money is
    // exclusively a payroll concern.
    overtime: {
      trackingEnabled: { type: Boolean, default: false },
      minimumExtraMinutes: { type: Number, default: 30, min: 0 },
      approvalRequired: { type: Boolean, default: true },
      weekendEligible: { type: Boolean, default: false },
      holidayEligible: { type: Boolean, default: false },
    },

    // Evaluation BEHAVIOR only. Holiday/WorkSchedule remain authoritative
    // for WHICH days are holidays/week-offs.
    weekendHoliday: {
      allowWorkOnWeeklyOff: { type: Boolean, default: true },
      allowWorkOnHoliday: { type: Boolean, default: true },
    },

    // Permitted work modes (controlled vocabulary in the rules module).
    // OFFICE stays enabled by default.
    workModes: {
      office: { type: Boolean, default: true },
      wfh: { type: Boolean, default: false },
      field: { type: Boolean, default: false },
      clientSite: { type: Boolean, default: false },
      businessTravel: { type: Boolean, default: false },
    },

    // Future-compatible seam for Phase 31.3. No coordinates, no offices,
    // no geofences, no browser location in 31.1.
    locationEnforcement: {
      type: String,
      enum: LOCATION_ENFORCEMENT,
      default: 'DISABLED',
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    activatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    activatedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Exactly one current policy per company (29.1 convention).
attendancePolicySchema.index(
  { companyId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } },
);

attendancePolicySchema.index({ companyId: 1, version: -1 });
attendancePolicySchema.index({ companyId: 1, status: 1 });

export default mongoose.model('AttendancePolicy', attendancePolicySchema);

export { attendancePolicySchema };
