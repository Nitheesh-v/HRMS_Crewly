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

    // ── Phase 31.5 (all additive; legacy readers ignore them) ──
    // True once an approved regularization wrote an effective-facts
    // overlay. Recorded punches stay untouched: the overlay carries
    // the corrected timeline for display + re-derivation.
    regularized: {
      type: Boolean,
      default: false,
    },

    regularization: {
      correctedIn: { type: Date, default: null },
      correctedOut: { type: Date, default: null },
      correctedBreakMinutes: { type: Number, default: null },
      correctedWorkMode: { type: String, default: null },
      resolvedExceptions: { type: [String], default: [] },
      appliedRequestIds: {
        type: [{ type: Schema.Types.ObjectId, ref: 'AttendanceRegularization' }],
        default: [],
      },
      appliedAt: { type: Date, default: null },
    },

    // ── Phase 31.6 (all additive; legacy readers ignore them) ──
    // Schedule meaning is versioned at first evaluation: later Shift
    // edits cannot rewrite this day. Legacy rows stay snapshot-less.
    scheduleStatus: {
      type: String,
      enum: ['RESOLVED', 'UNRESOLVED'],
      default: null,
    },

    scheduleSnapshot: {
      shiftId: { type: Schema.Types.ObjectId, ref: 'Shift', default: null },
      shiftName: { type: String, default: null },
      shiftType: { type: String, default: null },
      scheduleId: { type: Schema.Types.ObjectId, ref: 'WorkSchedule', default: null },
      scheduleName: { type: String, default: null },
      source: { type: String, default: null },
      startTime: { type: String, default: null },
      endTime: { type: String, default: null },
      scheduledStartAt: { type: Date, default: null },
      scheduledEndAt: { type: Date, default: null },
      scheduledMinutes: { type: Number, default: null },
      breakMinutes: { type: Number, default: null },
      minimumMinutes: { type: Number, default: null },
      crossesMidnight: { type: Boolean, default: false },
      isWorkingDay: { type: Boolean, default: null },
      dayType: { type: String, default: null },
      holiday: {
        name: { type: String, default: null },
        type: { type: String, default: null },
      },
      timezone: { type: String, default: null },
      graceMinutes: { type: Number, default: null },
      earlyGraceMinutes: { type: Number, default: null },
      overtimeEligible: { type: Boolean, default: false },
      resolvedAt: { type: Date, default: null },
    },
    // ── Phase 31.7 (all additive; legacy readers ignore them) ──
    // Deterministic daily resolution: outcome + calendar + leave
    // dimensions, fractions, conflicts. Refs/snapshots only — Leave
    // and Holiday stay authoritative in their own modules. Days
    // without punches have no control row and resolve on read.
    reconciliation: {
      outcome: { type: String, default: null },
      calendar: {
        primary: { type: String, default: null },
        alsoWeeklyOff: { type: Boolean, default: false },
        holiday: {
          name: { type: String, default: null },
          type: { type: String, default: null },
        },
      },
      leave: {
        portion: { type: String, default: 'NONE' },
        leaveId: { type: Schema.Types.ObjectId, ref: 'Leave', default: null },
        type: { type: String, default: null },
        label: { type: String, default: null },
      },
      halves: {
        first: { type: String, default: null },
        second: { type: String, default: null },
        midpoint: { type: Date, default: null },
      },
      fractions: {
        worked: { type: Number, default: 0 },
        leave: { type: Number, default: 0 },
        absent: { type: Number, default: 0 },
      },
      exceptions: { type: [String], default: [] },
      conflicts: { type: [String], default: [] },
      needsReview: { type: Boolean, default: false },
      unresolved: { type: Boolean, default: false },
      nonWorkingDayWorked: { type: Boolean, default: false },
      holidayWorked: { type: Boolean, default: false },
      weeklyOffWorked: { type: Boolean, default: false },
      schedule: {
        startTime: { type: String, default: null },
        endTime: { type: String, default: null },
        shiftName: { type: String, default: null },
        scheduleName: { type: String, default: null },
      },
      notes: { type: [String], default: [] },
      resolvedAt: { type: Date, default: null },
      resolvedBy: { type: String, default: null },
    },
  },
  { timestamps: true },
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true }); // no double punch
attendanceSchema.index({ companyId: 1, date: 1 }); // fast daily company view
attendanceSchema.index({ companyId: 1, user: 1, date: 1 }); // 31.2 tenant-first session lookup

const Attendance = model("Attendance", attendanceSchema);
export default Attendance;
