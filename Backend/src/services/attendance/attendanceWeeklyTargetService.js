// ═══════════════════════════════════════════════════════════════════════════
//  WEEKLY-HOURS FLEXI TARGET — SERVICE (the thin I/O shell)
//
//  All decisions live in attendanceWeeklyTargetRules (pure, hermetic). This
//  module only reads rows, writes materialized rest rows and fires the
//  one-time earned-rest nudge. Every entry point is best-effort: a weekly-
//  target failure must never break a punch, payroll inputs, or a read.
//
//  Materialization is idempotent: the Attendance unique {user, date} index
//  is the race guard, and an E11000 on insert simply means someone else
//  (another read, another instance) already wrote the same rest day.
// ═══════════════════════════════════════════════════════════════════════════

import Attendance from '../../models/Attendance.js';
import Holiday from '../../models/Holiday.js';
import Leave from '../../models/Leave.js';
import logger from '../../config/logger.js';
import Notification from '../../models/Notification.js';
import {
  crossingDecision,
  normaliseWeeklyTargetPolicy,
  restDayDecision,
  weekWindowFor,
} from './attendanceWeeklyTargetRules.js';

const dayKeysBetween = (startKey, endKey) => {
  const keys = [];
  const [y, m, d] = String(startKey || '').split('-').map(Number);
  const [ey, em, ed] = String(endKey || '').split('-').map(Number);
  if (!y || !m || !d || !ey || !em || !ed) return keys;
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  while (cursor <= end && keys.length < 400) {
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cursor.getUTCDate()).padStart(2, '0');
    keys.push(`${cursor.getUTCFullYear()}-${mm}-${dd}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
};

const dayKeyOfDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${mm}-${dd}`;
};

// Week context for dashboards and the qualification nudge.
export const getWeekContext = async ({
  companyId,
  userId,
  date,
  todayKey = null,
  AttendanceModel = Attendance,
  policy = null,
  policyLoader = null,
}) => {
  const effectivePolicy = policyLoader ? await policyLoader(companyId) : policy;
  const config = normaliseWeeklyTargetPolicy(effectivePolicy);
  const { weekStart, weekEnd } = weekWindowFor(date);

  const weekRows = await AttendanceModel.find({
    companyId,
    user: userId,
    date: { $gte: weekStart, $lte: weekEnd },
  })
    .select('date status workMinutes overtimeMinutes')
    .lean();

  const configForSums = { includeApprovedOvertime: config.includeApprovedOvertime };
  const sumThrough = (rows) => rows.reduce(
    (total, row) => total
      + Math.max(0, Number(row.workMinutes) || 0)
      + (configForSums.includeApprovedOvertime ? Math.max(0, Number(row.overtimeMinutes) || 0) : 0),
    0,
  );

  const achievedMinutes = sumThrough(weekRows.filter((row) => row.date <= date));
  return {
    enabled: config.enabled,
    targetMinutes: config.targetMinutes,
    weekStart,
    weekEnd,
    achievedMinutes,
    remainingMinutes: Math.max(0, config.targetMinutes - achievedMinutes),
    qualified: achievedMinutes >= config.targetMinutes,
    restDayMode: config.restDayMode,
    includeApprovedOvertime: config.includeApprovedOvertime,
    todayKey,
  };
};

// Fire-and-forget crossing nudge after a day's minutes become final.
// The Notification {companyId, eventKey} partial-unique index makes this
// exactly-once per employee per week — a retried punch cannot re-notify.
export const onControlDayFinalized = async ({
  companyId,
  userId,
  date,
  policy = null,
  policyLoader = null,
  AttendanceModel = Attendance,
  UserModel = null,
}) => {
  try {
    const effectivePolicy = policyLoader ? await policyLoader(companyId) : policy;
    const decision = crossingDecision({
      policyBlock: effectivePolicy,
      weekRows: await AttendanceModel.find({
        companyId,
        user: userId,
        date: { $gte: weekWindowFor(date).weekStart, $lte: weekWindowFor(date).weekEnd },
      })
        .select('date workMinutes overtimeMinutes')
        .lean(),
      date,
    });

    if (!decision.crossed) return { crossed: false, reason: decision.reason };

    const hoursLabel = Math.round((decision.targetMinutes / 60) * 10) / 10;
    await Notification.create({
      companyId,
      user: userId,
      type: 'ATTENDANCE',
      title: 'Weekly target met 🎉',
      message: `You have completed your ${hoursLabel}h weekly hours goal. The remaining working days this week are earned rest — enjoy, or punch in if you choose to work.`,
      link: '/app/attendance',
      eventKey: `WEEKLY_TARGET_MET:${userId}:${decision.weekStart}`,
    });
    return { crossed: true, ...decision };
  } catch (error) {
    // A lost notification race (E11000 on the eventKey) or any other failure
    // must never surface to the punch. Already-notified counts as success.
    if (error?.code === 11000) return { crossed: true, reason: 'ALREADY_NOTIFIED' };
    logger.warn(`weekly-target nudge failed: ${error?.message}`);
    return { crossed: false, reason: 'ERROR' };
  }
};

// Materialize earned-rest rows for elapsed, unworked, leave-free days.
// Called before payroll monthly-input aggregation, before finalization
// derivation and from the weekly-context read — whoever arrives first
// writes the rows; everyone else no-ops.
export const materializeRestDays = async ({
  companyId,
  userId,
  startKey,
  endKey,
  todayKey,
  AttendanceModel = Attendance,
  LeaveModel = Leave,
  HolidayModel = Holiday,
  policy = null,
  policyLoader = null,
}) => {
  const effectivePolicy = policyLoader ? await policyLoader(companyId) : policy;
  const config = normaliseWeeklyTargetPolicy(effectivePolicy);
  if (!config.enabled || config.restDayMode !== 'AUTO_MARK') {
    return { created: 0, skipped: 'POLICY_OFF' };
  }

  // "Elapsed" is judged in the POLICY's timezone, not the server's UTC —
  // a 2026-10-10 08:00 IST morning must not treat 2026-10-10 as past.
  const effectiveToday = todayKey
    || dayKeyInZone(new Date(), effectivePolicy?.timezone || 'Asia/Kolkata');

  const dates = dayKeysBetween(startKey, endKey).filter((key) => key < effectiveToday);
  if (!dates.length) return { created: 0, skipped: 'NOTHING_ELAPSED' };

  const rangeStart = dates[0];
  const rangeEnd = dates[dates.length - 1];

  const [rows, leaves, holidays] = await Promise.all([
    AttendanceModel.find({
      companyId,
      user: userId,
      date: { $gte: rangeStart, $lte: rangeEnd },
    })
      .select('date status workMinutes overtimeMinutes')
      .lean(),
    LeaveModel
      ? LeaveModel.find({
        companyId,
        user: userId,
        status: 'APPROVED',
        startDate: { $lte: `${rangeEnd}T23:59:59.999Z` },
        endDate: { $gte: `${rangeStart}T00:00:00.000Z` },
      })
        .select('startDate endDate')
        .lean()
      : [],
    HolidayModel
      ? HolidayModel.find({ companyId, date: { $gte: rangeStart, $lte: rangeEnd } })
        .select('date')
        .lean()
      : [],
  ]);

  const rowDates = new Set(rows.map((row) => row.date));
  const holidayDates = new Set(
    (holidays || [])
      .map((row) => dayKeyOfDate(row.date))
      .filter(Boolean),
  );
  const leaveDates = new Set();
  for (const leave of leaves || []) {
    const from = dayKeyOfDate(leave.startDate);
    const to = dayKeyOfDate(leave.endDate);
    if (!from || !to) continue;
    for (const key of dayKeysBetween(
      from < rangeStart ? rangeStart : from,
      to > rangeEnd ? rangeEnd : to,
    )) {
      leaveDates.add(key);
    }
  }

  let created = 0;
  for (const date of dates) {
    const decision = restDayDecision({
      policyBlock: effectivePolicy,
      weekRows: rows,
      date,
      holidayDates,
      leaveDates,
      hasRow: rowDates.has(date),
      todayKey: effectiveToday,
    });
    if (!decision.rest) continue;

    try {
      await AttendanceModel.create({
        companyId,
        user: userId,
        date,
        status: 'WEEKLY_TARGET_OFF',
        workMinutes: 0,
        weeklyTarget: {
          weekStart: decision.weekStart,
          targetMinutes: decision.targetMinutes,
          achievedMinutes: decision.achievedMinutes,
        },
      });
      created += 1;
      rowDates.add(date);
    } catch (error) {
      if (error?.code === 11000) continue; // already materialized — race won by a peer
      throw error;
    }
  }

  return { created };
};

export default {
  getWeekContext,
  onControlDayFinalized,
  materializeRestDays,
};
