// ─────────────────────────────────────────────────────────────
// Phase 31.6 — attendance schedule resolution service.
//
// The ONE authoritative attendance-facing schedule resolver.
// Consumes the EXISTING Shift / ShiftAssignment / WorkSchedule
// modules (never duplicates them, never writes them) and returns
// a normalized context the attendance code evaluates against.
//
// Resolution order mirrors the established scheduleEngine order
// (employee assignment → department assignment → shift-doc
// fallback → work-schedule chain) so the roster page and
// attendance agree; the difference is dated correctness (the
// assignment effective ON the attendance date) and injectable
// models for hermetic tests. Tenant authority is ALWAYS the
// explicit companyId argument.
// ─────────────────────────────────────────────────────────────
import ShiftAssignment from '../../models/ShiftAssignment.js';
import Shift from '../../models/Shift.js';
import WorkSchedule from '../../models/WorkSchedule.js';
import User from '../../models/User.js';
import { DEFAULT_WORKING_DAYS } from '../../utils/scheduleEngine.js';
import { holidayOnDate as defaultHolidayOnDate } from '../../utils/scheduleEngine.js';
import {
  NEUTRAL_VERDICT,
  SCHEDULE_STATUS,
  buildScheduleContext,
  deriveScheduleVerdict,
  shiftIntervalForDate,
  summarizeSchedule,
} from './attendanceScheduleRules.js';

export { SCHEDULE_STATUS };

const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  return String(value);
};

const dayStartUtc = (attendanceDate) => new Date(`${attendanceDate}T00:00:00Z`);

// The assignment window contains the business date: effectiveFrom
// on/before it AND (open-ended OR effectiveTo on/after it).
const windowFilter = (onDate) => ({
  effectiveFrom: { $lte: onDate },
  $or: [{ effectiveTo: null }, { effectiveTo: { $gte: onDate } }],
});

const matchesWindow = (row, onDate) => {
  if (!row) return false;
  const from = new Date(row.effectiveFrom).getTime();
  if (!Number.isFinite(from) || from > onDate.getTime()) return false;
  if (row.effectiveTo === null || row.effectiveTo === undefined) return true;
  const to = new Date(row.effectiveTo).getTime();
  return Number.isFinite(to) && to >= onDate.getTime();
};

// Follow a referenced doc WITHOUT trusting the pointer: the target
// must belong to the same company and be active, else the pointer
// is treated as missing (cross-tenant ids can never resolve).
const followRef = async ({ Model, companyId, id }) => {
  if (!id) return null;
  const doc = await Model.findOne({ _id: id, companyId }).lean();
  if (!doc) return null;
  if (doc.isActive === false) return null;
  return doc;
};

// Dated shift resolution for one business date. Returns
// { shift, schedule, source } — schedule here is the assignment's
// linked schedule (may be null), NOT the work-schedule fallback.
const resolveDatedShift = async ({ ShiftAssignmentModel, ShiftModel, companyId, user, onDate }) => {
  const uid = idOf(user._id || user);
  const deptId = idOf(user.department?._id || user.department);

  const empAssignment = await ShiftAssignmentModel.findOne({
    companyId,
    user: uid,
    ...windowFilter(onDate),
  })
    .sort('-effectiveFrom')
    .lean();
  if (empAssignment && matchesWindow(empAssignment, onDate)) {
    const shift = await followRef({ Model: ShiftModel, companyId, id: empAssignment.shift });
    if (shift) {
      return { shift, assignment: empAssignment, source: 'EMPLOYEE_OVERRIDE' };
    }
    // Pointer invalid (foreign/inactive/deleted): the assignment
    // cannot resolve — fall through to the next tier.
  }

  if (deptId) {
    const deptAssignment = await ShiftAssignmentModel.findOne({
      companyId,
      department: deptId,
      ...windowFilter(onDate),
    })
      .sort('-effectiveFrom')
      .lean();
    if (deptAssignment && matchesWindow(deptAssignment, onDate)) {
      const shift = await followRef({ Model: ShiftModel, companyId, id: deptAssignment.shift });
      if (shift) {
        return { shift, assignment: deptAssignment, source: 'DEPARTMENT_DEFAULT' };
      }
    }
  }

  // Convenience fallback (engine parity): a shift doc directly
  // listing the employee/department.
  const or = [{ employees: uid }];
  if (deptId) or.push({ departments: deptId });
  const direct = await ShiftModel.findOne({ companyId, isActive: true, $or: or }).lean();
  if (direct) {
    return { shift: direct, assignment: null, source: 'SHIFT_DOC' };
  }
  return { shift: null, assignment: null, source: null };
};

// Work-schedule fallback chain (engine parity): employee →
// department → branch → name:/general/i → oldest active.
const resolveScheduleDoc = async ({ WorkScheduleModel, companyId, user }) => {
  const uid = idOf(user._id || user);
  const deptId = idOf(user.department?._id || user.department);
  const branch = user.branch || '';

  const mine = await WorkScheduleModel.findOne({ companyId, isActive: true, employees: uid }).lean();
  if (mine) return mine;
  if (deptId) {
    const byDept = await WorkScheduleModel.findOne({ companyId, isActive: true, departments: deptId }).lean();
    if (byDept) return byDept;
  }
  if (branch) {
    const byBranch = await WorkScheduleModel.findOne({ companyId, isActive: true, branch }).lean();
    if (byBranch) return byBranch;
  }
  const general = await WorkScheduleModel.findOne({ companyId, isActive: true, name: /general/i }).lean();
  if (general) return general;
  return WorkScheduleModel.findOne({ companyId, isActive: true }).sort('createdAt').lean();
};

// ── Public API ───────────────────────────────────────────

export const resolveEmployeeSchedule = async ({
  companyId,
  user = null,
  userId = null,
  attendanceDate,
  timezone = 'Asia/Kolkata',
  ShiftAssignmentModel = ShiftAssignment,
  ShiftModel = Shift,
  WorkScheduleModel = WorkSchedule,
  UserModel = User,
  engine = null,
}) => {
  const zone = timezone || 'Asia/Kolkata';
  const unresolved = () => ({ status: SCHEDULE_STATUS.UNRESOLVED, attendanceDate, timezone: zone });

  let person = user;
  const uid = idOf(user?._id || user || userId);
  if (!person && UserModel && uid) {
    try {
      person = await UserModel.findById(uid).lean();
    } catch {
      person = null;
    }
  }
  if (!person) person = uid ? { _id: uid } : null;
  if (!person) return unresolved();

  const onDate = dayStartUtc(attendanceDate);
  const dated = await resolveDatedShift({
    ShiftAssignmentModel,
    ShiftModel,
    companyId,
    user: person,
    onDate,
  });

  let schedule = null;
  if (dated.assignment?.schedule) {
    schedule = await followRef({ Model: WorkScheduleModel, companyId, id: dated.assignment.schedule });
  }
  if (!schedule) {
    schedule = await resolveScheduleDoc({ WorkScheduleModel, companyId, user: person });
  }

  const rule = dated.shift || schedule;
  if (!rule) return unresolved();

  const workingDays = schedule?.workingDays?.length ? schedule.workingDays : [...DEFAULT_WORKING_DAYS];
  const dayKey = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][onDate.getUTCDay()];
  let holiday = null;
  if (workingDays.includes(dayKey)) {
    try {
      const check = engine?.holidayOnDate || defaultHolidayOnDate;
      holiday = await check(companyId, person, attendanceDate);
    } catch {
      holiday = null;
    }
  }

  const ctx = buildScheduleContext({
    attendanceDate,
    timezone: zone,
    rule,
    shiftRef: dated.shift ? { id: String(dated.shift._id), name: dated.shift.name || null, type: dated.shift.type || null } : null,
    scheduleRef: schedule ? { id: String(schedule._id), name: schedule.name || null } : null,
    source: dated.shift ? dated.source : schedule ? 'WORK_SCHEDULE' : null,
    workingDays,
    holiday,
  });
  // Provenance for legacy-shaped consumers (the live resolver and
  // the 31.5 rebuild): the winning rule doc plus its parents.
  if (ctx?.status === SCHEDULE_STATUS.RESOLVED) {
    ctx.rule = rule;
    ctx.shiftDoc = dated.shift || null;
    ctx.scheduleDoc = schedule || null;
  }
  return ctx;
};

// Stored meaning, not re-resolution: a control carrying a 31.6
// snapshot evaluates against the snapshot so later Shift edits
// cannot rewrite the day. Returns a resolved context or null.
export const resolveStoredSchedule = ({ control } = {}) => {
  const snapshot = control?.scheduleSnapshot;
  if (!snapshot?.scheduledStartAt || !snapshot?.scheduledEndAt) return null;
  const start = new Date(snapshot.scheduledStartAt);
  const end = new Date(snapshot.scheduledEndAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return {
    status: SCHEDULE_STATUS.RESOLVED,
    attendanceDate: control.date,
    timezone: snapshot.timezone || 'Asia/Kolkata',
    source: snapshot.source || null,
    startTime: snapshot.startTime || null,
    endTime: snapshot.endTime || null,
    shift: snapshot.shiftId ? { id: String(snapshot.shiftId), name: snapshot.shiftName || null, type: snapshot.shiftType || null } : null,
    schedule: snapshot.scheduleId ? { id: String(snapshot.scheduleId), name: snapshot.scheduleName || null } : null,
    shiftId: snapshot.shiftId ? String(snapshot.shiftId) : null,
    scheduleId: snapshot.scheduleId ? String(snapshot.scheduleId) : null,
    scheduledStartAt: start,
    scheduledEndAt: end,
    crossesMidnight: snapshot.crossesMidnight === true,
    spanMinutes: Math.round((end.getTime() - start.getTime()) / 60000),
    breakMinutes: Number(snapshot.breakMinutes) || 0,
    scheduledMinutes: Number(snapshot.scheduledMinutes) || 0,
    minimumMinutes: Number(snapshot.minimumMinutes) || 480,
    isWorkingDay: snapshot.isWorkingDay !== false,
    dayType: snapshot.dayType || 'WORK_DAY',
    holiday: snapshot.holiday || null,
    overtimeEligible: snapshot.overtimeEligible === true,
    fromSnapshot: true,
  };
};

// Persistence shape: everything a future evaluation needs, so the
// Shift master can change without rewriting this day's meaning.
export const buildScheduleSnapshot = ({ ctx, rule = null } = {}) => {
  if (!ctx || ctx.status !== SCHEDULE_STATUS.RESOLVED) return null;
  return {
    shiftId: ctx.shiftId || null,
    shiftName: ctx.shift?.name || null,
    shiftType: ctx.shift?.type || null,
    scheduleId: ctx.scheduleId || null,
    scheduleName: ctx.schedule?.name || null,
    source: ctx.source || null,
    startTime: ctx.startTime || null,
    endTime: ctx.endTime || null,
    scheduledStartAt: ctx.scheduledStartAt,
    scheduledEndAt: ctx.scheduledEndAt,
    scheduledMinutes: ctx.scheduledMinutes,
    breakMinutes: ctx.breakMinutes,
    minimumMinutes: ctx.minimumMinutes,
    crossesMidnight: ctx.crossesMidnight === true,
    isWorkingDay: ctx.isWorkingDay === true,
    dayType: ctx.dayType,
    holiday: ctx.holiday,
    timezone: ctx.timezone,
    graceMinutes: rule?.lateRule?.graceMinutes ?? rule?.graceMinutes ?? null,
    earlyGraceMinutes: rule?.earlyCheckoutRule?.graceMinutes ?? rule?.graceMinutes ?? null,
    overtimeEligible: rule?.overtimeEligible === true,
    resolvedAt: new Date(),
  };
};

// Verdict inputs from a bare rule (legacy/stub paths without a
// resolved context): the rule's times framed on the business date.
export const verdictInputsFromRule = ({ rule, attendanceDate, timezone } = {}) => {
  if (!rule) return null;
  const interval = shiftIntervalForDate({
    date: attendanceDate,
    startTime: rule.startTime,
    endTime: rule.endTime,
    timezone,
  });
  if (!interval) return null;
  return {
    scheduledStartAt: interval.startAt,
    scheduledEndAt: interval.endAt,
    minimumMinutes: Number(rule.minWorkingHours || 8) * 60,
  };
};

// One verdict function for every evaluator (live clock-in,
// live clock-out, 31.5 rebuild): a resolved context evaluates
// against its interval; a bare rule (legacy-injected) frames on
// the business date; anything else stays neutral (never guess).
export const deriveAttendanceVerdict = ({
  resolved,
  attendanceDate,
  timezone,
  policy,
  effectiveIn,
  effectiveOut = null,
  workedMinutes = 0,
}) => {
  const ctx = resolved?.scheduleCtx;
  if (ctx?.status === SCHEDULE_STATUS.RESOLVED) {
    return deriveScheduleVerdict({
      scheduledStartAt: ctx.scheduledStartAt,
      scheduledEndAt: ctx.scheduledEndAt,
      effectiveIn,
      effectiveOut,
      workedMinutes,
      minimumMinutes: ctx.minimumMinutes,
      policy,
      dayType: ctx.dayType,
    });
  }
  const inputs = resolved?.rule
    ? verdictInputsFromRule({ rule: resolved.rule, attendanceDate, timezone })
    : null;
  if (!inputs) return { ...NEUTRAL_VERDICT };
  return deriveScheduleVerdict({
    ...inputs,
    effectiveIn,
    effectiveOut,
    workedMinutes,
    policy,
  });
};

export const summarizeForToday = ({ ctx, now = null } = {}) => summarizeSchedule(ctx, { now });
