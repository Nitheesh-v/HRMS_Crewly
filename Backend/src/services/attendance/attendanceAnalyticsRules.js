// ─────────────────────────────────────────────────────────────
// Phase 31.15 — pure attendance analytics rules.
//
// Every non-trivial KPI lives here as a documented, tested pure
// function. No Mongo, no req/res, no Redis. Inputs are normalized
// day objects (the 31.10 shape) or 31.11 snapshot rows — the rules
// never reach for raw events.
//
// Unit model (31.7 fractions): a scheduled working day contributes
// up to 1.0 units split across worked / leave / absent. Approved
// leave is NEITHER worked NOR absent: it leaves the denominator.
// Holidays, weekly offs, future days and pre-join days never enter
// any rate denominator.
// ─────────────────────────────────────────────────────────────

import { DAY_TYPE } from './attendancePolicyRules.js';
import {
  TIMESHEET_EXCEPTION,
  TIMESHEET_OUTCOME,
} from './attendanceTimesheetRules.js';
import { financialYearMonths } from '../payroll/analyticsRules.js';

// ── Range bounds ─────────────────────────────────────────────
// Detailed (day-level) endpoints stay ≤ 93 days; trend endpoints
// aggregate whole months ≤ 12 buckets. Reconciliation is always a
// single month.

export const ANALYTICS_RANGE_LIMITS = Object.freeze({
  DETAILED_DAYS: 93,
  TREND_MONTHS: 12,
});

export const ANALYTICS_PRESETS = Object.freeze(['quarter', 'fy']);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const isMonthKey = (value) => MONTH_RE.test(String(value || ''));
export const isDayKey = (value) => {
  if (!DAY_RE.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

export const monthKeyOfDay = (day) => String(day || '').slice(0, 7);

export const quarterMonthsOf = (month) => {
  if (!isMonthKey(month)) return [];
  const year = Number(month.slice(0, 4));
  const quarter = Math.floor((Number(month.slice(5, 7)) - 1) / 3);
  return [0, 1, 2].map(
    (offset) => `${year}-${String(quarter * 3 + 1 + offset).padStart(2, '0')}`
  );
};

// Resolve { month | from+to | preset+month } to an explicit day
// window + month list. Pure over strings; the service supplies
// today's company-local day key. Returns { from, to, months, errors }.
export const resolveAnalyticsRange = ({ month = null, from = null, to = null, preset = null, todayKey = null, maxDays = ANALYTICS_RANGE_LIMITS.DETAILED_DAYS } = {}) => {
  const errors = [];
  let start = null;
  let end = null;

  if (preset) {
    if (!ANALYTICS_PRESETS.includes(preset)) {
      return { from: null, to: null, months: [], errors: ['preset must be quarter or fy'] };
    }
    if (!isMonthKey(month)) {
      return { from: null, to: null, months: [], errors: ['preset ranges need an anchor month'] };
    }
    const months = preset === 'quarter' ? quarterMonthsOf(month) : financialYearMonths(month, 4);
    start = `${months[0]}-01`;
    const [y, m] = months[months.length - 1].split('-').map(Number);
    end = `${months[months.length - 1]}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  } else if (month) {
    if (!isMonthKey(month)) {
      return { from: null, to: null, months: [], errors: ['month must be YYYY-MM'] };
    }
    const [y, m] = month.split('-').map(Number);
    start = `${month}-01`;
    end = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  } else {
    if (!isDayKey(from) || !isDayKey(to)) {
      return { from: null, to: null, months: [], errors: ['from and to must be YYYY-MM-DD'] };
    }
    if (from > to) {
      return { from: null, to: null, months: [], errors: ['from must not be after to'] };
    }
    start = from;
    end = to;
  }

  if (todayKey && isDayKey(todayKey) && start > todayKey) {
    return { from: null, to: null, months: [], errors: ['range starts in the future'] };
  }
  const span = daysBetween(start, end);
  if (span > maxDays) {
    return { from: null, to: null, months: [], errors: [`range exceeds the ${maxDays}-day limit`] };
  }
  const months = [];
  let cursor = monthKeyOfDay(start);
  const last = monthKeyOfDay(end);
  while (cursor <= last) {
    months.push(cursor);
    const [y, m] = cursor.split('-').map(Number);
    cursor = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return { from: start, to: end, months, errors };
};

// ── Safe math ────────────────────────────────────────────────
// Ratios round to 4 decimals; percents to 1 decimal. A zero
// denominator yields null (not 0, not NaN) so "no scheduled
// days" never masquerades as "0% attendance".

export const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const toRatio = (numerator, denominator) => {
  const num = Number(numerator) || 0;
  const den = Number(denominator) || 0;
  if (!(den > 0)) return null;
  return Math.round((num / den) * 10000) / 10000;
};

export const toPct = (numerator, denominator) => {
  const ratio = toRatio(numerator, denominator);
  return ratio === null ? null : Math.round(ratio * 1000) / 10;
};

// ── Day-unit extraction ──────────────────────────────────────
// Reads EITHER a 31.10 normalized day (fractions.*) OR a 31.11
// snapshot day (worked/leave/absent). Unknown shapes contribute
// zero — analytics degrades to undercount, never to NaN.

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const dayUnits = (day = {}) => {
  if (!day || typeof day !== 'object') {
    return { scheduled: 0, worked: 0, leave: 0, absent: 0 };
  }
  if (day.isFuture === true || day.bucket === TIMESHEET_OUTCOME.FUTURE) {
    return { scheduled: 0, worked: 0, leave: 0, absent: 0 };
  }
  const worked = num(day.fractions?.worked ?? day.worked);
  const leave = num(day.fractions?.leave ?? day.leave);
  const absent = num(day.fractions?.absent ?? day.absent);
  const scheduled = day.scheduledWorkingDay === true ? Math.max(0, 1 - leave) : 0;
  return { scheduled, worked, leave, absent };
};

// ── Day aggregation ──────────────────────────────────────────
// One pass over normalized days → every KPI numerator. Outcome
// buckets and work modes stay separate dimensions (a WFH present
// day increments BOTH, and the two are never summed together).

export const EMPTY_DAY_COUNTS = Object.freeze({
  present: 0,
  halfDay: 0,
  absent: 0,
  leave: 0,
  holiday: 0,
  weeklyOff: 0,
  unresolved: 0,
  future: 0,
});

export const EMPTY_MODES = Object.freeze({
  OFFICE: 0,
  WFH: 0,
  FIELD: 0,
  CLIENT_SITE: 0,
  BUSINESS_TRAVEL: 0,
});

const BUCKET_TO_COUNT = Object.freeze({
  [TIMESHEET_OUTCOME.PRESENT]: 'present',
  [TIMESHEET_OUTCOME.HALF_DAY]: 'halfDay',
  [TIMESHEET_OUTCOME.ABSENT]: 'absent',
  [TIMESHEET_OUTCOME.LEAVE]: 'leave',
  [TIMESHEET_OUTCOME.HOLIDAY]: 'holiday',
  [TIMESHEET_OUTCOME.WEEKLY_OFF]: 'weeklyOff',
  [TIMESHEET_OUTCOME.UNRESOLVED]: 'unresolved',
  [TIMESHEET_OUTCOME.FUTURE]: 'future',
});

export const aggregateDays = (days = []) => {
  const totals = {
    scheduledUnits: 0,
    workedUnits: 0,
    leaveUnits: 0,
    absentUnits: 0,
    dayCounts: { ...EMPTY_DAY_COUNTS },
    workedMinutes: 0,
    breakMinutes: 0,
    sessionDays: 0,
    lateOccurrences: 0,
    lateMinutes: 0,
    earlyOccurrences: 0,
    earlyMinutes: 0,
    missingPunchDays: 0,
    pendingRegDays: 0,
    attendanceOnLeaveDays: 0,
    conflictDays: 0,
    regularizedDays: 0,
    approvedOtMinutes: 0,
    compOffDays: 0,
    workedHolidayDays: 0,
    workedWeeklyOffDays: 0,
    modes: { ...EMPTY_MODES },
  };
  for (const day of days || []) {
    if (!day || typeof day !== 'object') continue;
    const countKey = BUCKET_TO_COUNT[day.bucket];
    if (countKey) totals.dayCounts[countKey] += 1;
    if (day.bucket === TIMESHEET_OUTCOME.FUTURE || day.isFuture === true) continue;

    const units = dayUnits(day);
    totals.scheduledUnits = round2(totals.scheduledUnits + units.scheduled);
    totals.workedUnits = round2(totals.workedUnits + units.worked);
    totals.leaveUnits = round2(totals.leaveUnits + units.leave);
    totals.absentUnits = round2(totals.absentUnits + units.absent);

    totals.workedMinutes += Math.max(0, Math.trunc(Number(day.workedMinutes) || 0));
    totals.breakMinutes += Math.max(0, Math.trunc(Number(day.breakMinutes) || 0));
    if (day.hasSession === true) totals.sessionDays += 1;

    const late = Math.max(0, Number(day.actual?.lateMinutes ?? day.lateMinutes) || 0);
    const early = Math.max(0, Number(day.actual?.earlyMinutes ?? day.earlyMinutes) || 0);
    if (late > 0) {
      totals.lateOccurrences += 1;
      totals.lateMinutes += late;
    }
    if (early > 0) {
      totals.earlyOccurrences += 1;
      totals.earlyMinutes += early;
    }
    const exceptions = Array.isArray(day.exceptions) ? day.exceptions : [];
    if (exceptions.includes(TIMESHEET_EXCEPTION.MISSING_PUNCH)) totals.missingPunchDays += 1;
    if (exceptions.includes(TIMESHEET_EXCEPTION.REGULARIZATION_PENDING)) totals.pendingRegDays += 1;
    if (exceptions.includes(TIMESHEET_EXCEPTION.ATTENDANCE_ON_LEAVE)) totals.attendanceOnLeaveDays += 1;
    if (Array.isArray(day.conflicts) && day.conflicts.length > 0) totals.conflictDays += 1;
    if (day.regularized === true) totals.regularizedDays += 1;

    totals.approvedOtMinutes += Math.max(0, Math.trunc(Number(day.approvedOtMinutes) || 0));
    totals.compOffDays = round2(totals.compOffDays + (Number(day.compOffDays) || 0));

    if (day.hasSession === true) {
      const primary = day.calendarPrimary || day.calendar?.primary || null;
      if (primary === DAY_TYPE.HOLIDAY) totals.workedHolidayDays += 1;
      else if (primary === DAY_TYPE.WEEKLY_OFF) totals.workedWeeklyOffDays += 1;
    }
    if (day.workMode && totals.modes[day.workMode] !== undefined) totals.modes[day.workMode] += 1;
  }
  totals.scheduledUnits = round2(totals.scheduledUnits);
  totals.workedUnits = round2(totals.workedUnits);
  totals.leaveUnits = round2(totals.leaveUnits);
  totals.absentUnits = round2(totals.absentUnits);
  totals.compOffDays = round2(totals.compOffDays);
  return totals;
};

// ── Rates ────────────────────────────────────────────────────
// attendanceRate = worked units / scheduled units (leave excluded
// from the denominator — it is neither worked nor absent).
// absenceRate   = absent units / scheduled units (holidays, weekly
// offs and approved leave never count as absence).

export const attendanceRate = ({ workedUnits = 0, scheduledUnits = 0 } = {}) => ({
  ratio: toRatio(workedUnits, scheduledUnits),
  pct: toPct(workedUnits, scheduledUnits),
});

export const absenceRate = ({ absentUnits = 0, scheduledUnits = 0 } = {}) => ({
  ratio: toRatio(absentUnits, scheduledUnits),
  pct: toPct(absentUnits, scheduledUnits),
});

export const averageWorkedMinutes = ({ workedMinutes = 0, sessionDays = 0 } = {}) => {
  if (!(sessionDays > 0)) return null;
  return Math.round((Number(workedMinutes) || 0) / sessionDays);
};

// ── Source aggregation (31.14 provenance) ────────────────────
// Events missing `source` predate provenance — every one of them
// was punched on WEB (no other write path existed), so they count
// as WEB. This describes provenance, never performance.

export const ANALYTICS_SOURCES = Object.freeze(['WEB', 'KIOSK', 'QR', 'IMPORT', 'DEVICE']);

export const aggregateSources = (counts = {}) => {
  const out = {};
  let total = 0;
  for (const source of ANALYTICS_SOURCES) {
    const value = Math.max(0, Math.trunc(Number(counts[source]) || 0));
    out[source] = value;
    total += value;
  }
  const pcts = {};
  for (const source of ANALYTICS_SOURCES) {
    pcts[source] = toPct(out[source], total);
  }
  return { counts: out, total, pcts };
};

// ── OT aggregation (TIME only — never currency) ──────────────

export const aggregateOt = (requests = []) => {
  const totals = {
    recorded: 0,
    requested: 0,
    approved: 0,
    rejected: 0,
    cancelled: 0,
    pending: 0,
    recordedMinutes: 0,
    requestedMinutes: 0,
    approvedMinutes: 0,
    byCalendar: { WORK_DAY: 0, WEEKLY_OFF: 0, HOLIDAY: 0 },
    compOffDays: 0,
    compOffBySource: { HOLIDAY: 0, WEEKLY_OFF: 0, WORK_DAY: 0 },
  };
  for (const row of requests || []) {
    if (!row || typeof row !== 'object') continue;
    const status = String(row.status || '').toUpperCase();
    if (status === 'PENDING') totals.pending += 1;
    else if (status === 'APPROVED') totals.approved += 1;
    else if (status === 'REJECTED') totals.rejected += 1;
    else if (status === 'CANCELLED') totals.cancelled += 1;
    else continue;
    totals.recorded += 1;
    totals.recordedMinutes += Math.max(0, Math.trunc(Number(row.recordedMinutes) || 0));
    totals.requestedMinutes += Math.max(0, Math.trunc(Number(row.requestedMinutes) || 0));
    if (status !== 'APPROVED') continue;
    totals.requested += 1;
    totals.approvedMinutes += Math.max(0, Math.trunc(Number(row.approvedMinutes) || 0));
    const context = row.calendarSnapshot?.primary || row.calendarContext || 'WORK_DAY';
    if (totals.byCalendar[context] !== undefined) totals.byCalendar[context] += 1;
    const compOff = Number(row.compOffDays) || 0;
    if (compOff > 0) {
      totals.compOffDays = round2(totals.compOffDays + compOff);
      const source = context === 'HOLIDAY' || context === 'WEEKLY_OFF' ? context : 'WORK_DAY';
      totals.compOffBySource[source] = round2(totals.compOffBySource[source] + compOff);
    }
  }
  return totals;
};

// ── Regularization aggregation (controlled types only — free-text
// reasons are never read, never counted, never exported) ──────

export const aggregateRegularizations = (requests = []) => {
  const totals = {
    submitted: 0,
    approved: 0,
    rejected: 0,
    cancelled: 0,
    pending: 0,
    byType: {},
  };
  for (const row of requests || []) {
    if (!row || typeof row !== 'object') continue;
    const status = String(row.status || '').toUpperCase();
    if (!['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status)) continue;
    totals.submitted += 1;
    if (status === 'PENDING') totals.pending += 1;
    else if (status === 'APPROVED') totals.approved += 1;
    else if (status === 'REJECTED') totals.rejected += 1;
    else totals.cancelled += 1;
    const type = String(row.type || 'UNKNOWN');
    totals.byType[type] = (totals.byType[type] || 0) + 1;
  }
  return totals;
};

// ── Reconciliation comparison ────────────────────────────────
// `expected` is built by the service with the REAL 31.11
// buildAutoFromSnapshot over the current snapshot — this function
// only compares. HR-owned entries/config previews are ignored:
// otPolicy is configuration, not an attendance fact.

export const RECON_STATUS = Object.freeze({
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  NOT_SYNCED: 'NOT_SYNCED',
  NOT_FINALIZED: 'NOT_FINALIZED',
});

const RECON_NUMERIC_FIELDS = Object.freeze([
  'workingDays',
  'presentDays',
  'absentDays',
  'lateMarks',
  'halfDays',
  'paidLeaveDays',
  'lopDays',
  'otMinutes',
  'nightShiftCount',
  'weekendShiftCount',
  'holidayShiftCount',
]);

const RECON_LEAVE_FIELDS = Object.freeze(['CASUAL', 'SICK', 'EARNED', 'OTHER']);

export const compareReconLine = ({ expected = null, actual = null, currentVersion = null } = {}) => {
  if (!expected) return { status: RECON_STATUS.NOT_FINALIZED, diffs: [] };
  if (!actual || !actual.attendanceSource) return { status: RECON_STATUS.NOT_SYNCED, diffs: [] };
  const diffs = [];
  if (Number(actual.attendanceSource.version) !== Number(currentVersion)) {
    diffs.push({
      field: 'attendanceSource.version',
      expected: Number(currentVersion) || 0,
      actual: Number(actual.attendanceSource.version) || 0,
    });
  }
  for (const field of RECON_NUMERIC_FIELDS) {
    const want = Number(expected[field]) || 0;
    const got = Number(actual[field]) || 0;
    if (want !== got) diffs.push({ field, expected: want, actual: got });
  }
  for (const field of RECON_LEAVE_FIELDS) {
    const want = Number(expected.leaveBreakdown?.[field]) || 0;
    const got = Number(actual.leaveBreakdown?.[field]) || 0;
    if (want !== got) diffs.push({ field: `leaveBreakdown.${field}`, expected: want, actual: got });
  }
  return { status: diffs.length ? RECON_STATUS.MISMATCH : RECON_STATUS.MATCH, diffs };
};

// ── Employee-table sorting (allowlisted — no raw client sort) ─

export const EMPLOYEE_SORT_FIELDS = Object.freeze([
  'name',
  'employeeCode',
  'workedUnits',
  'absentUnits',
  'attendanceRate',
  'workedMinutes',
  'lateOccurrences',
]);

export const parseEmployeeSort = (value) => {
  const fallback = { field: 'name', dir: 1 };
  if (typeof value !== 'string' || !value) return fallback;
  const descending = value.startsWith('-');
  const field = descending ? value.slice(1) : value;
  if (!EMPLOYEE_SORT_FIELDS.includes(field)) return fallback;
  return { field, dir: descending ? -1 : 1 };
};

export const sortEmployeeRows = (rows = [], sort) => {
  const { field, dir } = parseEmployeeSort(sort);
  const key = (row) => {
    if (field === 'name') return String(row.name || '');
    if (field === 'employeeCode') return String(row.employeeCode || '');
    if (field === 'attendanceRate') return row.attendanceRate?.ratio ?? -1;
    return Number(row[field]) || 0;
  };
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) return String(a.employeeId || '').localeCompare(String(b.employeeId || ''));
    if (typeof ka === 'string') return dir * ka.localeCompare(kb);
    return dir * (ka - kb);
  });
};

// ── Cache filter normalization ───────────────────────────────
// Canonical identity for cached analytics: scope + actor + range +
// filters. Returns null when any part is unusable (caller bypasses
// the cache; validation still runs in the service).

export const normalizeAnalyticsFilters = ({ scope, actorId, from, to, departmentId, shiftId, locationId, workMode, employeeId, report } = {}) => {
  if (!['COMPANY', 'TEAM', 'SELF'].includes(scope)) return null;
  if (!actorId || !isDayKey(from) || !isDayKey(to) || from > to) return null;
  const out = { scope, actorId: String(actorId).toLowerCase(), from, to };
  if (departmentId) out.departmentId = String(departmentId).toLowerCase();
  if (shiftId) out.shiftId = String(shiftId).toLowerCase();
  if (locationId) out.locationId = String(locationId).toLowerCase();
  if (workMode) out.workMode = String(workMode).toUpperCase();
  if (employeeId) out.employeeId = String(employeeId).toLowerCase();
  if (report) out.report = String(report).toLowerCase();
  return out;
};

export const stableSerialize = (obj = {}) =>
  JSON.stringify(
    Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = obj[key];
        return acc;
      }, {})
  );
