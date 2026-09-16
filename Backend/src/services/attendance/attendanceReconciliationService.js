// ─────────────────────────────────────────────────────────────
// Phase 31.7 — attendance reconciliation service (injectable).
//
// Resolves ONE deterministic daily result from the authoritative
// facts: effective attendance (recorded + approved regularization
// overlay) + 31.6 schedule context + APPROVED leave + applicable
// holiday + policy-band work facts. Consumes Leave / Holiday /
// Shift — never mutates them, never duplicates them.
//
// Layering: pure combination lives in
// attendanceReconciliationRules.js (this file only resolves
// contexts, invokes the rules, and persists/reads the additive
// `reconciliation` projection). No payroll math, no payroll reads.
// ─────────────────────────────────────────────────────────────
import { LEAVE_TYPES } from '../../utils/constants.js';
import { DAILY_OUTCOME } from './attendancePolicyRules.js';
import { DAY_PORTION } from './attendanceWorkModeRules.js';
import {
  ATTENDANCE_PRESENCE,
  leaveCoversDate,
  resolveDailyAttendance,
  weekdayKey,
} from './attendanceReconciliationRules.js';

export { ATTENDANCE_PRESENCE, DAILY_OUTCOME, DAY_PORTION };

// Bounded day iteration for leave-range refresh (same 370 cap the
// schedule engine uses for range expansion).
export const eachDayInRange = (from, to, cap = 370) => {
  const out = [];
  if (typeof from !== 'string' || typeof to !== 'string') return out;
  let cursor = from;
  while (cursor <= to && out.length < cap) {
    out.push(cursor);
    const ms = new Date(`${cursor}T00:00:00Z`).getTime();
    if (!Number.isFinite(ms)) break;
    cursor = new Date(ms + 86400000).toISOString().slice(0, 10);
  }
  return out;
};

// APPROVED-only leave cover for one business date. The Leave module
// owns balances and ranges; this only asks "does approved leave
// charge this date" (range match + Leave-counting parity: Mon–Fri).
// The Leave module has no portions, so cover is always FULL_DAY.
// No model, no lookup (fast null): production callers inject the
// real model; hermetic callers without one simply see no leave.
export const resolveLeaveForDay = async ({
  LeaveModel = null,
  companyId,
  userId,
  attendanceDate,
}) => {
  if (!LeaveModel?.find) return null;
  const rows = await LeaveModel.find({
    companyId,
    user: userId,
    status: 'APPROVED',
    startDate: { $lte: attendanceDate },
    endDate: { $gte: attendanceDate },
  }).lean();
  const hit = (rows || []).find((row) => leaveCoversDate({ leave: row, date: attendanceDate }));
  if (!hit) return null;
  return {
    portion: DAY_PORTION.FULL_DAY,
    leaveId: String(hit._id),
    type: hit.type || null,
    label: LEAVE_TYPES[hit.type]?.label || hit.type || null,
  };
};

// Applicable-holiday display facts for one business date (engine
// applicability: company/public + picked optional + department +
// branch + explicit employee; recurring projected).
export const resolveHolidayForDay = async ({
  engine = null,
  companyId,
  user,
  attendanceDate,
}) => {
  const check = engine?.holidayOnDate;
  if (!check) return null;
  const hit = await check(companyId, user || null, attendanceDate);
  if (!hit) return null;
  return { name: hit.name || null, type: hit.type || null };
};

// Weekly-pattern day? Prefer the 31.6 meaning when the caller has
// it (stored snapshot included); else the working-days authority.
export const resolveWeeklyOff = async ({
  schedule = null,
  engine = null,
  companyId,
  user,
  attendanceDate,
}) => {
  if (schedule && typeof schedule.isWorkingDay === 'boolean') {
    return schedule.isWorkingDay === false;
  }
  const check = engine?.getWorkingDaysForUser;
  if (!check) return false;
  const workingDays = await check(companyId, user || null);
  return !(workingDays || []).includes(weekdayKey(attendanceDate));
};

// Effective work facts from a control projection (recorded punches
// as corrected by the approved regularization overlay). The 31.6
// verdict band is reused, never recomputed.
export const attendanceFactsFromControl = (control = null) => {
  const effectiveIn = control?.punchIn || control?.regularization?.correctedIn || null;
  const effectiveOut = control?.punchOut || control?.regularization?.correctedOut || null;
  const presence = effectiveIn && effectiveOut
    ? ATTENDANCE_PRESENCE.FULL
    : effectiveIn || effectiveOut
      ? ATTENDANCE_PRESENCE.PARTIAL
      : ATTENDANCE_PRESENCE.NONE;
  const status = control?.status || null;
  const outcomeBand = presence === ATTENDANCE_PRESENCE.FULL
    ? status === 'HALF_DAY'
      ? DAILY_OUTCOME.HALF_DAY
      : status === 'ABSENT'
        ? DAILY_OUTCOME.ABSENT
        : DAILY_OUTCOME.PRESENT
    : presence === ATTENDANCE_PRESENCE.PARTIAL
      ? DAILY_OUTCOME.UNRESOLVED
      : DAILY_OUTCOME.ABSENT;
  return {
    presence,
    workedMinutes: Number(control?.workMinutes) || 0,
    breakMinutes: Number(control?.breakMinutes) || 0,
    lateMinutes: Number(control?.lateMinutes) || 0,
    earlyMinutes: Number(control?.earlyMinutes) || 0,
    outcomeBand,
    exceptions: Array.isArray(control?.policyExceptions) ? [...control.policyExceptions] : [],
    effectiveIn,
    effectiveOut,
    expectedMinutes: 0,
  };
};

const emptyFacts = () => ({
  presence: ATTENDANCE_PRESENCE.NONE,
  workedMinutes: 0,
  breakMinutes: 0,
  lateMinutes: 0,
  earlyMinutes: 0,
  outcomeBand: DAILY_OUTCOME.ABSENT,
  exceptions: [],
  effectiveIn: null,
  effectiveOut: null,
  expectedMinutes: 0,
});

// Full daily resolution: contexts in, ONE deterministic result out.
// `attendance` (pre-computed facts) wins over `control`; without
// either, the day resolves as no-work (leave/holiday/off/absent).
// `user` should be the populated employee where the caller has one
// (department/branch-scoped holidays need it); id-only degrades to
// company/public/explicit applicability.
export const resolveDay = async ({
  companyId,
  userId,
  user = null,
  attendanceDate,
  attendance = null,
  control = null,
  schedule = null,
  LeaveModel = null,
  engine = null,
}) => {
  const facts = attendance || (control ? attendanceFactsFromControl(control) : emptyFacts());
  if (schedule?.scheduledMinutes) {
    facts.expectedMinutes = Math.round(Number(schedule.scheduledMinutes) / 2);
  }
  const person = user || (userId ? { _id: userId } : null);
  const [leave, holiday, weeklyOff] = await Promise.all([
    resolveLeaveForDay({ LeaveModel, companyId, userId, attendanceDate }),
    resolveHolidayForDay({ engine, companyId, user: person, attendanceDate }),
    resolveWeeklyOff({ schedule, engine, companyId, user: person, attendanceDate }),
  ]);
  return resolveDailyAttendance({
    attendanceDate,
    attendance: facts,
    schedule,
    leave,
    holiday,
    weeklyOff,
  });
};

// Persist the resolution onto the day's control (when one exists).
// Days without punches have no control row by design (31.7 never
// fabricates attendance) — those resolve on read instead.
export const refreshDayProjection = async ({
  AttendanceModel = null,
  now = null,
  ...resolveArgs
}) => {
  if (!AttendanceModel?.findOne) {
    return { resolved: await resolveDay(resolveArgs), persisted: false };
  }
  const control = await AttendanceModel.findOne({
    companyId: resolveArgs.companyId,
    user: resolveArgs.userId,
    date: resolveArgs.attendanceDate,
  });
  // Without a control there are no work facts to combine (and none
  // are fabricated); with one, its effective facts anchor the day.
  const resolved = await resolveDay({ control: control || null, ...resolveArgs });
  if (!control) return { resolved, persisted: false };
  const id = control._id || control.id;
  await AttendanceModel.findOneAndUpdate(
    { _id: id, companyId: resolveArgs.companyId },
    {
      $set: {
        reconciliation: {
          ...resolved,
          resolvedAt: now || new Date(),
          resolvedBy: 'SYSTEM',
        },
      },
    },
  );
  return { resolved, persisted: true };
};

// Leave-transition refresh: after APPROVED / CANCELLED, re-resolve
// every in-range day that HAS a control row (bounded, idempotent,
// per-date isolated). Never throws — a refresh failure must not
// corrupt the Leave workflow; reads recompute on miss anyway.
export const refreshRangeForLeave = async ({
  leave,
  AttendanceModel = null,
  LeaveModel = null,
  UserModel = null,
  engine = null,
  user = null,
  now = null,
}) => {
  const summary = { refreshed: 0, skipped: 0, dates: 0 };
  try {
    if (!leave?.startDate || !leave?.endDate) return summary;
    const companyId = leave.companyId;
    const userId = leave.user?._id || leave.user;
    if (!companyId || !userId) return summary;
    let person = user;
    if (!person && UserModel?.findById) {
      try {
        person = await UserModel.findById(userId).lean();
      } catch {
        person = null;
      }
    }
    const dates = eachDayInRange(leave.startDate, leave.endDate);
    summary.dates = dates.length;
    for (const attendanceDate of dates) {
      try {
        const { persisted } = await refreshDayProjection({
          AttendanceModel,
          LeaveModel,
          engine,
          companyId,
          userId: String(userId),
          user: person,
          attendanceDate,
          now,
        });
        if (persisted) summary.refreshed += 1;
        else summary.skipped += 1;
      } catch {
        summary.skipped += 1;
      }
    }
  } catch {
    // Bounded best-effort: the summary reports what happened.
  }
  return summary;
};
