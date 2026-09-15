// ─────────────────────────────────────────────────────────────
// Phase 31.6 — schedule pure rules.
//
// Deterministic and side-effect-free: no Mongo, no req/res, no
// Redis, no payroll. Timezone work uses ONLY Intl with an explicit
// zone plus UTC getters — server-local time must never leak in
// (static-guarded). Late/early/OT math reuses the 31.1 policy
// rules; nothing here invents thresholds or grace.
// ─────────────────────────────────────────────────────────────
import {
  DAY_TYPE,
  detectEarlyOut,
  detectLate,
  deriveOTEligibleMinutes,
} from './attendancePolicyRules.js';

export const SCHEDULE_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  UNRESOLVED: 'UNRESOLVED',
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isValidDayString = (day) => {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const [year, month, date] = day.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === date
  );
};

export const isValidWallTime = (value) => typeof value === 'string' && TIME_RE.test(value);

export const toMinutes = (hhmm) => {
  const match = typeof hhmm === 'string' ? hhmm.match(TIME_RE) : null;
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

// Overnight in shift-clock semantics: end <= start means the end
// belongs to the NEXT calendar day (mirrors the established
// scheduleEngine.crossesMidnight — duplicated here so this module
// stays dependency-light and pure).
export const shiftCrossesMidnight = (startTime, endTime) => {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (start === null || end === null) return false;
  return end <= start;
};

export const addDays = (day, delta) => {
  const parsed = new Date(`${day}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
};

// IANA zone offset (ms) at an instant, via Intl only — no hardcoded
// offsets, no local-time getters. Positive east of UTC.
const zoneOffsetMs = (instantMs, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  // en-US can emit hour "24" for midnight — normalize to 0.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - instantMs;
};

// "YYYY-MM-DD + HH:MM wall time in `timeZone`" → UTC instant.
// DST folds/gaps resolve to one side deterministically; callers in
// DST zones inherit that documented edge (Kolkata has no DST).
export const zonedTimeToUtc = (day, hhmm, timeZone) => {
  if (!isValidDayString(day) || !isValidWallTime(hhmm)) return null;
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'Asia/Kolkata';
  }
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, date, hour, minute);
  // Two-pass correction so a DST transition between the guess and
  // the truth still converges.
  const first = guess - zoneOffsetMs(guess, zone);
  const second = guess - zoneOffsetMs(first, zone);
  return new Date(second);
};

export const dayKeyInZone = (instant, timeZone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant instanceof Date ? instant : new Date(instant));
  } catch {
    return new Date(instant).toISOString().slice(0, 10);
  }
};

// ── Shift interval (pure) ────────────────────────────────
// The scheduled window for one business date: overnight ends land
// on the next calendar day. Instant math throughout — never naive
// string subtraction.

export const shiftIntervalForDate = ({ date, startTime, endTime, timezone }) => {
  if (!isValidDayString(date) || !isValidWallTime(startTime) || !isValidWallTime(endTime)) {
    return null;
  }
  const crossesMidnight = shiftCrossesMidnight(startTime, endTime);
  const startAt = zonedTimeToUtc(date, startTime, timezone);
  const endAt = zonedTimeToUtc(crossesMidnight ? addDays(date, 1) : date, endTime, timezone);
  if (!startAt || !endAt || endAt.getTime() <= startAt.getTime()) return null;
  return {
    startAt,
    endAt,
    crossesMidnight,
    spanMinutes: Math.round((endAt.getTime() - startAt.getTime()) / 60000),
  };
};

// Expected work minutes: authoritative span minus the rule's own
// break allowance (the Shift/WorkSchedule breakMinutes), clamped.
export const deriveScheduledMinutes = ({ startAt, endAt, breakMinutes }) => {
  const start = startAt instanceof Date ? startAt.getTime() : Number(startAt);
  const end = endAt instanceof Date ? endAt.getTime() : Number(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const span = Math.round((end - start) / 60000);
  return Math.max(0, span - Math.max(0, Math.trunc(Number(breakMinutes) || 0)));
};

// ── Business date (pure) ─────────────────────────────────
// Attendance is anchored to the shift START date. A post-midnight
// instant inside yesterday's overnight window belongs to
// yesterday; anything else belongs to its own calendar day.
// Bounds are inclusive and strict — no invented grace.

export const businessDateForInstant = ({ now, timezone, yesterdayInterval = null }) => {
  const at = now instanceof Date ? now : new Date(now);
  const today = dayKeyInZone(at, timezone);
  if (yesterdayInterval?.startAt && yesterdayInterval?.endAt) {
    const start = new Date(yesterdayInterval.startAt).getTime();
    const end = new Date(yesterdayInterval.endAt).getTime();
    const ms = at.getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && ms >= start && ms <= end) {
      return addDays(today, -1);
    }
  }
  return today;
};

// ── Normalized schedule context (pure) ───────────────────

export const buildScheduleContext = ({
  attendanceDate,
  timezone,
  rule,
  shiftRef = null,
  scheduleRef = null,
  source = null,
  workingDays = [],
  holiday = null,
}) => {
  if (!isValidDayString(attendanceDate)) return null;
  if (!rule || !isValidWallTime(rule.startTime) || !isValidWallTime(rule.endTime)) {
    return {
      status: SCHEDULE_STATUS.UNRESOLVED,
      attendanceDate,
      timezone: timezone || 'Asia/Kolkata',
    };
  }
  const zone = timezone || 'Asia/Kolkata';
  const interval = shiftIntervalForDate({
    date: attendanceDate,
    startTime: rule.startTime,
    endTime: rule.endTime,
    timezone: zone,
  });
  if (!interval) {
    return { status: SCHEDULE_STATUS.UNRESOLVED, attendanceDate, timezone: zone };
  }
  const dayKey = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][
    new Date(`${attendanceDate}T00:00:00Z`).getUTCDay()
  ];
  const isWorkingDay = Array.isArray(workingDays) && workingDays.includes(dayKey);
  const dayType = holiday ? DAY_TYPE.HOLIDAY : !isWorkingDay ? DAY_TYPE.WEEKLY_OFF : DAY_TYPE.WORK_DAY;
  const breakMinutes = Math.max(0, Math.trunc(Number(rule.breakMinutes) || 0));
  return {
    status: SCHEDULE_STATUS.RESOLVED,
    attendanceDate,
    timezone: zone,
    source,
    startTime: rule.startTime,
    endTime: rule.endTime,
    shift: shiftRef,
    schedule: scheduleRef,
    shiftId: shiftRef?.id || null,
    scheduleId: scheduleRef?.id || null,
    scheduledStartAt: interval.startAt,
    scheduledEndAt: interval.endAt,
    crossesMidnight: interval.crossesMidnight,
    spanMinutes: interval.spanMinutes,
    breakMinutes,
    scheduledMinutes: deriveScheduledMinutes({
      startAt: interval.startAt,
      endAt: interval.endAt,
      breakMinutes,
    }),
    minimumMinutes: Number(rule.minWorkingHours || 8) * 60,
    isWorkingDay,
    dayType,
    holiday: holiday ? { name: holiday.name || null, type: holiday.type || null } : null,
  };
};

export const validateScheduleContext = (ctx) => {
  const errors = [];
  if (!ctx || typeof ctx !== 'object') return ['schedule context is required'];
  if (ctx.status === SCHEDULE_STATUS.UNRESOLVED) return [];
  if (ctx.status !== SCHEDULE_STATUS.RESOLVED) errors.push('status must be RESOLVED or UNRESOLVED');
  if (!isValidDayString(ctx.attendanceDate)) errors.push('attendanceDate must be a valid YYYY-MM-DD day');
  const start = ctx.scheduledStartAt ? new Date(ctx.scheduledStartAt).getTime() : NaN;
  const end = ctx.scheduledEndAt ? new Date(ctx.scheduledEndAt).getTime() : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    errors.push('scheduledStartAt/scheduledEndAt must be valid instants');
  } else if (end <= start) {
    errors.push('scheduledEndAt must be after scheduledStartAt');
  }
  if (!Number.isFinite(ctx.scheduledMinutes) || ctx.scheduledMinutes < 0) {
    errors.push('scheduledMinutes must be a non-negative number');
  }
  if (!Object.values(DAY_TYPE).includes(ctx.dayType)) errors.push('dayType must be a known day type');
  return errors;
};

// ── Payroll-facing verdict (pure) ────────────────────────
// Schedule-aware status/late/early/OT from EFFECTIVE facts. All
// semantics are 31.1's (detectLate/detectEarlyOut/
// deriveOTEligibleMinutes); this module only frames them against
// the resolved schedule. Unresolved schedules MUST NOT reach
// here — callers emit the neutral verdict instead (never guess).

export const NEUTRAL_VERDICT = Object.freeze({
  status: 'PRESENT',
  lateMinutes: 0,
  lateBeyondGrace: 0,
  earlyMinutes: 0,
  overtimeMinutes: 0,
  extraMinutes: 0,
  isLate: false,
  isEarlyOut: false,
});

const toMs = (value) => {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

export const deriveScheduleVerdict = ({
  scheduledStartAt,
  scheduledEndAt,
  effectiveIn,
  effectiveOut = null,
  workedMinutes = 0,
  minimumMinutes = 480,
  policy,
  dayType = DAY_TYPE.WORK_DAY,
}) => {
  const start = toMs(scheduledStartAt);
  const end = toMs(scheduledEndAt);
  const inMs = toMs(effectiveIn);
  const outMs = toMs(effectiveOut);
  if (start === null || end === null || end <= start || inMs === null || !policy) {
    return { ...NEUTRAL_VERDICT };
  }
  const late = detectLate(
    Math.round((inMs - start) / 60000),
    policy.grace?.lateInMinutes ?? 0,
  );
  const lateGrace = Math.max(0, Math.trunc(Number(policy.grace?.lateInMinutes) || 0));
  const early = outMs === null
    ? { isEarly: false, earlyMinutes: 0 }
    : detectEarlyOut(
      Math.round((end - outMs) / 60000),
      policy.grace?.earlyOutMinutes ?? 0,
    );
  const extraMinutes = outMs === null ? 0 : Math.max(0, Math.round((outMs - end) / 60000));
  // OT line: 31.8 owns approval, 31.6 only frames the candidate.
  // Overtime (money/math) is NEVER calculated here.
  const ot = outMs === null
    ? { eligibleMinutes: 0 }
    : deriveOTEligibleMinutes({ extraMinutes, overtime: policy.overtime, dayType });
  const worked = Math.max(0, Math.trunc(Number(workedMinutes) || 0));
  const minimum = Math.max(0, Math.trunc(Number(minimumMinutes) || 0));
  const status = outMs === null
    ? (late.isLate ? 'LATE' : 'PRESENT')
    : (worked < minimum ? 'HALF_DAY' : late.isLate ? 'LATE' : 'PRESENT');
  return {
    status,
    lateMinutes: late.lateMinutes,
    lateBeyondGrace: Math.max(0, late.lateMinutes - lateGrace),
    earlyMinutes: early.earlyMinutes,
    overtimeMinutes: Math.max(0, Math.trunc(Number(ot.eligibleMinutes) || 0)),
    extraMinutes,
    isLate: late.isLate,
    isEarlyOut: early.isEarly,
  };
};

// ── Safe display summary (pure) ──────────────────────────

export const summarizeSchedule = (ctx, { now = null } = {}) => {
  if (!ctx || ctx.status !== SCHEDULE_STATUS.RESOLVED) return null;
  const at = now ? new Date(now).getTime() : null;
  const start = new Date(ctx.scheduledStartAt).getTime();
  const end = new Date(ctx.scheduledEndAt).getTime();
  let phase = null;
  if (at !== null && Number.isFinite(at)) {
    if (at < start) phase = 'UPCOMING';
    else if (at <= end) phase = 'IN_WINDOW';
    else phase = 'ENDED';
  }
  const name = ctx.shift?.name || ctx.schedule?.name || 'Scheduled shift';
  return {
    name,
    startTime: ctx.startTime,
    endTime: ctx.endTime,
    crossesMidnight: ctx.crossesMidnight === true,
    windowLabel: ctx.crossesMidnight === true
      ? `${ctx.startTime} – ${ctx.endTime} (+1 day)`
      : `${ctx.startTime} – ${ctx.endTime}`,
    scheduledMinutes: ctx.scheduledMinutes,
    isWorkingDay: ctx.isWorkingDay === true,
    dayType: ctx.dayType,
    holiday: ctx.holiday,
    phase,
  };
};
