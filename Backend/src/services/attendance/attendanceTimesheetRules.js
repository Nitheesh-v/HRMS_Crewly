// ─────────────────────────────────────────────────────────────
// Phase 31.10 — pure monthly-timesheet rules.
//
// Read-model math for the attendance calendar & timesheets:
// month validation/enumeration, daily outcome buckets, monthly
// summaries, export rows, and spreadsheet-safe CSV cells. No
// Mongo, no req/res, no Redis, no payroll. Day boundaries are
// plain 'YYYY-MM-DD' string math (UTC calendar dates); the
// caller supplies the company-timezone `today` — this module
// never reads a clock or a timezone.
// ─────────────────────────────────────────────────────────────
import { DAILY_OUTCOME } from './attendancePolicyRules.js';
import { DAY_TYPE } from './attendancePolicyRules.js';

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Display outcome buckets (31.10 read model). Mutually exclusive
// per day: every date lands in exactly one bucket. FUTURE days
// are never absence; UNRESOLVED means "cannot determine the
// expectation" (never a guess).
export const TIMESHEET_OUTCOME = Object.freeze({
  PRESENT: 'PRESENT',
  HALF_DAY: 'HALF_DAY',
  ABSENT: 'ABSENT',
  LEAVE: 'LEAVE',
  HOLIDAY: 'HOLIDAY',
  WEEKLY_OFF: 'WEEKLY_OFF',
  UNRESOLVED: 'UNRESOLVED',
  FUTURE: 'FUTURE',
});

// Exception codes surfaced on timesheet days (safe display codes
// only — never free text, never employee-submitted reasons).
export const TIMESHEET_EXCEPTION = Object.freeze({
  LATE_ARRIVAL: 'LATE_ARRIVAL',
  EARLY_EXIT: 'EARLY_EXIT',
  MISSING_PUNCH: 'MISSING_PUNCH',
  REGULARIZATION_PENDING: 'REGULARIZATION_PENDING',
  ATTENDANCE_ON_LEAVE: 'ATTENDANCE_ON_LEAVE',
});

export const isValidMonth = (value) =>
  typeof value === 'string' && MONTH_PATTERN.test(value);

const lastDayOfMonth = (year, monthIndex1) =>
  new Date(Date.UTC(year, monthIndex1, 0)).getUTCDate();

// Every business date of a validated 'YYYY-MM' (28–31 entries).
// Throws on invalid input — callers validate for 400s first.
export const enumerateMonthDates = (month) => {
  if (!isValidMonth(month)) throw new Error('month must be YYYY-MM');
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const last = lastDayOfMonth(year, mon);
  const out = [];
  for (let day = 1; day <= last; day += 1) {
    out.push(`${month}-${String(day).padStart(2, '0')}`);
  }
  return out;
};

export const monthBounds = (month) => {
  const dates = enumerateMonthDates(month);
  return { start: dates[0], end: dates[dates.length - 1], dates };
};

// ── Daily outcome bucket ───────────────────────────────────────
// Exactly one bucket per day (see TIMESHEET_OUTCOME). Inputs are
// the 31.7 resolution facts (stored or live-resolved):
// - outcome: DAILY_OUTCOME value (or null when unresolvable)
// - fractions: { worked, leave, absent } day-equivalents
// - calendarPrimary: WORK_DAY / HOLIDAY / WEEKLY_OFF
// - flags: isFuture, scheduleResolved (false when no schedule
//   could be resolved AND no control exists for the day)
//
// Bucket rule (deterministic, documented):
//   future → FUTURE · full-day leave → LEAVE · partial leave →
//   HALF_DAY · PRESENT/HALF_DAY outcome → same ·
//   NON_WORKING_DAY → HOLIDAY/WEEKLY_OFF by calendar · ABSENT →
//   ABSENT (only with a resolved expectation) · else UNRESOLVED.
export const bucketDayOutcome = ({
  isFuture = false,
  outcome = null,
  fractions = null,
  calendarPrimary = DAY_TYPE.WORK_DAY,
  scheduleResolved = true,
  hasControl = false,
} = {}) => {
  if (isFuture) return TIMESHEET_OUTCOME.FUTURE;
  const leave = Math.max(0, Number(fractions?.leave) || 0);
  if (leave >= 1) return TIMESHEET_OUTCOME.LEAVE;
  if (leave > 0) return TIMESHEET_OUTCOME.HALF_DAY;
  if (outcome === DAILY_OUTCOME.PRESENT) return TIMESHEET_OUTCOME.PRESENT;
  if (outcome === DAILY_OUTCOME.HALF_DAY) return TIMESHEET_OUTCOME.HALF_DAY;
  if (outcome === DAILY_OUTCOME.NON_WORKING_DAY) {
    return calendarPrimary === DAY_TYPE.HOLIDAY
      ? TIMESHEET_OUTCOME.HOLIDAY
      : TIMESHEET_OUTCOME.WEEKLY_OFF;
  }
  if (outcome === DAILY_OUTCOME.ABSENT) {
    // Absence needs a known expectation: a schedule-resolved day
    // (or any recorded control) may be absent; a day whose
    // expectation is unknown stays UNRESOLVED, never absent.
    return scheduleResolved || hasControl
      ? TIMESHEET_OUTCOME.ABSENT
      : TIMESHEET_OUTCOME.UNRESOLVED;
  }
  return TIMESHEET_OUTCOME.UNRESOLVED;
};

// ── Monthly summary ────────────────────────────────────────────
// Pure aggregation over normalized day objects. Dimensions that
// overlap stay separate counters (never summed together):
// - dayCounts: exclusive outcome buckets (FUTURE reported alone)
// - equivalents: 31.7 fraction sums (worked/leave/absent)
// - modes: work-mode day breakdown (orthogonal to outcomes)
// - minutes/flags: simple sums over non-future days
//
// Day shape consumed (all fields optional, defensively read):
// { date, bucket, fractions, workMode, workedMinutes,
//   breakMinutes, exceptions[], regularized, approvedOtMinutes,
//   compOffDays, scheduledWorkingDay, calendarPrimary,
//   hasSession }
export const EMPTY_TIMESHEET_SUMMARY = Object.freeze({
  scheduledWorkingDays: 0,
  dayCounts: Object.freeze({
    present: 0,
    halfDay: 0,
    absent: 0,
    leave: 0,
    holiday: 0,
    weeklyOff: 0,
    unresolved: 0,
    future: 0,
  }),
  equivalents: Object.freeze({ worked: 0, leave: 0, absent: 0 }),
  modes: Object.freeze({
    OFFICE: 0,
    WFH: 0,
    FIELD: 0,
    CLIENT_SITE: 0,
    BUSINESS_TRAVEL: 0,
  }),
  workedMinutes: 0,
  breakMinutes: 0,
  lateDays: 0,
  earlyExitDays: 0,
  missingPunchDays: 0,
  unresolvedDays: 0,
  regularizedDays: 0,
  workedOnHolidayDays: 0,
  workedOnWeeklyOffDays: 0,
  approvedOtMinutes: 0,
  compOffEarnedDays: 0,
  exceptionDays: 0,
  totalDays: 0,
});

const BUCKET_COUNT_KEY = Object.freeze({
  [TIMESHEET_OUTCOME.PRESENT]: 'present',
  [TIMESHEET_OUTCOME.HALF_DAY]: 'halfDay',
  [TIMESHEET_OUTCOME.ABSENT]: 'absent',
  [TIMESHEET_OUTCOME.LEAVE]: 'leave',
  [TIMESHEET_OUTCOME.HOLIDAY]: 'holiday',
  [TIMESHEET_OUTCOME.WEEKLY_OFF]: 'weeklyOff',
  [TIMESHEET_OUTCOME.UNRESOLVED]: 'unresolved',
  [TIMESHEET_OUTCOME.FUTURE]: 'future',
});

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const summarizeMonth = (days = []) => {
  const summary = {
    scheduledWorkingDays: 0,
    dayCounts: { ...EMPTY_TIMESHEET_SUMMARY.dayCounts },
    equivalents: { ...EMPTY_TIMESHEET_SUMMARY.equivalents },
    modes: { ...EMPTY_TIMESHEET_SUMMARY.modes },
    workedMinutes: 0,
    breakMinutes: 0,
    lateDays: 0,
    earlyExitDays: 0,
    missingPunchDays: 0,
    unresolvedDays: 0,
    regularizedDays: 0,
    workedOnHolidayDays: 0,
    workedOnWeeklyOffDays: 0,
    approvedOtMinutes: 0,
    compOffEarnedDays: 0,
    exceptionDays: 0,
    totalDays: days.length,
  };
  for (const day of days) {
    if (day?.scheduledWorkingDay === true) summary.scheduledWorkingDays += 1;
    const countKey = BUCKET_COUNT_KEY[day?.bucket];
    if (countKey) summary.dayCounts[countKey] += 1;
    if (day?.bucket === TIMESHEET_OUTCOME.FUTURE) continue;
    summary.equivalents.worked += Math.max(0, Number(day?.fractions?.worked) || 0);
    summary.equivalents.leave += Math.max(0, Number(day?.fractions?.leave) || 0);
    summary.equivalents.absent += Math.max(0, Number(day?.fractions?.absent) || 0);
    if (day?.workMode && summary.modes[day.workMode] !== undefined) {
      summary.modes[day.workMode] += 1;
    }
    summary.workedMinutes += Math.max(0, Math.trunc(Number(day?.workedMinutes) || 0));
    summary.breakMinutes += Math.max(0, Math.trunc(Number(day?.breakMinutes) || 0));
    const exceptions = Array.isArray(day?.exceptions) ? day.exceptions : [];
    if (exceptions.includes(TIMESHEET_EXCEPTION.LATE_ARRIVAL)) summary.lateDays += 1;
    if (exceptions.includes(TIMESHEET_EXCEPTION.EARLY_EXIT)) summary.earlyExitDays += 1;
    if (exceptions.includes(TIMESHEET_EXCEPTION.MISSING_PUNCH)) summary.missingPunchDays += 1;
    if (day?.bucket === TIMESHEET_OUTCOME.UNRESOLVED) summary.unresolvedDays += 1;
    if (day?.regularized === true) summary.regularizedDays += 1;
    if (day?.hasSession === true && day?.calendarPrimary === DAY_TYPE.HOLIDAY) {
      summary.workedOnHolidayDays += 1;
    }
    if (day?.hasSession === true && day?.calendarPrimary === DAY_TYPE.WEEKLY_OFF) {
      summary.workedOnWeeklyOffDays += 1;
    }
    summary.approvedOtMinutes += Math.max(0, Math.trunc(Number(day?.approvedOtMinutes) || 0));
    summary.compOffEarnedDays += Math.max(0, Number(day?.compOffDays) || 0);
    if (exceptions.length > 0) summary.exceptionDays += 1;
  }
  summary.equivalents.worked = round2(summary.equivalents.worked);
  summary.equivalents.leave = round2(summary.equivalents.leave);
  summary.equivalents.absent = round2(summary.equivalents.absent);
  summary.compOffEarnedDays = round2(summary.compOffEarnedDays);
  return summary;
};

// Compact team-table row from a full summary (exactly the §14
// columns, plus identity the serializer attaches separately).
export const summarizeTeamRow = (summary = {}) => ({
  scheduledWorkingDays: summary.scheduledWorkingDays || 0,
  present: summary.dayCounts?.present || 0,
  halfDay: summary.dayCounts?.halfDay || 0,
  leave: summary.dayCounts?.leave || 0,
  absent: summary.dayCounts?.absent || 0,
  lateDays: summary.lateDays || 0,
  workedMinutes: summary.workedMinutes || 0,
  approvedOtMinutes: summary.approvedOtMinutes || 0,
  exceptionDays: summary.exceptionDays || 0,
  unresolvedDays: summary.unresolvedDays || 0,
});

// ── Spreadsheet-safe CSV cells ─────────────────────────────────
// Byte-parity with the audit export's csvCell (auditController):
// formula-prefix guard (' when starting with = + - @), then
// always-quote with doubled quotes. BOM + CRLF joining happens
// at document build (same as the audit precedent).
export const csvCell = (value) => {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
};

export const EXPORT_COLUMNS = Object.freeze([
  'Employee',
  'Employee code',
  'Department',
  'Date',
  'Outcome',
  'Scheduled in',
  'Scheduled out',
  'Effective in',
  'Effective out',
  'Worked minutes',
  'Break minutes',
  'Work mode',
  'Leave',
  'Calendar',
  'Holiday',
  'Late minutes',
  'Early minutes',
  'Approved OT minutes',
  'Comp-off days',
  'Exceptions',
  'Regularized',
]);

// One export row per employee-day (values pre-formatted by the
// service; this only orders + escapes them).
export const buildExportRow = (day = {}) => [
  day.employeeName ?? '',
  day.employeeCode ?? '',
  day.departmentName ?? '',
  day.date ?? '',
  day.outcome ?? '',
  day.scheduledIn ?? '',
  day.scheduledOut ?? '',
  day.effectiveIn ?? '',
  day.effectiveOut ?? '',
  day.workedMinutes ?? '',
  day.breakMinutes ?? '',
  day.workMode ?? '',
  day.leaveLabel ?? '',
  day.calendar ?? '',
  day.holidayName ?? '',
  day.lateMinutes ?? '',
  day.earlyMinutes ?? '',
  day.approvedOtMinutes ?? '',
  day.compOffDays ?? '',
  (day.exceptions || []).join(';'),
  day.regularized ? 'YES' : '',
];

export const buildExportCsv = (rows = []) => {
  const lines = [
    EXPORT_COLUMNS.map(csvCell).join(','),
    ...rows.map((row) => buildExportRow(row).map(csvCell).join(',')),
  ];
  return `\uFEFF${lines.join('\r\n')}`;
};
