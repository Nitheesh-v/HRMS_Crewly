// ─────────────────────────────────────────────────────────────
// Phase 31.9 — team presence service (injectable).
//
// The Who's Working board read path: resolve the actor's
// authorized scope, batch every authoritative fact ONCE (zero
// N+1), derive one safe presence row per employee through the
// pure rules, then count/filter/paginate in memory.
//
// Query budget per request (all tenant-scoped, all indexed):
//   scope ids · users · scope count · policy · company tz ·
//   controls · clock-in events · 4 schedule-master loads (one
//   helper) · leaves · regularizations · OT requests ·
//   departments ≈ 14 bounded queries for ANY team size.
//
// Tenant authority is ALWAYS the explicit companyId argument.
// Controllers stay thin; this service owns scope + derivation.
// ─────────────────────────────────────────────────────────────
import Attendance from '../../models/Attendance.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import AttendanceRegularization from '../../models/AttendanceRegularization.js';
import AttendanceOvertimeRequest from '../../models/AttendanceOvertimeRequest.js';
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
import { LIVE_STATE } from './attendancePolicyRules.js';
import {
  SCHEDULE_STATUS,
  addDays,
  businessDateForInstant,
  dayKeyInZone,
} from './attendanceScheduleRules.js';
import {
  holidayOnDateFromMasters,
  preloadScheduleMasters,
  resolveEmployeeScheduleFromMasters,
  resolveStoredSchedule,
} from './attendanceScheduleService.js';
import { leaveCoversDate, weekdayKey } from './attendanceReconciliationRules.js';
import {
  PRESENCE_STATE,
  derivePresence,
  isValidPresenceState,
  isValidWorkModeFilter,
  liveStateOf,
  matchesPresenceFilter,
  matchesWorkModeFilter,
  summarizePresence,
} from './attendancePresenceRules.js';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 60;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
// Same roles as the /company register: company-wide attendance
// visibility (deferred HR_HEAD/HR_EXECUTIVE stay out).
const FULL_ACCESS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];
const OPEN_STATES = [LIVE_STATE.WORKING, LIVE_STATE.ON_BREAK];

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
  policyReader: (args) => getCurrentPolicy(args),
  subtreeReader: (companyId, managerId) => getSubtreeIds(companyId, managerId),
  now: () => new Date(),
});

const strId = (value) => {
  if (value === null || value === undefined) return '';
  return String(value?._id || value);
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const asArrayParam = (value) => {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
};

// Allowlisted query contract — anything else is refused loudly so
// a mistyped filter can never silently widen a board.
const parseListQuery = (query = {}) => {
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, MAX_SEARCH_LENGTH) : '';
  const departmentId = typeof query.departmentId === 'string' && query.departmentId.trim()
    ? query.departmentId.trim()
    : null;
  if (departmentId && !OBJECT_ID_PATTERN.test(departmentId)) {
    throw ApiError.badRequest('Invalid department filter');
  }
  const presence = asArrayParam(query.presence).map(String);
  for (const value of presence) {
    if (!isValidPresenceState(value)) throw ApiError.badRequest(`Invalid presence filter: ${value}`);
  }
  const workMode = asArrayParam(query.workMode).map(String);
  for (const value of workMode) {
    if (!isValidWorkModeFilter(value)) throw ApiError.badRequest(`Invalid work-mode filter: ${value}`);
  }
  const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(query.pageSize)) || DEFAULT_PAGE_SIZE),
  );
  return { search, departmentId, presence, workMode, page, pageSize };
};

// Company/policy timezone for day boundaries (same precedence as
// the live read: policy wins, else company, else IST). Never throws.
const resolveTimezone = async ({ companyId, policy, CompanyModel }) => {
  if (policy?.timezone) return policy.timezone;
  try {
    const company = CompanyModel
      ? await CompanyModel.findById(companyId).select('timezone').lean()
      : null;
    if (company?.timezone) return company.timezone;
  } catch {
    // Timezone lookup must never break the board.
  }
  return DEFAULT_TIMEZONE;
};

// Exact allowlist serializer (§16/§38): safe identity + presence
// facts only. Raw docs NEVER leave this function.
const serializeRow = ({ person, departmentName, derived, locationName }) => ({
  user: {
    id: strId(person._id),
    name: person.name || '',
    employeeCode: person.employeeCode || '',
    avatarUrl: person.avatarUrl || '',
    designation: person.designation || '',
    department: person.department
      ? { id: strId(person.department), name: departmentName || '' }
      : null,
  },
  presence: derived.presence,
  liveState: derived.liveState,
  businessDate: derived.businessDate,
  workMode: derived.workMode,
  // Safe configured office name only (never coordinates, never
  // distance/accuracy, never home location).
  locationName: locationName || null,
  clockInAt: derived.clockInAt,
  clockOutAt: derived.clockOutAt,
  breakStartedAt: derived.breakStartedAt,
  workedMinutes: derived.workedMinutes,
  breakMinutes: derived.breakMinutes,
  schedule: derived.schedule,
  scheduleUnresolved: derived.scheduleUnresolved,
  late: derived.late,
  calendar: derived.calendar,
  exceptions: derived.exceptions,
  needsReview: derived.needsReview,
  regularized: derived.regularized,
  ot: derived.ot,
});

export const getTeamPresence = async ({
  companyId,
  actor,
  query = {},
  deps = {},
}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const actorId = strId(actor?._id || actor?.id);
  if (!actorId) throw ApiError.badRequest('Actor context is required');
  const full = { ...defaultDeps(), ...deps };
  const {
    UserModel,
    AttendanceModel,
    AttendanceEventModel,
    LeaveModel,
    RegularizationModel,
    OvertimeRequestModel,
    DepartmentModel,
    CompanyModel,
    policyReader,
  } = full;
  const filters = parseListQuery(query);
  const at = full.now();

  const { policy } = await policyReader({ companyId });
  const timezone = await resolveTimezone({ companyId, policy, CompanyModel });
  const today = dayKeyInZone(at, timezone);
  const yesterday = addDays(today, -1);
  const lateGraceMinutes = policy?.grace?.lateInMinutes ?? 0;

  // ── Scope (backend-derived, never from the client) ──────────
  const companyScope = FULL_ACCESS.includes(actor?.role);
  let scopeIds;
  if (companyScope) {
    const all = await UserModel.find({ companyId, status: 'ACTIVE' }).select('_id').lean();
    scopeIds = (all || []).map((row) => strId(row._id));
  } else {
    const subtree = await full.subtreeReader(companyId, actorId);
    scopeIds = [...new Set([...(subtree || []).map(String), actorId])];
  }

  // ── Users (Mongo-side filters narrow BEFORE derivation) ─────
  const userFilter = { companyId, status: 'ACTIVE', _id: { $in: scopeIds } };
  if (filters.departmentId) userFilter.department = filters.departmentId;
  if (filters.search) {
    const pattern = { $regex: escapeRegex(filters.search), $options: 'i' };
    userFilter.$or = [{ name: pattern }, { employeeCode: pattern }, { designation: pattern }];
  }
  const [users, scopeTotal, masters, departments] = await Promise.all([
    UserModel.find(userFilter)
      .select('_id name employeeCode avatarUrl designation department')
      .sort({ name: 1, _id: 1 })
      .lean(),
    UserModel.countDocuments({ companyId, status: 'ACTIVE', _id: { $in: scopeIds } }),
    preloadScheduleMasters({
      companyId,
      fromDate: yesterday,
      toDate: today,
      ShiftAssignmentModel: full.ShiftAssignmentModel,
      ShiftModel: full.ShiftModel,
      WorkScheduleModel: full.WorkScheduleModel,
      HolidayModel: full.HolidayModel,
    }),
    DepartmentModel.find({ companyId }).select('_id name').lean(),
  ]);

  const userIds = (users || []).map((person) => person._id);
  const [controls, clockIns, leaves, regs, ots] = userIds.length
    ? await Promise.all([
      AttendanceModel.find({
        companyId,
        user: { $in: userIds },
        $or: [
          { date: { $in: [yesterday, today] } },
          { liveState: { $in: OPEN_STATES } },
          { liveState: null, punchIn: { $ne: null }, punchOut: null },
          { liveState: { $exists: false }, punchIn: { $ne: null }, punchOut: null },
        ],
      }).lean(),
      AttendanceEventModel.find({
        companyId,
        user: { $in: userIds },
        date: { $in: [yesterday, today] },
        type: 'CLOCK_IN',
      }).lean(),
      LeaveModel.find({
        companyId,
        user: { $in: userIds },
        status: 'APPROVED',
        startDate: { $lte: today },
        endDate: { $gte: yesterday },
      }).lean(),
      RegularizationModel.find({
        companyId,
        user: { $in: userIds },
        status: 'PENDING',
        attendanceDate: { $in: [yesterday, today] },
      }).lean(),
      OvertimeRequestModel.find({
        companyId,
        user: { $in: userIds },
        status: { $in: ['PENDING', 'APPROVED'] },
        attendanceDate: { $in: [yesterday, today] },
      }).lean(),
    ])
    : [[], [], [], [], []];

  // ── In-memory indexes (one pass each, no per-user queries) ──
  const controlsByUser = new Map();
  for (const control of controls || []) {
    const key = strId(control.user);
    if (!controlsByUser.has(key)) controlsByUser.set(key, []);
    controlsByUser.get(key).push(control);
  }
  for (const list of controlsByUser.values()) {
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
  }
  const clockInNameByUserDate = new Map();
  for (const event of clockIns || []) {
    clockInNameByUserDate.set(
      `${strId(event.user)}|${event.date}`,
      event?.locationVerification?.locationName || null,
    );
  }
  const leavesByUser = new Map();
  for (const leave of leaves || []) {
    const key = strId(leave.user);
    if (!leavesByUser.has(key)) leavesByUser.set(key, []);
    leavesByUser.get(key).push(leave);
  }
  const regPendingByUserDate = new Set(
    (regs || []).map((row) => `${strId(row.user)}|${row.attendanceDate}`),
  );
  const otByUserDate = new Map();
  for (const row of ots || []) {
    const key = `${strId(row.user)}|${row.attendanceDate}`;
    if (!otByUserDate.has(key)) {
      otByUserDate.set(key, { pending: false, approved: false, compOffApproved: false });
    }
    const flags = otByUserDate.get(key);
    if (row.status === 'PENDING') flags.pending = true;
    if (row.status === 'APPROVED' && row.type === 'COMP_OFF') flags.compOffApproved = true;
    else if (row.status === 'APPROVED') flags.approved = true;
  }
  const departmentNames = new Map(
    (departments || []).map((dept) => [strId(dept._id), dept.name || '']),
  );

  // ── Derive one safe row per employee (pure, in memory) ──────
  const rows = (users || []).map((person) => {
    const key = strId(person._id);
    const personControls = controlsByUser.get(key) || [];

    const todayCtx = resolveEmployeeScheduleFromMasters({
      masters,
      user: person,
      attendanceDate: today,
      timezone,
    });
    const yesterdayCtx = resolveEmployeeScheduleFromMasters({
      masters,
      user: person,
      attendanceDate: yesterday,
      timezone,
    });
    // Overnight attribution (§9): inside yesterday's crossing
    // window the business date is yesterday, not today.
    const businessDate = yesterdayCtx?.status === SCHEDULE_STATUS.RESOLVED
      && yesterdayCtx.crossesMidnight === true
      ? businessDateForInstant({
        now: at,
        timezone,
        yesterdayInterval: {
          startAt: yesterdayCtx.scheduledStartAt,
          endAt: yesterdayCtx.scheduledEndAt,
        },
      })
      : today;

    // Session selection (getLiveAttendance parity): the business
    // date's control, else the newest open session anywhere.
    const primary = personControls.find((control) => control.date === businessDate)
      || personControls.find((control) => OPEN_STATES.includes(liveStateOf(control)))
      || null;
    const liveState = liveStateOf(primary);
    const openControls = personControls.filter((control) => OPEN_STATES.includes(liveStateOf(control)));
    const primaryOpen = primary && OPEN_STATES.includes(liveState);
    const staleOpen = openControls.length > 0
      && (!primaryOpen || openControls.some((control) => control.date < yesterday));

    // Stored schedule meaning wins (31.6 law); otherwise the
    // business date's resolved context.
    const storedCtx = primary ? resolveStoredSchedule({ control: primary }) : null;
    const scheduleCtx = storedCtx
      || (businessDate === today ? todayCtx : yesterdayCtx);

    // Calendar facts, 31.7-style: the holiday applies independent
    // of the schedule verdict; the weekly pattern falls back to
    // the company default when no schedule resolves.
    const holiday = holidayOnDateFromMasters(masters, person, businessDate);
    const weeklyOff = scheduleCtx?.status === SCHEDULE_STATUS.RESOLVED
      ? scheduleCtx.isWorkingDay === false
      : !(DEFAULT_WORKING_DAYS || []).includes(weekdayKey(businessDate));
    const leaveHit = (leavesByUser.get(key) || []).find((leave) =>
      leaveCoversDate({ leave, date: businessDate }),
    );
    const leave = leaveHit
      ? { label: LEAVE_TYPES[leaveHit.type]?.label || leaveHit.type || null }
      : null;

    const otFlags = otByUserDate.get(`${key}|${businessDate}`) || {};
    const derived = derivePresence({
      now: at,
      businessDate,
      control: primary,
      liveState,
      schedule: scheduleCtx,
      leave,
      holiday,
      weeklyOff,
      lateGraceMinutes,
      staleOpen,
      pendingRegularization: regPendingByUserDate.has(`${key}|${businessDate}`),
      otPending: otFlags.pending === true,
      otApproved: otFlags.approved === true,
      compOffApproved: otFlags.compOffApproved === true,
    });

    // Verified office name only, and only while the row's final
    // mode is OFFICE (a corrected WFH day shows no office).
    const locationName = derived.workMode === 'OFFICE' && primary
      ? clockInNameByUserDate.get(`${key}|${primary.date}`) || null
      : null;

    return serializeRow({
      person,
      departmentName: person.department ? departmentNames.get(strId(person.department)) : '',
      derived,
      locationName,
    });
  });

  // ── Derived-side filters → counts → pagination ───────────────
  const filtered = rows.filter(
    (row) => matchesPresenceFilter(row, filters.presence)
      && matchesWorkModeFilter(row, filters.workMode),
  );
  const counts = summarizePresence(filtered);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, totalPages);
  const start = (page - 1) * filters.pageSize;
  const pageRows = filtered.slice(start, start + filters.pageSize);

  return {
    date: today,
    timezone,
    now: at instanceof Date ? at.toISOString() : new Date(at).toISOString(),
    scope: {
      type: companyScope ? 'COMPANY' : 'TEAM',
      total: Number(scopeTotal) || 0,
    },
    counts,
    rows: pageRows,
    page,
    pageSize: filters.pageSize,
    total,
    totalPages,
  };
};

export { PRESENCE_STATE };
