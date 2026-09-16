// ─────────────────────────────────────────────────────────────
// Phase 31.12 — pure HR attendance-operations rules.
//
// Aggregation over 31.9 presence ROWS (never re-derivation: the
// presence, calendar, schedule and exception facts arrive already
// derived by attendancePresenceService). No Mongo, no req/res, no
// Redis, no clock reads, no server-local timezone assumption —
// the caller passes the business date and every fact the rules
// need. All comparisons happen on ISO day keys / UTC instants.
//
// Dimension discipline (§5): presence, work-mode, calendar and
// attention are ORTHOGONAL dimensions. Presence buckets are
// mutually exclusive; work-mode breaks down the working rows
// only; attention items overlap headcount and must never be
// summed with it. Counts reconcile: scope = applicable +
// nonApplicable; applicable = expected + nonWorking.
// ─────────────────────────────────────────────────────────────
import { PRESENCE_STATE, PRESENCE_EXCEPTION } from './attendancePresenceRules.js';
import { ISSUE_SEVERITY, ISSUE_WORKFLOW } from './attendanceFinalizationRules.js';
import { DAY_TYPE, WORK_MODE } from './attendancePolicyRules.js';

// ── Attention vocabulary ───────────────────────────────────────
// Categories are stable codes (never free text). Severity reuses
// the 31.11 BLOCKER/WARNING vocabulary plus operational INFO.
// A BLOCKER here means "would block month-end finalization if
// still open then" — NOT "payroll is blocked right now".

export const ATTENTION_CATEGORY = Object.freeze({
  LATE_NOT_IN: 'LATE_NOT_IN',
  LATE_ARRIVAL: 'LATE_ARRIVAL',
  MISSING_PUNCH: 'MISSING_PUNCH',
  UNRESOLVED_SESSION: 'UNRESOLVED_SESSION',
  INCOMPLETE_BREAK: 'INCOMPLETE_BREAK',
  EARLY_EXIT: 'EARLY_EXIT',
  SHORT_HOURS: 'SHORT_HOURS',
  RECON_CONFLICT: 'RECON_CONFLICT',
  REG_PENDING: 'REG_PENDING',
  OT_PENDING: 'OT_PENDING',
  WORKED_DAY_OFF: 'WORKED_DAY_OFF',
});

export const ATTENTION_SEVERITY = Object.freeze({
  BLOCKER: ISSUE_SEVERITY.BLOCKER,
  WARNING: ISSUE_SEVERITY.WARNING,
  INFO: 'INFO',
});

export const ATTENTION_WORKFLOW = Object.freeze({
  [ATTENTION_CATEGORY.LATE_NOT_IN]: ISSUE_WORKFLOW.LATE_ARRIVAL,
  [ATTENTION_CATEGORY.LATE_ARRIVAL]: ISSUE_WORKFLOW.LATE_ARRIVAL,
  [ATTENTION_CATEGORY.MISSING_PUNCH]: ISSUE_WORKFLOW.MISSING_PUNCH,
  [ATTENTION_CATEGORY.UNRESOLVED_SESSION]: ISSUE_WORKFLOW.OPEN_SESSION,
  [ATTENTION_CATEGORY.INCOMPLETE_BREAK]: ISSUE_WORKFLOW.OPEN_SESSION,
  [ATTENTION_CATEGORY.EARLY_EXIT]: ISSUE_WORKFLOW.EARLY_EXIT,
  [ATTENTION_CATEGORY.SHORT_HOURS]: ISSUE_WORKFLOW.EARLY_EXIT,
  [ATTENTION_CATEGORY.RECON_CONFLICT]: ISSUE_WORKFLOW.ATTENDANCE_ON_LEAVE,
  [ATTENTION_CATEGORY.REG_PENDING]: ISSUE_WORKFLOW.REGULARIZATION_PENDING,
  [ATTENTION_CATEGORY.OT_PENDING]: ISSUE_WORKFLOW.PENDING_OT,
  [ATTENTION_CATEGORY.WORKED_DAY_OFF]: ISSUE_WORKFLOW.WORKED_HOLIDAY,
});

export const ATTENTION_LABEL = Object.freeze({
  [ATTENTION_CATEGORY.LATE_NOT_IN]: 'Late — not in yet',
  [ATTENTION_CATEGORY.LATE_ARRIVAL]: 'Late arrival',
  [ATTENTION_CATEGORY.MISSING_PUNCH]: 'Missing punch',
  [ATTENTION_CATEGORY.UNRESOLVED_SESSION]: 'Unresolved session',
  [ATTENTION_CATEGORY.INCOMPLETE_BREAK]: 'Break left open',
  [ATTENTION_CATEGORY.EARLY_EXIT]: 'Early exit',
  [ATTENTION_CATEGORY.SHORT_HOURS]: 'Short hours',
  [ATTENTION_CATEGORY.RECON_CONFLICT]: 'Attendance/leave conflict',
  [ATTENTION_CATEGORY.REG_PENDING]: 'Regularization pending',
  [ATTENTION_CATEGORY.OT_PENDING]: 'OT review pending',
  [ATTENTION_CATEGORY.WORKED_DAY_OFF]: 'Worked day off',
});

export const isValidAttentionCategory = (value) =>
  typeof value === 'string' && Object.values(ATTENTION_CATEGORY).includes(value);

// Short-hours tolerance: a completed day within 60 minutes of the
// scheduled length is normal variance (grace, rounding, approved
// early leave handled elsewhere) — only a larger shortfall pages
// HR. Documented heuristic, day-facts only.
export const SHORT_HOURS_TOLERANCE_MINUTES = 60;

// ── Small helpers ──────────────────────────────────────────────

const toMs = (value) => {
  if (value === null || value === undefined) return NaN;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? NaN : ms;
};

const hasException = (row, code) =>
  Array.isArray(row?.exceptions) && row.exceptions.includes(code);

const NON_WORKING_PRESENCE = new Set([
  PRESENCE_STATE.ON_LEAVE,
  PRESENCE_STATE.HOLIDAY,
  PRESENCE_STATE.WEEKLY_OFF,
]);

const WORKING_PRESENCE = new Set([
  PRESENCE_STATE.WORKING,
  PRESENCE_STATE.ON_BREAK,
]);

const SESSION_PRESENCE = new Set([
  PRESENCE_STATE.WORKING,
  PRESENCE_STATE.ON_BREAK,
  PRESENCE_STATE.COMPLETED,
]);

// ── Employment applicability (§6/§7) ───────────────────────────
// dateOfJoining / lastWorkingDate arrive as YYYY-MM-DD keys (or
// null when unknown — never fabricated). String comparison is
// exact for zero-padded ISO keys.

export const isApplicable = ({ dateOfJoining = null, lastWorkingDate = null, businessDate = '' } = {}) => {
  if (!businessDate) return false;
  if (dateOfJoining && dateOfJoining > businessDate) return false;
  if (lastWorkingDate && businessDate > lastWorkingDate) return false;
  return true;
};

export const isExpected = ({ row = null, employment = null, businessDate = '' } = {}) => {
  if (!row) return false;
  if (!isApplicable({ ...(employment || {}), businessDate })) return false;
  return !NON_WORKING_PRESENCE.has(row.presence);
};

// ── Attention classification ───────────────────────────────────
// Deterministic items over one 31.9 row. Minutes prefer the
// authoritative 31.1/31.6 facts (opsFacts) and fall back to the
// schedule/clock arithmetic the row already carries.

const lateArrivalMinutes = (row) => {
  if (Number.isFinite(Number(row?.lateMinutes)) && Number(row.lateMinutes) > 0) {
    return Math.trunc(Number(row.lateMinutes));
  }
  const startMs = toMs(row?.schedule?.scheduledStartAt);
  const inMs = toMs(row?.clockInAt);
  if (Number.isNaN(startMs) || Number.isNaN(inMs)) return 0;
  return Math.max(0, Math.round((inMs - startMs) / 60000));
};

const earlyExitMinutes = (row) => {
  if (Number.isFinite(Number(row?.earlyMinutes)) && Number(row.earlyMinutes) > 0) {
    return Math.trunc(Number(row.earlyMinutes));
  }
  const endMs = toMs(row?.schedule?.scheduledEndAt);
  const outMs = toMs(row?.clockOutAt);
  if (Number.isNaN(endMs) || Number.isNaN(outMs)) return 0;
  return Math.max(0, Math.round((endMs - outMs) / 60000));
};

const scheduledMinutesOf = (row) => {
  const startMs = toMs(row?.schedule?.scheduledStartAt);
  const endMs = toMs(row?.schedule?.scheduledEndAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return 0;
  return Math.round((endMs - startMs) / 60000);
};

export const classifyAttention = (row = null) => {
  if (!row) return [];
  const items = [];
  const push = (category, severity, extra = {}) => {
    items.push({
      category,
      severity,
      label: ATTENTION_LABEL[category],
      workflow: ATTENTION_WORKFLOW[category],
      ...extra,
    });
  };

  if (row.presence === PRESENCE_STATE.LATE_NOT_IN) {
    push(ATTENTION_CATEGORY.LATE_NOT_IN, ATTENTION_SEVERITY.WARNING, {
      minutes: Math.max(0, Math.trunc(Number(row?.late?.lateMinutes) || 0)),
      scheduledStartAt: row?.schedule?.scheduledStartAt || null,
      since: row?.schedule?.scheduledStartAt || null,
    });
  }
  if (hasException(row, PRESENCE_EXCEPTION.LATE_ARRIVAL)) {
    push(ATTENTION_CATEGORY.LATE_ARRIVAL, ATTENTION_SEVERITY.WARNING, {
      minutes: lateArrivalMinutes(row),
      clockInAt: row?.clockInAt || null,
      scheduledStartAt: row?.schedule?.scheduledStartAt || null,
      since: row?.clockInAt || null,
    });
  }
  if (hasException(row, PRESENCE_EXCEPTION.MISSING_PUNCH)) {
    push(ATTENTION_CATEGORY.MISSING_PUNCH, ATTENTION_SEVERITY.BLOCKER, {
      since: row?.clockInAt || row?.schedule?.scheduledStartAt || null,
    });
  }
  if (hasException(row, PRESENCE_EXCEPTION.STALE_OPEN_SESSION)) {
    push(
      row?.liveState === 'ON_BREAK'
        ? ATTENTION_CATEGORY.INCOMPLETE_BREAK
        : ATTENTION_CATEGORY.UNRESOLVED_SESSION,
      ATTENTION_SEVERITY.BLOCKER,
      { since: row?.clockInAt || row?.breakStartedAt || null },
    );
  }
  if (hasException(row, PRESENCE_EXCEPTION.EARLY_EXIT)) {
    push(ATTENTION_CATEGORY.EARLY_EXIT, ATTENTION_SEVERITY.WARNING, {
      minutes: earlyExitMinutes(row),
      clockOutAt: row?.clockOutAt || null,
      scheduledEndAt: row?.schedule?.scheduledEndAt || null,
      since: row?.clockOutAt || null,
    });
  }
  if (row.presence === PRESENCE_STATE.COMPLETED && !row?.scheduleUnresolved) {
    const scheduled = scheduledMinutesOf(row);
    const worked = Math.max(0, Math.trunc(Number(row?.workedMinutes) || 0));
    if (scheduled > 0 && worked < scheduled - SHORT_HOURS_TOLERANCE_MINUTES) {
      push(ATTENTION_CATEGORY.SHORT_HOURS, ATTENTION_SEVERITY.WARNING, {
        minutes: scheduled - worked,
        workedMinutes: worked,
        scheduledMinutes: scheduled,
        since: row?.clockOutAt || null,
      });
    }
  }
  if (hasException(row, PRESENCE_EXCEPTION.ATTENDANCE_ON_LEAVE)) {
    push(ATTENTION_CATEGORY.RECON_CONFLICT, ATTENTION_SEVERITY.BLOCKER, {
      since: row?.clockInAt || null,
    });
  } else if (row?.needsReview === true) {
    push(ATTENTION_CATEGORY.RECON_CONFLICT, ATTENTION_SEVERITY.WARNING, {
      since: row?.clockInAt || null,
    });
  }
  if (hasException(row, PRESENCE_EXCEPTION.REGULARIZATION_PENDING)) {
    push(ATTENTION_CATEGORY.REG_PENDING, ATTENTION_SEVERITY.WARNING, {
      since: row?.clockInAt || row?.schedule?.scheduledStartAt || null,
    });
  }
  if (row?.ot?.pending === true) {
    push(ATTENTION_CATEGORY.OT_PENDING, ATTENTION_SEVERITY.WARNING, {
      since: row?.clockInAt || row?.schedule?.scheduledStartAt || null,
    });
  }
  if (SESSION_PRESENCE.has(row?.presence)
    && (row?.calendar?.primary === DAY_TYPE.HOLIDAY || row?.calendar?.primary === DAY_TYPE.WEEKLY_OFF)) {
    push(ATTENTION_CATEGORY.WORKED_DAY_OFF, ATTENTION_SEVERITY.INFO, {
      calendar: row.calendar.primary,
      holidayName: row?.calendar?.holidayName || null,
      since: row?.clockInAt || null,
    });
  }
  return items;
};

// ── Operations summary ─────────────────────────────────────────
// Buckets count APPLICABLE rows only (pre-joiners and exited
// employees are employment facts, not today's operations).
// `employmentByUser` maps user id → { dateOfJoining,
// lastWorkingDate } day keys (missing entry = no constraint).

export const EMPTY_OPS_SUMMARY = Object.freeze({
  scope: 0,
  applicable: 0,
  nonApplicable: 0,
  expected: 0,
  nonWorking: 0,
  working: 0,
  onBreak: 0,
  completed: 0,
  notIn: 0,
  lateNotIn: 0,
  unresolved: 0,
  onLeave: 0,
  holiday: 0,
  weeklyOff: 0,
});

export const EMPTY_MODE_COUNTS = Object.freeze({
  [WORK_MODE.OFFICE]: 0,
  [WORK_MODE.WFH]: 0,
  [WORK_MODE.FIELD]: 0,
  [WORK_MODE.CLIENT_SITE]: 0,
  [WORK_MODE.BUSINESS_TRAVEL]: 0,
  NONE: 0,
});

const PRESENCE_BUCKET = Object.freeze({
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

export const summarizeOperations = (rows = [], { employmentByUser = null, businessDate = '' } = {}) => {
  const summary = { ...EMPTY_OPS_SUMMARY };
  const modes = { ...EMPTY_MODE_COUNTS };
  let blockers = 0;
  let warnings = 0;
  let info = 0;
  let peopleNeedingAttention = 0;
  const employmentOf = (row) => employmentByUser?.get?.(String(row?.user?.id)) || null;

  for (const row of rows || []) {
    summary.scope += 1;
    const employment = employmentOf(row);
    if (!isApplicable({ ...(employment || {}), businessDate })) {
      summary.nonApplicable += 1;
      continue;
    }
    summary.applicable += 1;
    if (NON_WORKING_PRESENCE.has(row?.presence)) summary.nonWorking += 1;
    else summary.expected += 1;
    const bucket = PRESENCE_BUCKET[row?.presence];
    if (bucket) summary[bucket] += 1;
    if (WORKING_PRESENCE.has(row?.presence)) {
      const mode = row?.workMode && modes[row.workMode] !== undefined ? row.workMode : 'NONE';
      modes[mode] += 1;
    }
    const items = classifyAttention(row);
    if (items.length > 0) peopleNeedingAttention += 1;
    for (const item of items) {
      if (item.severity === ATTENTION_SEVERITY.BLOCKER) blockers += 1;
      else if (item.severity === ATTENTION_SEVERITY.WARNING) warnings += 1;
      else info += 1;
    }
  }
  return {
    summary,
    modes,
    attention: {
      people: peopleNeedingAttention,
      items: blockers + warnings + info,
      blockers,
      warnings,
      info,
    },
  };
};

// ── Groupings (applicable rows; same headcount discipline) ──────

const blankGroup = () => ({
  expected: 0,
  working: 0,
  onBreak: 0,
  completed: 0,
  notIn: 0,
  lateNotIn: 0,
  onLeave: 0,
  attention: 0,
});

export const groupOperations = (rows = [], { employmentByUser = null, businessDate = '' } = {}) => {
  const departments = new Map();
  const shifts = new Map();
  const locations = new Map();
  const employmentOf = (row) => employmentByUser?.get?.(String(row?.user?.id)) || null;

  for (const row of rows || []) {
    if (!isApplicable({ ...(employmentOf(row) || {}), businessDate })) continue;
    const needsAttention = classifyAttention(row).length > 0;
    const deptId = row?.user?.department?.id ? String(row.user.department.id) : '';
    if (!departments.has(deptId)) {
      departments.set(deptId, {
        id: deptId || null,
        name: row?.user?.department?.name || 'Unassigned',
        ...blankGroup(),
      });
    }
    const shiftName = row?.schedule?.shiftName || 'Unassigned';
    if (!shifts.has(shiftName)) shifts.set(shiftName, { name: shiftName, ...blankGroup() });
    for (const group of [departments.get(deptId), shifts.get(shiftName)]) {
      if (!NON_WORKING_PRESENCE.has(row?.presence)) group.expected += 1;
      if (row?.presence === PRESENCE_STATE.WORKING) group.working += 1;
      else if (row?.presence === PRESENCE_STATE.ON_BREAK) group.onBreak += 1;
      else if (row?.presence === PRESENCE_STATE.COMPLETED) group.completed += 1;
      else if (row?.presence === PRESENCE_STATE.NOT_IN) group.notIn += 1;
      else if (row?.presence === PRESENCE_STATE.LATE_NOT_IN) group.lateNotIn += 1;
      else if (row?.presence === PRESENCE_STATE.ON_LEAVE) group.onLeave += 1;
      if (needsAttention) group.attention += 1;
    }
    // Locations count office check-ins only: users carry no home
    // location, so "expected per location" would be fabricated.
    if (row?.locationName && row?.clockInAt) {
      if (!locations.has(row.locationName)) {
        locations.set(row.locationName, {
          name: row.locationName, checkedIn: 0, working: 0, lateArrivals: 0,
        });
      }
      const loc = locations.get(row.locationName);
      loc.checkedIn += 1;
      if (WORKING_PRESENCE.has(row?.presence)) loc.working += 1;
      if (hasException(row, PRESENCE_EXCEPTION.LATE_ARRIVAL)) loc.lateArrivals += 1;
    }
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  return {
    departments: [...departments.values()].sort(byName),
    shifts: [...shifts.values()].sort(byName),
    locations: [...locations.values()].sort(byName),
  };
};

// ── Derived-side filters (allowlisted, tenant-safe by design: ───
// foreign values simply match nothing inside scope rows) ────────

export const matchesOpsFilters = (row, items = [], filters = {}, employment = null) => {
  if (!row) return false;
  if (Array.isArray(filters.presence) && filters.presence.length > 0
    && !filters.presence.includes(row.presence)) return false;
  if (Array.isArray(filters.workMode) && filters.workMode.length > 0
    && !filters.workMode.includes(row?.workMode || 'NONE')) return false;
  if (Array.isArray(filters.categories) && filters.categories.length > 0
    && !items.some((item) => filters.categories.includes(item.category))) return false;
  if (filters.managerId) {
    if (String(employment?.reportingTo || '') !== String(filters.managerId)) return false;
  }
  if (filters.shift) {
    const name = row?.schedule?.shiftName || 'Unassigned';
    if (name !== filters.shift) return false;
  }
  if (filters.location) {
    if ((row?.locationName || '') !== filters.location) return false;
  }
  return true;
};

export const paginate = (items = [], page = 1, pageSize = 25) => {
  const safeSize = Math.min(100, Math.max(1, Math.trunc(Number(pageSize)) || 25));
  const total = (items || []).length;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const safePage = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), totalPages);
  const start = (safePage - 1) * safeSize;
  return {
    items: (items || []).slice(start, start + safeSize),
    page: safePage,
    pageSize: safeSize,
    total,
    totalPages,
  };
};

// ── Safe attention serializer (safe identity + issue facts only) ─

export const serializeAttentionItem = ({ row = null, item = null } = {}) => ({
  category: item?.category,
  severity: item?.severity,
  label: item?.label,
  workflow: item?.workflow,
  minutes: Number.isFinite(Number(item?.minutes)) ? item.minutes : null,
  since: item?.since || null,
  scheduledStartAt: item?.scheduledStartAt || null,
  scheduledEndAt: item?.scheduledEndAt || null,
  clockInAt: row?.clockInAt || null,
  clockOutAt: row?.clockOutAt || null,
  workMode: row?.workMode || null,
  presence: row?.presence || null,
  liveState: row?.liveState || null,
  employee: {
    id: String(row?.user?.id || ''),
    name: row?.user?.name || '',
    employeeCode: row?.user?.employeeCode || '',
    designation: row?.user?.designation || '',
    department: row?.user?.department
      ? { id: String(row.user.department.id || ''), name: row.user.department.name || '' }
      : null,
  },
  shiftName: row?.schedule?.shiftName || null,
  locationName: row?.locationName || null,
});
