// ─────────────────────────────────────────────────────────────
// Phase 31.12 — HR attendance-operations service (injectable,
// read-only).
//
// The operations dashboard does NOT derive presence: it calls
// 31.9's getTeamPresence once (inheriting its org scope, batch
// loading, overnight attribution and safe serializer verbatim)
// and aggregates the returned rows through the pure operations
// rules. Everything 31.9 does not carry arrives in four bounded,
// tenant-scoped, indexed batch reads:
//
//   employment fields · approved exits · pending regularizations
//   · pending OT/comp-off
//
// Query budget per request ≈ 18 bounded queries for ANY headcount
// (+2 timezone reads only when ?date=yesterday is used). No N+1:
// every follow-up read is a single $in over the board's user ids.
//
// Tenant authority is ALWAYS the explicit companyId argument.
// No audit writes (dashboard reads are not audited, §33). No
// cache, no queue, no mutations, no money, no GPS.
// ─────────────────────────────────────────────────────────────
import Attendance from '../../models/Attendance.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import AttendanceRegularization from '../../models/AttendanceRegularization.js';
import AttendanceOvertimeRequest from '../../models/AttendanceOvertimeRequest.js';
import Company from '../../models/Company.js';
import Department from '../../models/Department.js';
import Holiday from '../../models/Holiday.js';
import Leave from '../../models/Leave.js';
import Resignation from '../../models/Resignation.js';
import Shift from '../../models/Shift.js';
import ShiftAssignment from '../../models/ShiftAssignment.js';
import User from '../../models/User.js';
import WorkSchedule from '../../models/WorkSchedule.js';
import ApiError from '../../utils/ApiError.js';
import { getSubtreeIds } from '../../utils/orgHelpers.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import {
  isValidPresenceState,
  isValidWorkModeFilter,
} from './attendancePresenceRules.js';
import { getTeamPresence } from './attendancePresenceService.js';
import {
  addDays,
  dayKeyInZone,
  zonedTimeToUtc,
} from './attendanceScheduleRules.js';
import {
  ATTENTION_SEVERITY,
  classifyAttention,
  groupOperations,
  isApplicable,
  isValidAttentionCategory,
  matchesOpsFilters,
  paginate,
  serializeAttentionItem,
  summarizeOperations,
} from './attendanceOperationsRules.js';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 60;
const MAX_TEXT_FILTER_LENGTH = 60;
const MAX_WORKFLOW_ITEMS = 10;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const defaultDeps = () => ({
  UserModel: User,
  AttendanceModel: Attendance,
  AttendanceEventModel: AttendanceEvent,
  LeaveModel: Leave,
  RegularizationModel: AttendanceRegularization,
  OvertimeRequestModel: AttendanceOvertimeRequest,
  ResignationModel: Resignation,
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

const asArrayParam = (value) => {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
};

const asIdParam = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = String(value).trim();
  if (!OBJECT_ID_PATTERN.test(trimmed)) throw ApiError.badRequest(`Invalid ${label} filter`);
  return trimmed;
};

const asTextParam = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = String(value).trim().slice(0, MAX_TEXT_FILTER_LENGTH);
  if (!trimmed) return null;
  void label;
  return trimmed;
};

// Allowlisted dashboard query — anything else is refused loudly.
const parseOpsQuery = (query = {}) => {
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, MAX_SEARCH_LENGTH) : '';
  const departmentId = asIdParam(query.departmentId, 'department');
  const managerId = asIdParam(query.managerId, 'manager');
  const shift = asTextParam(query.shift, 'shift');
  const location = asTextParam(query.location, 'location');
  const presence = asArrayParam(query.presence).map(String);
  for (const value of presence) {
    if (!isValidPresenceState(value)) throw ApiError.badRequest(`Invalid presence filter: ${value}`);
  }
  const workMode = asArrayParam(query.workMode).map(String);
  for (const value of workMode) {
    if (!isValidWorkModeFilter(value)) throw ApiError.badRequest(`Invalid work-mode filter: ${value}`);
  }
  const categories = asArrayParam(query.category).map(String);
  for (const value of categories) {
    if (!isValidAttentionCategory(value)) throw ApiError.badRequest(`Invalid attention filter: ${value}`);
  }
  let date = null;
  if (query.date !== undefined && query.date !== null && query.date !== '') {
    date = String(query.date).trim();
    if (!DAY_PATTERN.test(date)) throw ApiError.badRequest('Invalid date filter (expected YYYY-MM-DD)');
  }
  const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(query.pageSize)) || DEFAULT_PAGE_SIZE),
  );
  return { search, departmentId, managerId, shift, location, presence, workMode, categories, date, page, pageSize };
};

const resolveTimezone = async ({ companyId, CompanyModel, policyReader }) => {
  let policy = null;
  try {
    ({ policy } = await policyReader({ companyId }));
  } catch {
    policy = null;
  }
  if (policy?.timezone) return policy.timezone;
  try {
    const company = CompanyModel
      ? await CompanyModel.findById(companyId).select('timezone').lean()
      : null;
    if (company?.timezone) return company.timezone;
  } catch {
    // Timezone lookup must never break the dashboard.
  }
  return DEFAULT_TIMEZONE;
};

const dayKeyOf = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && DAY_PATTERN.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

const severityRank = (severity) => {
  if (severity === ATTENTION_SEVERITY.BLOCKER) return 0;
  if (severity === ATTENTION_SEVERITY.WARNING) return 1;
  return 2;
};

export const getOperationsDashboard = async ({
  companyId,
  actor,
  query = {},
  deps = {},
}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const actorId = strId(actor?._id || actor?.id);
  if (!actorId) throw ApiError.badRequest('Actor context is required');
  const full = { ...defaultDeps(), ...deps };
  const filters = parseOpsQuery(query);
  const at = full.now();

  // ── Business date (today default; yesterday on request) ─────
  // 31.9 derives its board date from the injected `now`, so a
  // yesterday review reuses the exact same derivation by moving
  // the instant — no second code path, no semantic drift.
  let effectiveNow = at;
  if (filters.date) {
    const timezone = await resolveTimezone({
      companyId,
      CompanyModel: full.CompanyModel,
      policyReader: full.policyReader,
    });
    const todayKey = dayKeyInZone(at, timezone);
    const yesterdayKey = addDays(todayKey, -1);
    if (filters.date !== todayKey && filters.date !== yesterdayKey) {
      throw ApiError.badRequest('Only today or yesterday can be reviewed');
    }
    if (filters.date === yesterdayKey) {
      effectiveNow = zonedTimeToUtc(yesterdayKey, '23:59', timezone) || at;
    }
  }

  // ── 31.9 board (scope + presence + safe rows, verbatim) ──────
  // search/departmentId narrow in Mongo; every other dashboard
  // filter applies derived-side so one row set drives KPIs,
  // groupings and the queue identically.
  const board = await getTeamPresence({
    companyId,
    actor,
    query: {
      search: filters.search,
      departmentId: filters.departmentId,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    },
    deps: {
      UserModel: full.UserModel,
      AttendanceModel: full.AttendanceModel,
      AttendanceEventModel: full.AttendanceEventModel,
      LeaveModel: full.LeaveModel,
      RegularizationModel: full.RegularizationModel,
      OvertimeRequestModel: full.OvertimeRequestModel,
      DepartmentModel: full.DepartmentModel,
      CompanyModel: full.CompanyModel,
      ShiftAssignmentModel: full.ShiftAssignmentModel,
      ShiftModel: full.ShiftModel,
      WorkScheduleModel: full.WorkScheduleModel,
      HolidayModel: full.HolidayModel,
      policyReader: full.policyReader,
      subtreeReader: full.subtreeReader,
      now: () => effectiveNow,
    },
    includeAllRows: true,
    opsFacts: true,
  });
  const businessDate = board.date;
  const allRows = Array.isArray(board.allRows) ? board.allRows : [];
  const userIds = [...new Set(allRows.map((row) => String(row?.user?.id)).filter(Boolean))];

  // ── Bounded follow-up reads (one query each, never per-row) ──
  const prevDay = addDays(businessDate, -1);
  const [employmentDocs, exitDocs, pendingRegs, pendingOts] = userIds.length > 0
    ? await Promise.all([
      full.UserModel.find({ _id: { $in: userIds } })
        .select('_id dateOfJoining reportingTo')
        .lean(),
      full.ResignationModel.find({ companyId, user: { $in: userIds }, status: 'APPROVED' })
        .select('user lastWorkingDate')
        .lean(),
      full.RegularizationModel.find({
        companyId,
        user: { $in: userIds },
        status: 'PENDING',
        attendanceDate: { $in: [prevDay, businessDate] },
      })
        .select('_id user attendanceDate type createdAt')
        .sort({ createdAt: -1 })
        .lean(),
      full.OvertimeRequestModel.find({
        companyId,
        user: { $in: userIds },
        status: 'PENDING',
        attendanceDate: { $in: [prevDay, businessDate] },
      })
        .select('_id user attendanceDate type createdAt')
        .sort({ createdAt: -1 })
        .lean(),
    ])
    : [[], [], [], []];

  const employmentByUser = new Map();
  for (const doc of employmentDocs || []) {
    employmentByUser.set(String(doc._id), {
      dateOfJoining: dayKeyOf(doc.dateOfJoining),
      lastWorkingDate: null,
      reportingTo: doc.reportingTo ? String(doc.reportingTo) : null,
    });
  }
  for (const doc of exitDocs || []) {
    const key = strId(doc.user);
    const exitKey = dayKeyOf(doc.lastWorkingDate);
    const entry = employmentByUser.get(key) || { dateOfJoining: null, lastWorkingDate: null, reportingTo: null };
    if (exitKey && (!entry.lastWorkingDate || exitKey < entry.lastWorkingDate)) {
      entry.lastWorkingDate = exitKey;
    }
    employmentByUser.set(key, entry);
  }
  const employmentOf = (row) => employmentByUser.get(String(row?.user?.id)) || null;

  // ── Aggregate (pure rules over ONE filtered row set) ─────────
  // 31.9 precedent: every derived-side filter narrows KPIs,
  // groupings and the queue identically, so counts always match
  // the rows HR sees. scope.total (from 31.9) keeps reporting
  // the authorized scope size regardless of filters.
  const derivedFilters = {
    presence: filters.presence,
    workMode: filters.workMode,
    categories: filters.categories,
    managerId: filters.managerId,
    shift: filters.shift,
    location: filters.location,
  };
  const visibleRows = [];
  const visibleIndexes = new Set();
  const itemsByIndex = new Map();
  allRows.forEach((row, index) => {
    const items = classifyAttention(row);
    itemsByIndex.set(index, items);
    if (matchesOpsFilters(row, items, derivedFilters, employmentOf(row))) {
      visibleRows.push(row);
      visibleIndexes.add(index);
    }
  });
  const { summary, modes, attention: attentionCounts } = summarizeOperations(visibleRows, {
    employmentByUser,
    businessDate,
  });
  const groups = groupOperations(visibleRows, { employmentByUser, businessDate });

  const queue = [];
  allRows.forEach((row, index) => {
    if (!visibleIndexes.has(index)) return;
    if (!isApplicable({ ...(employmentOf(row) || {}), businessDate })) return;
    for (const item of itemsByIndex.get(index) || []) {
      queue.push(serializeAttentionItem({ row, item }));
    }
  });
  queue.sort((a, b) => {
    const rank = severityRank(a.severity) - severityRank(b.severity);
    if (rank !== 0) return rank;
    return String(a.since || '').localeCompare(String(b.since || ''));
  });
  const attentionPage = paginate(queue, filters.page, filters.pageSize);

  // ── Pending workflow workload (counts + most recent; the full ─
  // queues live in their owner workflows — linked, not copied) ──
  const nameByUser = new Map(
    allRows.map((row) => [String(row?.user?.id), {
      name: row?.user?.name || '',
      employeeCode: row?.user?.employeeCode || '',
    }]),
  );
  const serializeWorkflowRow = (doc) => ({
    id: String(doc._id),
    employeeId: strId(doc.user),
    employeeName: nameByUser.get(strId(doc.user))?.name || '',
    employeeCode: nameByUser.get(strId(doc.user))?.employeeCode || '',
    attendanceDate: doc.attendanceDate,
    type: doc.type,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt || null,
  });
  const regItems = (pendingRegs || []).map(serializeWorkflowRow);
  const otItems = (pendingOts || []).map(serializeWorkflowRow);

  return {
    date: businessDate,
    timezone: board.timezone,
    refreshedAt: at instanceof Date ? at.toISOString() : new Date(at).toISOString(),
    scope: board.scope,
    summary,
    modes,
    attentionCounts,
    departments: groups.departments,
    shifts: groups.shifts,
    locations: groups.locations,
    workflows: {
      regularizations: { total: regItems.length, items: regItems.slice(0, MAX_WORKFLOW_ITEMS) },
      overtime: { total: otItems.length, items: otItems.slice(0, MAX_WORKFLOW_ITEMS) },
    },
    attention: {
      items: attentionPage.items,
      page: attentionPage.page,
      pageSize: attentionPage.pageSize,
      total: attentionPage.total,
      totalPages: attentionPage.totalPages,
    },
  };
};
