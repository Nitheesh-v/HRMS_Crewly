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
import Company from '../../models/Company.js';
import ApiError from '../../utils/ApiError.js';
import {
  HALF_DAY_MINUTES,
  LATE_GRACE_MINUTES,
  WORK_START_TIME,
} from '../../utils/constants.js';
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

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_STATES = [LIVE_STATE.WORKING, LIVE_STATE.ON_BREAK];

// Legacy parity: the classic punch flow's schedule fallback (Shift ›
// Work Schedule › default). Mirrors attendanceController.resolveRule.
const defaultResolveScheduleRule = async ({ companyId, user, at, engine }) => {
  const resolved = await engine.resolveShiftForUser(companyId, user, at);
  const schedule =
    resolved.schedule || (await engine.resolveScheduleForUser(companyId, user));
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
};

const defaultDeps = () => ({
  AttendanceModel: Attendance,
  AttendanceEventModel: AttendanceEvent,
  CompanyModel: Company,
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
});

const isDuplicateKey = (err) => err?.code === 11000;

const serializeEvent = (event) => ({
  id: String(event._id || event.id || ''),
  seq: event.seq,
  type: event.type,
  at: event.at instanceof Date ? event.at.toISOString() : new Date(event.at).toISOString(),
  workMode: event.workMode || null,
  source: event.source || EVENT_SOURCE.WEB,
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
  if (!resolved?.rule) return null;
  return {
    name: resolved.rule.name || null,
    startTime: resolved.rule.startTime || null,
    endTime: resolved.rule.endTime || null,
    source: resolved.source || 'DEFAULT',
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

  let control = await AttendanceModel.findOne({ companyId, user: userId, date: todayKey });
  if (!control) {
    control = await findOpenSession({ AttendanceModel, companyId, userId, excludeDate: todayKey });
  }

  let schedule = null;
  try {
    const resolved = await resolveScheduleRule({
      companyId,
      user: { _id: userId },
      at,
      engine,
    });
    schedule = snapshotSchedule(resolved);
  } catch {
    schedule = null;
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
  return snapshot;
};

// ── Mutation ─────────────────────────────────────────────────

export const recordEvent = async ({
  companyId,
  userId,
  action,
  workMode = null,
  date = null,
  idempotencyKey = null,
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
      const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at });
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
    if (control) {
      const state = deriveLiveState(control);
      if (control.date === todayKey || isOpenState(state)) {
        throw ApiError.conflict(
          control.date === todayKey
            ? 'You have already clocked in today'
            : `Close your open session from ${control.date} before clocking in`,
        );
      }
    }
    return clockIn({ full, companyId, userId, at, todayKey, timezone, policy, workMode, idempotencyKey });
  }

  if (!control) {
    throw ApiError.badRequest('You have not clocked in yet');
  }

  const liveState = deriveLiveState(control);
  const check = transition(liveState, action);
  if (!check.allowed) {
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
  const sessionOpenedAt = control.punchIn || withNew[0]?.at || at;
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
    const stored = await resolveRuleFromRecord({ control, companyId, userId, engine, resolveScheduleRule, at });
    const evaluation = engine.evaluatePunch({ rule: stored.rule, punchIn: control.punchIn, punchOut: at });
    const minimumMinutes = Number(stored.rule.minWorkingHours || 8) * 60;
    const workedMinutes = policy
      ? closed.workedMinutes
      : Math.max(0, Math.round((at.getTime() - new Date(control.punchIn).getTime()) / 60000)
          - Number(stored.rule.breakMinutes || 0));

    patch = {
      ...patch,
      punchOut: at,
      workMinutes: workedMinutes,
      breakMinutes: policy ? closed.breakMinutes : 0,
      earlyMinutes: evaluation.earlyMinutes || 0,
      overtimeMinutes: evaluation.overtimeMinutes || 0,
      status: workedMinutes < minimumMinutes ? 'HALF_DAY' : control.status || 'PRESENT',
    };

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
  const updated = await AttendanceModel.findOneAndUpdate(
    { companyId, user: userId, date: control.date, eventSeq: expectedSeq },
    { $set: patch, $inc: { eventSeq: 1 } },
    { new: true },
  );

  if (!updated) {
    // Lost a race. A retried key replays; anything else refreshes.
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
        const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at });
        return replayFromEvent(
          { deps: full, companyId, userId, policy, timezone, todayKey, schedule, now: at },
          existing,
        );
      }
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
        const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at });
        return replayFromEvent(
          { deps: full, companyId, userId, policy, timezone, todayKey, schedule, now: at },
          existing,
        );
      }
    }
    throw ApiError.conflict('Attendance state changed — please refresh and retry');
  }

  const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at });
  const snapshot = await buildSnapshot({
    control: updated,
    events: [...events, created.toObject ? created.toObject() : created],
    policy,
    timezone,
    todayKey,
    schedule,
    now: at,
  });
  return { event: serializeEvent(created), snapshot, replayed: false };
};

const isOpenState = (liveState) =>
  liveState === LIVE_STATE.WORKING || liveState === LIVE_STATE.ON_BREAK;

const bestEffortSchedule = async ({ resolveScheduleRule, engine, companyId, userId, at }) => {
  try {
    const resolved = await resolveScheduleRule({ companyId, user: { _id: userId }, at, engine });
    return snapshotSchedule(resolved);
  } catch {
    return null;
  }
};

// Prefer the rule stored at CLOCK_IN (same guarantee as the classic
// flow's ruleFromRecord), else re-resolve.
const resolveRuleFromRecord = async ({ control, companyId, userId, engine, resolveScheduleRule, at }) => {
  if (engine.resolveStoredRule) {
    try {
      const stored = await engine.resolveStoredRule({ control });
      if (stored?.rule) return stored;
    } catch {
      // Fall through to re-resolution.
    }
  }
  return resolveScheduleRule({ companyId, user: { _id: userId }, at, engine });
};

const clockIn = async ({ full, companyId, userId, at, todayKey, timezone, policy, workMode, idempotencyKey }) => {
  const { AttendanceModel, AttendanceEventModel, resolveScheduleRule, engine } = full;

  const mode = workMode || WORK_MODE.OFFICE;
  if (!Object.values(WORK_MODE).includes(mode)) {
    throw ApiError.badRequest('Invalid work mode');
  }
  if (!isWorkModeAllowed(mode, policy)) {
    throw ApiError.forbidden(`${mode} is not enabled in your company attendance policy`);
  }

  const resolved = await resolveScheduleRule({ companyId, user: { _id: userId }, at, engine });
  const evaluation = engine.evaluatePunch({ rule: resolved.rule, punchIn: at });
  const status = evaluation.status === 'LATE' ? 'LATE' : 'PRESENT';

  let control;
  try {
    control = await AttendanceModel.create({
      companyId,
      user: userId,
      date: todayKey,
      punchIn: at,
      status,
      shift: resolved.shift?._id || null,
      schedule: resolved.schedule?._id || null,
      shiftSource: resolved.source,
      lateMinutes: evaluation.lateMinutes || 0,
      workMode: mode,
      liveState: LIVE_STATE.WORKING,
      eventSeq: 1,
      policyVersion: policy?.version ?? null,
      lastEventAt: at,
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Lost the creation race: replay a retried key, else report.
    if (idempotencyKey) {
      const existing = await AttendanceEventModel.findOne({
        companyId,
        user: userId,
        requestId: idempotencyKey,
      }).lean();
      if (existing && existing.type === EVENT_TYPE.CLOCK_IN) {
        const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at });
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
    created = await AttendanceEventModel.create({
      companyId,
      user: userId,
      date: todayKey,
      seq: 1,
      type: EVENT_TYPE.CLOCK_IN,
      at,
      workMode: mode,
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
      if (existing && existing.type === EVENT_TYPE.CLOCK_IN) {
        const schedule = await bestEffortSchedule({ resolveScheduleRule, engine, companyId, userId, at });
        return replayFromEvent(
          { deps: full, companyId, userId, policy, timezone, todayKey, schedule, now: at },
          existing,
        );
      }
    }
    throw ApiError.conflict('You have already clocked in today');
  }

  const snapshot = await buildSnapshot({
    control,
    events: [created.toObject ? created.toObject() : created],
    policy,
    timezone,
    todayKey,
    schedule: snapshotSchedule(resolved),
    now: at,
  });
  return { event: serializeEvent(created), snapshot, replayed: false };
};
