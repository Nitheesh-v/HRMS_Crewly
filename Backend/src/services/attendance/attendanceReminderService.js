// ============================================================
//  PHASE 31.13 — ATTENDANCE REMINDER SCHEDULING + DELIVERY
//
//  Read-only against attendance: this module NEVER creates,
//  updates, or deletes Attendance / AttendanceEvent /
//  AttendanceRegularization / AttendanceOvertimeRequest /
//  AttendancePeriod rows. It only READS them to decide whether a
//  reminder is still valid, then writes NOTIFICATION records
//  (Notification bell rows + 28.3 EmailDelivery rows).
//
//  Two reminder legs (28.5/28.6 architecture, SCHEDULED queue):
//
//    DELAYED JOBS (ATTENDANCE_REMINDER + reminderType):
//      SHIFT_START / MISSING_CLOCK_IN / MISSING_CLOCK_OUT /
//      INCOMPLETE_BREAK — one job per employee per day per type,
//      scheduled by hooks + reconcile, revalidated by the worker.
//
//    RECONCILE-DIRECT (no jobs — §12, no job-per-request spam):
//      REG_REVIEW / OT_REVIEW / FINALIZATION_PENDING — reconcile
//      revalidates Mongo truth and notifies at most once per
//      entity per recipient (eventKey dedupe).
//
//  Scheduling never throws (hooks must never break attendance
//  actions); the worker revalidates everything and owns the truth.
// ============================================================

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { JOB_NAMES } from '../../config/queueConfig.js';
import { addScheduledJob, cancelScheduledJob } from '../scheduledJobScheduler.js';
import { requestEmailDelivery } from '../emailDeliveryService.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import {
  preloadScheduleMasters,
  resolveEmployeeScheduleFromMasters,
} from './attendanceScheduleService.js';
import { dayKeyInZone } from './attendanceRegularizationRules.js';
import { leaveCoversDate } from './attendanceReconciliationRules.js';
import { EVENT_TYPE } from './attendancePolicyRules.js';
import { resolveNotificationAudience } from '../payroll/payrollReviewService.js';
import {
  REMINDER_TYPE,
  REVIEW_REMINDER_KIND,
  SKIP_REASON,
  REMINDER_RECONCILE_BOUNDS,
  REVIEW_PENDING_THRESHOLD_MS,
  normalizeNotificationsConfig,
  isReminderEnabled,
  shiftStartDueMs,
  missingClockInDueMs,
  missingClockOutDueMs,
  incompleteBreakDueMs,
  evaluateShiftStartEligibility,
  evaluateMissingClockInEligibility,
  evaluateMissingClockOutEligibility,
  evaluateIncompleteBreakEligibility,
  evaluateReviewEligibility,
  evaluateFinalizationEligibility,
  toDayCompact,
  buildAttendanceReminderJobId,
  buildAttendanceReminderEventKey,
  buildReviewEventKey,
  buildFinalizationEventKey,
  buildReminderCopy,
  formatTimeInZone,
} from './attendanceReminderRules.js';
import User from '../../models/User.js';
import Company from '../../models/Company.js';
import Attendance from '../../models/Attendance.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import Notification from '../../models/Notification.js';
import NotificationPref from '../../models/NotificationPref.js';
import Leave from '../../models/Leave.js';
import AttendanceRegularization from '../../models/AttendanceRegularization.js';
import AttendanceOvertimeRequest from '../../models/AttendanceOvertimeRequest.js';
import AttendancePeriod from '../../models/AttendancePeriod.js';
import logger from '../../config/logger.js';

const ATTENDANCE_NOTIFY_CATEGORY = 'ATTENDANCE';

const REVIEW_PERMISSIONS = Object.freeze({
  [REVIEW_REMINDER_KIND.REG_REVIEW]: 'ATTENDANCE_REGULARIZATION_REVIEW',
  [REVIEW_REMINDER_KIND.OT_REVIEW]: 'ATTENDANCE_OVERTIME_REVIEW',
  [REVIEW_REMINDER_KIND.FINALIZATION_PENDING]: 'ATTENDANCE_FINALIZATION_MANAGE',
});

const toMs = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : null;
};

const strId = (value) => {
  try {
    return value ? String(value) : '';
  } catch {
    return '';
  }
};

// Mongoose Maps survive .lean() as Maps on some versions and as
// plain objects on others — read both shapes (missing key = ON).
const prefIsOn = (container, key) => {
  if (!container) return true;
  const value = typeof container.get === 'function' ? container.get(key) : container[key];
  return value !== false;
};

// ── Reminder context (policy; never throws) ──────────────────
// Only an ACTIVE (current) policy authorizes reminders. Anything
// else — no policy, draft only, read failure — resolves to the
// secure all-disabled default.

export const loadReminderContext = async ({ companyId, deps = {} } = {}) => {
  const fallback = {
    notifications: normalizeNotificationsConfig(null),
    timezone: 'Asia/Kolkata',
    hasActive: false,
  };
  if (!mongoose.isValidObjectId(companyId)) return fallback;
  try {
    const getPolicy = deps.getCurrentPolicy || getCurrentPolicy;
    const result = await getPolicy({ companyId });
    if (!result?.hasActive || !result?.policy) return fallback;
    return {
      notifications: normalizeNotificationsConfig(result.policy.notifications),
      timezone: result.policy.timezone || 'Asia/Kolkata',
      breaksEnabled: result.policy.breaks?.enabled !== false,
      hasActive: true,
    };
  } catch {
    return fallback;
  }
};

export const loadActiveUser = async ({ userId, companyId, deps = {} } = {}) => {
  try {
    if (!mongoose.isValidObjectId(userId)) return null;
    const UserModel = deps.UserModel || User;
    const user = await UserModel.findOne({ _id: userId, status: 'ACTIVE' })
      .select('_id companyId department branch')
      .lean();
    if (!user) return null;
    if (companyId && strId(user.companyId) !== strId(companyId)) return null;
    return user;
  } catch {
    return null;
  }
};

export const loadAttendanceDay = async ({ companyId, userId, day, deps = {} } = {}) => {
  try {
    const AttendanceModel = deps.AttendanceModel || Attendance;
    return await AttendanceModel.findOne({ companyId, user: userId, date: day }).lean();
  } catch {
    return null;
  }
};

// Latest break-ledger state: an open break is a BREAK_START with no
// later BREAK_END (31.2 ledger semantics). Anchor = the start's `at`.
export const loadBreakState = async ({ companyId, userId, day, deps = {} } = {}) => {
  const closed = { breakOpen: false, breakStartAt: null };
  try {
    const AttendanceEventModel = deps.AttendanceEventModel || AttendanceEvent;
    const rows = await AttendanceEventModel.find({
      companyId,
      user: userId,
      date: day,
      type: { $in: [EVENT_TYPE.BREAK_START, EVENT_TYPE.BREAK_END] },
    })
      .sort({ seq: -1 })
      .limit(2)
      .select('type at seq')
      .lean();
    if (!rows?.length || rows[0].type !== EVENT_TYPE.BREAK_START) return closed;
    return { breakOpen: true, breakStartAt: rows[0].at || null };
  } catch {
    return closed;
  }
};

export const hasApprovedLeave = async ({ companyId, userId, day, deps = {} } = {}) => {
  try {
    const LeaveModel = deps.LeaveModel || Leave;
    const rows = await LeaveModel.find({
      companyId,
      user: userId,
      status: 'APPROVED',
      startDate: { $lte: day },
      endDate: { $gte: day },
    }).lean();
    return (rows || []).some((leave) => leaveCoversDate({ leave, date: day }));
  } catch {
    return false;
  }
};

// Injectable seam (default: the real 31.6 resolver). Hermetic tests
// stub the schedule; the resolver itself is covered by 31.6's suite.
const resolveDaySchedule = ({ masters, user, day, timezone, resolve }) => {
  const run = resolve || resolveEmployeeScheduleFromMasters;
  try {
    return run({ masters, user, attendanceDate: day, timezone });
  } catch {
    return null;
  }
};

const scheduleAnchorMs = (sched, reminderType) => {
  if (!sched || sched.status !== 'RESOLVED') return null;
  if (reminderType === REMINDER_TYPE.MISSING_CLOCK_OUT) return toMs(sched.scheduledEndAt);
  return toMs(sched.scheduledStartAt);
};

const dueMsFor = (reminderType, anchorMs, notifications) => {
  switch (reminderType) {
    case REMINDER_TYPE.SHIFT_START:
      return shiftStartDueMs(anchorMs, notifications);
    case REMINDER_TYPE.MISSING_CLOCK_IN:
      return missingClockInDueMs(anchorMs, notifications);
    case REMINDER_TYPE.MISSING_CLOCK_OUT:
      return missingClockOutDueMs(anchorMs, notifications);
    default:
      return null;
  }
};

// ── Scheduling (never throws) ────────────────────────────────
// Best-effort pre-checks keep the queue lean; the worker owns the
// truth, so a stale schedule is harmless (it skips at execution).

export const scheduleShiftReminders = async ({
  companyId,
  user,
  day,
  masters = null,
  enqueue,
  nowMs = Date.now(),
  deps = {},
} = {}) => {
  const results = [];
  const skipAll = (reason) =>
    Object.values(REMINDER_TYPE)
      .filter((type) => type !== REMINDER_TYPE.INCOMPLETE_BREAK)
      .map((type) => ({ type, scheduled: false, reason }));
  try {
    const userId = strId(user?._id || user);
    if (!mongoose.isValidObjectId(companyId) || !mongoose.isValidObjectId(userId) || !toDayCompact(day)) {
      return { day, results: skipAll('INVALID_REF') };
    }
    const ctx = await loadReminderContext({ companyId, deps });
    if (!ctx.hasActive) return { day, results: skipAll(SKIP_REASON.NO_POLICY) };

    let resolved = masters;
    if (!resolved) {
      const preload = deps.preloadScheduleMasters || preloadScheduleMasters;
      resolved = await preload({ companyId, fromDate: day, toDate: day });
    }
    const sched = resolveDaySchedule({ masters: resolved, user, day, timezone: ctx.timezone, resolve: deps.resolveDaySchedule });
    if (!sched || sched.status !== 'RESOLVED' || sched.isWorkingDay !== true) {
      return { day, results: skipAll(SKIP_REASON.NOT_A_WORK_DAY) };
    }
    if (await hasApprovedLeave({ companyId, userId, day, deps })) {
      return { day, results: skipAll(SKIP_REASON.ON_APPROVED_LEAVE) };
    }

    const attendance = await loadAttendanceDay({ companyId, userId, day, deps });
    const hasClockedIn = Boolean(attendance?.punchIn);
    const hasClockedOut = Boolean(attendance?.punchOut);

    for (const type of [REMINDER_TYPE.SHIFT_START, REMINDER_TYPE.MISSING_CLOCK_IN, REMINDER_TYPE.MISSING_CLOCK_OUT]) {
      if (!isReminderEnabled(ctx.notifications, type)) {
        results.push({ type, scheduled: false, reason: SKIP_REASON.POLICY_DISABLED });
        continue;
      }
      const anchorMs = scheduleAnchorMs(sched, type);
      const dueMs = anchorMs === null ? null : dueMsFor(type, anchorMs, ctx.notifications);
      if (anchorMs === null || dueMs === null) {
        results.push({ type, scheduled: false, reason: SKIP_REASON.ANCHOR_CHANGED });
        continue;
      }
      // SHIFT_START is pointless once the start has passed (the
      // missing-in leg owns late arrivals). Missing-* legs fire
      // immediately when already due — delay clamps to 0.
      if (type === REMINDER_TYPE.SHIFT_START && dueMs <= nowMs) {
        results.push({ type, scheduled: false, reason: 'PAST_DUE' });
        continue;
      }
      // Schedule-time pre-checks (worker revalidates at execution):
      // clock-IN state is final (punches never un-happen), but
      // clock-OUT jobs must NOT require a clock-in yet — reconcile
      // schedules them in the morning, hours before anyone clocks in.
      if ((type === REMINDER_TYPE.SHIFT_START || type === REMINDER_TYPE.MISSING_CLOCK_IN) && hasClockedIn) {
        results.push({ type, scheduled: false, reason: SKIP_REASON.ALREADY_CLOCKED_IN });
        continue;
      }
      if (type === REMINDER_TYPE.MISSING_CLOCK_OUT && hasClockedOut) {
        results.push({ type, scheduled: false, reason: SKIP_REASON.ALREADY_CLOCKED_OUT });
        continue;
      }
      const jobId = buildAttendanceReminderJobId(userId, type, day, anchorMs);
      if (!jobId) {
        results.push({ type, scheduled: false, reason: 'INVALID_ID' });
        continue;
      }
      // Best-effort dedupe pre-check: already notified → don't
      // requeue. Races stay safe via the unique eventKey.
      const eventKey = buildAttendanceReminderEventKey(companyId, type, userId, day, anchorMs);
      if (eventKey) {
        try {
          const NotificationModel = deps.NotificationModel || Notification;
          const seen = await NotificationModel.findOne({ companyId, eventKey }).select('_id').lean();
          if (seen) {
            results.push({ type, scheduled: false, reason: SKIP_REASON.ALREADY_NOTIFIED });
            continue;
          }
        } catch {
          // Pre-check failure must not block scheduling.
        }
      }
      const outcome = await addScheduledJob({
        jobName: JOB_NAMES.ATTENDANCE_REMINDER,
        jobId,
        payload: {
          companyId: strId(companyId),
          employeeId: userId,
          attendanceDate: day,
          reminderType: type,
          anchorIso: new Date(anchorMs).toISOString(),
          correlationId: crypto.randomUUID(),
        },
        executeAt: new Date(dueMs),
        enqueue,
      });
      results.push(
        outcome?.scheduled
          ? { type, scheduled: true, jobId, dueAt: new Date(dueMs).toISOString() }
          : { type, scheduled: false, reason: 'QUEUE_UNAVAILABLE' }
      );
    }
    return { day, results };
  } catch {
    return { day, results: skipAll('SCHEDULER_ERROR') };
  }
};

export const scheduleBreakReminder = async ({
  companyId,
  userId,
  day,
  breakStartAt,
  enqueue,
  deps = {},
} = {}) => {
  try {
    if (!mongoose.isValidObjectId(companyId) || !mongoose.isValidObjectId(userId) || !toDayCompact(day)) {
      return { scheduled: false, reason: 'INVALID_REF' };
    }
    const anchorMs = toMs(breakStartAt);
    if (anchorMs === null) return { scheduled: false, reason: 'INVALID_ANCHOR' };
    const ctx = await loadReminderContext({ companyId, deps });
    if (!ctx.hasActive) return { scheduled: false, reason: SKIP_REASON.NO_POLICY };
    if (!isReminderEnabled(ctx.notifications, REMINDER_TYPE.INCOMPLETE_BREAK)) {
      return { scheduled: false, reason: SKIP_REASON.POLICY_DISABLED };
    }
    if (ctx.breaksEnabled === false) return { scheduled: false, reason: SKIP_REASON.BREAKS_DISABLED };
    const dueMs = incompleteBreakDueMs(anchorMs, ctx.notifications);
    const jobId = buildAttendanceReminderJobId(userId, REMINDER_TYPE.INCOMPLETE_BREAK, day, anchorMs);
    if (dueMs === null || !jobId) return { scheduled: false, reason: 'INVALID_ID' };
    const outcome = await addScheduledJob({
      jobName: JOB_NAMES.ATTENDANCE_REMINDER,
      jobId,
      payload: {
        companyId: strId(companyId),
        employeeId: strId(userId),
        attendanceDate: day,
        reminderType: REMINDER_TYPE.INCOMPLETE_BREAK,
        anchorIso: new Date(anchorMs).toISOString(),
        correlationId: crypto.randomUUID(),
      },
      executeAt: new Date(dueMs),
      enqueue,
    });
    return outcome?.scheduled
      ? { scheduled: true, jobId, dueAt: new Date(dueMs).toISOString() }
      : { scheduled: false, reason: 'QUEUE_UNAVAILABLE' };
  } catch {
    return { scheduled: false, reason: 'SCHEDULER_ERROR' };
  }
};

// Best-effort cancellation (resolve/retire hygiene). Anchors come
// from the day snapshot when present, else a fresh 31.6 resolve.
// Unresolvable anchors return 'unknown' — execution-time validation
// is the real protection, never this removal.
export const cancelShiftReminderJobs = async ({
  companyId,
  user,
  userId: userIdArg,
  day,
  types = [REMINDER_TYPE.SHIFT_START, REMINDER_TYPE.MISSING_CLOCK_IN, REMINDER_TYPE.MISSING_CLOCK_OUT],
  breakStartAt = null,
  deps = {},
} = {}) => {
  const results = [];
  try {
    const userId = strId(userIdArg || user?._id || user);
    if (!mongoose.isValidObjectId(companyId) || !mongoose.isValidObjectId(userId) || !toDayCompact(day)) {
      return types.map((type) => ({ type, jobId: null, result: 'invalid-ref' }));
    }
    const attendance = await loadAttendanceDay({ companyId, userId, day, deps });
    let startMs = toMs(attendance?.scheduleSnapshot?.scheduledStartAt);
    let endMs = toMs(attendance?.scheduleSnapshot?.scheduledEndAt);
    if ((startMs === null || endMs === null) && user) {
      try {
        const ctx = await loadReminderContext({ companyId, deps });
        const preload = deps.preloadScheduleMasters || preloadScheduleMasters;
        const resolved = await preload({ companyId, fromDate: day, toDate: day });
        const sched = resolveDaySchedule({ masters: resolved, user, day, timezone: ctx.timezone, resolve: deps.resolveDaySchedule });
        if (sched?.status === 'RESOLVED') {
          startMs = startMs ?? toMs(sched.scheduledStartAt);
          endMs = endMs ?? toMs(sched.scheduledEndAt);
        }
      } catch {
        // Anchor resolution failure → 'unknown' below.
      }
    }
    const cancel = deps.cancelScheduledJob || cancelScheduledJob;
    for (const type of types) {
      const anchorMs =
        type === REMINDER_TYPE.MISSING_CLOCK_OUT
          ? endMs
          : type === REMINDER_TYPE.INCOMPLETE_BREAK
            ? toMs(breakStartAt)
            : startMs;
      const jobId = anchorMs === null ? null : buildAttendanceReminderJobId(userId, type, day, anchorMs);
      if (!jobId) {
        results.push({ type, jobId: null, result: 'unknown' });
        continue;
      }
      results.push({ type, jobId, result: await cancel(jobId) });
    }
    return results;
  } catch {
    return types.map((type) => ({ type, jobId: null, result: 'unavailable' }));
  }
};

// Reactive scheduling after a shift assignment (bounded horizon).
// Masters are preloaded ONCE for the whole call; callers pass full
// user docs (the 31.6 resolver needs department/branch).
export const scheduleForAssignmentDays = async ({
  companyId,
  users = [],
  fromDay,
  days = REMINDER_RECONCILE_BOUNDS.shiftHookHorizonDays,
  enqueue,
  nowMs = Date.now(),
  deps = {},
} = {}) => {
  const summary = { users: 0, days: 0, queued: 0, skipped: 0 };
  try {
    if (!mongoose.isValidObjectId(companyId) || !toDayCompact(fromDay)) return summary;
    const ctx = await loadReminderContext({ companyId, deps });
    if (!ctx.hasActive) return summary;
    const horizon = Math.min(14, Math.max(1, Math.trunc(days) || 1));
    const startDay = fromDay > dayKeyInZone(new Date(nowMs), ctx.timezone) ? fromDay : dayKeyInZone(new Date(nowMs), ctx.timezone);
    const dayList = [];
    const cursor = new Date(`${startDay}T00:00:00Z`);
    for (let i = 0; i < horizon; i += 1) {
      dayList.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const preload = deps.preloadScheduleMasters || preloadScheduleMasters;
    const masters = await preload({ companyId, fromDate: dayList[0], toDate: dayList[dayList.length - 1] });
    const list = (users || []).filter(Boolean).slice(0, REMINDER_RECONCILE_BOUNDS.departmentHookMaxUsers);
    for (const user of list) {
      summary.users += 1;
      for (const day of dayList) {
        summary.days += 1;
        try {
          const outcome = await scheduleShiftReminders({ companyId, user, day, masters, enqueue, nowMs, deps });
          for (const r of outcome.results || []) {
            if (r.scheduled) summary.queued += 1;
            else summary.skipped += 1;
          }
        } catch {
          summary.skipped += 1;
        }
      }
    }
    return summary;
  } catch {
    return summary;
  }
};

// ── Delivery (worker path; prefs-aware; never throws on business ─
// paths — only unexpected infra failures propagate for retry) ────

export const deliverReminder = async ({
  companyId,
  userId,
  kind,
  eventKey,
  copyFacts = {},
  entityType = 'ATTENDANCE_REMINDER',
  entityId,
  recipientType = 'EMPLOYEE',
  emailPayload = {},
  deps = {},
} = {}) => {
  const outcome = { dispatched: false, inapp: 'skipped', email: 'skipped', duplicate: false };
  if (!mongoose.isValidObjectId(companyId) || !mongoose.isValidObjectId(userId) || !eventKey) {
    return outcome;
  }
  const copy = buildReminderCopy(kind, copyFacts);
  const title = String(copy.title || 'Attendance reminder').slice(0, 120);
  const message = String(copy.message || '').slice(0, 300);

  let inappOn = true;
  let emailOn = true;
  try {
    const NotificationPrefModel = deps.NotificationPrefModel || NotificationPref;
    const pref = await NotificationPrefModel.findOne({ user: userId }).lean();
    inappOn = prefIsOn(pref?.inapp, ATTENDANCE_NOTIFY_CATEGORY);
    emailOn = prefIsOn(pref?.email, ATTENDANCE_NOTIFY_CATEGORY);
  } catch {
    // Pref read failure → default ON (missing = ON semantics).
  }
  if (!inappOn && !emailOn) {
    outcome.inapp = 'muted';
    outcome.email = 'muted';
    return outcome;
  }

  if (inappOn) {
    try {
      const NotificationModel = deps.NotificationModel || Notification;
      await NotificationModel.create({
        companyId,
        user: userId,
        type: ATTENDANCE_NOTIFY_CATEGORY,
        title,
        message,
        link: copy.link || '/app/attendance',
        eventKey,
      });
      outcome.inapp = 'sent';
      outcome.dispatched = true;
    } catch (error) {
      if (error?.code === 11000) {
        outcome.inapp = 'duplicate';
        outcome.duplicate = true;
        outcome.dispatched = true;
      } else {
        throw error;
      }
    }
  } else {
    outcome.inapp = 'muted';
  }

  if (emailOn) {
    const dispatch = deps.dispatch || requestEmailDelivery;
    const emailKeys = { employeeId: strId(userId), reminderType: kind, ...emailPayload };
    const result = await dispatch({
      jobName: JOB_NAMES.EMAIL_ATTENDANCE_REMINDER,
      eventType: `ATTENDANCE_${kind}`,
      eventKey,
      companyId,
      entityType,
      entityId,
      recipientType,
      recipientReference: userId,
      payload: emailKeys,
    });
    if (result?.queued || result?.duplicate) {
      outcome.email = result.duplicate ? 'duplicate' : 'queued';
      if (result.duplicate) outcome.duplicate = true;
      outcome.dispatched = true;
    } else {
      outcome.email = 'failed';
    }
  } else {
    outcome.email = 'muted';
  }
  return outcome;
};

// ── Worker execution (revalidate Mongo truth, then deliver) ────
// Business ineligibility → { skipped }. Unexpected infra failures
// propagate so BullMQ retries (attempts=3, exp backoff).

export const executeReminder = async (
  { companyId, employeeId, attendanceDate, reminderType, anchorIso } = {},
  deps = {}
) => {
  const skip = (reason) => ({ processed: false, skipped: true, reason });
  const user = await loadActiveUser({ userId: employeeId, companyId, deps });
  if (!user) return skip(SKIP_REASON.EMPLOYEE_INACTIVE);
  const ctx = await loadReminderContext({ companyId, deps });
  if (!ctx.hasActive) return skip(SKIP_REASON.NO_POLICY);
  if (!isReminderEnabled(ctx.notifications, reminderType)) return skip(SKIP_REASON.POLICY_DISABLED);

  const payloadAnchorMs = toMs(anchorIso);
  if (payloadAnchorMs === null) return skip(SKIP_REASON.ANCHOR_CHANGED);

  if (reminderType === REMINDER_TYPE.INCOMPLETE_BREAK) {
    if (ctx.breaksEnabled === false) return skip(SKIP_REASON.BREAKS_DISABLED);
    const { breakOpen, breakStartAt } = await loadBreakState({ companyId, userId: employeeId, day: attendanceDate, deps });
    const verdict = evaluateIncompleteBreakEligibility({
      policyEnabled: true,
      breaksEnabled: true,
      anchorChanged: toMs(breakStartAt) !== payloadAnchorMs,
      breakStillOpen: breakOpen,
    });
    if (!verdict.eligible) return skip(verdict.reason);
    const minutesOpen = Math.max(1, Math.floor((Date.now() - payloadAnchorMs) / 60000));
    const eventKey = buildAttendanceReminderEventKey(companyId, reminderType, employeeId, attendanceDate, anchorIso);
    const delivery = await deliverReminder({
      companyId,
      userId: employeeId,
      kind: reminderType,
      eventKey,
      copyFacts: { minutesOpen },
      entityId: employeeId,
      emailPayload: { attendanceDate, anchorIso: new Date(payloadAnchorMs).toISOString() },
      deps,
    });
    return { processed: true, ...delivery };
  }

  const preload = deps.preloadScheduleMasters || preloadScheduleMasters;
  const masters = await preload({ companyId, fromDate: attendanceDate, toDate: attendanceDate });
  const sched = resolveDaySchedule({ masters, user, day: attendanceDate, timezone: ctx.timezone, resolve: deps.resolveDaySchedule });
  if (!sched || sched.status !== 'RESOLVED' || sched.isWorkingDay !== true) {
    return skip(SKIP_REASON.NOT_A_WORK_DAY);
  }
  const liveAnchorMs = scheduleAnchorMs(sched, reminderType);
  if (liveAnchorMs !== payloadAnchorMs) return skip(SKIP_REASON.ANCHOR_CHANGED);
  if (await hasApprovedLeave({ companyId, userId: employeeId, day: attendanceDate, deps })) {
    return skip(SKIP_REASON.ON_APPROVED_LEAVE);
  }

  const attendance = await loadAttendanceDay({ companyId, userId: employeeId, day: attendanceDate, deps });
  const facts = {
    policyEnabled: true,
    isWorkDay: true,
    onApprovedLeave: false,
    anchorChanged: false,
    hasClockedIn: Boolean(attendance?.punchIn),
    hasClockedOut: Boolean(attendance?.punchOut),
  };
  const verdict =
    reminderType === REMINDER_TYPE.SHIFT_START
      ? evaluateShiftStartEligibility(facts)
      : reminderType === REMINDER_TYPE.MISSING_CLOCK_IN
        ? evaluateMissingClockInEligibility(facts)
        : evaluateMissingClockOutEligibility(facts);
  if (!verdict.eligible) return skip(verdict.reason);

  const eventKey = buildAttendanceReminderEventKey(companyId, reminderType, employeeId, attendanceDate, anchorIso);
  const delivery = await deliverReminder({
    companyId,
    userId: employeeId,
    kind: reminderType,
    eventKey,
    copyFacts:
      reminderType === REMINDER_TYPE.SHIFT_START
        ? { timeLabel: formatTimeInZone(payloadAnchorMs, ctx.timezone) }
        : {},
    entityId: employeeId,
    emailPayload: { attendanceDate, anchorIso: new Date(payloadAnchorMs).toISOString() },
    deps,
  });
  return { processed: true, ...delivery };
};

// ── Reconcile-direct reviewer reminders (no delayed jobs) ─────

const notifyReviewAudience = async ({
  companyId,
  kind,
  entity,
  entityType,
  pendingSinceMs,
  nowMs = Date.now(),
  copyFacts = {},
  emailPayload = {},
  deps = {},
}) => {
  const summary = { notified: 0, skipped: 0, errors: 0, reason: null };
  const verdict = evaluateReviewEligibility({ status: entity?.status, pendingSinceMs, nowMs });
  if (!verdict.eligible) {
    summary.reason = verdict.reason;
    return summary;
  }
  const permission = REVIEW_PERMISSIONS[kind];
  let audience = [];
  try {
    const resolveAudience = deps.resolveNotificationAudience || resolveNotificationAudience;
    audience = (await resolveAudience({ companyId, permissions: [permission] })) || [];
  } catch {
    summary.errors += 1;
    return summary;
  }
  const NotificationModel = deps.NotificationModel || Notification;
  for (const recipient of audience) {
    const recipientId = strId(recipient?._id || recipient);
    if (!mongoose.isValidObjectId(recipientId)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const eventKey = buildReviewEventKey(companyId, kind, entity._id, recipientId);
      if (!eventKey) {
        summary.skipped += 1;
        continue;
      }
      const seen = await NotificationModel.findOne({ companyId, eventKey }).select('_id').lean().catch(() => null);
      if (seen) {
        summary.skipped += 1;
        continue;
      }
      const delivery = await deliverReminder({
        companyId,
        userId: recipientId,
        kind,
        eventKey,
        copyFacts,
        entityType,
        entityId: entity._id,
        recipientType: 'HR',
        emailPayload,
        deps,
      });
      if (delivery.dispatched) summary.notified += 1;
      else summary.skipped += 1;
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
};

export const notifyRegReviewers = async ({ request, nowMs = Date.now(), deps = {} } = {}) =>
  notifyReviewAudience({
    companyId: request?.companyId,
    kind: REVIEW_REMINDER_KIND.REG_REVIEW,
    entity: request,
    entityType: 'ATTENDANCE_REGULARIZATION',
    pendingSinceMs: toMs(request?.createdAt),
    nowMs,
    emailPayload: { requestId: strId(request?._id) },
    deps,
  });

export const notifyOtReviewers = async ({ request, nowMs = Date.now(), deps = {} } = {}) =>
  notifyReviewAudience({
    companyId: request?.companyId,
    kind: REVIEW_REMINDER_KIND.OT_REVIEW,
    entity: request,
    entityType: 'ATTENDANCE_OVERTIME',
    pendingSinceMs: toMs(request?.createdAt),
    nowMs,
    emailPayload: { requestId: strId(request?._id) },
    deps,
  });

export const notifyFinalizationPending = async ({ companyId, period, nowMs = Date.now(), deps = {} } = {}) => {
  const summary = { notified: 0, skipped: 0, errors: 0, reason: null };
  const month = period?.month;
  const verdict = evaluateFinalizationEligibility({ periodStatus: period?.status, monthElapsed: true });
  if (!verdict.eligible || !month) {
    summary.reason = verdict.reason;
    return summary;
  }
  let audience = [];
  try {
    const resolveAudience = deps.resolveNotificationAudience || resolveNotificationAudience;
    audience = (await resolveAudience({
      companyId,
      permissions: [REVIEW_PERMISSIONS[REVIEW_REMINDER_KIND.FINALIZATION_PENDING]],
    })) || [];
  } catch {
    summary.errors += 1;
    return summary;
  }
  const NotificationModel = deps.NotificationModel || Notification;
  for (const recipient of audience) {
    const recipientId = strId(recipient?._id || recipient);
    if (!mongoose.isValidObjectId(recipientId)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const eventKey = buildFinalizationEventKey(companyId, month, recipientId);
      if (!eventKey) {
        summary.skipped += 1;
        continue;
      }
      const seen = await NotificationModel.findOne({ companyId, eventKey }).select('_id').lean().catch(() => null);
      if (seen) {
        summary.skipped += 1;
        continue;
      }
      const delivery = await deliverReminder({
        companyId,
        userId: recipientId,
        kind: REVIEW_REMINDER_KIND.FINALIZATION_PENDING,
        eventKey,
        copyFacts: { month, periodStatus: String(period.status || 'open').toLowerCase() },
        entityType: 'ATTENDANCE_PERIOD',
        entityId: period._id,
        recipientType: 'HR',
        emailPayload: { month },
        deps,
      });
      if (delivery.dispatched) summary.notified += 1;
      else summary.skipped += 1;
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
};

// ── Reconciliation (bounded; never throws) ───────────────────
// Employee shift/missing legs are policy-gated; reviewer and
// finalization legs are operational (always evaluated).

export const loadCompaniesForReminderReconcile = async ({ limit = 50, deps = {} } = {}) => {
  try {
    const CompanyModel = deps.CompanyModel || Company;
    return await CompanyModel.find({ status: 'ACTIVE' })
      .select('_id')
      .sort({ _id: 1 })
      .limit(Math.min(200, Math.max(1, limit)))
      .lean();
  } catch {
    return [];
  }
};

export const reconcileCompanyAttendance = async ({ companyId, now = new Date(), enqueue, deps = {} } = {}) => {
  const summary = { checked: 0, queued: 0, skipped: 0, reviewerNotified: 0, errors: 0 };
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  try {
    const ctx = await loadReminderContext({ companyId, deps });
    const today = dayKeyInZone(now, ctx.timezone);
    const tomorrowDate = new Date(`${today}T00:00:00Z`);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const days = [today, tomorrowDate.toISOString().slice(0, 10)];

    const anyEmployeeLeg =
      ctx.hasActive &&
      [REMINDER_TYPE.SHIFT_START, REMINDER_TYPE.MISSING_CLOCK_IN, REMINDER_TYPE.MISSING_CLOCK_OUT].some((type) =>
        isReminderEnabled(ctx.notifications, type)
      );

    if (anyEmployeeLeg) {
      const preload = deps.preloadScheduleMasters || preloadScheduleMasters;
      const masters = await preload({ companyId, fromDate: days[0], toDate: days[days.length - 1] });
      const UserModel = deps.UserModel || User;
      const users = await UserModel.find({ companyId, status: 'ACTIVE' })
        .select('_id department branch')
        .sort({ _id: 1 })
        .limit(REMINDER_RECONCILE_BOUNDS.maxEmployeesPerCompany)
        .lean();
      for (const user of users || []) {
        summary.checked += 1;
        for (const day of days) {
          try {
            const outcome = await scheduleShiftReminders({ companyId, user, day, masters, enqueue, nowMs, deps });
            for (const r of outcome.results || []) {
              if (r.scheduled) summary.queued += 1;
              else summary.skipped += 1;
            }
          } catch {
            summary.errors += 1;
          }
        }
      }
    }

    // Reviewer legs: PENDING older than 24h, bounded per company.
    const staleBefore = new Date(nowMs - REVIEW_PENDING_THRESHOLD_MS);
    try {
      const RegularizationModel = deps.RegularizationModel || AttendanceRegularization;
      const regs = await RegularizationModel.find({ companyId, status: 'PENDING', createdAt: { $lt: staleBefore } })
        .select('_id companyId status createdAt')
        .sort({ createdAt: 1, _id: 1 })
        .limit(100)
        .lean();
      for (const request of regs || []) {
        try {
          const r = await notifyRegReviewers({ request, nowMs, deps });
          summary.reviewerNotified += r.notified;
          summary.skipped += r.skipped;
          summary.errors += r.errors;
        } catch {
          summary.errors += 1;
        }
      }
    } catch {
      summary.errors += 1;
    }
    try {
      const OvertimeModel = deps.OvertimeModel || AttendanceOvertimeRequest;
      const ots = await OvertimeModel.find({ companyId, status: 'PENDING', createdAt: { $lt: staleBefore } })
        .select('_id companyId status createdAt')
        .sort({ createdAt: 1, _id: 1 })
        .limit(100)
        .lean();
      for (const request of ots || []) {
        try {
          const r = await notifyOtReviewers({ request, nowMs, deps });
          summary.reviewerNotified += r.notified;
          summary.skipped += r.skipped;
          summary.errors += r.errors;
        } catch {
          summary.errors += 1;
        }
      }
    } catch {
      summary.errors += 1;
    }

    // Finalization leg: elapsed months still OPEN/REOPENED.
    try {
      const PeriodModel = deps.PeriodModel || AttendancePeriod;
      const currentMonth = today.slice(0, 7);
      const periods = await PeriodModel.find({
        companyId,
        status: { $in: ['OPEN', 'REOPENED'] },
        month: { $lt: currentMonth },
      })
        .select('_id companyId month status')
        .sort({ month: 1 })
        .limit(12)
        .lean();
      for (const period of periods || []) {
        try {
          const r = await notifyFinalizationPending({ companyId, period, nowMs, deps });
          summary.reviewerNotified += r.notified;
          summary.skipped += r.skipped;
          summary.errors += r.errors;
        } catch {
          summary.errors += 1;
        }
      }
    } catch {
      summary.errors += 1;
    }
    return summary;
  } catch {
    summary.errors += 1;
    return summary;
  }
};

export const runAttendanceReminderReconcile = async ({
  now = new Date(),
  limit = REMINDER_RECONCILE_BOUNDS.maxCompaniesPerRun,
  enqueue,
  deps = {},
  loadCompanies = loadCompaniesForReminderReconcile,
} = {}) => {
  const summary = { companies: 0, checked: 0, queued: 0, skipped: 0, reviewerNotified: 0, errors: 0 };
  let companies = [];
  try {
    companies = await loadCompanies({ limit, deps });
  } catch {
    summary.errors += 1;
    return summary;
  }
  for (const company of (companies || []).slice(0, REMINDER_RECONCILE_BOUNDS.maxCompaniesPerRun)) {
    summary.companies += 1;
    try {
      const r = await reconcileCompanyAttendance({ companyId: company._id, now, enqueue, deps });
      summary.checked += r.checked;
      summary.queued += r.queued;
      summary.skipped += r.skipped;
      summary.reviewerNotified += r.reviewerNotified;
      summary.errors += r.errors;
    } catch {
      summary.errors += 1;
    }
  }
  logger.info(
    `[AttendanceReminders] reconcile: companies=${summary.companies} checked=${summary.checked} ` +
      `queued=${summary.queued} reviewerNotified=${summary.reviewerNotified} errors=${summary.errors}`
  );
  return summary;
};
