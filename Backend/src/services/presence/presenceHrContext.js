// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.6 — READ-ONLY HR CONTEXT FOR PRESENCE
//
//  Provides two read-only lookups the 37.6 resolver consumes:
//    · findActiveApprovedLeave  — leaves that authorize "On Leave"
//                                for the inclusive calendar day
//                                (todayKey in the tenant timezone).
//    · resolveWorkingHoursContext — a thin wrapper around the existing
//                                attendanceScheduleService#resolveEmployeeSchedule,
//                                summarised to the four fields the
//                                presence resolver needs.
//
//  STRICT BOUNDARY (spec §2, §40, §45)
//    The module exports ONLY read helpers. There is no LeaveModel.save,
//    no LeaveModel.findOneAndUpdate, no Attendance create / update, no
//    ShiftAssignment create, no PayrollSnapshot touch, no AI call. The
//    hermetic suite asserts this both behaviorally (throw-on-write
//    sentinels) and statically (source-pin: forbidden strings are
//    never present in the file).
//
//  PRIVACY (spec §10, §37)
//    The Leave projection is the strictest possible: { _id, user,
//    startDate, endDate, status, companyId }. NO reason, NO type, NO
//    approver, NO approverNote, NO decidedAt, NO days. The 37.6 reader
//    never populates any user / approver field; the response is
//    consumed by the resolver as a pure boolean (on_leave or not).
// ═══════════════════════════════════════════════════════════════════════════

import Leave from '../../models/Leave.js';

// Inclusive day-string comparison (YYYY-MM-DD) — same as 31.x.
// Day strings compare lexicographically as ISO dates do.
const isCovered = (row, todayKey) =>
  typeof row?.startDate === 'string' &&
  typeof row?.endDate === 'string' &&
  row.startDate <= todayKey &&
  todayKey <= row.endDate;

// Minimum projection. The select is exhaustive — the resolver never
// touches any other field.
const LEAVE_PROJECTION = '_id user startDate endDate status companyId';

// ── leave reader ─────────────────────────────────────────

/**
 * Find the approved-active leave row for one user on `todayKey`.
 * Returns the row (with the minimum projection) or null.
 *
 * @param {Object} args
 * @param {string} args.companyId
 * @param {string} args.userId
 * @param {string} args.todayKey   — YYYY-MM-DD in the tenant timezone
 * @param {Object} [args.LeaveModel]  — injectable for tests
 * @returns {Promise<Object|null>}
 */
export const findActiveApprovedLeave = async ({
  companyId,
  userId,
  todayKey,
  LeaveModel = Leave,
} = {}) => {
  if (!companyId || !userId || !todayKey) return null;
  if (!LeaveModel) return null;
  // The single query: tenant-scoped, status=APPROVED, day range covers today.
  // We fetch with a limit of 1 — a single employee can in principle have
  // overlapping approved leaves (vacation + sick) and we treat the
  // first-matching as authoritative for the boolean "on leave" read.
  // (Overlapping approved leaves are a real-world edge case; the
  // boolean is the same whether 1 or 2 match.)
  const row = await LeaveModel.findOne({
    companyId,
    user: userId,
    status: 'APPROVED',
    startDate: { $lte: todayKey },
    endDate: { $gte: todayKey },
  })
    .select(LEAVE_PROJECTION)
    .lean();
  if (!row) return null;
  if (!isCovered(row, todayKey)) return null;
  return row;
};

/**
 * Batch variant — for the team endpoint.
 *
 * @returns {Promise<Map<string, Object>>}  userId -> row (or absent)
 */
export const findActiveApprovedLeaveMany = async ({
  companyId,
  userIds,
  todayKey,
  LeaveModel = Leave,
} = {}) => {
  const out = new Map();
  if (!companyId || !Array.isArray(userIds) || userIds.length === 0) return out;
  if (!todayKey) return out;
  if (!LeaveModel) return out;
  const rows = await LeaveModel.find({
    companyId,
    user: { $in: userIds },
    status: 'APPROVED',
    startDate: { $lte: todayKey },
    endDate: { $gte: todayKey },
  })
    .select(LEAVE_PROJECTION)
    .lean();
  for (const row of rows || []) {
    if (!isCovered(row, todayKey)) continue;
    out.set(String(row.user), row);
  }
  return out;
};

// ── working hours reader ─────────────────────────────────

/**
 * Resolve the working-hours context for one user on a given date.
 * Pure wrapper over the authoritative attendanceScheduleService.
 * Returns a small frozen summary the resolver can compose with, or
 * `null` if the schedule read failed / was missing.
 *
 * Shape (frozen, never carries employee reason / type / balance):
 *   { phase, isWorkingDay, dayType, source, crossesMidnight,
 *     startTime, endTime, attendanceDate, timezone }
 */
export const resolveWorkingHoursContext = async ({
  companyId,
  user,
  attendanceDate,
  timezone = 'Asia/Kolkata',
  scheduleResolver = null,
} = {}) => {
  if (!companyId || !user || !attendanceDate) return null;
  // The default resolver is the authoritative 31.6 service. Tests may
  // inject a fake.
  const resolver =
    scheduleResolver ||
    (await import('../attendance/attendanceScheduleService.js'))
      .resolveEmployeeSchedule;
  let ctx = null;
  try {
    ctx = await resolver({
      companyId,
      user,
      attendanceDate,
      timezone,
    });
  } catch {
    // Failure is distinct from "no shift" (spec §54). Return null —
    // the resolver treats null as "schedule unavailable", NOT as
    // "outside working hours".
    return null;
  }
  if (!ctx || ctx.status !== 'RESOLVED') return null;
  // Compute the phase against `now`. We re-use the existing pure
  // helper from the same module so the precedence stays in one
  // place. `now` is optional — when absent, the summary reports
  // `phase: null` (i.e. unevaluated).
  const scheduleRules = await import(
    '../attendance/attendanceScheduleRules.js'
  );
  const summary = scheduleRules.summarizeSchedule(ctx, { now: new Date() });
  if (!summary) return null;
  // Map the phase to a boolean. The resolver carries the boolean
  // AND the raw phase (so the team page can distinguish "before
  // shift" from "after shift" if it ever needs to).
  const outside =
    summary.phase === 'UPCOMING' || summary.phase === 'ENDED' || summary.isWorkingDay === false;
  return Object.freeze({
    phase: summary.phase,
    isWorkingDay: summary.isWorkingDay === true,
    dayType: summary.dayType || null,
    source: ctx.source || null,
    crossesMidnight: ctx.crossesMidnight === true,
    startTime: ctx.startTime || null,
    endTime: ctx.endTime || null,
    attendanceDate: ctx.attendanceDate || attendanceDate,
    timezone: ctx.timezone || timezone,
    outsideWorkingHours: outside,
  });
};

export default {
  findActiveApprovedLeave,
  findActiveApprovedLeaveMany,
  resolveWorkingHoursContext,
};
