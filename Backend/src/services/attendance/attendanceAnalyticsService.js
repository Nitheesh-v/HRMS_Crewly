// ─────────────────────────────────────────────────────────────
// Phase 31.15 — historical attendance reporting & analytics.
//
// "What happened over time" (31.12 owns operational today).
// Descriptive HR facts only: rates, trends, distributions,
// groupings, and a read-only payroll reconciliation. No scores,
// no rankings, no predictions, no payroll math, no mutations.
//
// Source hierarchy (§2): finalized months aggregate the CURRENT
// 31.11 snapshot (isCurrent, current version — old versions never
// counted); open months reuse the 31.10 deriveMonths batch
// projection (absent days have no control row and resolve on
// read). Raw events are touched ONLY for source/location
// distribution via countDocuments — never transferred.
// ─────────────────────────────────────────────────────────────

import mongoose from 'mongoose';
import ApiError from '../../utils/ApiError.js';
import { ROLES } from '../../utils/constants.js';
import { getSubtreeIds } from '../../utils/orgHelpers.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import { dayKeyInZone } from './attendancePolicyRules.js';
import {
  deriveMonths,
  resolveTimezone,
} from './attendanceTimesheetService.js';
import { csvCell } from './attendanceTimesheetRules.js';
import {
  FINALIZATION_STATUS,
  buildAutoFromSnapshot,
} from './attendanceFinalizationRules.js';
import { buildXlsx } from '../payroll/payrollPaymentRules.js';
import {
  ANALYTICS_RANGE_LIMITS,
  RECON_STATUS,
  aggregateDays,
  aggregateOt,
  aggregateRegularizations,
  aggregateSources,
  attendanceRate,
  absenceRate,
  averageWorkedMinutes,
  compareReconLine,
  normalizeAnalyticsFilters,
  resolveAnalyticsRange,
  sortEmployeeRows,
  stableSerialize,
} from './attendanceAnalyticsRules.js';
import {
  attendanceAnalyticsGenerationKey,
} from '../analyticsCacheInvalidation.js';
import {
  buildTenantCacheKey,
  getCacheRaw,
  getOrSetCache,
  sha256Hex,
} from '../redisCacheService.js';
import User from '../../models/User.js';
import Department from '../../models/Department.js';
import Company from '../../models/Company.js';
import Attendance from '../../models/Attendance.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import AttendancePayrollSnapshot from '../../models/AttendancePayrollSnapshot.js';
import AttendancePeriod from '../../models/AttendancePeriod.js';
import AttendanceRegularization from '../../models/AttendanceRegularization.js';
import AttendanceOvertimeRequest from '../../models/AttendanceOvertimeRequest.js';
import AttendanceLocation from '../../models/AttendanceLocation.js';
import EmployeeMonthlyInput from '../../models/EmployeeMonthlyInput.js';
import AuditLog from '../../models/AuditLog.js';
import Shift from '../../models/Shift.js';
import ShiftAssignment from '../../models/ShiftAssignment.js';
import WorkSchedule from '../../models/WorkSchedule.js';
import Holiday from '../../models/Holiday.js';
import Leave from '../../models/Leave.js';

const CACHE_VERSION = 1;
const CACHE_NAMESPACE = 'attendance:analytics';
const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_DEFAULT = 25;
const LOCATION_COUNT_CAP = 50;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

// Same roles as the live board + timesheets: company-wide
// attendance visibility (deferred HR_HEAD/HR_EXECUTIVE stay out).
const FULL_ACCESS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

const FINALIZED_STATUSES = [FINALIZATION_STATUS.FINALIZED, FINALIZATION_STATUS.SENT_TO_PAYROLL];

export const ANALYTICS_EXPORT_REPORTS = Object.freeze(['employees', 'reconciliation']);
export const ANALYTICS_EXPORT_FORMATS = Object.freeze(['csv', 'xlsx']);

const strId = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.toString === 'function') return value.toString();
  return String(value);
};

const defaultDeps = () => ({
  UserModel: User,
  DepartmentModel: Department,
  CompanyModel: Company,
  AttendanceModel: Attendance,
  AttendanceEventModel: AttendanceEvent,
  SnapshotModel: AttendancePayrollSnapshot,
  PeriodModel: AttendancePeriod,
  RegularizationModel: AttendanceRegularization,
  OvertimeRequestModel: AttendanceOvertimeRequest,
  LocationModel: AttendanceLocation,
  MonthlyInputModel: EmployeeMonthlyInput,
  AuditLogModel: AuditLog,
  ShiftModel: Shift,
  ShiftAssignmentModel: ShiftAssignment,
  WorkScheduleModel: WorkSchedule,
  HolidayModel: Holiday,
  LeaveModel: Leave,
  policyReader: (args) => getCurrentPolicy(args),
  subtreeReader: (companyId, managerId) => getSubtreeIds(companyId, managerId),
  deriveMonthsFn: (args) => deriveMonths(args),
  now: () => new Date(),
  cacheGetRaw: (key) => getCacheRaw(key),
  cacheGetOrSet: (key, options) => getOrSetCache(key, options),
});

const requireContext = ({ companyId, actor }) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const actorId = strId(actor?._id || actor?.id);
  if (!actorId) throw ApiError.badRequest('Actor context is required');
  return actorId;
};

// ── Scope (31.10 mirror) ─────────────────────────────────────
// COMPANY for full-access roles, else TEAM (subtree + self).
// Department/employee filters intersect — they never expand.

const resolveScopeIds = async ({ companyId, actor, UserModel, subtreeReader }) => {
  if (FULL_ACCESS.includes(actor?.role)) {
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

const SAFE_USER_SELECT = '_id name employeeCode designation department';

// ── Cache ────────────────────────────────────────────────────
// validate → normalize → generation → hash → getOrSet. Anything
// unusable bypasses to Mongo; authorization always precedes the
// cache (routes enforce it before the service runs).

export const getAttendanceAnalyticsCacheTtlSeconds = (source = process.env) => {
  const raw = source.ATTENDANCE_ANALYTICS_CACHE_TTL_SECONDS;
  if (raw === undefined || raw === '') return 60;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 60;
  if (parsed <= 0) return 0; // explicit opt-out
  return Math.min(3600, Math.max(10, Math.trunc(parsed)));
};

const readGeneration = async ({ companyId, full }) => {
  try {
    const raw = await full.cacheGetRaw(attendanceAnalyticsGenerationKey(companyId));
    if (raw === null || raw === undefined) return 0;
    const generation = parseInt(raw, 10);
    return Number.isFinite(generation) && generation > 0 ? generation : 0;
  } catch {
    return null; // Redis down → bypass
  }
};

const buildCacheKey = async ({ companyId, normalized, full }) => {
  if (!normalized) return null;
  const generation = await readGeneration({ companyId, full });
  if (generation === null) return null;
  return buildTenantCacheKey({
    companyId,
    namespace: CACHE_NAMESPACE,
    version: CACHE_VERSION,
    segments: [`g${generation}`, sha256Hex(stableSerialize(normalized)).slice(0, 16)],
  });
};

const cached = async ({ companyId, normalized, full, loader }) => {
  const ttlSeconds = getAttendanceAnalyticsCacheTtlSeconds();
  const key = ttlSeconds > 0 ? await buildCacheKey({ companyId, normalized, full }) : null;
  if (!key) return loader();
  const { value } = await full.cacheGetOrSet(key, {
    ttlSeconds,
    version: CACHE_VERSION,
    loader,
  });
  return value;
};

// ── Loading ──────────────────────────────────────────────────

const loadMonthProvenance = async ({ companyId, months, full }) => {
  const periods = months.length
    ? await full.PeriodModel.find({ companyId, month: { $in: months } })
      .select('month status currentVersion')
      .lean()
    : [];
  const byMonth = new Map((periods || []).map((row) => [row.month, row]));
  return months.map((month) => {
    const period = byMonth.get(month) || null;
    const finalized = period ? FINALIZED_STATUSES.includes(period.status) : false;
    return {
      month,
      status: period?.status || 'OPEN',
      finalized,
      version: finalized ? period.currentVersion : null,
    };
  });
};

const loadUsers = async ({ companyId, scopeIds, departmentId, employeeId, full }) => {
  let ids = [...scopeIds];
  if (employeeId) {
    if (!ids.includes(employeeId)) {
      throw ApiError.forbidden('Employee is outside your analytics scope');
    }
    ids = [employeeId];
  }
  const userFilter = { companyId, status: 'ACTIVE', _id: { $in: ids } };
  if (departmentId) userFilter.department = departmentId;
  const [users, departments] = await Promise.all([
    full.UserModel.find(userFilter).select(SAFE_USER_SELECT).sort({ name: 1, _id: 1 }).lean(),
    full.DepartmentModel.find({ companyId }).select('_id name').lean(),
  ]);
  if (employeeId && !(users || []).length) throw ApiError.notFound('Employee not found');
  return {
    users: users || [],
    departmentsById: new Map((departments || []).map((row) => [strId(row._id), row.name || ''])),
  };
};

// Snapshot days → analytics day shape. hasSession derives from
// worked units (snapshots freeze outcomes, not control rows);
// calendar primary derives from the frozen holiday/weeklyOff flags.
const normalizeSnapshotDay = (day = {}) => ({
  date: day.date,
  bucket: day.bucket,
  fractions: {
    worked: Number(day.worked) || 0,
    leave: Number(day.leave) || 0,
    absent: Number(day.absent) || 0,
  },
  workMode: day.workMode || null,
  workedMinutes: Number(day.workedMinutes) || 0,
  breakMinutes: Number(day.breakMinutes) || 0,
  lateMinutes: Number(day.lateMinutes) || 0,
  earlyMinutes: Number(day.earlyMinutes) || 0,
  exceptions: Array.isArray(day.exceptions) ? day.exceptions : [],
  regularized: day.regularized === true,
  approvedOtMinutes: Number(day.approvedOtMinutes) || 0,
  compOffDays: Number(day.compOffDays) || 0,
  scheduledWorkingDay: day.scheduledWorkingDay === true,
  calendarPrimary: day.holiday === true ? 'HOLIDAY' : day.weeklyOff === true ? 'WEEKLY_OFF' : 'WORK_DAY',
  hasSession: (Number(day.worked) || 0) > 0,
});

const loadFinalizedDays = async ({ companyId, months, userIds, full }) => {
  if (!months.length || !userIds.length) return new Map();
  const snapshots = await full.SnapshotModel.find({
    companyId,
    month: { $in: months },
    employeeId: { $in: userIds },
    isCurrent: true,
  })
    .select('employeeId month days')
    .lean();
  const byUser = new Map();
  for (const snap of snapshots || []) {
    const uid = strId(snap.employeeId);
    if (!byUser.has(uid)) byUser.set(uid, []);
    for (const day of snap.days || []) {
      byUser.get(uid).push({ ...normalizeSnapshotDay(day), month: snap.month });
    }
  }
  return byUser;
};

const enumerateRangeDates = (from, to) => {
  const out = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
};

const loadProvisionalDays = async ({ companyId, users, months, today, timezone, policy, full }) => {
  const byUser = new Map((users || []).map((person) => [strId(person._id), []]));
  for (const month of months) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const dates = [];
    for (let day = 1; day <= last; day += 1) {
      dates.push(`${month}-${String(day).padStart(2, '0')}`);
    }
    const derived = await full.deriveMonthsFn({
      companyId, users, dates, today, timezone, policy, full,
    });
    for (const [uid, entry] of derived || []) {
      if (!byUser.has(uid)) byUser.set(uid, []);
      for (const day of entry?.days || []) {
        if (day.date < dates[0] || day.date > dates[dates.length - 1]) continue;
        byUser.get(uid).push({ ...day, month });
      }
    }
  }
  return byUser;
};

const mergeDaysByUser = (maps = []) => {
  const merged = new Map();
  for (const map of maps) {
    for (const [uid, days] of map || []) {
      if (!merged.has(uid)) merged.set(uid, []);
      merged.get(uid).push(...days);
    }
  }
  for (const days of merged.values()) {
    days.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return merged;
};

// Source distribution via counts only — events are never
// transferred. Missing source predates provenance (all WEB).
const loadSourceCounts = async ({ companyId, userIds, from, to, full }) => {
  if (!userIds.length) return aggregateSources({});
  const base = { companyId, user: { $in: userIds }, date: { $gte: from, $lte: to } };
  const [web, kiosk, qr, imported, device, missing] = await Promise.all([
    full.AttendanceEventModel.countDocuments({ ...base, source: 'WEB' }),
    full.AttendanceEventModel.countDocuments({ ...base, source: 'KIOSK' }),
    full.AttendanceEventModel.countDocuments({ ...base, source: 'QR' }),
    full.AttendanceEventModel.countDocuments({ ...base, source: 'IMPORT' }),
    full.AttendanceEventModel.countDocuments({ ...base, source: 'DEVICE' }),
    full.AttendanceEventModel.countDocuments({ ...base, source: { $exists: false } }),
  ]);
  return aggregateSources({
    WEB: (web || 0) + (missing || 0),
    KIOSK: kiosk || 0,
    QR: qr || 0,
    IMPORT: imported || 0,
    DEVICE: device || 0,
  });
};

// Location distribution via counts per known location (names only
// — coordinates never leave the location master).
const loadLocationBreakdown = async ({ companyId, userIds, from, to, full }) => {
  const locations = await full.LocationModel.find({ companyId })
    .select('_id name')
    .sort({ name: 1 })
    .limit(LOCATION_COUNT_CAP + 1)
    .lean();
  const known = (locations || []).slice(0, LOCATION_COUNT_CAP);
  const base = { companyId, user: { $in: userIds }, date: { $gte: from, $lte: to } };
  const total = userIds.length ? await full.AttendanceEventModel.countDocuments(base) : 0;
  let assigned = 0;
  const rows = [];
  for (const location of known) {
    const count = userIds.length
      ? await full.AttendanceEventModel.countDocuments({
        ...base,
        'provenance.locationId': location._id,
      })
      : 0;
    assigned += count || 0;
    rows.push({ locationId: strId(location._id), locationName: location.name || '', events: count || 0 });
  }
  rows.push({ locationId: null, locationName: 'Unassigned', events: Math.max(0, (total || 0) - assigned) });
  return { locations: rows, totalEvents: total || 0, truncated: (locations || []).length > LOCATION_COUNT_CAP };
};

const loadOtReg = async ({ companyId, userIds, from, to, full }) => {
  if (!userIds.length) return { ot: aggregateOt([]), regs: aggregateRegularizations([]) };
  const [ots, regs] = await Promise.all([
    full.OvertimeRequestModel.find({
      companyId, user: { $in: userIds }, attendanceDate: { $gte: from, $lte: to },
    })
      .select('user status recordedMinutes requestedMinutes approvedMinutes compOffDays calendarSnapshot attendanceDate')
      .lean(),
    full.RegularizationModel.find({
      companyId, user: { $in: userIds }, attendanceDate: { $gte: from, $lte: to },
    })
      .select('user status type attendanceDate')
      .lean(),
  ]);
  return { ot: aggregateOt(ots || []), regs: aggregateRegularizations(regs || []) };
};

// ── Shared range pipeline ────────────────────────────────────
// Validates, scopes, provenances, and loads days. Every read
// endpoint funnels through here so scope + source rules are
// identical everywhere.

const prepareRange = async ({ companyId, actor, query = {}, deps = {}, selfOnly = false, maxDays = ANALYTICS_RANGE_LIMITS.DETAILED_DAYS }) => {
  const actorId = requireContext({ companyId, actor });
  const full = { ...defaultDeps(), ...deps };
  const { policy } = await full.policyReader({ companyId });
  const timezone = await resolveTimezone({ companyId, policy, CompanyModel: full.CompanyModel });
  const today = dayKeyInZone(full.now(), timezone);

  // Validators leave the range optional: a bare call means the current
  // month (future days resolve to the FUTURE bucket downstream and
  // never enter KPI denominators).
  const bareRange = !query.month && !query.from && !query.to && !query.preset;
  const range = resolveAnalyticsRange({
    month: query.month || (bareRange ? today.slice(0, 7) : null),
    from: query.from || null,
    to: query.to || null,
    preset: query.preset || null,
    todayKey: today,
    maxDays,
  });
  if (range.errors.length) throw ApiError.badRequest(range.errors[0]);

  let scope = 'SELF';
  let scopeIds = [actorId];
  if (!selfOnly) {
    ({ scope, scopeIds } = await resolveScopeIds({
      companyId, actor, UserModel: full.UserModel, subtreeReader: full.subtreeReader,
    }));
  }

  const departmentId = query.departmentId && OBJECT_ID_PATTERN.test(String(query.departmentId))
    ? String(query.departmentId)
    : null;
  const employeeId = query.employeeId && OBJECT_ID_PATTERN.test(String(query.employeeId))
    ? String(query.employeeId)
    : null;
  // Non-id filter values are validated by the route; the service
  // treats unknown enums as absent (fail-closed, never crash).
  const workMode = typeof query.workMode === 'string' && query.workMode ? String(query.workMode).toUpperCase() : null;
  const shiftId = query.shiftId && OBJECT_ID_PATTERN.test(String(query.shiftId)) ? String(query.shiftId) : null;
  const locationId = query.locationId && OBJECT_ID_PATTERN.test(String(query.locationId)) ? String(query.locationId) : null;

  const { users, departmentsById } = await loadUsers({
    companyId, scopeIds, departmentId, employeeId, full,
  });
  const provenance = await loadMonthProvenance({ companyId, months: range.months, full });
  const finalizedMonths = provenance.filter((row) => row.finalized).map((row) => row.month);
  const provisionalMonths = provenance.filter((row) => !row.finalized).map((row) => row.month);

  const userIds = users.map((person) => strId(person._id));
  const [finalizedDays, provisionalDays] = await Promise.all([
    loadFinalizedDays({ companyId, months: finalizedMonths, userIds, full }),
    loadProvisionalDays({ companyId, users, months: provisionalMonths, today, timezone, policy, full }),
  ]);
  let daysByUser = mergeDaysByUser([finalizedDays, provisionalDays]);
  // Clamp to the explicit window (month derivation overshoots
  // custom from/to ranges).
  for (const [uid, days] of daysByUser) {
    daysByUser.set(uid, days.filter((day) => day.date >= range.from && day.date <= range.to));
  }
  // Work-mode slices the DAY set (orthogonal dimension — the day
  // still counts in outcomes; only mode-filtered views narrow).
  if (workMode) {
    for (const [uid, days] of daysByUser) {
      daysByUser.set(uid, days.filter((day) => day.workMode === workMode));
    }
  }

  return {
    full, actorId, scope, users, departmentsById, range, provenance,
    finalized: finalizedMonths.length > 0 && provisionalMonths.length === 0,
    provisional: provisionalMonths.length > 0,
    daysByUser, workMode, shiftId, locationId,
  };
};

const serializeIdentity = (person, departmentsById) => ({
  employeeId: strId(person._id),
  name: person.name || '',
  employeeCode: person.employeeCode || '',
  designation: person.designation || '',
  department: person.department
    ? { id: strId(person.department), name: departmentsById.get(strId(person.department)) || '' }
    : null,
});

const summarizeTotals = (totals) => {
  const rate = attendanceRate({ workedUnits: totals.workedUnits, scheduledUnits: totals.scheduledUnits });
  const absence = absenceRate({ absentUnits: totals.absentUnits, scheduledUnits: totals.scheduledUnits });
  return {
    ...totals,
    attendanceRate: rate,
    absenceRate: absence,
    averageWorkedMinutes: averageWorkedMinutes({ workedMinutes: totals.workedMinutes, sessionDays: totals.sessionDays }),
  };
};

// ── Overview ─────────────────────────────────────────────────

export const getOverview = async ({ companyId, actor, query = {}, deps = {} }) => {
  const ctx = await prepareRange({ companyId, actor, query, deps });
  const normalized = normalizeAnalyticsFilters({
    scope: ctx.scope,
    actorId: ctx.actorId,
    from: ctx.range.from,
    to: ctx.range.to,
    departmentId: query.departmentId,
    shiftId: query.shiftId,
    locationId: query.locationId,
    workMode: query.workMode,
    employeeId: query.employeeId,
    report: 'overview',
  });
  return cached({
    companyId,
    normalized,
    full: ctx.full,
    loader: async () => {
      const userIds = ctx.users.map((person) => strId(person._id));
      const allDays = [];
      for (const days of ctx.daysByUser.values()) allDays.push(...days);
      const totals = summarizeTotals(aggregateDays(allDays));
      const [sources, locations, otReg] = await Promise.all([
        loadSourceCounts({ companyId, userIds, from: ctx.range.from, to: ctx.range.to, full: ctx.full }),
        loadLocationBreakdown({ companyId, userIds, from: ctx.range.from, to: ctx.range.to, full: ctx.full }),
        loadOtReg({ companyId, userIds, from: ctx.range.from, to: ctx.range.to, full: ctx.full }),
      ]);
      return {
        scope: ctx.scope,
        range: { from: ctx.range.from, to: ctx.range.to, months: ctx.range.months },
        provenance: ctx.provenance,
        finalized: ctx.finalized,
        provisional: ctx.provisional,
        employees: ctx.users.length,
        totals,
        sources,
        locations,
        overtime: otReg.ot,
        regularizations: otReg.regs,
      };
    },
  });
};

// ── Trends (monthly buckets) ─────────────────────────────────

export const getTrends = async ({ companyId, actor, query = {}, deps = {} }) => {
  const ctx = await prepareRange({
    companyId, actor, query, deps, maxDays: ANALYTICS_RANGE_LIMITS.TREND_MONTHS * 31,
  });
  if (ctx.range.months.length > ANALYTICS_RANGE_LIMITS.TREND_MONTHS) {
    throw ApiError.badRequest(`trends support up to ${ANALYTICS_RANGE_LIMITS.TREND_MONTHS} months`);
  }
  const normalized = normalizeAnalyticsFilters({
    scope: ctx.scope,
    actorId: ctx.actorId,
    from: ctx.range.from,
    to: ctx.range.to,
    departmentId: query.departmentId,
    workMode: query.workMode,
    employeeId: query.employeeId,
    report: 'trends',
  });
  return cached({
    companyId,
    normalized,
    full: ctx.full,
    loader: async () => {
      const byMonth = new Map(ctx.range.months.map((month) => [month, []]));
      for (const days of ctx.daysByUser.values()) {
        for (const day of days) {
          const bucket = byMonth.get(day.month || String(day.date || '').slice(0, 7));
          if (bucket) bucket.push(day);
        }
      }
      const months = ctx.range.months.map((month) => {
        const totals = summarizeTotals(aggregateDays(byMonth.get(month) || []));
        const prov = ctx.provenance.find((row) => row.month === month) || null;
        return {
          month,
          status: prov?.status || 'OPEN',
          finalized: prov?.finalized === true,
          totals,
        };
      });
      return {
        scope: ctx.scope,
        range: { from: ctx.range.from, to: ctx.range.to, months: ctx.range.months },
        provenance: ctx.provenance,
        finalized: ctx.finalized,
        provisional: ctx.provisional,
        employees: ctx.users.length,
        months,
      };
    },
  });
};

// ── Employee detail table (paginated, allowlisted sort) ──────

export const getEmployees = async ({ companyId, actor, query = {}, deps = {} }) => {
  const ctx = await prepareRange({ companyId, actor, query, deps });
  const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.trunc(Number(query.pageSize)) || PAGE_SIZE_DEFAULT));
  const normalized = normalizeAnalyticsFilters({
    scope: ctx.scope,
    actorId: ctx.actorId,
    from: ctx.range.from,
    to: ctx.range.to,
    departmentId: query.departmentId,
    workMode: query.workMode,
    employeeId: query.employeeId,
    report: `employees:${query.sort || 'name'}:${page}:${pageSize}`,
  });
  return cached({
    companyId,
    normalized,
    full: ctx.full,
    loader: async () => {
      const rows = ctx.users.map((person) => {
        const uid = strId(person._id);
        const totals = summarizeTotals(aggregateDays(ctx.daysByUser.get(uid) || []));
        return {
          ...serializeIdentity(person, ctx.departmentsById),
          scheduledUnits: totals.scheduledUnits,
          workedUnits: totals.workedUnits,
          leaveUnits: totals.leaveUnits,
          absentUnits: totals.absentUnits,
          attendanceRate: totals.attendanceRate,
          workedMinutes: totals.workedMinutes,
          sessionDays: totals.sessionDays,
          averageWorkedMinutes: totals.averageWorkedMinutes,
          lateOccurrences: totals.lateOccurrences,
          lateMinutes: totals.lateMinutes,
          earlyOccurrences: totals.earlyOccurrences,
          earlyMinutes: totals.earlyMinutes,
          missingPunchDays: totals.missingPunchDays,
          approvedOtMinutes: totals.approvedOtMinutes,
          dayCounts: totals.dayCounts,
          modes: totals.modes,
        };
      });
      // Neutral default order (name); every sort is an explicit,
      // allowlisted, unranked column sort — never a leaderboard.
      const sorted = sortEmployeeRows(rows, query.sort);
      const total = sorted.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      return {
        scope: ctx.scope,
        range: { from: ctx.range.from, to: ctx.range.to, months: ctx.range.months },
        provenance: ctx.provenance,
        finalized: ctx.finalized,
        provisional: ctx.provisional,
        page: safePage,
        pageSize,
        total,
        totalPages,
        rows: sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
      };
    },
  });
};

// ── Self analytics (own days only) ───────────────────────────

export const getMine = async ({ companyId, actor, query = {}, deps = {} }) => {
  const ctx = await prepareRange({ companyId, actor, query, deps, selfOnly: true });
  const normalized = normalizeAnalyticsFilters({
    scope: 'SELF',
    actorId: ctx.actorId,
    from: ctx.range.from,
    to: ctx.range.to,
    report: 'mine',
  });
  return cached({
    companyId,
    normalized,
    full: ctx.full,
    loader: async () => {
      const allDays = [];
      for (const days of ctx.daysByUser.values()) allDays.push(...days);
      const totals = summarizeTotals(aggregateDays(allDays));
      return {
        scope: 'SELF',
        range: { from: ctx.range.from, to: ctx.range.to, months: ctx.range.months },
        provenance: ctx.provenance,
        finalized: ctx.finalized,
        provisional: ctx.provisional,
        totals,
      };
    },
  });
};

// ── Payroll reconciliation (read-only) ───────────────────────
// Current snapshot → buildAutoFromSnapshot (the REAL 31.11 pure
// mapping) vs the stored auto block. HR-owned entries are never
// compared. No writes anywhere in this function.

export const getPayrollReconciliation = async ({ companyId, actor, query = {}, deps = {} }) => {
  const actorId = requireContext({ companyId, actor });
  const full = { ...defaultDeps(), ...deps };
  const month = String(query.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw ApiError.badRequest('month must be YYYY-MM');
  }
  const { scope, scopeIds } = await resolveScopeIds({
    companyId, actor, UserModel: full.UserModel, subtreeReader: full.subtreeReader,
  });
  const [period, snapshots, inputs, users] = await Promise.all([
    full.PeriodModel.findOne({ companyId, month }).select('month status currentVersion syncedEmployees').lean(),
    full.SnapshotModel.find({ companyId, month, isCurrent: true }).lean(),
    full.MonthlyInputModel.find({ companyId, month }).select('employeeId auto status').lean(),
    full.UserModel.find({ companyId, status: 'ACTIVE', _id: { $in: scopeIds } })
      .select('_id name employeeCode department')
      .sort({ name: 1, _id: 1 })
      .lean(),
  ]);
  const finalized = period ? FINALIZED_STATUSES.includes(period.status) : false;
  const snapsByEmployee = new Map((snapshots || []).map((snap) => [strId(snap.employeeId), snap]));
  const inputsByEmployee = new Map((inputs || []).map((row) => [strId(row.employeeId), row]));
  const departments = await full.DepartmentModel.find({ companyId }).select('_id name').lean();
  const departmentsById = new Map((departments || []).map((row) => [strId(row._id), row.name || '']));

  const rows = [];
  const summary = {
    [RECON_STATUS.MATCH]: 0,
    [RECON_STATUS.MISMATCH]: 0,
    [RECON_STATUS.NOT_SYNCED]: 0,
    [RECON_STATUS.NOT_FINALIZED]: 0,
  };
  for (const person of users || []) {
    const uid = strId(person._id);
    const snap = snapsByEmployee.get(uid) || null;
    const input = inputsByEmployee.get(uid) || null;
    let compared;
    if (!finalized || !snap) {
      compared = { status: RECON_STATUS.NOT_FINALIZED, diffs: [] };
    } else {
      const expected = buildAutoFromSnapshot({ snapshot: snap, otPolicy: null });
      compared = compareReconLine({
        expected,
        actual: input?.auto || null,
        currentVersion: period.currentVersion,
      });
    }
    summary[compared.status] += 1;
    rows.push({
      ...serializeIdentity(person, departmentsById),
      status: compared.status,
      snapshotVersion: snap?.version ?? null,
      currentVersion: finalized ? period.currentVersion : null,
      syncedAt: input?.auto?.attendanceSource?.syncedAt || null,
      inputStatus: input?.status || null,
      diffs: compared.diffs,
    });
  }
  return {
    scope,
    month,
    periodStatus: period?.status || 'OPEN',
    finalized,
    currentVersion: finalized ? period.currentVersion : null,
    summary,
    rows,
  };
};

// ── Exports ──────────────────────────────────────────────────
// Same scope + filters as the reads. CSV cells ride the guarded
// 31.10 csvCell (formula-injection safe); XLSX rides the dep-free
// payroll writer. One audit row per export — never row contents.

const EMPLOYEE_EXPORT_COLUMNS = Object.freeze([
  'Employee',
  'Employee code',
  'Department',
  'Scheduled units',
  'Worked units',
  'Leave units',
  'Absent units',
  'Attendance %',
  'Worked minutes',
  'Avg worked minutes',
  'Late occurrences',
  'Late minutes',
  'Early occurrences',
  'Early minutes',
  'Missing punch days',
  'Approved OT minutes',
]);

const RECON_EXPORT_COLUMNS = Object.freeze([
  'Employee',
  'Employee code',
  'Department',
  'Status',
  'Snapshot version',
  'Current version',
  'Synced at',
  'Differences',
]);

const buildCsv = (columns, rows) => {
  const lines = [
    columns.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ];
  return `﻿${lines.join('\r\n')}`;
};

export const exportReport = async ({ companyId, actor, query = {}, deps = {} }) => {
  const reportType = String(query.reportType || '');
  const format = String(query.format || 'csv').toLowerCase();
  if (!ANALYTICS_EXPORT_REPORTS.includes(reportType)) {
    throw ApiError.badRequest('reportType must be employees or reconciliation');
  }
  if (!ANALYTICS_EXPORT_FORMATS.includes(format)) {
    throw ApiError.badRequest('format must be csv or xlsx');
  }

  let columns;
  let rows;
  let filename;
  let scope;
  if (reportType === 'reconciliation') {
    const recon = await getPayrollReconciliation({ companyId, actor, query, deps });
    scope = recon.scope;
    columns = [...RECON_EXPORT_COLUMNS];
    rows = recon.rows.map((row) => [
      row.name,
      row.employeeCode,
      row.department?.name || '',
      row.status,
      row.snapshotVersion ?? '',
      row.currentVersion ?? '',
      row.syncedAt ? new Date(row.syncedAt).toISOString() : '',
      (row.diffs || []).map((diff) => `${diff.field}: expected ${diff.expected}, found ${diff.actual}`).join('; '),
    ]);
    filename = `crewly-attendance-reconciliation-${scope.toLowerCase()}-${recon.month}.${format}`;
  } else {
    const table = await getEmployees({ companyId, actor, query: { ...query, page: 1, pageSize: PAGE_SIZE_MAX }, deps });
    // Exports cover the whole scope, not one page — page through
    // the same loader (bounded by scope, cached per page).
    scope = table.scope;
    columns = [...EMPLOYEE_EXPORT_COLUMNS];
    rows = table.rows.map((row) => [
      row.name,
      row.employeeCode,
      row.department?.name || '',
      row.scheduledUnits,
      row.workedUnits,
      row.leaveUnits,
      row.absentUnits,
      row.attendanceRate?.pct ?? '',
      row.workedMinutes,
      row.averageWorkedMinutes ?? '',
      row.lateOccurrences,
      row.lateMinutes,
      row.earlyOccurrences,
      row.earlyMinutes,
      row.missingPunchDays,
      row.approvedOtMinutes,
    ]);
    // Fetch remaining pages when the scope exceeds one page.
    let page = 2;
    while (rows.length < table.total) {
      const next = await getEmployees({ companyId, actor, query: { ...query, page, pageSize: PAGE_SIZE_MAX }, deps });
      if (!next.rows.length) break;
      for (const row of next.rows) {
        rows.push([
          row.name, row.employeeCode, row.department?.name || '', row.scheduledUnits,
          row.workedUnits, row.leaveUnits, row.absentUnits, row.attendanceRate?.pct ?? '',
          row.workedMinutes, row.averageWorkedMinutes ?? '', row.lateOccurrences,
          row.lateMinutes, row.earlyOccurrences, row.earlyMinutes,
          row.missingPunchDays, row.approvedOtMinutes,
        ]);
      }
      page += 1;
    }
    const stamp = table.range.months.length === 1
      ? table.range.months[0]
      : `${table.range.from}_to_${table.range.to}`;
    filename = `crewly-attendance-employees-${scope.toLowerCase()}-${stamp}.${format}`;
  }

  const actorId = strId(actor?._id || actor?.id);
  const full = { ...defaultDeps(), ...deps };
  try {
    await full.AuditLogModel.create({
      companyId,
      actor: mongoose.isValidObjectId(actorId) ? actorId : undefined,
      actorName: actor?.name || '',
      actorRole: actor?.role || '',
      action: 'ATTENDANCE_ANALYTICS_EXPORTED',
      method: 'GET',
      path: '/api/attendance/analytics/export',
      statusCode: 200,
      metadata: { reportType, format, scope, rows: rows.length },
    });
  } catch {
    // Audit loss must not fail the download (31.10 precedent).
  }

  if (format === 'xlsx') {
    return {
      filename,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: buildXlsx(columns, rows),
    };
  }
  return { filename, contentType: 'text/csv; charset=utf-8', content: buildCsv(columns, rows) };
};
