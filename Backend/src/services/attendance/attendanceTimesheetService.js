// ─────────────────────────────────────────────────────────────
// Phase 31.10 — monthly timesheet read service.
//
// Employee calendars, day detail, month summaries, scoped team
// timesheets, and the scoped CSV export. READ-ONLY: the only
// write in this module is the best-effort export-audit row
// (statutory/audit precedent). No payroll math, no money, no
// locks, no status transitions — 31.11 owns finalization.
//
// Daily truth precedence (per user × business date):
//   1. Stored 31.7 reconciliation WITH resolvedAt (frozen meaning:
//      outcome, calendar, leave, halves, fractions, conflicts).
//      Minutes always come from the live control facts so a stored
//      projection can never disagree with corrected punches.
//   2. Else pure live resolution in memory: attendanceFactsFromControl
//      + resolveDailyAttendance over (stored schedule snapshot →
//      batch masters ctx), batch leave, batch holiday, default-
//      pattern weekly-off fallback (31.9 precedent).
// Days have no control row by design when nobody punched (31.7
// never fabricates attendance) — those resolve on read.
// ─────────────────────────────────────────────────────────────
import Attendance from '../../models/Attendance.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import AttendanceRegularization from '../../models/AttendanceRegularization.js';
import AttendanceOvertimeRequest from '../../models/AttendanceOvertimeRequest.js';
import AuditLog from '../../models/AuditLog.js';
import Company from '../../models/Company.js';
import Department from '../../models/Department.js';
import Holiday from '../../models/Holiday.js';
import Leave from '../../models/Leave.js';
import Shift from '../../models/Shift.js';
import ShiftAssignment from '../../models/ShiftAssignment.js';
import User from '../../models/User.js';
import WorkSchedule from '../../models/WorkSchedule.js';
import ApiError from '../../utils/ApiError.js';
import { LEAVE_TYPES, ROLES } from '../../utils/constants.js';
import { DEFAULT_WORKING_DAYS } from '../../utils/scheduleEngine.js';
import { getSubtreeIds } from '../../utils/orgHelpers.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import { DAILY_OUTCOME, DAY_TYPE, LIVE_STATE, dayKeyInZone } from './attendancePolicyRules.js';
import { DAY_PORTION } from './attendanceWorkModeRules.js';
import {
  holidayOnDateFromMasters,
  preloadScheduleMasters,
  resolveEmployeeScheduleFromMasters,
  resolveStoredSchedule,
} from './attendanceScheduleService.js';
import { SCHEDULE_STATUS } from './attendanceScheduleRules.js';
import { attendanceFactsFromControl } from './attendanceReconciliationService.js';
import {
  ATTENDANCE_PRESENCE,
  leaveCoversDate,
  resolveDailyAttendance,
  weekdayKey,
} from './attendanceReconciliationRules.js';
import {
  TIMESHEET_EXCEPTION,
  TIMESHEET_OUTCOME,
  bucketDayOutcome,
  buildExportCsv,
  enumerateMonthDates,
  isValidMonth,
  summarizeMonth,
  summarizeTeamRow,
} from './attendanceTimesheetRules.js';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
// A team-timesheet page carries up to 31 days per employee, so the
// default page is smaller than the live board's (25).
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH_LENGTH = 60;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
// Same roles as the live board: company-wide attendance
// visibility (deferred HR_HEAD/HR_EXECUTIVE stay out).
const FULL_ACCESS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];
const OPEN_STATES = [LIVE_STATE.WORKING, LIVE_STATE.ON_BREAK];
// Display conflicts must be stable vocabulary codes — free text
// (or employee-submitted text) can never reach a timesheet day.
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{2,40}$/;

const defaultDeps = () => ({
  UserModel: User,
  AttendanceModel: Attendance,
  AttendanceEventModel: AttendanceEvent,
  LeaveModel: Leave,
  RegularizationModel: AttendanceRegularization,
  OvertimeRequestModel: AttendanceOvertimeRequest,
  DepartmentModel: Department,
  CompanyModel: Company,
  ShiftAssignmentModel: ShiftAssignment,
  ShiftModel: Shift,
  WorkScheduleModel: WorkSchedule,
  HolidayModel: Holiday,
  AuditLogModel: AuditLog,
  policyReader: (args) => getCurrentPolicy(args),
  subtreeReader: (companyId, managerId) => getSubtreeIds(companyId, managerId),
  now: () => new Date(),
});

const strId = (value) => {
  if (value === null || value === undefined) return '';
  return String(value?._id || value);
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const iso = (value) => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// Allowlisted query contract — anything else is refused loudly so
// a mistyped filter can never silently widen a timesheet.
const parseTimesheetQuery = (query = {}) => {
  const month = typeof query.month === 'string' ? query.month.trim() : '';
  if (!isValidMonth(month)) throw ApiError.badRequest('month must be YYYY-MM');
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, MAX_SEARCH_LENGTH) : '';
  const departmentId = typeof query.departmentId === 'string' && query.departmentId.trim()
    ? query.departmentId.trim()
    : null;
  if (departmentId && !OBJECT_ID_PATTERN.test(departmentId)) {
    throw ApiError.badRequest('Invalid department filter');
  }
  const rawExceptions = query.hasExceptions;
  const hasExceptions = rawExceptions === true || rawExceptions === 'true'
    ? true
    : rawExceptions === undefined || rawExceptions === null || rawExceptions === '' || rawExceptions === 'false'
      ? false
      : null;
  if (hasExceptions === null) throw ApiError.badRequest('Invalid hasExceptions filter');
  const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(query.pageSize)) || DEFAULT_PAGE_SIZE),
  );
  return { month, search, departmentId, hasExceptions, page, pageSize };
};

// Company/policy timezone for day boundaries (same precedence as
// the live read: policy wins, else company, else IST).
// Exported for 31.11 finalization (same precedence, zero behavior change).
export const resolveTimezone = async ({ companyId, policy, CompanyModel }) => {
  if (policy?.timezone) return policy.timezone;
  try {
    const company = CompanyModel
      ? await CompanyModel.findById(companyId).select('timezone').lean()
      : null;
    if (company?.timezone) return company.timezone;
  } catch {
    // Timezone lookup must never break the timesheet.
  }
  return DEFAULT_TIMEZONE;
};

const safeCodes = (values) => (Array.isArray(values) ? values : [])
  .filter((code) => typeof code === 'string' && SAFE_CODE_PATTERN.test(code));

// APPROVED-only leave cover for one business date (batch mirror of
// resolveLeaveForDay: range match + Mon–Fri charging parity, the
// Leave module owns balances; cover is always FULL_DAY).
const pickLeaveForDay = (leaves, date) => {
  const hit = (leaves || []).find((row) => leaveCoversDate({ leave: row, date }));
  if (!hit) return null;
  return {
    portion: DAY_PORTION.FULL_DAY,
    leaveId: strId(hit._id),
    type: hit.type || null,
    label: LEAVE_TYPES[hit.type]?.label || hit.type || null,
  };
};

// One deterministic day object. Stored 31.7 meaning wins when
// frozen (resolvedAt); minutes always come from live control
// facts; everything else resolves purely in memory.
const buildDay = ({
  person,
  date,
  today,
  masters,
  control,
  events,
  leaves,
  regs,
  ot,
}) => {
  const isToday = date === today;
  const isFuture = date > today;
  const schedule = control?.scheduleSnapshot
    ? resolveStoredSchedule({ control })
    : resolveEmployeeScheduleFromMasters({
      masters,
      user: person,
      attendanceDate: date,
      timezone: masters?.timezone,
    });
  const scheduleResolved = schedule?.status === SCHEDULE_STATUS.RESOLVED;
  const holidayHit = holidayOnDateFromMasters(masters, person, date);
  const holiday = holidayHit ? { name: holidayHit.name || null, type: holidayHit.type || null } : null;
  const weeklyOff = typeof schedule?.isWorkingDay === 'boolean'
    ? schedule.isWorkingDay === false
    : !(DEFAULT_WORKING_DAYS || []).includes(weekdayKey(date));
  const leave = isFuture ? null : pickLeaveForDay(leaves, date);

  const facts = control ? attendanceFactsFromControl(control) : null;
  const noWorkFacts = {
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
  };
  const workFacts = facts || { ...noWorkFacts };
  if (schedule?.scheduledMinutes) {
    workFacts.expectedMinutes = Math.round(Number(schedule.scheduledMinutes) / 2);
  }

  const stored = control?.reconciliation?.resolvedAt ? control.reconciliation : null;
  const live = isFuture
    ? null
    : resolveDailyAttendance({
      attendanceDate: date,
      attendance: workFacts,
      schedule,
      leave,
      holiday,
      weeklyOff,
    });
  const resolution = stored || live;
  const fractions = {
    worked: Number(resolution?.fractions?.worked) || 0,
    leave: Number(resolution?.fractions?.leave) || 0,
    absent: Number(resolution?.fractions?.absent) || 0,
  };
  let bucket = bucketDayOutcome({
    isFuture,
    outcome: resolution?.outcome || null,
    fractions,
    calendarPrimary: resolution?.calendar?.primary || DAY_TYPE.WORK_DAY,
    scheduleResolved,
    hasControl: Boolean(control),
  });
  // The current business day with no control yet is still open —
  // absence is an end-of-day determination, so today never reads
  // ABSENT before its facts exist (leave/holiday/off days keep
  // their known buckets; the live outcome stays on the day for
  // transparency).
  if (isToday && !control && !leave && bucket !== TIMESHEET_OUTCOME.FUTURE
    && (resolution?.calendar?.primary || DAY_TYPE.WORK_DAY) === DAY_TYPE.WORK_DAY) {
    bucket = TIMESHEET_OUTCOME.UNRESOLVED;
  }

  const effectiveMode = control?.regularization?.correctedWorkMode || control?.workMode || null;
  const hasSession = Boolean(workFacts.effectiveIn || workFacts.effectiveOut);
  const openNow = isToday && control && OPEN_STATES.includes(control.liveState);
  const pendingRegs = (regs || []).filter((row) => row?.status === 'PENDING');
  const approvedRegs = (regs || []).filter((row) => row?.status === 'APPROVED');
  const exceptions = [];
  if (!isFuture) {
    if (workFacts.lateMinutes > 0) exceptions.push(TIMESHEET_EXCEPTION.LATE_ARRIVAL);
    if (workFacts.earlyMinutes > 0) exceptions.push(TIMESHEET_EXCEPTION.EARLY_EXIT);
    if (hasSession && !(workFacts.effectiveIn && workFacts.effectiveOut) && !openNow) {
      exceptions.push(TIMESHEET_EXCEPTION.MISSING_PUNCH);
    }
    if (pendingRegs.length > 0) exceptions.push(TIMESHEET_EXCEPTION.REGULARIZATION_PENDING);
    if (hasSession && leave?.portion === DAY_PORTION.FULL_DAY) {
      exceptions.push(TIMESHEET_EXCEPTION.ATTENDANCE_ON_LEAVE);
    }
  }

  const otApproved = ot?.status === 'APPROVED';
  const approvedOtMinutes = otApproved && ot?.type === 'OVERTIME'
    ? Math.max(0, Math.trunc(Number(control?.overtimeMinutes ?? ot?.approvedMinutes) || 0))
    : 0;
  const compOffDays = otApproved && ot?.type === 'COMP_OFF'
    ? Math.max(0, Number(ot?.compOffDays) || 0)
    : 0;

  const timeline = (events || [])
    .map((event) => ({
      seq: event?.seq ?? null,
      type: event?.type || null,
      at: iso(event?.at),
      workMode: event?.workMode || null,
      // Safe configured office name only (never coordinates,
      // never distance/accuracy, never home location).
      locationName: event?.locationVerification?.locationName || null,
    }))
    .filter((row) => row.at && row.type)
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  const day = {
    date,
    isToday,
    isFuture,
    bucket,
    outcome: resolution?.outcome || null,
    fractions,
    halves: resolution?.halves?.first || resolution?.halves?.second
      ? {
        first: resolution.halves.first || null,
        second: resolution.halves.second || null,
        midpoint: iso(resolution.halves.midpoint),
      }
      : null,
    calendar: {
      primary: resolution?.calendar?.primary || DAY_TYPE.WORK_DAY,
      alsoWeeklyOff: resolution?.calendar?.alsoWeeklyOff === true,
      holiday: resolution?.calendar?.holiday?.name || holiday
        ? {
          name: resolution?.calendar?.holiday?.name ?? holiday?.name ?? null,
          type: resolution?.calendar?.holiday?.type ?? holiday?.type ?? null,
        }
        : null,
      leave,
    },
    workMode: isFuture ? null : effectiveMode,
    schedule: scheduleResolved
      ? {
        startTime: schedule.startTime || null,
        endTime: schedule.endTime || null,
        shiftName: schedule.shift?.name || null,
        scheduleName: schedule.schedule?.name || null,
        scheduledStartAt: iso(schedule.scheduledStartAt),
        scheduledEndAt: iso(schedule.scheduledEndAt),
        crossesMidnight: schedule.crossesMidnight === true,
        scheduledMinutes: Number(schedule.scheduledMinutes) || 0,
        source: schedule.source || null,
      }
      : null,
    scheduleUnresolved: !scheduleResolved,
    scheduledWorkingDay: typeof schedule?.isWorkingDay === 'boolean'
      ? schedule.isWorkingDay === true
      : (DEFAULT_WORKING_DAYS || []).includes(weekdayKey(date)),
    actual: isFuture
      ? {
        recordedIn: null, recordedOut: null, effectiveIn: null, effectiveOut: null,
        workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, earlyMinutes: 0,
      }
      : {
        recordedIn: iso(control?.punchIn),
        recordedOut: iso(control?.punchOut),
        effectiveIn: iso(workFacts.effectiveIn),
        effectiveOut: iso(workFacts.effectiveOut),
        workedMinutes: workFacts.workedMinutes,
        breakMinutes: workFacts.breakMinutes,
        lateMinutes: workFacts.lateMinutes,
        earlyMinutes: workFacts.earlyMinutes,
      },
    timeline: isFuture ? [] : timeline,
    regularization: {
      // Safe status only — employee reasons and reviewer notes
      // stay in the exception center (31.5 review permission).
      applied: control?.regularization?.appliedAt != null,
      appliedAt: iso(control?.regularization?.appliedAt),
      pending: pendingRegs.length > 0,
      pendingTypes: [...new Set(pendingRegs.map((row) => row?.type).filter(Boolean))],
      approvedTypes: [...new Set(approvedRegs.map((row) => row?.type).filter(Boolean))],
    },
    regularized: control?.regularization?.appliedAt != null,
    exceptions,
    conflicts: isFuture ? [] : safeCodes(resolution?.conflicts),
    needsReview: isFuture ? false : resolution?.needsReview === true,
    ot: ot && (ot.status === 'PENDING' || ot.status === 'APPROVED')
      ? {
        type: ot.type || null,
        status: ot.status || null,
        recordedMinutes: Math.max(0, Math.trunc(Number(ot.recordedMinutes) || 0)),
        eligibleMinutes: Math.max(0, Math.trunc(Number(ot.eligibleMinutes) || 0)),
        requestedMinutes: Math.max(0, Math.trunc(Number(ot.requestedMinutes) || 0)),
        approvedMinutes: ot.approvedMinutes == null
          ? null
          : Math.max(0, Math.trunc(Number(ot.approvedMinutes) || 0)),
        compOffDays: ot.compOffDays == null ? null : Math.max(0, Number(ot.compOffDays) || 0),
      }
      : null,
    approvedOtMinutes,
    compOffDays,
    calendarPrimary: resolution?.calendar?.primary || DAY_TYPE.WORK_DAY,
    hasSession: isFuture ? false : hasSession,
    // 31.11 validation seam: open live session on this business
    // date regardless of past/today (future days never open).
    sessionOpen: isFuture ? false : Boolean(control && OPEN_STATES.includes(control.liveState)),
    workedMinutes: isFuture ? 0 : workFacts.workedMinutes,
    breakMinutes: isFuture ? 0 : workFacts.breakMinutes,
  };
  return day;
};

// Batch indexes: one pass per collection, no per-user queries.
const indexByUserDate = (rows, userKey = 'user', dateKey = 'date') => {
  const map = new Map();
  for (const row of rows || []) {
    const key = `${strId(row?.[userKey])}|${row?.[dateKey]}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

const indexByUser = (rows, userKey = 'user') => {
  const map = new Map();
  for (const row of rows || []) {
    const key = strId(row?.[userKey]);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

// Whole-month derivation for already-scoped users. Bounded reads:
// masters(4-in-1) + controls + events + leaves + regs + ots.
// Exported for 31.11 finalization (whole-company derivation reuse).
export const deriveMonths = async ({
  companyId,
  users,
  dates,
  today,
  timezone,
  policy,
  full,
}) => {
  const start = dates[0];
  const end = dates[dates.length - 1];
  const userIds = (users || []).map((person) => person._id);
  const [masters, controls, events, leaves, regs, ots] = userIds.length
    ? await Promise.all([
      preloadScheduleMasters({
        companyId,
        fromDate: start,
        toDate: end,
        ShiftAssignmentModel: full.ShiftAssignmentModel,
        ShiftModel: full.ShiftModel,
        WorkScheduleModel: full.WorkScheduleModel,
        HolidayModel: full.HolidayModel,
      }),
      full.AttendanceModel.find({
        companyId,
        user: { $in: userIds },
        date: { $gte: start, $lte: end },
      }).lean(),
      full.AttendanceEventModel.find({
        companyId,
        user: { $in: userIds },
        date: { $gte: start, $lte: end },
      }).lean(),
      full.LeaveModel.find({
        companyId,
        user: { $in: userIds },
        status: 'APPROVED',
        startDate: { $lte: end },
        endDate: { $gte: start },
      }).lean(),
      full.RegularizationModel.find({
        companyId,
        user: { $in: userIds },
        status: { $in: ['PENDING', 'APPROVED'] },
        attendanceDate: { $gte: start, $lte: end },
      }).lean(),
      full.OvertimeRequestModel.find({
        companyId,
        user: { $in: userIds },
        status: { $in: ['PENDING', 'APPROVED'] },
        attendanceDate: { $gte: start, $lte: end },
      }).lean(),
    ])
    : [null, [], [], [], [], []];
  const mastersWithZone = { ...(masters || {}), timezone };
  const controlsByKey = indexByUserDate(controls, 'user', 'date');
  const eventsByKey = indexByUserDate(events, 'user', 'date');
  const leavesByUser = indexByUser(leaves, 'user');
  const regsByKey = indexByUserDate(regs, 'user', 'attendanceDate');
  const otsByKey = indexByUserDate(ots, 'user', 'attendanceDate');

  const months = new Map();
  for (const person of users || []) {
    const uid = strId(person._id);
    const days = dates.map((date) => buildDay({
      person,
      date,
      today,
      masters: mastersWithZone,
      control: (controlsByKey.get(`${uid}|${date}`) || [])[0] || null,
      events: eventsByKey.get(`${uid}|${date}`) || [],
      leaves: leavesByUser.get(uid) || [],
      regs: regsByKey.get(`${uid}|${date}`) || [],
      // One live request per day max (31.8 unique partial index).
      ot: (otsByKey.get(`${uid}|${date}`) || [])[0] || null,
    }));
    months.set(uid, { days, summary: summarizeMonth(days) });
  }
  return months;
};

// Exact allowlist serializer: safe identity + timesheet facts
// only. Raw docs NEVER leave this function.
const serializeEmployee = ({ person, departmentsById }) => ({
  id: strId(person._id),
  name: person.name || '',
  employeeCode: person.employeeCode || '',
  avatarUrl: person.avatarUrl || '',
  designation: person.designation || '',
  department: person.department
    ? { id: strId(person.department), name: departmentsById.get(strId(person.department)) || '' }
    : null,
});

const resolveScopeIds = async ({ companyId, actor, UserModel, subtreeReader }) => {
  const companyScope = FULL_ACCESS.includes(actor?.role);
  if (companyScope) {
    const all = await UserModel.find({ companyId, status: 'ACTIVE' }).select('_id').lean();
    return { scope: 'COMPANY', scopeIds: (all || []).map((row) => strId(row._id)) };
  }
  const actorId = strId(actor?._id || actor?.id);
  const subtree = await subtreeReader(companyId, actorId);
  return {
    scope: 'TEAM',
    scopeIds: [...new Set([...(subtree || []).map(String), actorId])],
  };
};

const SAFE_USER_SELECT = '_id name employeeCode avatarUrl designation department branch';

// ── Self-service month ─────────────────────────────────────────
export const getMyTimesheet = async ({ companyId, actor, month, deps = {} }) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const actorId = strId(actor?._id || actor?.id);
  if (!actorId) throw ApiError.badRequest('Actor context is required');
  if (!isValidMonth(month)) throw ApiError.badRequest('month must be YYYY-MM');
  const full = { ...defaultDeps(), ...deps };

  const { policy } = await full.policyReader({ companyId });
  const timezone = await resolveTimezone({ companyId, policy, CompanyModel: full.CompanyModel });
  const today = dayKeyInZone(full.now(), timezone);
  const dates = enumerateMonthDates(month);

  const [person, departments] = await Promise.all([
    full.UserModel.findOne({ _id: actorId, companyId, status: 'ACTIVE' })
      .select(SAFE_USER_SELECT)
      .lean(),
    full.DepartmentModel.find({ companyId }).select('_id name').lean(),
  ]);
  if (!person) throw ApiError.notFound('Employee not found');
  const months = await deriveMonths({
    companyId, users: [person], dates, today, timezone, policy, full,
  });
  const departmentsById = new Map(
    (departments || []).map((row) => [strId(row._id), row.name || '']),
  );
  const { days, summary } = months.get(actorId) || { days: [], summary: summarizeMonth([]) };
  return {
    month,
    timezone,
    today,
    employee: serializeEmployee({ person, departmentsById }),
    days,
    summary,
  };
};

// ── One scoped employee month (manager/HR drill-down) ──────────
export const getEmployeeTimesheet = async ({ companyId, actor, employeeId, month, deps = {} }) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const actorId = strId(actor?._id || actor?.id);
  if (!actorId) throw ApiError.badRequest('Actor context is required');
  if (!isValidMonth(month)) throw ApiError.badRequest('month must be YYYY-MM');
  const targetId = strId(employeeId);
  if (!targetId || !OBJECT_ID_PATTERN.test(targetId)) throw ApiError.badRequest('Invalid employee id');
  const full = { ...defaultDeps(), ...deps };

  const { policy } = await full.policyReader({ companyId });
  const timezone = await resolveTimezone({ companyId, policy, CompanyModel: full.CompanyModel });
  const today = dayKeyInZone(full.now(), timezone);
  const dates = enumerateMonthDates(month);

  const { scope, scopeIds } = await resolveScopeIds({
    companyId, actor, UserModel: full.UserModel, subtreeReader: full.subtreeReader,
  });
  if (!scopeIds.includes(targetId)) {
    throw ApiError.forbidden('Employee is outside your timesheet scope');
  }
  const [person, departments] = await Promise.all([
    full.UserModel.findOne({ _id: targetId, companyId, status: 'ACTIVE' })
      .select(SAFE_USER_SELECT)
      .lean(),
    full.DepartmentModel.find({ companyId }).select('_id name').lean(),
  ]);
  if (!person) throw ApiError.notFound('Employee not found');
  const months = await deriveMonths({
    companyId, users: [person], dates, today, timezone, policy, full,
  });
  const departmentsById = new Map(
    (departments || []).map((row) => [strId(row._id), row.name || '']),
  );
  const { days, summary } = months.get(targetId) || { days: [], summary: summarizeMonth([]) };
  return {
    month,
    timezone,
    today,
    scope,
    employee: serializeEmployee({ person, departmentsById }),
    days,
    summary,
  };
};

// ── Scoped team table ──────────────────────────────────────────
// Without the exception filter, users paginate in Mongo and only
// the visible page is derived. With it, every scoped month is
// derived in memory (CPU-only), then filtered + paginated — the
// flag cannot be expressed as a Mongo predicate.
export const getTeamTimesheets = async ({ companyId, actor, query = {}, deps = {} }) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const actorId = strId(actor?._id || actor?.id);
  if (!actorId) throw ApiError.badRequest('Actor context is required');
  const full = { ...defaultDeps(), ...deps };
  const filters = parseTimesheetQuery(query);

  const { policy } = await full.policyReader({ companyId });
  const timezone = await resolveTimezone({ companyId, policy, CompanyModel: full.CompanyModel });
  const today = dayKeyInZone(full.now(), timezone);
  const dates = enumerateMonthDates(filters.month);

  const { scope, scopeIds } = await resolveScopeIds({
    companyId, actor, UserModel: full.UserModel, subtreeReader: full.subtreeReader,
  });
  const userFilter = { companyId, status: 'ACTIVE', _id: { $in: scopeIds } };
  if (filters.departmentId) userFilter.department = filters.departmentId;
  if (filters.search) {
    const pattern = { $regex: escapeRegex(filters.search), $options: 'i' };
    userFilter.$or = [{ name: pattern }, { employeeCode: pattern }, { designation: pattern }];
  }
  const departments = await full.DepartmentModel.find({ companyId }).select('_id name').lean();
  const departmentsById = new Map(
    (departments || []).map((row) => [strId(row._id), row.name || '']),
  );

  let pageUsers;
  let total;
  if (filters.hasExceptions) {
    const all = await full.UserModel.find(userFilter)
      .select(SAFE_USER_SELECT)
      .sort({ name: 1, _id: 1 })
      .lean();
    const months = await deriveMonths({
      companyId, users: all, dates, today, timezone, policy, full,
    });
    const flagged = (all || []).filter(
      (person) => (months.get(strId(person._id))?.summary?.exceptionDays || 0) > 0,
    );
    total = flagged.length;
    const start = (filters.page - 1) * filters.pageSize;
    pageUsers = flagged.slice(start, start + filters.pageSize).map((person) => ({
      person,
      summary: months.get(strId(person._id)).summary,
    }));
  } else {
    const [users, count] = await Promise.all([
      full.UserModel.find(userFilter)
        .select(SAFE_USER_SELECT)
        .sort({ name: 1, _id: 1 })
        .skip((filters.page - 1) * filters.pageSize)
        .limit(filters.pageSize)
        .lean(),
      full.UserModel.countDocuments(userFilter),
    ]);
    const months = await deriveMonths({
      companyId, users, dates, today, timezone, policy, full,
    });
    total = count;
    pageUsers = (users || []).map((person) => ({
      person,
      summary: months.get(strId(person._id)).summary,
    }));
  }

  return {
    month: filters.month,
    timezone,
    today,
    scope,
    filters: {
      search: filters.search,
      departmentId: filters.departmentId,
      hasExceptions: filters.hasExceptions,
    },
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    rows: pageUsers.map(({ person, summary }) => ({
      user: serializeEmployee({ person, departmentsById }),
      summary: summarizeTeamRow(summary),
    })),
  };
};

// ── Scoped CSV export ──────────────────────────────────────────
// Same scope + filters as the team table (page ignored — the
// export always covers the whole filtered scope for the month).
// Audited once with safe metadata (statutory/audit precedent);
// the audit write is best-effort and never fails the download.
export const exportTeamTimesheets = async ({
  companyId, actor, query = {}, deps = {},
}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const actorId = strId(actor?._id || actor?.id);
  if (!actorId) throw ApiError.badRequest('Actor context is required');
  const full = { ...defaultDeps(), ...deps };
  const filters = parseTimesheetQuery(query);

  const { policy } = await full.policyReader({ companyId });
  const timezone = await resolveTimezone({ companyId, policy, CompanyModel: full.CompanyModel });
  const today = dayKeyInZone(full.now(), timezone);
  const dates = enumerateMonthDates(filters.month);

  const { scope, scopeIds } = await resolveScopeIds({
    companyId, actor, UserModel: full.UserModel, subtreeReader: full.subtreeReader,
  });
  const userFilter = { companyId, status: 'ACTIVE', _id: { $in: scopeIds } };
  if (filters.departmentId) userFilter.department = filters.departmentId;
  if (filters.search) {
    const pattern = { $regex: escapeRegex(filters.search), $options: 'i' };
    userFilter.$or = [{ name: pattern }, { employeeCode: pattern }, { designation: pattern }];
  }
  const [users, departments] = await Promise.all([
    full.UserModel.find(userFilter).select(SAFE_USER_SELECT).sort({ name: 1, _id: 1 }).lean(),
    full.DepartmentModel.find({ companyId }).select('_id name').lean(),
  ]);
  const departmentsById = new Map(
    (departments || []).map((row) => [strId(row._id), row.name || '']),
  );
  const months = await deriveMonths({
    companyId, users, dates, today, timezone, policy, full,
  });

  const rows = [];
  for (const person of users || []) {
    const entry = months.get(strId(person._id));
    if (!entry) continue;
    if (filters.hasExceptions && (entry.summary?.exceptionDays || 0) === 0) continue;
    const identity = serializeEmployee({ person, departmentsById });
    for (const day of entry.days) {
      rows.push({
        employeeName: identity.name,
        employeeCode: identity.employeeCode,
        departmentName: identity.department?.name || '',
        date: day.date,
        outcome: day.bucket,
        scheduledIn: day.schedule?.startTime || '',
        scheduledOut: day.schedule?.endTime || '',
        effectiveIn: day.actual?.effectiveIn || '',
        effectiveOut: day.actual?.effectiveOut || '',
        workedMinutes: day.isFuture ? '' : day.workedMinutes,
        breakMinutes: day.isFuture ? '' : day.breakMinutes,
        workMode: day.workMode || '',
        leaveLabel: day.calendar?.leave?.label || '',
        calendar: day.calendar?.primary || '',
        holidayName: day.calendar?.holiday?.name || '',
        lateMinutes: day.isFuture ? '' : day.actual.lateMinutes,
        earlyMinutes: day.isFuture ? '' : day.actual.earlyMinutes,
        approvedOtMinutes: day.isFuture ? '' : day.approvedOtMinutes,
        compOffDays: day.isFuture ? '' : day.compOffDays,
        exceptions: day.exceptions,
        regularized: day.regularized,
      });
    }
  }
  const content = buildExportCsv(rows);
  const filename = `crewly-timesheet-${scope.toLowerCase()}-${filters.month}.csv`;

  try {
    await full.AuditLogModel.create({
      companyId,
      actor: actorId,
      actorName: actor?.name || '',
      actorRole: actor?.role || '',
      action: 'ATTENDANCE_TIMESHEET_EXPORTED',
      method: 'GET',
      path: '/api/attendance/timesheets/export',
      statusCode: 200,
      metadata: {
        month: filters.month,
        scope,
        format: 'CSV',
        employees: (users || []).length,
        rows: rows.length,
        filename,
      },
    });
  } catch {
    // Export auditing must never fail the download.
  }

  return {
    filename,
    contentType: 'text/csv; charset=utf-8',
    content,
    rowCount: rows.length,
    employeeCount: (users || []).length,
  };
};

export { TIMESHEET_OUTCOME, TIMESHEET_EXCEPTION };
