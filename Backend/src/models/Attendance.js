import { Schema, model } from "mongoose";

/*
 * ONE document per employee per day.
 * ABSENT is intentionally NOT stored — absence = no record for that working day.
 * (Computed at report time. Saves storage across thousands of tenants. 💡)
 */
const attendanceSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: String, required: true }, // 'YYYY-MM-DD' company-local day
    punchIn: { type: Date },
    punchOut: { type: Date },
    workMinutes: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["PRESENT", "LATE", "HALF_DAY"],
      default: "PRESENT",
    },
    shift: {
      type: Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
    },

    schedule: {
      type: Schema.Types.ObjectId,
      ref: "WorkSchedule",
      default: null,
    },

    shiftSource: {
      type: String,
      default: "",
    },

    lateMinutes: {
      type: Number,
      default: 0,
    },

    earlyMinutes: {
      type: Number,
      default: 0,
    },

    overtimeMinutes: {
      type: Number,
      default: 0,
    },

    // ── Phase 31.2 (all additive; legacy readers ignore them) ──
    // Session control record for the event ledger. `null`/missing means
    // a legacy record: live state is derived from punchIn/punchOut.
    liveState: {
      type: String,
      enum: ['NOT_IN', 'WORKING', 'ON_BREAK', 'COMPLETED'],
      default: null,
    },

    // Attendance fact captured at CLOCK_IN (31.1 policy-gated).
    workMode: {
      type: String,
      default: null,
    },

    // Event-derived break total (integer minutes). Legacy days keep 0.
    breakMinutes: {
      type: Number,
      default: 0,
    },

    // CAS counter: events assigned seq = eventSeq + 1 under compare-and-set.
    eventSeq: {
      type: Number,
      default: 0,
    },

    // 31.1 policy generation used for derivation (null when unconfigured).
    policyVersion: {
      type: Number,
      default: null,
    },

    // 31.1 evaluateDay outcome vocabulary for future phases. NEVER feeds
    // `status` (payroll-facing enum stays scheduleEngine-derived).
    policyOutcome: {
      type: String,
      default: null,
    },

    policyExceptions: {
      type: [String],
      default: [],
    },

    lastEventAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true }); // no double punch
attendanceSchema.index({ companyId: 1, date: 1 }); // fast daily company view
attendanceSchema.index({ companyId: 1, user: 1, date: 1 }); // 31.2 tenant-first session lookup

const Attendance = model("Attendance", attendanceSchema);
export default Attendance;
