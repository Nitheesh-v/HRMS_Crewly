// ─────────────────────────────────────────────────────────────
// Phase 31.7 — pure daily attendance reconciliation rules.
//
// The combiner, not a calculator: work facts arrive PRE-COMPUTED
// (from the 31.1 evaluateDay band / the 31.6 verdict), calendar
// meaning arrives from the schedule + holiday authorities, leave
// arrives from the Leave module. This layer only resolves how the
// authoritative facts combine into ONE deterministic daily result.
//
// Dimensions are NEVER collapsed into one status:
//   outcome   — DAILY_OUTCOME (what the day counts as; 31.1 owns it,
//               and it intentionally has no LEAVE)
//   calendar  — DAY_TYPE primary + overlap retention
//   leave     — NONE / FULL_DAY / FIRST_HALF / SECOND_HALF + ref
//   fractions — per-dimension day claims (0 / 0.5 / 1), never money
//   conflicts — preserved contradictions, never silently guessed
//
// Pure: no Mongo, no req/res, no Redis, no payroll, no wall clock.
// ─────────────────────────────────────────────────────────────
import {
  DAILY_OUTCOME,
  DAY_TYPE,
  EXCEPTION_CODE,
} from './attendancePolicyRules.js';
import { DAY_PORTION } from './attendanceWorkModeRules.js';

export { DAILY_OUTCOME, DAY_TYPE };

// Work-fact presence for a day (effective facts: recorded as
// corrected by an approved regularization, resolved by callers).
export const ATTENDANCE_PRESENCE = Object.freeze({
  NONE: 'NONE',
  PARTIAL: 'PARTIAL',
  FULL: 'FULL',
});

// Controlled conflict codes. Both authoritative facts survive; the
// code only says a human must look (Leave owns leave fixes, 31.5
// owns attendance fixes — 31.7 auto-mutates nothing).
export const RECONCILIATION_CONFLICT = Object.freeze({
  ATTENDANCE_ON_APPROVED_LEAVE: 'ATTENDANCE_ON_APPROVED_LEAVE',
  LEAVE_HALF_MISMATCH: 'LEAVE_HALF_MISMATCH',
});

export const HALF_MARK = Object.freeze({
  LEAVE: 'LEAVE',
  WORKED: 'WORKED',
  ABSENT: 'ABSENT',
  UNRESOLVED: 'UNRESOLVED',
});

const WEEKDAY_KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// UTC weekday key for a 'YYYY-MM-DD' string (matches the engine's
// dayKey for calendar dates; local re-implementation keeps this
// module free of the model-graph import).
export const weekdayKey = (day) => {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = new Date(`${day}T00:00:00Z`).getTime();
  if (!Number.isFinite(ms)) return null;
  return WEEKDAY_KEYS[new Date(ms).getUTCDay()];
};

// Leave-counting parity: the Leave module charges balance for
// Mon–Fri only (countWorkingDays skips Sat/Sun, holidays included).
// A date inside an approved range counts as leave cover only when
// the Leave module itself would charge it.
export const isLeaveCountedDay = (day) => {
  const key = weekdayKey(day);
  return key !== null && key !== 'SAT' && key !== 'SUN';
};

// Approved-range cover check (pure half of findLeaveOnDay).
export const leaveCoversDate = ({ leave, date } = {}) => {
  if (!leave || leave.status !== 'APPROVED') return false;
  if (typeof leave.startDate !== 'string' || typeof leave.endDate !== 'string') return false;
  if (date < leave.startDate || date > leave.endDate) return false;
  return isLeaveCountedDay(date);
};

// ── Half-day midpoint (documented 31.7 rule) ─────────────────
// The split is the SCHEDULED window's midpoint (start + span/2),
// never 12:00 noon. Without a resolved interval there is no
// midpoint — halves stay unresolved rather than guessed.
export const halfDayMidpoint = ({ scheduledStartAt, scheduledEndAt } = {}) => {
  const start = scheduledStartAt instanceof Date
    ? scheduledStartAt.getTime()
    : new Date(scheduledStartAt).getTime();
  const end = scheduledEndAt instanceof Date
    ? scheduledEndAt.getTime()
    : new Date(scheduledEndAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return new Date(Math.round((start + end) / 2));
};

// ── Calendar context ─────────────────────────────────────────
// A date can be both a configured holiday and a weekly off: the
// date-specific fact (holiday) is primary, the pattern fact is
// retained — never lost to query order.
export const deriveCalendarContext = ({ holiday = null, weeklyOff = false } = {}) => ({
  primary: holiday ? DAY_TYPE.HOLIDAY : weeklyOff ? DAY_TYPE.WEEKLY_OFF : DAY_TYPE.WORK_DAY,
  alsoWeeklyOff: Boolean(holiday && weeklyOff),
  holiday: holiday ? { name: holiday.name || null, type: holiday.type || null } : null,
});

const toMs = (value) => {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

// ── Daily resolution ─────────────────────────────────────────
//
// attendance: pre-computed work facts — {
//   presence, workedMinutes, breakMinutes, lateMinutes,
//   earlyMinutes, outcomeBand, exceptions[], effectiveIn,
//   effectiveOut, expectedMinutes? }
//   outcomeBand is the 31.1/31.6 band for the WORK facts alone
//   (callers evaluate with policy; this layer never re-thresholds
//   full days). expectedMinutes is the caller's half-day bar
//   (scheduledMinutes/2) — used ONLY for half-leave days.
// schedule: 31.6 context/snapshot or null — {
//   scheduledStartAt, scheduledEndAt, startTime, endTime,
//   shiftName, scheduleName }
// leave: approved cover or null — {
//   portion, leaveId, type, label }
// holiday: applicable holiday or null — { name, type }
// weeklyOff: schedule-pattern non-working day (boolean)
export const resolveDailyAttendance = ({
  attendanceDate,
  attendance = {},
  schedule = null,
  leave = null,
  holiday = null,
  weeklyOff = false,
} = {}) => {
  const calendar = deriveCalendarContext({ holiday, weeklyOff });
  const presence = Object.values(ATTENDANCE_PRESENCE).includes(attendance.presence)
    ? attendance.presence
    : ATTENDANCE_PRESENCE.NONE;
  const workedMinutes = Math.max(0, Math.trunc(Number(attendance.workedMinutes) || 0));
  const breakMinutes = Math.max(0, Math.trunc(Number(attendance.breakMinutes) || 0));
  const lateMinutes = Math.max(0, Math.trunc(Number(attendance.lateMinutes) || 0));
  const earlyMinutes = Math.max(0, Math.trunc(Number(attendance.earlyMinutes) || 0));
  const exceptions = Array.isArray(attendance.exceptions) ? [...attendance.exceptions] : [];
  const notes = [];

  const leaveCtx = leave
    ? {
      portion: leave.portion || DAY_PORTION.FULL_DAY,
      leaveId: leave.leaveId || null,
      type: leave.type || null,
      label: leave.label || null,
    }
    : { portion: 'NONE', leaveId: null, type: null, label: null };

  const base = {
    attendanceDate,
    outcome: DAILY_OUTCOME.UNRESOLVED,
    calendar,
    leave: leaveCtx,
    halves: null,
    workedMinutes,
    breakMinutes,
    lateMinutes,
    earlyMinutes,
    fractions: { worked: 0, leave: 0, absent: 0 },
    exceptions,
    conflicts: [],
    needsReview: false,
    unresolved: false,
    nonWorkingDayWorked: false,
    holidayWorked: false,
    weeklyOffWorked: false,
    schedule: schedule
      ? {
        startTime: schedule.startTime || null,
        endTime: schedule.endTime || null,
        shiftName: schedule.shiftName || schedule.shift?.name || null,
        scheduleName: schedule.scheduleName || schedule.schedule?.name || null,
      }
      : null,
    notes,
  };
  const finish = (patch) => {
    Object.assign(base, patch);
    base.needsReview = base.conflicts.length > 0;
    base.unresolved = base.outcome === DAILY_OUTCOME.UNRESOLVED;
    return base;
  };

  const band = Object.values(DAILY_OUTCOME).includes(attendance.outcomeBand)
    ? attendance.outcomeBand
    : DAILY_OUTCOME.UNRESOLVED;
  const hasWork = presence !== ATTENDANCE_PRESENCE.NONE;
  const isWorkDay = calendar.primary === DAY_TYPE.WORK_DAY;

  // ── FULL-DAY LEAVE ──
  if (leaveCtx.portion === DAY_PORTION.FULL_DAY) {
    if (!hasWork) {
      // On leave, whatever the calendar says (holiday + leave keeps
      // BOTH facts; the outcome intentionally has no LEAVE — the
      // leave dimension carries it, exactly as 31.1 designed).
      return finish({
        outcome: DAILY_OUTCOME.NON_WORKING_DAY,
        fractions: { worked: 0, leave: 1, absent: 0 },
      });
    }
    // Punches under approved full-day leave: preserve both sides,
    // evaluate the work, flag the contradiction for a human.
    notes.push('attendance overlaps approved full-day leave: both facts kept, review required');
    const worked = band === DAILY_OUTCOME.HALF_DAY ? 0.5 : band === DAILY_OUTCOME.ABSENT ? 0 : 1;
    return finish({
      outcome: presence === ATTENDANCE_PRESENCE.FULL ? band : DAILY_OUTCOME.UNRESOLVED,
      fractions: { worked: presence === ATTENDANCE_PRESENCE.FULL ? worked : 0, leave: 1, absent: 0 },
      conflicts: [RECONCILIATION_CONFLICT.ATTENDANCE_ON_APPROVED_LEAVE],
    });
  }

  // ── HALF-DAY LEAVE (FIRST_HALF / SECOND_HALF) ──
  // The Leave module cannot supply halves yet; the rule is live for
  // injected contexts and activates if Leave ever gains portions.
  if (leaveCtx.portion === DAY_PORTION.FIRST_HALF || leaveCtx.portion === DAY_PORTION.SECOND_HALF) {
    const midpoint = halfDayMidpoint({
      scheduledStartAt: schedule?.scheduledStartAt,
      scheduledEndAt: schedule?.scheduledEndAt,
    });
    const leaveFirst = leaveCtx.portion === DAY_PORTION.FIRST_HALF;
    if (!midpoint) {
      notes.push('half-day leave without a resolved schedule: halves cannot be placed');
      return finish({
        outcome: DAILY_OUTCOME.UNRESOLVED,
        fractions: { worked: 0, leave: 0.5, absent: 0 },
        halves: {
          first: leaveFirst ? HALF_MARK.LEAVE : HALF_MARK.UNRESOLVED,
          second: leaveFirst ? HALF_MARK.UNRESOLVED : HALF_MARK.LEAVE,
          midpoint: null,
        },
      });
    }
    const halves = {
      first: leaveFirst ? HALF_MARK.LEAVE : HALF_MARK.UNRESOLVED,
      second: leaveFirst ? HALF_MARK.UNRESOLVED : HALF_MARK.LEAVE,
      midpoint: midpoint.toISOString(),
    };
    if (!hasWork) {
      // Half excused, half absence (the LOP candidate is the absent
      // fraction — money is never computed here).
      notes.push('half-day leave with no work: unworked half is absence');
      halves.first = leaveFirst ? HALF_MARK.LEAVE : HALF_MARK.ABSENT;
      halves.second = leaveFirst ? HALF_MARK.ABSENT : HALF_MARK.LEAVE;
      return finish({
        outcome: DAILY_OUTCOME.ABSENT,
        halves,
        fractions: { worked: 0, leave: 0.5, absent: 0.5 },
      });
    }
    if (presence === ATTENDANCE_PRESENCE.PARTIAL) {
      return finish({
        outcome: DAILY_OUTCOME.UNRESOLVED,
        halves,
        fractions: { worked: 0, leave: 0.5, absent: 0 },
      });
    }
    // FULL presence: placement first, sufficiency second.
    const inMs = toMs(attendance.effectiveIn);
    const outMs = toMs(attendance.effectiveOut);
    const midMs = midpoint.getTime();
    const inLeaveHalfOnly = inMs !== null && outMs !== null && (leaveFirst
      ? inMs < midMs && outMs <= midMs
      : inMs >= midMs && outMs >= midMs);
    if (inLeaveHalfOnly) {
      notes.push('work falls inside the approved leave half instead of the working half');
      return finish({
        outcome: band,
        halves,
        fractions: {
          worked: band === DAILY_OUTCOME.HALF_DAY ? 0.5 : band === DAILY_OUTCOME.ABSENT ? 0 : 1,
          leave: 0.5,
          absent: 0,
        },
        conflicts: [RECONCILIATION_CONFLICT.LEAVE_HALF_MISMATCH],
      });
    }
    const expected = Math.max(0, Math.trunc(Number(attendance.expectedMinutes) || 0));
    if (expected > 0 && workedMinutes < expected) {
      notes.push('half-day leave with short work: working half is absence');
      if (!exceptions.includes(EXCEPTION_CODE.SHORT_HOURS)) exceptions.push(EXCEPTION_CODE.SHORT_HOURS);
      halves.first = leaveFirst ? HALF_MARK.LEAVE : HALF_MARK.ABSENT;
      halves.second = leaveFirst ? HALF_MARK.ABSENT : HALF_MARK.LEAVE;
      return finish({
        outcome: DAILY_OUTCOME.ABSENT,
        halves,
        fractions: { worked: 0, leave: 0.5, absent: 0.5 },
      });
    }
    halves.first = leaveFirst ? HALF_MARK.LEAVE : HALF_MARK.WORKED;
    halves.second = leaveFirst ? HALF_MARK.WORKED : HALF_MARK.LEAVE;
    return finish({
      outcome: DAILY_OUTCOME.HALF_DAY,
      halves,
      fractions: { worked: 0.5, leave: 0.5, absent: 0 },
    });
  }

  // ── NO LEAVE ──
  if (!isWorkDay) {
    if (!hasWork) {
      return finish({ outcome: DAILY_OUTCOME.NON_WORKING_DAY });
    }
    // Work on a weekly off / holiday: the calendar fact survives,
    // the work survives, and the flags say so. No comp-off, no OT
    // approval, no money — 31.8 owns those workflows.
    return finish({
      outcome: DAILY_OUTCOME.NON_WORKING_DAY,
      nonWorkingDayWorked: true,
      holidayWorked: calendar.primary === DAY_TYPE.HOLIDAY && workedMinutes > 0,
      weeklyOffWorked: (calendar.primary === DAY_TYPE.WEEKLY_OFF || calendar.alsoWeeklyOff)
        && workedMinutes > 0,
    });
  }
  if (presence === ATTENDANCE_PRESENCE.NONE) {
    return finish({
      outcome: DAILY_OUTCOME.ABSENT,
      fractions: { worked: 0, leave: 0, absent: 1 },
    });
  }
  if (presence === ATTENDANCE_PRESENCE.PARTIAL) {
    return finish({ outcome: DAILY_OUTCOME.UNRESOLVED });
  }
  return finish({
    outcome: band,
    fractions: {
      worked: band === DAILY_OUTCOME.HALF_DAY ? 0.5 : band === DAILY_OUTCOME.ABSENT ? 0 : 1,
      leave: 0,
      absent: band === DAILY_OUTCOME.ABSENT ? 1 : 0,
    },
  });
};
