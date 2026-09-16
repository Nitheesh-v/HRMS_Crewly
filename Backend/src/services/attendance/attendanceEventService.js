// ─────────────────────────────────────────────────────────────
// Phase 31.2 — attendance event service (injectable).
//
// Interactive mutations (CLOCK_IN / BREAK_START / BREAK_END / CLOCK_OUT)
// plus the live-attendance read. Owns:
// - session resolution (today's control, else the single open session —
//   cross-midnight safe, never stranded by a date rollover)
// - 31.1 policy reads (work modes, break treatment, outcome derivation)
// - transition validation via pure attendanceEventRules
// - Mongo-authoritative concurrency (control-record CAS + unique
//   indexes; Redis is never in the correctness path)
// - idempotent replay via the event's requestId
// - legacy-compatible Attendance projection writes (payroll/report
//   fields populated exactly as the classic punch flow does)
//
// Defaults hit real models/engine; every collaborator is injectable
// for hermetic tests. Policy derivation is best-effort and can NEVER
// break a punch.
// ─────────────────────────────────────────────────────────────
import Attendance from '../../models/Attendance.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import AttendanceLocation from '../../models/AttendanceLocation.js';
import AttendanceWorkModeRequest from '../../models/AttendanceWorkModeRequest.js';
import ShiftAssignment from '../../models/ShiftAssignment.js';
import Shift from '../../models/Shift.js';
import WorkSchedule from '../../models/WorkSchedule.js';
import User from '../../models/User.js';
import Company from '../../models/Company.js';
import {
  HALF_DAY_MINUTES,
  LATE_GRACE_MINUTES,
  WORK_START_TIME,
} from '../../utils/constants.js';
import ApiError from '../../utils/ApiError.js';
import { verifyClockInLocation } from './attendanceLocationService.js';
import {
  findClockInAuthorization,
  getWorkModeAuthorization,
} from './attendanceWorkModeService.js';
import {
  dayKey,
  evaluatePunch,
  getHolidaysForUser,
  getWorkingDaysForUser,
  holidayOnDate,
  resolveScheduleForUser,
  resolveShiftForUser,
} from '../../utils/scheduleEngine.js';
import { timeToMinutes } from '../../utils/dateHelpers.js';
import {
  DAY_TYPE,
  EVENT_SOURCE,
  EVENT_TYPE,
  LEAVE_CONTEXT,
  LIVE_STATE,
  WORK_MODE,
  dayKeyInZone,
  evaluateDay,
  minutesSinceMidnightInZone,
} from './attendancePolicyRules.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import {
  allowedActions,
  deriveClosedDurations,
  deriveLiveDurations,
  deriveLiveState,
  enabledWorkModes,
  isWorkModeAllowed,
  orderEvents,
  transition,
} from './attendanceEventRules.js';
import {
  buildScheduleSnapshot,
  deriveAttendanceVerdict,
  resolveEmployeeSchedule,
  resolveStoredSchedule,
} from './attendanceScheduleService.js';
import {
  SCHEDULE_STATUS,
  addDays,
  businessDateForInstant,
} from './attendanceScheduleRules.js';
import {
  ATTENDANCE_PRESENCE,
  DAILY_OUTCOME,
  resolveDay as resolveReconciliationDay,
} from './attendanceReconciliationService.js';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_STATES = [LIVE_STATE.WORKING, LIVE_STATE.ON_BREAK];

// Phase 31.6 — dated attendance-facing resolution (Shift › Work
// Schedule › explicit UNRESOLVED). Replaces the legacy DEFAULT
// fabrication: without a resolvable schedule the context reports
// UNRESOLVED and schedule-dependent flags stay neutral (never
// guessed). Returns the legacy shape plus `scheduleCtx`.
const defaultResolveScheduleRule = async ({ companyId, user, at, engine, timezone, attendanceDate, models }) => {
  // Legacy engine seam: a caller-supplied shift resolver (the 31.x
  // hermetic suites' stub engines — anything but the real
  // scheduleEngine fn) keeps the EXACT legacy behavior, fabrication
  // included. Only the real engine takes the dated 31.6 path, so
  // production never fabricates while legacy-injected callers see
  // nothing but the verdict's UTC→day framing correction.
  if (engine?.resolveShiftForUser && engine.resolveShiftForUser !== resolveShiftForUser) {
    const resolved = await engine.resolveShiftForUser(companyId, user, at);
    const schedule = resolved.schedule
      || (engine.resolveScheduleForUser ? await engine.resolveScheduleForUser(companyId, user) : null);
    const fallbackRule = {
      name: 'Default schedule',
      startTime: WORK_START_TIME,
      endTime: '18:00',
      breakMinutes: 0,
      graceMinutes: LATE_GRACE_MINUTES,
      minWorkingHours: 8,
      halfDayHours: HALF_DAY_MINUTES / 60,
      overtimeEligible: false,
    };
    return {
      shift: resolved.shift || null,
      schedule: schedule || null,
      source: resolved.shift ? resolved.source : schedule ? 'WORK_SCHEDULE' : 'DEFAULT',
      rule: resolved.shift || schedule || fallbackRule,
    };
  }
  const zone = timezone || DEFAULT_TIMEZONE;
  const instant = at instanceof Date ? at : new Date(at);
  const businessDate = attendanceDate || dayKeyInZone(instant, zone);
  const ctx = await resolveEmployeeSchedule({
    companyId,
    user,
    attendanceDate: businessDate,
    timezone: zone,
    ShiftAssignmentModel: models?.ShiftAssignmentModel,
    ShiftModel: models?.ShiftModel,
    WorkScheduleModel: models?.WorkScheduleModel,
    UserModel: models?.UserModel,
    engine,
  });
  if (!ctx || ctx.status !== SCHEDULE_STATUS.RESOLVED) {
    return { rule: null, shift: null, schedule: null, source: 'UNRESOLVED', scheduleCtx: ctx || null };
  }
  return {
    rule: ctx.rule || null,
    shift: ctx.shiftDoc || null,
    schedule: ctx.scheduleDoc || null,
    source: ctx.source || 'WORK_SCHEDULE',
    scheduleCtx: ctx,
  };
};

const defaultDeps = () => ({
  AttendanceModel: Attendance,
  AttendanceEventModel: AttendanceEvent,
  AttendanceLocationModel: AttendanceLocation,
  WorkModeRequestModel: AttendanceWorkModeRequest,
  CompanyModel: Company,
  ShiftAssignmentModel: ShiftAssignment,
  ShiftModel: Shift,
  WorkScheduleModel: WorkSchedule,
  UserModel: User,
  policyReader: (args) => getCurrentPolicy(args),
  engine: {
    resolveShiftForUser,
    resolveScheduleForUser,
    getWorkingDaysForUser,
    getHolidaysForUser,
    holidayOnDate,
    evaluatePunch,
    dayKey,
  },
  resolveScheduleRule: defaultResolveScheduleRule,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const isDuplicateKey = (err) => err?.code === 11000;

const serializeLocationVerification = (snapshot) => {
  if (!snapshot) return null;
  return {
    locationId: String(snapshot.locationId || ''),
    locationName: snapshot.locationName || null,
    radiusMeters: snapshot.radiusMeters ?? null,
    distanceMeters: snapshot.distanceMeters ?? null,
    result: snapshot.result || null,
    accuracyMeters: snapshot.accuracyMeters ?? null,
    verifiedAt: snapshot.verifiedAt ? new Date(snapshot.verifiedAt).toISOString() : null,
  };
};

const serializeEvent = (event) => ({
  id: String(event._id || event.id || ''),
  seq: event.seq,
  type: event.type,
  at: event.at instanceof Date ? event.at.toISOString() : new Date(event.at).toISOString(),
  workMode: event.workMode || null,
  source: event.source || EVENT_SOURCE.WEB,
  location: serializeLocationVerification(event.locationVerification),
  // Phase 31.4 — which approved request permitted this mode (CLOCK_IN
  // only, approval-gated modes only; otherwise null).
  authorization: event.authorization
    ? {
        requestId: String(event.authorization.requestId || ''),
        mode: event.authorization.mode || null,
        startDate: event.authorization.startDate || null,
        endDate: event.authorization.endDate || null,
        dayPortion: event.authorization.dayPortion || null,
      }
    : null,
});

// Company/policy timezone for day boundaries. Policy wins when active,
// else the company profile, else the legacy IST default. Never throws.
const resolveTimezone = async ({ companyId, policy, CompanyModel }) => {
  if (policy?.timezone) return policy.timezone;
  try {
    const company = CompanyModel
      ? await CompanyModel.findById(companyId).select('timezone').lean()
      : null;
    if (company?.timezone) return company.timezone;
  } catch {
    // Timezone lookup must never break punching.
  }
  return DEFAULT_TIMEZONE;
};

// Most recent open session on another date (cross-midnight shifts,
// forgotten clock-outs). Covers event-backed AND legacy-open sessions.
const findOpenSession = async ({ AttendanceModel, companyId, userId, excludeDate }) =>
  AttendanceModel.findOne({
    companyId,
    user: userId,
    date: { $ne: excludeDate },
    $or: [
      { liveState: { $in: OPEN_STATES } },
      { liveState: null, punchIn: { $ne: null }, punchOut: null },
      { liveState: { $exists: false }, punchIn: { $ne: null }, punchOut: null },
    ],
  }).sort({ date: -1 });

const snapshotSchedule = (resolved) => {
  const ctx = resolved?.scheduleCtx;
  if (!resolved?.rule && ctx?.status !== SCHEDULE_STATUS.RESOLVED) return null;
  const base = {
    name: resolved.rule?.name || null,
    startTime: resolved.rule?.startTime || null,
    endTime: resolved.rule?.endTime || null,
    source: resolved.source || 'DEFAULT',
  };
  if (!ctx || ctx.status !== SCHEDULE_STATUS.RESOLVED) return base;
  return {
    ...base,
    status: SCHEDULE_STATUS.RESOLVED,
    shiftName: ctx.shift?.name || null,
    scheduleName: ctx.schedule?.name || null,
    crossesMidnight: ctx.crossesMidnight === true,
    windowLabel: ctx.crossesMidnight === true
      ? `${ctx.startTime} – ${ctx.endTime} (+1 day)`
      : `${ctx.startTime} – ${ctx.endTime}`,
    scheduledStartAt: ctx.scheduledStartAt ? new Date(ctx.scheduledStartAt).toISOString() : null,
    scheduledEndAt: ctx.scheduledEndAt ? new Date(ctx.scheduledEndAt).toISOString() : null,
    scheduledMinutes: ctx.scheduledMinutes,
    isWorkingDay: ctx.isWorkingDay === true,
    dayType: ctx.dayType,
    holiday: ctx.holiday || null,
  };
};

// 31.1 outcome derivation for a completed day. Schedule context comes
// from the same rule the legacy flow used; day type from the established
// working-days/holiday APIs; leave is always NONE (31.2 does no leave
// reconciliation — §20). Returns null instead of guessing.
const derivePolicyOutcome = async ({ policy, rule, punchIn, punchOut, breakMinutes, workMode, dayCtx }) => {
  if (!policy || !rule?.startTime || !rule?.endTime || !punchIn || !punchOut) return null;
  try {
    const { engine, companyId, user, date, timezone } = dayCtx;
    const workingDays = await engine.getWorkingDaysForUser(companyId, user);
    const isWorkingDay = workingDays.includes(engine.dayKey(date));
    const holiday = isWorkingDay ? await engine.holidayOnDate(companyId, user, date) : null;
    const dayType = holiday ? DAY_TYPE.HOLIDAY : !isWorkingDay ? DAY_TYPE.WEEKLY_OFF : DAY_TYPE.WORK_DAY;

    const clockIn = minutesSinceMidnightInZone(punchIn, timezone);
    let clockOut = minutesSinceMidnightInZone(punchOut, timezone);
    if (clockOut <= clockIn) clockOut += 1440; // overnight session

    const result = evaluateDay({
      policy,
      scheduledStart: timeToMinutes(rule.startTime),
      scheduledEnd: timeToMinutes(rule.endTime),
      clockIn,
      clockOut,
      breakMinutes,
      workMode,
      dayType,
      leave: LEAVE_CONTEXT.NONE,
    });
    return { outcome: result.outcome, exceptions: result.exceptions || [] };
  } catch {
    return null;
  }
};

const buildSnapshot = async ({
  control,
  events,
  policy,
  timezone,
  todayKey,
  schedule,
  now,
}) => {
  const ordered = orderEvents(events);
  const liveState = deriveLiveState(control);
  const includeBreaks = policy?.breaks?.includeInWorkedTime === true;
  const sessionOpenedAt = control?.punchIn || ordered[0]?.at || null;
  const live = deriveLiveDurations(ordered, { now, sessionOpenedAt, includeBreaks });
  const firstIn = ordered.find((event) => event.type === EVENT_TYPE.CLOCK_IN);

  return {
    date: control?.date || todayKey,
    today: todayKey,
    isToday: !control || control.date === todayKey,
    liveState,
    workMode: control?.workMode || firstIn?.workMode || null,
    clockInAt: control?.punchIn ? new Date(control.punchIn).toISOString() : null,
    clockOutAt: control?.punchOut ? new Date(control.punchOut).toISOString() : null,
    lastEventAt: control?.lastEventAt ? new Date(control.lastEventAt).toISOString() : null,
    openInterval: live.openInterval,
    workedSecondsSoFar: live.workedSecondsSoFar,
    breakSecondsSoFar: live.breakSecondsSoFar,
    spanMinutes: live.spanMinutes,
    breakMinutes: control?.breakMinutes ?? live.breakMinutes,
    workedMinutes: control?.workMinutes ?? live.workedMinutes,
    timeline: ordered.map((event) => ({
      seq: event.seq,
      type: event.type,
      at: event.at instanceof Date ? event.at.toISOString() : new Date(event.at).toISOString(),
      workMode: event.workMode || null,
    })),
    outcome: control?.policyOutcome || null,
    exceptions: control?.policyExceptions || [],
    status: control?.status || null,
    policyVersion: control?.policyVersion ?? null,
    allowedActions: allowedActions(liveState),
    enabledWorkModes: enabledWorkModes(policy),
    // Phase 31.3: the employee UI reads enforcement here (self-service
    // safe — no policy-read permission needed to know the rule).
    locationEnforcement: policy?.locationEnforcement || 'DISABLED',
    schedule,
  };
};

const replayFromEvent = async (ctx, existing) => {
  const { AttendanceModel, AttendanceEventModel } = ctx.deps;
  const control = await AttendanceModel.findOne({
    companyId: ctx.companyId,
    user: ctx.userId,
    date: existing.date,
  });
  const events = await AttendanceEventModel.find({
    companyId: ctx.companyId,
    user: ctx.userId,
    date: existing.date,
  })
    .sort({ seq: 1 })
    .lean();
  const snapshot = await buildSnapshot({
    control,
    events,
    policy: ctx.policy,
    timezone: ctx.timezone,
    todayKey: ctx.todayKey,
    schedule: ctx.schedule,
    now: ctx.now,
  });
  return { event: serializeEvent(existing), snapshot, replayed: true };
};

// ── Live read ────────────────────────────────────────────────

export const getLiveAttendance = async ({ companyId, userId, deps = {} }) => {
  const full = { ...defaultDeps(), ...deps };
  const { AttendanceModel, AttendanceEventModel, policyReader, resolveScheduleRule, engine, now } = full;

  const at = now();
  const { policy } = await policyReader({ companyId });
  const timezone = await resolveTimezone({ companyId, policy, CompanyModel: full.CompanyModel });
  const todayKey = dayKeyInZone(at, timezone);

  // Phase 31.4 — today-card authorization map (best-effort: null when
  // unreadable so the UI stays silent instead of misleading).
  let workModeAuthorization = null;
  try {
    workModeAuthorization = await getWorkModeAuthorization({
      WorkModeRequestModel: full.WorkModeRequestModel,
      companyId,
      userId,
      date: todayKey,
      policy,
    });
  } catch {
    workModeAuthorization = null;
  }

  let control = await AttendanceModel.findOne({ companyId, user: userId, date: todayKey });
  if (!control) {
    control = await findOpenSession({ AttendanceModel, companyId, userId, excludeDate: todayKey });
  }

  let schedule = null;
  try {
    // Overnight-aware display: at 01:00 the relevant schedule is
    // yesterday's window, not today's. Legacy-injected resolvers
    // (no scheduleCtx) degrade to the legacy today-only snapshot.
    const [todayResolved, yesterdayResolved] = await Promise.all([
      resolveScheduleRule({ companyId, user: { _id: userId }, at, engine, timezone, attendanceDate: todayKey, models: full }),
      resolveScheduleRule({ companyId, user: { _id: userId }, at, engine, timezone, attendanceDate: addDays(todayKey, -1), models: full }),
    ]);
    const yesterdayCtx = yesterdayResolved?.scheduleCtx;
    const businessDate = yesterdayCtx?.status === SCHEDULE_STATUS.RESOLVED && yesterdayCtx.crossesMidnight === true
      ? businessDateForInstant({
        now: at,
        timezone,
        yesterdayInterval: { startAt: yesterdayCtx.scheduledStartAt, endAt: yesterdayCtx.scheduledEndAt },
      })
      : todayKey;
    schedule = snapshotSchedule(businessDate === todayKey ? todayResolved : yesterdayResolved);
  } catch {
    schedule = null;
  }

  // Phase 31.7 — derived daily resolution for the today card
  // (best-effort: null when unreadable, like the schedule above).
  // Stored snapshot preferred; without a control the day still
  // resolves as no-work (leave / holiday / off / absent).
  let dayReconciliation = null;
  try {
    dayReconciliation = await resolveReconciliationDay({
      companyId,
      userId,
      attendanceDate: control?.date || todayKey,
      control,
      schedule: resolveStoredSchedule({ control }),
      LeaveModel: full.LeaveModel,
      engine,
    });
  } catch {
    dayReconciliation = null;
  }

  if (!control) {
    const empty = await buildSnapshot({
      control: null,
      events: [],
      policy,
      timezone,
      todayKey,
      schedule,
      now: at,
    });
    empty.otherOpenSession = null;
    empty.workModeAuthorization = workModeAuthorization;
    empty.reconciliation = dayReconciliation;
    return empty;
  }

  const events = await AttendanceEventModel.find({
    companyId,
    user: userId,
    date: control.date,
  })
    .sort({ seq: 1 })
    .lean();

  const snapshot = await buildSnapshot({
    control,
    events,
    policy,
    timezone,
    todayKey,
    schedule,
    now: at,
  });

  // Legacy interleave (classic punch-in while another date is open) can
  // leave two open sessions. Surface the other one so the UI can offer
  // closing it explicitly via the `date` action parameter.
  let otherOpenSession = null;
  if (control.date === todayKey) {
    const other = await findOpenSession({ AttendanceModel, companyId, userId, excludeDate: todayKey });
    if (other) otherOpenSession = { date: other.date, liveState: deriveLiveState(other) };
  }
  snapshot.otherOpenSession = otherOpenSession;
  snapshot.workModeAuthorization = workModeAuthorization;
  snapshot.reconciliation = dayReconciliation;
  return snapshot;
};

// ── Mutation ─────────────────────────────────────────────────

// ── Phase 31.13: reactive reminder hooks ─────────────────────
// Fire-and-forget, never-throwing, never-awaited: the attendance
// event already committed when this runs. Scheduling failures only
// skip reminders (reconcile re-derives them); they can never break
// or delay the punch response. Dynamic import: zero cycle risk
// with the reminder service, zero cost until the first punch.
const fireReminderHooks = ({ companyId, userId, action, day, at, events }) => {
  Promise.resolve()
    .then(async () => {
      const {
        scheduleShiftReminders,
        scheduleBreakReminder,
        cancelShiftReminderJobs,
      } = await import('./attendanceReminderService.js');
      const { REMINDER_TYPE } = await import('./attendanceReminderRules.js');
      if (action === EVENT_TYPE.CLOCK_IN) {
        await cancelShiftReminderJobs({
          companyId,
          userId,
          day,
          types: [REMINDER_TYPE.SHIFT_START, REMINDER_TYPE.MISSING_CLOCK_IN],
        });
      } else if (action === EVENT_TYPE.CLOCK_OUT) {
        await cancelShiftReminderJobs({
          companyId,
          userId,
          day,
          types: [REMINDER_TYPE.MISSING_CLOCK_OUT],
        });
        // Chain tomorrow's reminders off today's clock-out (the
        // schedule for tomorrow is resolvable right now).
        const { default: UserModel } = await import('../../models/User.js');
        const user = await UserModel.findOne({ _id: userId, status: 'ACTIVE' })
          .select('_id companyId department branch')
          .lean()
          .catch(() => null);
        if (user && String(user.companyId) === String(companyId)) {
          const cursor = new Date(`${day}T00:00:00Z`);
          cursor.setUTCDate(cursor.getUTCDate() + 1);
          await scheduleShiftReminders({
            companyId,
            user,
            day: cursor.toISOString().slice(0, 10),
          });
        }
      } else if (action === EVENT_TYPE.BREAK_START) {
        await scheduleBreakReminder({ companyId, userId, day, breakStartAt: at });
      } else if (action === EVENT_TYPE.BREAK_END) {
        const starts = (events || []).filter((event) => event?.type === EVENT_TYPE.BREAK_START);
        const last = starts[starts.length - 1];
        await cancelShiftReminderJobs({
          companyId,
          userId,
          day,
          types: [REMINDER_TYPE.INCOMPLETE_BREAK],
          breakStartAt: last?.at || null,
        });
      }
    })
    .catch(() => {});
};

export const recordEvent = async ({
  companyId,
  userId,
  action,
  workMode = null,
  date = null,
  idempotencyKey = null,
  // Phase 31.3: { locationId, position? } — consumed ONLY by CLOCK_IN;
  // break/out actions ignore it (no location collection by design).
  location = null,
  deps = {},
}) => {
  const full = { ...defaultDeps(), ...deps };
  const {
    AttendanceModel,
    AttendanceEventModel,
    policyReader,
    resolveScheduleRule,
    engine,
    now,
  } = full;

  if (!Object.values(EVENT_TYPE).includes(action)) {
    throw ApiError.badRequest('Unknown attendance action');
  }
  if (date !== null && (typeof date !== 'string' || !DATE_KEY_PATTERN.test(date))) {
    throw ApiError.badRequest('date must be YYYY-MM-DD');
  }

  const at = now();
  const { policy } = await policyReader({ companyId });
  const timezone = await resolveTimezone({ companyId, policy, CompanyModel: full.CompanyModel });
  const todayKey = dayKeyInZone(at, timezone);

  if (date !== null && date > todayKey) {
    throw ApiError.badRequest('Cannot punch for a future date');
  }

  // Idempotent replay: the fact already exists — return it instead of
  // re-validating. Same key + different action is a conflict.
  if (idempotencyKey) {
    const existing = await AttendanceEventModel.findOne({
      companyId,
      user: userId,
      requestId: idempotencyKey,
    }).lean();
    if (existing) {
      if (existing.type !== action) {
        throw ApiError.conflict('This request was already used for a different attendance action');
      }
      const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at, timezone, attendanceDate: existing.date, models: full });
      return replayFromEvent(
        { deps: full, companyId, userId, policy, timezone, todayKey, schedule, now: at },
        existing,
      );
    }
  }

  // Resolve the target session: explicit date, today's control, or the
  // single open session elsewhere (cross-midnight safety).
  let control = null;
  if (date !== null) {
    control = await AttendanceModel.findOne({ companyId, user: userId, date });
    if (!control) throw ApiError.notFound('No attendance session for that date');
  } else {
    control = await AttendanceModel.findOne({ companyId, user: userId, date: todayKey });
    if (!control) {
      control = await findOpenSession({ AttendanceModel, companyId, userId, excludeDate: todayKey });
    }
  }

  // CLOCK_IN needs a free day AND no open session anywhere.
  if (action === EVENT_TYPE.CLOCK_IN) {
    if (control && (control.date === todayKey || isOpenState(deriveLiveState(control)))) {
      // Fresh duplicate dispatch (double-click / render-gap re-click):
      // the session this request wanted already exists — merge into a
      // replay instead of a phantom 409. Completed sessions and other
      // dates still refuse (different intent, not a duplicate).
      if (!control.punchOut) {
        const merged = await tryMergeFreshDuplicate({
          full,
          companyId,
          userId,
          date: control.date,
          action,
          policy,
          timezone,
          todayKey,
          at,
        });
        if (merged) return merged;
      }
      throw ApiError.conflict(
        control.date === todayKey
          ? 'You have already clocked in today'
          : `Close your open session from ${control.date} before clocking in`,
      );
    }
    return clockIn({ full, companyId, userId, at, todayKey, timezone, policy, workMode, idempotencyKey, location });
  }

  if (!control) {
    throw ApiError.badRequest('You have not clocked in yet');
  }

  const liveState = deriveLiveState(control);
  const check = transition(liveState, action);
  if (!check.allowed) {
    const merged = await tryMergeFreshDuplicate({
      full,
      companyId,
      userId,
      date: control.date,
      action,
      policy,
      timezone,
      todayKey,
      at,
    });
    if (merged) return merged;
    if (check.code === 'SESSION_COMPLETED') throw ApiError.conflict(check.reason);
    throw ApiError.badRequest(check.reason);
  }

  const events = await AttendanceEventModel.find({
    companyId,
    user: userId,
    date: control.date,
  })
    .sort({ seq: 1 })
    .lean();

  const expectedSeq = Number(control.eventSeq || 0);
  const nextSeq = expectedSeq + 1;
  const withNew = [...events, { seq: nextSeq, type: action, at, workMode: null }];
  // Phase 31.5 interplay: a day whose clock-in exists only as an
  // approved correction has no recorded punchIn — live durations
  // then seed from the effective (regularized) clock-in. No-op for
  // every day without an approved clock-in correction.
  const sessionOpenedAt =
    control.punchIn || control.regularization?.correctedIn || withNew[0]?.at || at;
  const includeBreaks = policy?.breaks?.includeInWorkedTime === true;

  let patch = { lastEventAt: at, liveState: check.next };
  let policyDerivation = null;

  if (action === EVENT_TYPE.BREAK_START) {
    const closed = deriveClosedDurations(withNew, { sessionOpenedAt, sessionClosedAt: at, includeBreaks });
    patch = { ...patch, breakMinutes: closed.breakMinutes, workMinutes: closed.workedMinutes };
  } else if (action === EVENT_TYPE.BREAK_END) {
    const closed = deriveClosedDurations(withNew, { sessionOpenedAt, sessionClosedAt: at, includeBreaks });
    patch = { ...patch, breakMinutes: closed.breakMinutes, workMinutes: closed.workedMinutes };
  } else if (action === EVENT_TYPE.CLOCK_OUT) {
    const closed = deriveClosedDurations(withNew, { sessionOpenedAt, sessionClosedAt: at, includeBreaks });
    // Same-rule evaluation as the classic punch-out (late/early/OT stay
    // scheduleEngine-derived for payroll parity).
    const stored = await resolveRuleFromRecord({ control, companyId, userId, engine, resolveScheduleRule, at, timezone, attendanceDate: control.date, models: full });
    const workedMinutes = policy
      ? closed.workedMinutes
      : Math.max(0, Math.round((at.getTime() - new Date(control.punchIn || control.regularization?.correctedIn || at).getTime()) / 60000)
          - Number(stored.rule?.breakMinutes || 0));
    // Phase 31.6 — payroll verdict from the resolved schedule +
    // policy grace (replaces the UTC-anchored punch evaluation).
    // Recomputed here so a mid-day policy change applies at each
    // evaluation point instead of half the day going stale.
    const verdict = deriveAttendanceVerdict({
      resolved: stored,
      attendanceDate: control.date,
      timezone,
      policy,
      effectiveIn: control.punchIn,
      effectiveOut: at,
      workedMinutes,
    });
    // Phase 31.7 — re-resolve the day on close (best-effort: a
    // failed lookup must never break a punch).
    let dayReconciliation = null;
    try {
      dayReconciliation = await resolveReconciliationDay({
        companyId,
        userId,
        attendanceDate: control.date,
        attendance: {
          presence: ATTENDANCE_PRESENCE.FULL,
          workedMinutes,
          breakMinutes: policy ? closed.breakMinutes : 0,
          lateMinutes: verdict.lateMinutes,
          earlyMinutes: verdict.earlyMinutes,
          outcomeBand: verdict.status === 'HALF_DAY' ? DAILY_OUTCOME.HALF_DAY : DAILY_OUTCOME.PRESENT,
          exceptions: control.policyExceptions || [],
          effectiveIn: control.punchIn,
          effectiveOut: at,
          expectedMinutes: 0,
        },
        schedule: stored.scheduleCtx?.status === SCHEDULE_STATUS.RESOLVED ? stored.scheduleCtx : null,
        LeaveModel: full.LeaveModel,
        engine,
      });
    } catch {
      dayReconciliation = null;
    }

    patch = {
      ...patch,
      punchOut: at,
      workMinutes: workedMinutes,
      breakMinutes: policy ? closed.breakMinutes : 0,
      lateMinutes: verdict.lateMinutes,
      earlyMinutes: verdict.earlyMinutes,
      // Phase 31.8 — verdict.overtimeMinutes is the ELIGIBLE
      // candidate (display/eligibility only). The record field is
      // approved-only and written solely by a 31.8 OT approval, so
      // a late clock-out never auto-becomes payable time. Any
      // previously approved value is preserved, never clobbered.
      status: verdict.status,
    };
    if (dayReconciliation) {
      patch.reconciliation = { ...dayReconciliation, resolvedAt: at, resolvedBy: 'SYSTEM' };
    }

    policyDerivation = await derivePolicyOutcome({
      policy,
      rule: stored.rule,
      punchIn: control.punchIn,
      punchOut: at,
      breakMinutes: closed.breakMinutes,
      workMode: control.workMode || WORK_MODE.OFFICE,
      dayCtx: { engine, companyId, user: { _id: userId }, date: control.date, timezone },
    });
    if (policyDerivation) {
      patch.policyOutcome = policyDerivation.outcome;
      patch.policyExceptions = policyDerivation.exceptions;
      patch.policyVersion = policy.version ?? patch.policyVersion ?? null;
    }
  }

  // Atomic transition: exactly one concurrent writer wins the sequence.
  // Legacy/hand-mangled controls may lack eventSeq: match 0/null/missing
  // once so the first 31.2 touch adopts the session ($inc backfills it).
  const seqFilter = expectedSeq === 0 ? { $in: [0, null] } : expectedSeq;
  const updated = await AttendanceModel.findOneAndUpdate(
    { companyId, user: userId, date: control.date, eventSeq: seqFilter },
    { $set: patch, $inc: { eventSeq: 1 } },
    { new: true },
  );

  if (!updated) {
    // Lost a race. A fresh duplicate merges, a retried key replays;
    // anything else refreshes.
    const merged = await tryMergeFreshDuplicate({
      full,
      companyId,
      userId,
      date: control.date,
      action,
      policy,
      timezone,
      todayKey,
      at,
    });
    if (merged) return merged;
    if (idempotencyKey) {
      const existing = await AttendanceEventModel.findOne({
        companyId,
        user: userId,
        requestId: idempotencyKey,
      }).lean();
      if (existing) {
        if (existing.type !== action) {
          throw ApiError.conflict('This request was already used for a different attendance action');
        }
        const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at, timezone, attendanceDate: control.date, models: full });
        return replayFromEvent(
          { deps: full, companyId, userId, policy, timezone, todayKey, schedule, now: at },
          existing,
        );
      }
    }
    // No replay applies. Explain against CURRENT state: if the action is
    // no longer valid (e.g. Clock Out mashed during a fresh break), say
    // so actionably instead of a generic refresh prompt.
    const fresh = await AttendanceModel.findOne({ companyId, user: userId, date: control.date });
    console.warn('[attendance] CAS missed (concurrent write or stale read)', {
      companyId: String(companyId),
      userId: String(userId),
      date: control.date,
      action,
      expectedSeq,
      freshEventSeq: fresh?.eventSeq ?? null,
      freshState: deriveLiveState(fresh),
    });
    const freshCheck = transition(deriveLiveState(fresh), action);
    if (!freshCheck.allowed) {
      if (freshCheck.code === 'SESSION_COMPLETED') throw ApiError.conflict(freshCheck.reason);
      throw ApiError.badRequest(freshCheck.reason);
    }
    throw ApiError.conflict('Attendance state changed — please refresh and retry');
  }

  let created;
  try {
    created = await AttendanceEventModel.create({
      companyId,
      user: userId,
      date: control.date,
      seq: nextSeq,
      type: action,
      at,
      workMode: null,
      source: EVENT_SOURCE.WEB,
      requestId: idempotencyKey || null,
    });
  } catch (err) {
    if (isDuplicateKey(err) && idempotencyKey) {
      const existing = await AttendanceEventModel.findOne({
        companyId,
        user: userId,
        requestId: idempotencyKey,
      }).lean();
      if (existing) {
        const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at, timezone, attendanceDate: control.date, models: full });
        return replayFromEvent(
          { deps: full, companyId, userId, policy, timezone, todayKey, schedule, now: at },
          existing,
        );
      }
    }
    if (isDuplicateKey(err)) {
      // Sequence collision with NO matching idempotency key: the ledger
      // holds an orphaned/conflicting fact (e.g. rows were partially
      // deleted outside the API). Never mask it as a generic race —
      // name the colliding key in the server log for instant diagnosis.
      console.warn('[attendance] event insert conflict (no key match)', {
        companyId: String(companyId),
        userId: String(userId),
        date: control.date,
        action,
        seq: nextSeq,
        keyValue: err.keyValue || null,
      });
      throw ApiError.conflict(
        'Attendance record conflict — please refresh. If this keeps happening, ask support to reset the day.',
      );
    }
    // True insert failure (not a duplicate): never swallow it — log the
    // code + message so causes like Atlas validation rules (121) are
    // named in the server log instead of surfacing as a generic 409.
    console.error('[attendance] event insert failed', {
      companyId: String(companyId),
      userId: String(userId),
      date: control.date,
      action,
      seq: nextSeq,
      name: err?.name || null,
      code: err?.code || null,
      message: err?.message || null,
    });
    throw ApiError.conflict('Attendance state changed — please refresh and retry');
  }

  const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at, timezone, attendanceDate: control.date, models: full });
  const snapshot = await buildSnapshot({
    control: updated,
    events: [...events, created.toObject ? created.toObject() : created],
    policy,
    timezone,
    todayKey,
    schedule,
    now: at,
  });
  // 31.13: reactive reminder scheduling — fire-and-forget (the
  // event committed; scheduling can never fail this response).
  fireReminderHooks({ companyId, userId, action, day: control.date, at, events });
  return { event: serializeEvent(created), snapshot, replayed: false };
};

const isOpenState = (liveState) =>
  liveState === LIVE_STATE.WORKING || liveState === LIVE_STATE.ON_BREAK;

// Duplicate-merge window (§15 idempotent behavior): a repeated action
// landing within seconds of the identical recorded fact — double-click,
// render-gap re-click, overlapped retry with a fresh key — merges into
// a replay instead of a phantom 409. The caller's intent is satisfied
// either way. Genuine mistakes (stale, wrong state, other session) still
// refuse loudly: the merge requires the CURRENT session's LATEST event
// to be the SAME action and FRESH.
const MERGE_WINDOW_MS = 10 * 1000;

// Delayed merge re-read. A duplicate landing inside the winner's
// commit→fact window (Atlas write latency) reads empty/stale events on
// the first attempt; one pause lets the in-flight fact land before we
// refuse. Only merge-miss paths pay this — successes never sleep.
const MERGE_RETRY_MS = 800;

const isFresh = (timestamp, now) => {
  const ms = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (Number.isNaN(ms)) return false;
  return now.getTime() - ms <= MERGE_WINDOW_MS;
};

// Returns a replay result when `action` is a fresh duplicate of the
// session's latest fact, else null. Reloads events (callers may hold
// stale pre-race reads); on a miss, pauses once and re-reads, so a
// duplicate landing inside the winner's commit→fact window still merges
// instead of a phantom 409. Genuine refusals just take ~800ms longer.
const tryMergeFreshDuplicate = async ({
  full,
  companyId,
  userId,
  date,
  action,
  policy,
  timezone,
  todayKey,
  at,
}) => {
  const sleep = full.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const readLatest = async () => {
    const events = await full.AttendanceEventModel.find({ companyId, user: userId, date })
      .sort({ seq: 1 })
      .lean();
    if (!events.length) return null;
    const latest = events[events.length - 1];
    if (latest.type !== action || !isFresh(latest.at, at)) return null;
    return latest;
  };
  let latest = await readLatest();
  if (!latest) {
    await sleep(MERGE_RETRY_MS);
    latest = await readLatest();
  }
  if (!latest) return null;
  const schedule = await bestEffortSchedule({
    resolveScheduleRule: full.resolveScheduleRule,
    engine: full.engine,
    companyId,
    userId,
    at,
    timezone,
    attendanceDate: date,
    models: full,
  });
  return replayFromEvent(
    { deps: full, companyId, userId, policy, timezone, todayKey, schedule, now: at },
    latest,
  );
};

const bestEffortSchedule = async ({ resolveScheduleRule, engine, companyId, userId, at, timezone, attendanceDate, models }) => {
  try {
    const resolved = await resolveScheduleRule({ companyId, user: { _id: userId }, at, engine, timezone, attendanceDate, models });
    return snapshotSchedule(resolved);
  } catch {
    return null;
  }
};

// Phase 31.6 — stored meaning first: a control carrying a schedule
// snapshot evaluates against it (later Shift edits cannot rewrite the
// day); else the legacy stored-rule hook; else dated re-resolution
// for the record's own business date.
const resolveRuleFromRecord = async ({ control, companyId, userId, engine, resolveScheduleRule, at, timezone, attendanceDate, models }) => {
  const snapCtx = resolveStoredSchedule({ control });
  if (snapCtx) {
    return {
      rule: {
        name: snapCtx.shift?.name || snapCtx.schedule?.name || null,
        startTime: snapCtx.startTime,
        endTime: snapCtx.endTime,
        breakMinutes: snapCtx.breakMinutes,
        minWorkingHours: Number(snapCtx.minimumMinutes || 480) / 60,
        overtimeEligible: snapCtx.overtimeEligible === true,
      },
      shift: snapCtx.shiftId ? { _id: snapCtx.shiftId } : null,
      schedule: snapCtx.scheduleId ? { _id: snapCtx.scheduleId } : null,
      source: snapCtx.source,
      scheduleCtx: snapCtx,
    };
  }
  if (engine.resolveStoredRule) {
    try {
      const stored = await engine.resolveStoredRule({ control });
      if (stored?.rule) return stored;
    } catch {
      // Fall through to re-resolution.
    }
  }
  return resolveScheduleRule({ companyId, user: { _id: userId }, at, engine, timezone, attendanceDate: attendanceDate || control.date, models });
};

// Phase 31.5 — approval-rebuild reuse seam. The regularization
// approval path re-derives the daily projection with the SAME
// helpers the live session path uses, so a regularized day matches
// a day that was punched correctly. Additive export only: no live
// behavior changes.
export {
  defaultResolveScheduleRule as resolveDayScheduleRule,
  derivePolicyOutcome,
  resolveRuleFromRecord,
};

const clockIn = async ({ full, companyId, userId, at, todayKey, timezone, policy, workMode, idempotencyKey, location = null }) => {
  const { AttendanceModel, AttendanceEventModel, AttendanceLocationModel, WorkModeRequestModel, resolveScheduleRule, engine } = full;

  const mode = workMode || WORK_MODE.OFFICE;
  if (!Object.values(WORK_MODE).includes(mode)) {
    throw ApiError.badRequest('Invalid work mode');
  }
  if (!isWorkModeAllowed(mode, policy)) {
    throw ApiError.forbidden(`${mode} is not enabled in your company attendance policy`);
  }

  // Phase 31.4 — non-office authorization gate. OFFICE never needs a
  // request; other modes need an APPROVED request covering the
  // attendance date when the policy requires approval for them.
  // Refusals throw here, before anything is written. Matching NEVER
  // mutates the request.
  // Phase 31.6 — schedule resolution + overnight anchoring FIRST: the
  // authorization below must cover the BUSINESS date (single-day
  // approvals name the shift date), and both gates stay before any
  // write. Attribution itself never throws — calendar day stands.
  const resolved = await resolveScheduleRule({ companyId, user: { _id: userId }, at, engine, timezone, attendanceDate: todayKey, models: full });
  let businessDate = todayKey;
  let active = resolved;
  try {
    const yesterdayResolved = await resolveScheduleRule({ companyId, user: { _id: userId }, at, engine, timezone, attendanceDate: addDays(todayKey, -1), models: full });
    const yesterdayCtx = yesterdayResolved?.scheduleCtx;
    if (yesterdayCtx?.status === SCHEDULE_STATUS.RESOLVED && yesterdayCtx.crossesMidnight === true) {
      businessDate = businessDateForInstant({
        now: at,
        timezone,
        yesterdayInterval: { startAt: yesterdayCtx.scheduledStartAt, endAt: yesterdayCtx.scheduledEndAt },
      });
      if (businessDate !== todayKey) active = yesterdayResolved;
    }
  } catch {
    // Attribution must never break punching — calendar day stands.
  }
  const authorization = await findClockInAuthorization({
    WorkModeRequestModel,
    companyId,
    userId,
    mode,
    date: businessDate,
    policy,
  });

  // Phase 31.3 — geofence gate (OFFICE CLOCK_IN only). Refusals throw
  // here, before anything is written: no control, no event.
  const verification = await verifyClockInLocation({
    AttendanceLocationModel,
    companyId,
    policy,
    mode,
    location,
    now: at,
  });

  // Phase 31.6 — payroll verdict from schedule + policy grace.
  const verdict = deriveAttendanceVerdict({
    resolved: active,
    attendanceDate: businessDate,
    timezone,
    policy,
    effectiveIn: at,
    effectiveOut: null,
    workedMinutes: 0,
  });
  const status = verdict.status;
  const scheduleCtx = active?.scheduleCtx || null;
  // Phase 31.7 — derived daily resolution rides the create
  // (best-effort: a failed lookup must never break a punch).
  let dayReconciliation = null;
  try {
    dayReconciliation = await resolveReconciliationDay({
      companyId,
      userId,
      attendanceDate: businessDate,
      attendance: {
        presence: ATTENDANCE_PRESENCE.PARTIAL,
        workedMinutes: 0,
        breakMinutes: 0,
        lateMinutes: verdict.lateMinutes,
        earlyMinutes: 0,
        outcomeBand: DAILY_OUTCOME.UNRESOLVED,
        exceptions: [],
        effectiveIn: at,
        effectiveOut: null,
        expectedMinutes: 0,
      },
      schedule: scheduleCtx?.status === SCHEDULE_STATUS.RESOLVED ? scheduleCtx : null,
      LeaveModel: full.LeaveModel,
      engine,
    });
  } catch {
    dayReconciliation = null;
  }

  let control;
  try {
    control = await AttendanceModel.create({
      companyId,
      user: userId,
      date: businessDate,
      punchIn: at,
      status,
      shift: active.shift?._id || null,
      schedule: active.schedule?._id || null,
      shiftSource: active.source,
      lateMinutes: verdict.lateMinutes,
      scheduleSnapshot: scheduleCtx?.status === SCHEDULE_STATUS.RESOLVED
        ? buildScheduleSnapshot({ ctx: scheduleCtx, rule: active.rule })
        : null,
      scheduleStatus: scheduleCtx?.status || (active.rule ? 'RESOLVED' : 'UNRESOLVED'),
      reconciliation: dayReconciliation ? { ...dayReconciliation, resolvedAt: at, resolvedBy: 'SYSTEM' } : null,
      workMode: mode,
      liveState: LIVE_STATE.WORKING,
      eventSeq: 1,
      policyVersion: policy?.version ?? null,
      lastEventAt: at,
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Lost the creation race: a fresh duplicate merges, a retried key
    // replays, else report.
    const merged = await tryMergeFreshDuplicate({
      full,
      companyId,
      userId,
      date: businessDate,
      action: EVENT_TYPE.CLOCK_IN,
      policy,
      timezone,
      todayKey,
      at,
    });
    if (merged) return merged;
    if (idempotencyKey) {
      const existing = await AttendanceEventModel.findOne({
        companyId,
        user: userId,
        requestId: idempotencyKey,
      }).lean();
      if (existing && existing.type === EVENT_TYPE.CLOCK_IN) {
        const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at, timezone, attendanceDate: businessDate, models: full });
        return replayFromEvent(
          { deps: full, companyId, userId, policy, timezone, todayKey, schedule, now: at },
          existing,
        );
      }
    }
    throw ApiError.conflict('You have already clocked in today');
  }

  let created;
  try {
    const eventDoc = {
      companyId,
      user: userId,
      date: businessDate,
      seq: 1,
      type: EVENT_TYPE.CLOCK_IN,
      at,
      workMode: mode,
      source: EVENT_SOURCE.WEB,
      requestId: idempotencyKey || null,
    };
    // Immutable verification snapshot rides the fact (absent when no
    // verification applied — DISABLED, non-OFFICE, or OPTIONAL-empty).
    if (verification.snapshot) eventDoc.locationVerification = verification.snapshot;
    // Phase 31.4 — minimal authorization facts (absent for OFFICE and
    // approval-free modes). Read-only match; the request is untouched.
    if (authorization) eventDoc.authorization = authorization;
    created = await AttendanceEventModel.create(eventDoc);
  } catch (err) {
    if (isDuplicateKey(err) && idempotencyKey) {
      const existing = await AttendanceEventModel.findOne({
        companyId,
        user: userId,
        requestId: idempotencyKey,
      }).lean();
      if (existing && existing.type === EVENT_TYPE.CLOCK_IN) {
        const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at, timezone, attendanceDate: businessDate, models: full });
        return replayFromEvent(
          { deps: full, companyId, userId, policy, timezone, todayKey, schedule, now: at },
          existing,
        );
      }
    }
    if (isDuplicateKey(err)) {
      // Sequence collision with NO matching idempotency key: orphaned
      // facts from rows deleted outside the API. Name the colliding
      // key in the server log instead of masking it as a duplicate.
      console.warn('[attendance] clock-in event insert conflict (no key match)', {
        companyId: String(companyId),
        userId: String(userId),
        date: businessDate,
        seq: 1,
        keyValue: err.keyValue || null,
      });
      throw ApiError.conflict(
        'Attendance record conflict — please refresh. If this keeps happening, ask support to reset the day.',
      );
    }
    // True insert failure (not a duplicate): log the Mongo code + message
    // instead of swallowing it behind the duplicate message.
    console.error('[attendance] clock-in event insert failed', {
      companyId: String(companyId),
      userId: String(userId),
      date: businessDate,
      seq: 1,
      name: err?.name || null,
      code: err?.code || null,
      message: err?.message || null,
    });
    throw ApiError.conflict('You have already clocked in today');
  }

  const snapshot = await buildSnapshot({
    control,
    events: [created.toObject ? created.toObject() : created],
    policy,
    timezone,
    todayKey,
    schedule: snapshotSchedule(active),
    now: at,
  });
  return { event: serializeEvent(created), snapshot, replayed: false };
};
