// ─────────────────────────────────────────────────────────────
// Phase 31.9 — pure attendance-presence rules.
//
// ONE deterministic derivation layer for the Who's Working board:
// authoritative attendance facts in, safe display presence out.
// No Mongo, no req/res, no Redis, no payroll. The caller passes an
// authoritative `now` — this module never reads the clock and never
// assumes the server's local timezone (all instants compare in UTC).
//
// Vocabulary discipline (§3): the 31.2 LIVE_STATE values
// (NOT_IN/WORKING/ON_BREAK/COMPLETED) are NEVER mutated here —
// presence DISPLAY states are a separate layer carried alongside
// the underlying live state.
// ─────────────────────────────────────────────────────────────
import {
  DAY_TYPE,
  LIVE_STATE,
  WORK_MODE,
} from './attendancePolicyRules.js';
import { SCHEDULE_STATUS } from './attendanceScheduleRules.js';
import { RECONCILIATION_CONFLICT } from './attendanceReconciliationRules.js';

// ── Display presence vocabulary (31.9 only) ────────────────────
// WORKING/ON_BREAK/COMPLETED mirror the underlying live state;
// the rest are calendar/schedule-derived display states for days
// with no open or completed session.

export const PRESENCE_STATE = Object.freeze({
  WORKING: 'WORKING',
  ON_BREAK: 'ON_BREAK',
  COMPLETED: 'COMPLETED',
  ON_LEAVE: 'ON_LEAVE',
  HOLIDAY: 'HOLIDAY',
  WEEKLY_OFF: 'WEEKLY_OFF',
  NOT_IN: 'NOT_IN',
  LATE_NOT_IN: 'LATE_NOT_IN',
  UNRESOLVED: 'UNRESOLVED',
});

// Safe board exception flags (display-only codes — never free
// text, never employee-submitted reasons).

export const PRESENCE_EXCEPTION = Object.freeze({
  LATE_ARRIVAL: 'LATE_ARRIVAL',
  EARLY_EXIT: 'EARLY_EXIT',
  MISSING_PUNCH: 'MISSING_PUNCH',
  REGULARIZATION_PENDING: 'REGULARIZATION_PENDING',
  ATTENDANCE_ON_LEAVE: 'ATTENDANCE_ON_LEAVE',
  STALE_OPEN_SESSION: 'STALE_OPEN_SESSION',
});

export const isValidPresenceState = (value) =>
  typeof value === 'string' && Object.values(PRESENCE_STATE).includes(value);

export const isValidWorkModeFilter = (value) =>
  value === 'NONE' || (typeof value === 'string' && Object.values(WORK_MODE).includes(value));

const toMs = (value) => {
  if (value === null || value === undefined) return NaN;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? NaN : ms;
};

const asIso = (value) => {
  const ms = toMs(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

// Effective clock-in/out: the approved 31.5 overlay wins over the
// recorded punch (same rule the report page displays by).

export const effectiveClockInOf = (control) =>
  control?.regularization?.correctedIn || control?.punchIn || null;

export const effectiveClockOutOf = (control) =>
  control?.regularization?.correctedOut || control?.punchOut || null;

// Underlying 31.2 live state for a control (legacy rows without a
// liveState derive from punchIn/punchOut — same rule as
// attendanceEventRules.deriveLiveState, re-implemented here so
// this module stays dependency-light for hermetic use).

export const liveStateOf = (control) => {
  if (!control) return LIVE_STATE.NOT_IN;
  if (Object.values(LIVE_STATE).includes(control.liveState)) return control.liveState;
  if (control.punchOut) return LIVE_STATE.COMPLETED;
  if (control.punchIn) return LIVE_STATE.WORKING;
  return LIVE_STATE.NOT_IN;
};

const isOpenLiveState = (liveState) =>
  liveState === LIVE_STATE.WORKING || liveState === LIVE_STATE.ON_BREAK;

// Late gate for a no-session day: now strictly beyond the scheduled
// start plus the 31.1 policy grace (31.6-verdict parity — grace
// comes from policy, never from an invented default). Anything
// unresolvable (no interval, bad now) stays NOT late.

export const isLateNotIn = ({ now, scheduledStartAt, lateGraceMinutes = 0 } = {}) => {
  const nowMs = toMs(now);
  const startMs = toMs(scheduledStartAt);
  if (Number.isNaN(nowMs) || Number.isNaN(startMs)) return false;
  const grace = Math.max(0, Math.trunc(Number(lateGraceMinutes) || 0));
  return nowMs > startMs + grace * 60000;
};

// ── Presence derivation ────────────────────────────────────────
// Precedence (§7):
//   open session  → WORKING / ON_BREAK (+ calendar context kept)
//   completed     → COMPLETED (+ calendar context kept)
//   approved full-day leave (no session) → ON_LEAVE
//   holiday (no session)                → HOLIDAY
//   weekly off (no session)             → WEEKLY_OFF
//   unresolved schedule                 → UNRESOLVED (never invented)
//   before start (+grace)               → NOT_IN
//   beyond start+grace, no clock-in     → LATE_NOT_IN
//
// Inputs are pre-fetched authoritative facts:
// - control: the day's Attendance projection (or null)
// - liveState: underlying 31.2 state for that control
// - businessDate: the YYYY-MM-DD the board attributes the row to
// - schedule: resolved 31.6 context for the business date (or
//   { status: UNRESOLVED })
// - leave: { label } when approved leave covers the business date
// - holiday: { name } when a holiday covers the business date
// - weeklyOff: boolean weekly-pattern day
// - staleOpen: true when the open session belongs to an older
//   business date (forgotten clock-out — still a session, flagged)
// - pendingRegularization / ot: batch flags (never reasons)

export const derivePresence = ({
  now,
  businessDate,
  control = null,
  liveState = LIVE_STATE.NOT_IN,
  schedule = null,
  leave = null,
  holiday = null,
  weeklyOff = false,
  lateGraceMinutes = 0,
  staleOpen = false,
  pendingRegularization = false,
  otPending = false,
  otApproved = false,
  compOffApproved = false,
} = {}) => {
  const scheduleResolved = schedule?.status === SCHEDULE_STATUS.RESOLVED;
  const clockInAt = effectiveClockInOf(control);
  const clockOutAt = effectiveClockOutOf(control);
  const open = isOpenLiveState(liveState);
  const completed = liveState === LIVE_STATE.COMPLETED || !!control?.punchOut;

  let presence;
  if (open) {
    presence = liveState === LIVE_STATE.ON_BREAK ? PRESENCE_STATE.ON_BREAK : PRESENCE_STATE.WORKING;
  } else if (completed) {
    presence = PRESENCE_STATE.COMPLETED;
  } else if (leave) {
    presence = PRESENCE_STATE.ON_LEAVE;
  } else if (holiday) {
    presence = PRESENCE_STATE.HOLIDAY;
  } else if (weeklyOff) {
    presence = PRESENCE_STATE.WEEKLY_OFF;
  } else if (!scheduleResolved) {
    presence = PRESENCE_STATE.UNRESOLVED;
  } else if (isLateNotIn({ now, scheduledStartAt: schedule.scheduledStartAt, lateGraceMinutes })) {
    presence = PRESENCE_STATE.LATE_NOT_IN;
  } else {
    presence = PRESENCE_STATE.NOT_IN;
  }

  // Calendar context is NEVER dropped (§7/§8): a working row on a
  // holiday/leave day keeps both facts visible.
  const storedCalendar = control?.reconciliation?.calendar || null;
  const calendarPrimary = storedCalendar?.primary
    || (holiday ? DAY_TYPE.HOLIDAY : weeklyOff ? DAY_TYPE.WEEKLY_OFF : DAY_TYPE.WORK_DAY);
  const calendar = {
    primary: calendarPrimary,
    alsoWeeklyOff: storedCalendar
      ? storedCalendar.alsoWeeklyOff === true
      : Boolean(holiday && weeklyOff),
    holidayName: storedCalendar?.holiday?.name || holiday?.name || null,
    leaveLabel: control?.reconciliation?.leave?.portion && control.reconciliation.leave.portion !== 'NONE'
      ? control.reconciliation.leave.label || leave?.label || null
      : leave?.label || null,
  };

  // Exception flags — every flag is a deterministic boolean over
  // authoritative facts (no text, no reasons).
  const storedConflicts = Array.isArray(control?.reconciliation?.conflicts)
    ? control.reconciliation.conflicts
    : [];
  const attendanceOnLeave = storedConflicts.includes(RECONCILIATION_CONFLICT.ATTENDANCE_ON_APPROVED_LEAVE)
    || ((open || completed) && !!leave && !storedCalendar);
  const exceptions = [];
  if (Number(control?.lateMinutes) > 0) exceptions.push(PRESENCE_EXCEPTION.LATE_ARRIVAL);
  if (Number(control?.earlyMinutes) > 0 && completed) exceptions.push(PRESENCE_EXCEPTION.EARLY_EXIT);
  if (open && !clockInAt) exceptions.push(PRESENCE_EXCEPTION.MISSING_PUNCH);
  if (pendingRegularization) exceptions.push(PRESENCE_EXCEPTION.REGULARIZATION_PENDING);
  if (attendanceOnLeave) exceptions.push(PRESENCE_EXCEPTION.ATTENDANCE_ON_LEAVE);
  if (staleOpen) exceptions.push(PRESENCE_EXCEPTION.STALE_OPEN_SESSION);

  const late = presence === PRESENCE_STATE.LATE_NOT_IN
    ? {
        isLate: true,
        lateMinutes: Math.max(0, Math.round((toMs(now) - toMs(schedule.scheduledStartAt)) / 60000)),
      }
    : { isLate: false, lateMinutes: 0 };

  return {
    presence,
    liveState,
    businessDate,
    workMode: control?.regularization?.correctedWorkMode || control?.workMode || null,
    clockInAt: asIso(clockInAt),
    clockOutAt: asIso(clockOutAt),
    // ON_BREAK rows: the break started at the last recorded event.
    breakStartedAt: liveState === LIVE_STATE.ON_BREAK ? asIso(control?.lastEventAt) : null,
    workedMinutes: Number(control?.workMinutes) || 0,
    breakMinutes: Number(control?.breakMinutes) || 0,
    schedule: scheduleResolved
      ? {
          startTime: schedule.startTime || null,
          endTime: schedule.endTime || null,
          shiftName: schedule.shift?.name || null,
          scheduleName: schedule.schedule?.name || null,
          scheduledStartAt: asIso(schedule.scheduledStartAt),
          scheduledEndAt: asIso(schedule.scheduledEndAt),
          crossesMidnight: schedule.crossesMidnight === true,
        }
      : null,
    scheduleUnresolved: !scheduleResolved,
    late,
    calendar,
    exceptions,
    needsReview: control?.reconciliation?.needsReview === true || attendanceOnLeave,
    regularized: control?.regularized === true,
    ot: {
      pending: otPending === true,
      approved: otApproved === true,
      compOffApproved: compOffApproved === true,
    },
  };
};

// ── Summary counts (KPI semantics, §26) ─────────────────────────
// Status buckets are mutually exclusive (every row lands in exactly
// one); `modes` is an orthogonal breakdown of the working rows
// (WORKING + ON_BREAK) and must NOT be summed with the statuses.

export const EMPTY_PRESENCE_COUNTS = Object.freeze({
  total: 0,
  working: 0,
  onBreak: 0,
  completed: 0,
  notIn: 0,
  lateNotIn: 0,
  onLeave: 0,
  holiday: 0,
  weeklyOff: 0,
  unresolved: 0,
  exceptions: 0,
});

export const EMPTY_MODE_COUNTS = Object.freeze({
  OFFICE: 0,
  WFH: 0,
  FIELD: 0,
  CLIENT_SITE: 0,
  BUSINESS_TRAVEL: 0,
  NONE: 0,
});

const STATUS_BUCKET = Object.freeze({
  [PRESENCE_STATE.WORKING]: 'working',
  [PRESENCE_STATE.ON_BREAK]: 'onBreak',
  [PRESENCE_STATE.COMPLETED]: 'completed',
  [PRESENCE_STATE.NOT_IN]: 'notIn',
  [PRESENCE_STATE.LATE_NOT_IN]: 'lateNotIn',
  [PRESENCE_STATE.ON_LEAVE]: 'onLeave',
  [PRESENCE_STATE.HOLIDAY]: 'holiday',
  [PRESENCE_STATE.WEEKLY_OFF]: 'weeklyOff',
  [PRESENCE_STATE.UNRESOLVED]: 'unresolved',
});

export const summarizePresence = (rows = []) => {
  const counts = { ...EMPTY_PRESENCE_COUNTS };
  const modes = { ...EMPTY_MODE_COUNTS };
  for (const row of rows) {
    const bucket = STATUS_BUCKET[row?.presence];
    if (!bucket) continue;
    counts.total += 1;
    counts[bucket] += 1;
    if (Array.isArray(row?.exceptions) && row.exceptions.length > 0) {
      counts.exceptions += 1;
    }
    if (row?.presence === PRESENCE_STATE.WORKING || row?.presence === PRESENCE_STATE.ON_BREAK) {
      const mode = row?.workMode && modes[row.workMode] !== undefined ? row.workMode : 'NONE';
      modes[mode] += 1;
    }
  }
  return { ...counts, modes };
};

// ── Filter matching (derived-side, allowlisted) ─────────────────
// Mongo-side filters (search/department) narrow the user query;
// these match the derived rows. Unknown values never match —
// callers validate before filtering.

export const matchesPresenceFilter = (row, presenceStates = []) => {
  if (!presenceStates.length) return true;
  return presenceStates.includes(row?.presence);
};

export const matchesWorkModeFilter = (row, workModes = []) => {
  if (!workModes.length) return true;
  return workModes.includes(row?.workMode || 'NONE');
};
