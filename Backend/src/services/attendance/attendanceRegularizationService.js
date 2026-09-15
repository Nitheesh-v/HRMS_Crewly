// ─────────────────────────────────────────────────────────────
// Phase 31.5 — attendance regularization service.
//
// CORRECTION requests fix effective facts; EXPLANATION requests
// resolve exceptions with words. CORE LAW: AttendanceEvents are
// NEVER edited — an APPROVED request writes an overlay onto the
// daily Attendance projection, leaving recorded punches intact.
//
// The approval rebuild re-derives the day with the SAME helpers
// the live 31.2 CLOCK_OUT path uses (shared seam), so a
// regularized day matches a day that was punched correctly.
//
// Injectable deps keep the hermetic suite DB-free. Tenant
// authority is ALWAYS the explicit companyId argument.
// ─────────────────────────────────────────────────────────────
import ApiError from '../../utils/ApiError.js';
import Attendance from '../../models/Attendance.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import AttendanceRegularization from '../../models/AttendanceRegularization.js';
import AttendanceWorkModeRequest from '../../models/AttendanceWorkModeRequest.js';
import Leave from '../../models/Leave.js';
import PayrollPeriod from '../../models/PayrollPeriod.js';
import User from '../../models/User.js';
import { ROLES } from '../../utils/constants.js';
import { resolveScopeIds as defaultResolveScopeIds } from '../../utils/orgHelpers.js';
import { notifySmart } from '../../utils/notifyPref.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  dayKey,
  evaluatePunch,
  getHolidaysForUser,
  getWorkingDaysForUser,
  holidayOnDate,
  resolveScheduleForUser,
  resolveShiftForUser,
} from '../../utils/scheduleEngine.js';
import {
  derivePolicyOutcome,
  resolveDayScheduleRule,
  resolveRuleFromRecord,
} from './attendanceEventService.js';
import {
  buildScheduleSnapshot,
  deriveAttendanceVerdict,
} from './attendanceScheduleService.js';
import {
  ATTENDANCE_PRESENCE,
  DAILY_OUTCOME,
  resolveDay as resolveReconciliationDay,
} from './attendanceReconciliationService.js';
import {
  EVENT_TYPE,
  LIVE_STATE,
  WORK_MODE,
} from './attendancePolicyRules.js';
import {
  deriveClosedDurations,
  orderEvents,
} from './attendanceEventRules.js';
import { modeRequiresApproval } from './attendanceWorkModeRules.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import {
  REG_KIND,
  REQUEST_STATUS,
  buildEffectiveTimeline,
  cancelEligibility,
  conflictGroupOf,
  isRegularizationType,
  isValidDayString,
  kindOf,
  reviewEligibility,
  toDateOrNull,
  validateProposal,
  validateReason,
  validateReviewReason,
  windowCheck,
} from './attendanceRegularizationRules.js';

const writeAudit = (args) => recordAudit(args);

// Safe notify wrapper (31.4 pattern): never throws, never blocks.
const safeNotify = async (notify, userId, payload) => {
  try {
    if (userId) await notify(userId, payload);
  } catch {
    // Fire-and-forget: notification failure never rolls back a
    // committed workflow mutation.
  }
};

const defaultNotify = (userId, payload) => notifySmart(userId, payload);

const defaultEngine = () => ({
  resolveShiftForUser,
  resolveScheduleForUser,
  getWorkingDaysForUser,
  getHolidaysForUser,
  holidayOnDate,
  evaluatePunch,
  dayKey,
});

const dayKeyInZone = (at, timezone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at instanceof Date ? at : new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
};

const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const TYPE_LABEL = Object.freeze({
  MISSED_CLOCK_IN: 'Missed clock-in',
  MISSED_CLOCK_OUT: 'Missed clock-out',
  CLOCK_IN_TIME_CORRECTION: 'Clock-in time correction',
  CLOCK_OUT_TIME_CORRECTION: 'Clock-out time correction',
  BREAK_CORRECTION: 'Break correction',
  WORK_MODE_CORRECTION: 'Work-mode correction',
  LATE_EXPLANATION: 'Late-arrival explanation',
  EARLY_EXIT_EXPLANATION: 'Early-exit explanation',
  SHORT_HOURS_EXPLANATION: 'Short-hours explanation',
  GEOFENCE_EXPLANATION: 'Location explanation',
});

// ── Serialize ────────────────────────────────────────────

export const serializeRegularization = (row, options = {}) => {
  if (!row) return null;
  const obj = typeof row.toObject === 'function' ? row.toObject() : row;
  const { viewerId = null, isReviewer = false } = options;
  const ownerId = obj.user?._id || obj.user;
  const isOwner = viewerId != null && String(ownerId) === String(viewerId);
  return {
    id: String(obj._id || obj.id || ''),
    attendanceDate: obj.attendanceDate,
    type: obj.type,
    typeLabel: TYPE_LABEL[obj.type] || obj.type,
    kind: kindOf(obj.type),
    reason: obj.reason || '',
    proposal: obj.proposal || null,
    originalSnapshot: obj.originalSnapshot || null,
    status: obj.status,
    approver: obj.approver
      ? { id: idOf(obj.approver), name: obj.approver?.name || null }
      : null,
    reviewReason: obj.reviewReason || null,
    decidedAt: obj.decidedAt || null,
    cancelledAt: obj.cancelledAt || null,
    appliedAt: obj.appliedAt || null,
    authorizationOverride: obj.authorizationOverride === true,
    createdAt: obj.createdAt || null,
    employee: obj.user && typeof obj.user === 'object' && obj.user.name
      ? {
          id: String(obj.user._id || ''),
          name: obj.user.name || '',
          email: obj.user.email || null,
          designation: obj.user.designation || null,
        }
      : null,
    canCancel:
      cancelEligibility(obj, { isOwner, isReviewer }) === null,
  };
};

// ── Internal helpers ─────────────────────────────────────

const readPolicy = async ({ companyId, policyReader, RequestPolicyModel }) =>
  policyReader
    ? policyReader({ companyId })
    : getCurrentPolicy({ companyId, AttendancePolicyModel: RequestPolicyModel });

// Payroll boundary (§J): a month whose period is LOCKED or
// SENT_TO_PAYROLL refuses both submission and approval. A missing
// period row means the month is still open. Read-only: payroll is
// never mutated here.
const LOCKED_PERIOD_STATUSES = ['LOCKED', 'SENT_TO_PAYROLL'];

const periodLockRefusal = async ({ PayrollPeriodModel, companyId, attendanceDate }) => {
  const month = String(attendanceDate || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const period = await PayrollPeriodModel.findOne({ companyId, month }).lean();
  if (period && LOCKED_PERIOD_STATUSES.includes(period.status)) {
    return `Payroll for ${month} is already ${String(period.status).toLowerCase().replace(/_/g, ' ')} — attendance for that month is frozen`;
  }
  return null;
};

// Approved Leave wins over regularization for the shared day.
// Read-only: Leave is never mutated here.
const findLeaveOnDay = async ({ LeaveModel, companyId, userId, attendanceDate }) => {
  const rows = await LeaveModel.find({
    companyId,
    user: userId,
    status: 'APPROVED',
    startDate: { $lte: attendanceDate },
    endDate: { $gte: attendanceDate },
  }).lean();
  return rows?.[0] || null;
};

// Recorded facts for a day: control projection + ordered raw events.
// Events pair into break intervals; recorded clock times come from
// the events (first in / last out) with the control as fallback.
const pairBreakIntervals = (events) => {
  const intervals = [];
  let openStart = null;
  for (const event of orderEvents(events || [])) {
    if (event.type === EVENT_TYPE.BREAK_START) {
      if (openStart === null) openStart = toDateOrNull(event.at);
    } else if (event.type === EVENT_TYPE.BREAK_END) {
      if (openStart !== null) {
        const end = toDateOrNull(event.at);
        if (end && end > openStart) intervals.push({ start: openStart, end });
        openStart = null;
      }
    }
  }
  return intervals;
};

const readOriginalFacts = async ({
  AttendanceModel,
  AttendanceEventModel,
  companyId,
  userId,
  attendanceDate,
}) => {
  const control = await AttendanceModel.findOne({
    companyId,
    user: userId,
    date: attendanceDate,
  }).lean();
  const events = await AttendanceEventModel.find({
    companyId,
    user: userId,
    date: attendanceDate,
  })
    .sort({ seq: 1 })
    .lean();
  const ordered = orderEvents(events || []);
  const ins = ordered.filter((event) => event.type === EVENT_TYPE.CLOCK_IN);
  const outs = ordered.filter((event) => event.type === EVENT_TYPE.CLOCK_OUT);
  const firstIn = toDateOrNull(ins[0]?.at) || toDateOrNull(control?.punchIn);
  const lastOut = toDateOrNull(outs[outs.length - 1]?.at) || toDateOrNull(control?.punchOut);
  return {
    control,
    events: ordered,
    original: {
      firstIn,
      lastOut,
      breaks: pairBreakIntervals(ordered),
      workMode: control?.workMode || WORK_MODE.OFFICE,
      hasControl: control != null,
    },
  };
};

const openOrAppliedOnDay = async ({ RequestModel, companyId, userId, attendanceDate, excludeId = null }) => {
  const filter = {
    companyId,
    user: userId,
    attendanceDate,
    status: { $in: [REQUEST_STATUS.PENDING, REQUEST_STATUS.APPROVED] },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return RequestModel.find(filter).lean();
};

// 31.4 cover lookup for work-mode corrections: an APPROVED mode
// request covering the day. Returns the row or null (tri-state:
// missing cover + HR/Admin reviewer = audited override).
const findModeCover = async ({ WorkModeRequestModel, companyId, userId, mode, attendanceDate }) =>
  WorkModeRequestModel.findOne({
    companyId,
    user: userId,
    mode,
    status: 'APPROVED',
    startDate: { $lte: attendanceDate },
    endDate: { $gte: attendanceDate },
  }).lean();

// Resolved approver(s) for submit/cancel notifications: direct
// manager when set, else company Admin + HR (31.4 pattern).
const notifyApprovers = async ({ UserModel, notify, companyId, requester, payload }) => {
  if (requester?.reportingTo) {
    await safeNotify(notify, requester.reportingTo, payload);
    return;
  }
  try {
    const bosses = await UserModel.find({
      companyId,
      role: { $in: [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER] },
      _id: { $ne: requester?._id },
    })
      .select('_id')
      .lean();
    await Promise.all(
      (bosses || []).map((boss) => safeNotify(notify, boss._id, payload)),
    );
  } catch {
    // Notification discovery failure never blocks the workflow.
  }
};

// ── Submit ───────────────────────────────────────────────

export const submitRegularization = async ({
  companyId,
  requester,
  input = {},
  today = null,
  policyReader = null,
  RequestModel = AttendanceRegularization,
  AttendanceModel = Attendance,
  AttendanceEventModel = AttendanceEvent,
  LeaveModel = Leave,
  PayrollPeriodModel = PayrollPeriod,
  UserModel = User,
  AttendancePolicyModel,
  resolveScopeIds = defaultResolveScopeIds,
  notify = defaultNotify,
  audit = writeAudit,
}) => {
  void resolveScopeIds;
  const userId = requester?._id || requester?.id;
  if (!userId) throw ApiError.badRequest('Requester identity is required');

  const { type, attendanceDate, reason, proposal = {} } = input;
  if (!isRegularizationType(type)) {
    throw ApiError.badRequest('type must be a supported regularization type');
  }
  if (!isValidDayString(attendanceDate)) {
    throw ApiError.badRequest('attendanceDate must be a valid YYYY-MM-DD day');
  }
  const reasonError = validateReason(reason);
  if (reasonError) throw ApiError.badRequest(reasonError);

  const { policy } = await readPolicy({ companyId, policyReader, RequestPolicyModel: AttendancePolicyModel });
  const timezone = policy?.timezone || 'Asia/Kolkata';
  const day = today || dayKeyInZone(new Date(), timezone);
  const windowRefusal = windowCheck(attendanceDate, day, policy?.missingPunch);
  if (windowRefusal) throw ApiError.badRequest(windowRefusal);

  const lockRefusal = await periodLockRefusal({ PayrollPeriodModel, companyId, attendanceDate });
  if (lockRefusal) throw ApiError.conflict(lockRefusal);

  const { control, original } = await readOriginalFacts({
    AttendanceModel,
    AttendanceEventModel,
    companyId,
    userId,
    attendanceDate,
  });
  const proposalErrors = validateProposal(type, proposal, original, { attendanceDate, timezone });
  if (proposalErrors.length) throw ApiError.badRequest(proposalErrors[0]);

  const leave = await findLeaveOnDay({ LeaveModel, companyId, userId, attendanceDate });
  if (leave) {
    throw ApiError.conflict('Approved leave already covers this day — regularization cannot apply over it');
  }

  const group = conflictGroupOf(type);
  const existing = await openOrAppliedOnDay({ RequestModel, companyId, userId, attendanceDate });
  const clash = (existing || []).find((row) => conflictGroupOf(row.type) === group);
  if (clash) {
    throw ApiError.conflict(
      clash.status === REQUEST_STATUS.PENDING
        ? `A ${TYPE_LABEL[clash.type] || clash.type} request for ${attendanceDate} is already pending`
        : `${attendanceDate} was already regularized (${TYPE_LABEL[clash.type] || clash.type}) — only one correction per fact is allowed`,
    );
  }

  const snapshotBreaks = (original.breaks || []).map((interval) => ({
    start: interval.start,
    end: interval.end,
  }));
  const created = await RequestModel.create({
    companyId,
    user: userId,
    attendanceDate,
    type,
    reason: String(reason).trim(),
    proposal: {
      correctedIn: toDateOrNull(proposal.correctedIn),
      correctedOut: toDateOrNull(proposal.correctedOut),
      breaks: Array.isArray(proposal.breaks)
        ? proposal.breaks.map((interval) => ({
          start: toDateOrNull(interval?.start),
          end: toDateOrNull(interval?.end),
        }))
        : undefined,
      workMode: typeof proposal.workMode === 'string' ? proposal.workMode : null,
    },
    originalSnapshot: {
      firstIn: original.firstIn,
      lastOut: original.lastOut,
      breaks: snapshotBreaks.length ? snapshotBreaks : undefined,
      workMode: control?.workMode || null,
      workedMinutes: control?.workMinutes ?? null,
      breakMinutes: control?.breakMinutes ?? null,
      status: control?.status || null,
      eventIds: [],
      policyExceptions: Array.isArray(control?.policyExceptions) ? [...control.policyExceptions] : undefined,
    },
  });

  const plain = typeof created.toObject === 'function' ? created.toObject() : created;
  await audit({
    action: 'ATTENDANCE_REGULARIZATION_SUBMITTED',
    resource: 'AttendanceRegularization',
    resourceId: String(plain._id || plain.id),
    companyId,
    actorId: String(userId),
    newValue: { type, attendanceDate, status: REQUEST_STATUS.PENDING },
  });

  await notifyApprovers({
    UserModel,
    notify,
    companyId,
    requester,
    payload: {
      title: 'Attendance regularization requested',
      message: `${requester?.name || 'An employee'} requested ${TYPE_LABEL[type] || type} for ${attendanceDate}`,
      link: '/app/attendance/regularizations',
      category: 'ATTENDANCE',
    },
  });

  return serializeRegularization(plain, { viewerId: userId });
};

// ── Mine / pending / get ─────────────────────────────────

export const listMyRegularizations = async ({
  companyId,
  userId,
  RequestModel = AttendanceRegularization,
}) => {
  const rows = await RequestModel.find({ companyId, user: userId }).sort({ createdAt: -1 }).lean();
  return (rows || []).map((row) => serializeRegularization(row, { viewerId: userId }));
};

export const listPendingRegularizations = async ({
  companyId,
  viewer,
  RequestModel = AttendanceRegularization,
  resolveScopeIds = defaultResolveScopeIds,
}) => {
  const scopeIds = await resolveScopeIds({ companyId, user: viewer });
  const rows = await RequestModel.find({
    companyId,
    status: REQUEST_STATUS.PENDING,
    user: { $in: scopeIds },
  })
    .populate({ path: 'user', select: 'name email designation' })
    .sort({ createdAt: 1 })
    .lean();
  return (rows || []).map((row) =>
    serializeRegularization(row, { viewerId: viewer?._id, isReviewer: true }),
  );
};

export const getRegularization = async ({
  companyId,
  viewer,
  requestId,
  asReviewer = false,
  RequestModel = AttendanceRegularization,
  resolveScopeIds = defaultResolveScopeIds,
}) => {
  const row = await RequestModel.findOne({ _id: requestId, companyId })
    .populate({ path: 'user', select: 'name email designation' })
    .populate({ path: 'approver', select: 'name' })
    .lean();
  if (!row) throw ApiError.notFound('Regularization request not found');
  const isOwner = String(row.user?._id || row.user) === String(viewer?._id || viewer?.id);
  if (!isOwner) {
    if (!asReviewer) throw ApiError.notFound('Regularization request not found');
    const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
    if (!scopeIds.includes(String(row.user?._id || row.user))) {
      throw ApiError.forbidden('This employee is not in your team');
    }
  }
  return serializeRegularization(row, {
    viewerId: viewer?._id || viewer?.id,
    isReviewer: asReviewer,
  });
};

// ── Projection rebuild (approve path) ────────────────────
// Reads raw events + ALL approved corrections for the day and
// re-derives the projection with the shared CLOCK_OUT helpers.
// Pure function of (events + approvals): retry-safe (§18).

export const rebuildDayProjection = async ({
  companyId,
  userId,
  attendanceDate,
  policy = null,
  AttendanceModel = Attendance,
  AttendanceEventModel = AttendanceEvent,
  RequestModel = AttendanceRegularization,
  engine = null,
  resolveScheduleRule = resolveDayScheduleRule,
  models = {},
  LeaveModel = null,
  now = null,
}) => {
  const activeEngine = engine || defaultEngine();
  const at = now || new Date();
  const timezone = policy?.timezone || 'Asia/Kolkata';
  const includeBreaks = policy?.breaks?.includeInWorkedTime === true;

  const { control, original } = await readOriginalFacts({
    AttendanceModel,
    AttendanceEventModel,
    companyId,
    userId,
    attendanceDate,
  });
  const approved = await RequestModel.find({
    companyId,
    user: userId,
    attendanceDate,
    status: REQUEST_STATUS.APPROVED,
  }).lean();
  const corrections = (approved || []).map((row) => ({ type: row.type, proposal: row.proposal || {} }));
  const hasCorrection = corrections.some((entry) => kindOf(entry.type) === REG_KIND.CORRECTION);
  const effective = buildEffectiveTimeline(original, corrections);

  // Explanation-only on a day with no recorded attendance: the
  // request stands alone (e.g. a geofence note on a failed
  // clock-in) — there is no projection to overlay.
  if (!control && !hasCorrection) {
    return { control: null, overlayOnly: true };
  }

  const overlay = {
    correctedIn: effective.clockIn,
    correctedOut: effective.clockOut,
    correctedBreakMinutes: null,
    correctedWorkMode: effective.workMode,
    resolvedExceptions: effective.resolvedExceptions,
    appliedRequestIds: (approved || []).map((row) => row._id),
    appliedAt: at,
  };

  // Explanation-only approvals overlay words, never derived facts.
  if (!hasCorrection) {
    overlay.correctedBreakMinutes = control?.breakMinutes ?? 0;
    const patched = await AttendanceModel.findOneAndUpdate(
      { _id: control._id, companyId },
      { $set: { regularization: overlay, regularized: true } },
      { new: true },
    );
    return { control: patched, overlayOnly: true };
  }

  // Effective durations: the corrected timeline runs through the
  // SAME closed-duration math as a live clock-out.
  const synthetic = [];
  let seq = 1;
  if (effective.clockIn) synthetic.push({ seq: seq++, type: EVENT_TYPE.CLOCK_IN, at: effective.clockIn });
  for (const interval of effective.breaks || []) {
    if (interval.start) synthetic.push({ seq: seq++, type: EVENT_TYPE.BREAK_START, at: interval.start });
    if (interval.end) synthetic.push({ seq: seq++, type: EVENT_TYPE.BREAK_END, at: interval.end });
  }
  if (effective.clockOut) synthetic.push({ seq: seq++, type: EVENT_TYPE.CLOCK_OUT, at: effective.clockOut });
  const closed = deriveClosedDurations(synthetic, {
    sessionOpenedAt: effective.clockIn,
    sessionClosedAt: effective.clockOut,
    includeBreaks,
  });
  overlay.correctedBreakMinutes = policy ? closed.breakMinutes : 0;

  // Phase 31.6 — stored snapshot wins, else dated re-resolution for
  // the request's own business date (never the effective-out day).
  const stored = await resolveRuleFromRecord({
    control: control || { date: attendanceDate },
    companyId,
    userId,
    engine: activeEngine,
    resolveScheduleRule,
    at: effective.clockOut || effective.clockIn || at,
    timezone,
    attendanceDate,
    models,
  });
  const workedMinutes = policy
    ? closed.workedMinutes
    : Math.max(
      0,
      effective.clockIn && effective.clockOut
        ? Math.round((effective.clockOut.getTime() - effective.clockIn.getTime()) / 60000)
          - Number(stored.rule?.breakMinutes || 0)
        : 0,
    );

  const patch = {
    regularization: overlay,
    regularized: true,
    workMode: effective.workMode,
  };
  // Phase 31.6 — payroll verdict from EFFECTIVE facts against the
  // resolved schedule + policy grace (replaces the UTC-anchored
  // punch evaluation so approvals match live derivation exactly).
  const verdict = deriveAttendanceVerdict({
    resolved: stored,
    attendanceDate,
    timezone,
    policy,
    effectiveIn: effective.clockIn,
    effectiveOut: effective.clockOut,
    workedMinutes,
  });
  if (effective.clockIn) patch.lateMinutes = verdict.lateMinutes;
  if (effective.clockOut) {
    patch.workMinutes = workedMinutes;
    patch.breakMinutes = policy ? closed.breakMinutes : 0;
    patch.earlyMinutes = verdict.earlyMinutes;
    patch.overtimeMinutes = verdict.overtimeMinutes;
    patch.status = verdict.status;
  } else if (!control) {
    // Corrected clock-in with the day still open: the projection
    // opens as a working session the employee can clock out of.
    patch.status = verdict.status;
    patch.liveState = LIVE_STATE.WORKING;
    patch.workMinutes = 0;
    patch.breakMinutes = 0;
  }
  // First 31.6 evaluation versions a snapshot-less control: later
  // Shift edits cannot rewrite the day. Existing snapshots are never
  // overwritten here (resolveRuleFromRecord already preferred them).
  const scheduleCtx = stored.scheduleCtx || null;
  if (!control?.scheduleSnapshot && scheduleCtx?.status === 'RESOLVED') {
    patch.scheduleSnapshot = buildScheduleSnapshot({ ctx: scheduleCtx, rule: stored.rule });
    patch.scheduleStatus = 'RESOLVED';
  } else if (!control?.scheduleStatus && !stored.rule) {
    patch.scheduleStatus = 'UNRESOLVED';
  }
  try {
    const outPresent = Boolean(effective.clockOut);
    const reconciled = await resolveReconciliationDay({
      companyId,
      userId,
      attendanceDate,
      attendance: {
        presence: effective.clockIn && outPresent
          ? ATTENDANCE_PRESENCE.FULL
          : effective.clockIn || outPresent
            ? ATTENDANCE_PRESENCE.PARTIAL
            : ATTENDANCE_PRESENCE.NONE,
        workedMinutes,
        breakMinutes: policy ? closed.breakMinutes : 0,
        lateMinutes: verdict.lateMinutes,
        earlyMinutes: verdict.earlyMinutes,
        outcomeBand: !outPresent
          ? DAILY_OUTCOME.UNRESOLVED
          : verdict.status === 'HALF_DAY'
            ? DAILY_OUTCOME.HALF_DAY
            : DAILY_OUTCOME.PRESENT,
        exceptions: control?.policyExceptions || [],
        effectiveIn: effective.clockIn,
        effectiveOut: effective.clockOut,
        expectedMinutes: 0,
      },
      schedule: scheduleCtx?.status === 'RESOLVED' ? scheduleCtx : null,
      LeaveModel,
      engine: activeEngine,
    });
    patch.reconciliation = { ...reconciled, resolvedAt: at, resolvedBy: 'SYSTEM' };
  } catch {
    // Best-effort: reads recompute on miss.
  }

  if (effective.clockOut) {
    const derivation = await derivePolicyOutcome({
      policy,
      rule: stored.rule,
      punchIn: effective.clockIn,
      punchOut: effective.clockOut,
      breakMinutes: closed.breakMinutes,
      workMode: effective.workMode,
      dayCtx: { engine: activeEngine, companyId, user: { _id: userId }, date: attendanceDate, timezone },
    });
    if (derivation) {
      patch.policyOutcome = derivation.outcome;
      patch.policyExceptions = derivation.exceptions;
      if (control) patch.policyVersion = policy?.version ?? control.policyVersion ?? null;
      else patch.policyVersion = policy?.version ?? null;
    }
  }

  if (control) {
    const patched = await AttendanceModel.findOneAndUpdate(
      { _id: control._id, companyId },
      { $set: patch },
      { new: true },
    );
    return { control: patched, overlayOnly: false };
  }
  const created = await AttendanceModel.create({
    companyId,
    user: userId,
    date: attendanceDate,
    ...patch,
  });
  return { control: created, overlayOnly: false };
};

// ── Decide (approve / reject) ────────────────────────────

export const decideRegularization = async ({
  companyId,
  viewer,
  requestId,
  action,
  reviewReason = null,
  today = null,
  policyReader = null,
  RequestModel = AttendanceRegularization,
  AttendanceModel = Attendance,
  AttendanceEventModel = AttendanceEvent,
  LeaveModel = Leave,
  PayrollPeriodModel = PayrollPeriod,
  WorkModeRequestModel = AttendanceWorkModeRequest,
  AttendancePolicyModel,
  resolveScopeIds = defaultResolveScopeIds,
  engine = null,
  resolveScheduleRule = resolveDayScheduleRule,
  models = {},
  notify = defaultNotify,
  audit = writeAudit,
}) => {
  const reviewerId = viewer?._id || viewer?.id;
  const row = await RequestModel.findOne({ _id: requestId, companyId });
  if (!row) throw ApiError.notFound('Regularization request not found');

  // Retry-safe completion (§18): an APPROVED request whose overlay
  // never landed (crash between CAS and rebuild) completes on a
  // scoped re-approve instead of 409ing.
  const needsApplication = row.status === REQUEST_STATUS.APPROVED && !row.appliedAt && action === 'APPROVE';
  if (needsApplication) {
    const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
    if (!scopeIds.includes(String(row.user))) {
      throw ApiError.forbidden('This employee is not in your team');
    }
    if (String(row.user) === String(reviewerId)) {
      throw ApiError.forbidden('you cannot review your own request');
    }
    const { policy } = await readPolicy({ companyId, policyReader, RequestPolicyModel: AttendancePolicyModel });
    await rebuildDayProjection({
      companyId,
      userId: row.user,
      attendanceDate: row.attendanceDate,
      policy,
      AttendanceModel,
      AttendanceEventModel,
      RequestModel,
      engine,
      resolveScheduleRule,
      models,
      LeaveModel,
    });
    const appliedAt = new Date();
    await RequestModel.findOneAndUpdate(
      { _id: row._id, companyId },
      { $set: { appliedAt } },
    );
    await audit({
      action: 'ATTENDANCE_REGULARIZATION_APPLIED',
      resource: 'AttendanceRegularization',
      resourceId: String(row._id),
      companyId,
      actorId: String(reviewerId),
      newValue: { type: row.type, attendanceDate: row.attendanceDate, completed: 'retry' },
    });
    const completed = await RequestModel.findOne({ _id: row._id, companyId }).lean();
    return serializeRegularization(completed || row, { viewerId: reviewerId, isReviewer: true });
  }

  const eligibility = reviewEligibility(row, reviewerId);
  if (eligibility) {
    const gone = row.status !== REQUEST_STATUS.PENDING;
    throw gone ? ApiError.conflict(eligibility) : ApiError.forbidden(eligibility);
  }
  const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
  if (!scopeIds.includes(String(row.user))) {
    throw ApiError.forbidden('This employee is not in your team');
  }

  const approve = action === 'APPROVE';
  if (!approve && action !== 'REJECT') throw ApiError.badRequest('action must be APPROVE or REJECT');

  const reasonError = validateReviewReason(reviewReason, { required: !approve });
  if (reasonError) throw ApiError.badRequest(reasonError);

  const { policy } = await readPolicy({ companyId, policyReader, RequestPolicyModel: AttendancePolicyModel });
  const timezone = policy?.timezone || 'Asia/Kolkata';
  const day = today || dayKeyInZone(new Date(), timezone);

  let authorizationOverride = false;
  if (approve) {
    // Revalidate everything at decision time: policy, payroll,
    // leave and the day itself may have changed since submission.
    const windowRefusal = windowCheck(row.attendanceDate, day, policy?.missingPunch);
    if (windowRefusal) throw ApiError.conflict(windowRefusal);
    const lockRefusal = await periodLockRefusal({ PayrollPeriodModel, companyId, attendanceDate: row.attendanceDate });
    if (lockRefusal) throw ApiError.conflict(lockRefusal);
    const leave = await findLeaveOnDay({
      LeaveModel,
      companyId,
      userId: row.user,
      attendanceDate: row.attendanceDate,
    });
    if (leave) {
      throw ApiError.conflict('Approved leave already covers this day — cannot approve over it');
    }
    const group = conflictGroupOf(row.type);
    const rivals = await openOrAppliedOnDay({
      RequestModel,
      companyId,
      userId: row.user,
      attendanceDate: row.attendanceDate,
      excludeId: row._id,
    });
    if ((rivals || []).some((rival) => conflictGroupOf(rival.type) === group)) {
      throw ApiError.conflict('Another request for the same fact was decided meanwhile — only one correction per fact is allowed');
    }
    const { original } = await readOriginalFacts({
      AttendanceModel,
      AttendanceEventModel,
      companyId,
      userId: row.user,
      attendanceDate: row.attendanceDate,
    });
    const drift = validateProposal(row.type, row.proposal || {}, original, {
      attendanceDate: row.attendanceDate,
      timezone,
    });
    if (drift.length) {
      throw ApiError.conflict(`The day changed since submission — cannot approve: ${drift[0]}`);
    }
    // Work-mode guard (§I): non-office modes need a covering 31.4
    // approval; HR/Admin may record an audited override instead.
    if (row.type === 'WORK_MODE_CORRECTION') {
      const proposed = row.proposal?.workMode;
      if (modeRequiresApproval(proposed, policy)) {
        const cover = await findModeCover({
          WorkModeRequestModel,
          companyId,
          userId: row.user,
          mode: proposed,
          attendanceDate: row.attendanceDate,
        });
        if (!cover) {
          const elevated = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(viewer?.role);
          if (!elevated) {
            throw ApiError.forbidden(
              `An approved ${proposed} request must cover ${row.attendanceDate} before this mode can be granted`,
            );
          }
          authorizationOverride = true;
        }
      }
    }
  }

  const fromStatus = row.status;
  const decidedAt = new Date();
  const updated = await RequestModel.findOneAndUpdate(
    { _id: row._id, companyId, status: REQUEST_STATUS.PENDING },
    {
      $set: {
        status: approve ? REQUEST_STATUS.APPROVED : REQUEST_STATUS.REJECTED,
        approver: reviewerId,
        reviewReason: typeof reviewReason === 'string' && reviewReason.trim() ? reviewReason.trim() : null,
        decidedAt,
        authorizationOverride,
      },
    },
    { new: true },
  );
  // Lost a decide race: refuse, never silently double-decide.
  if (!updated) throw ApiError.conflict('Request is no longer pending');

  await audit({
    action: approve ? 'ATTENDANCE_REGULARIZATION_APPROVED' : 'ATTENDANCE_REGULARIZATION_REJECTED',
    resource: 'AttendanceRegularization',
    resourceId: String(row._id),
    companyId,
    actorId: String(reviewerId),
    newValue: {
      type: row.type,
      attendanceDate: row.attendanceDate,
      from: fromStatus,
      to: approve ? REQUEST_STATUS.APPROVED : REQUEST_STATUS.REJECTED,
      authorizationOverride,
    },
  });

  if (approve) {
    await rebuildDayProjection({
      companyId,
      userId: row.user,
      attendanceDate: row.attendanceDate,
      policy,
      AttendanceModel,
      AttendanceEventModel,
      RequestModel,
      engine,
      resolveScheduleRule,
      models,
      LeaveModel,
    });
    const appliedAt = new Date();
    await RequestModel.findOneAndUpdate(
      { _id: row._id, companyId },
      { $set: { appliedAt } },
    );
    await audit({
      action: 'ATTENDANCE_REGULARIZATION_APPLIED',
      resource: 'AttendanceRegularization',
      resourceId: String(row._id),
      companyId,
      actorId: String(reviewerId),
      newValue: { type: row.type, attendanceDate: row.attendanceDate },
    });
  }

  await safeNotify(notify, row.user, {
    title: approve ? 'Regularization approved' : 'Regularization rejected',
    message: `Your ${TYPE_LABEL[row.type] || row.type} request for ${row.attendanceDate} was ${approve ? 'approved' : 'rejected'} by ${viewer?.name || 'your reviewer'}`,
    link: '/app/attendance/regularizations',
    category: 'ATTENDANCE',
  });

  const fresh = await RequestModel.findOne({ _id: row._id, companyId }).lean();
  const plain = (fresh && (typeof fresh.toObject === 'function' ? fresh.toObject() : fresh))
    || (typeof updated.toObject === 'function' ? updated.toObject() : updated);
  return serializeRegularization(
    { ...plain, approver: { _id: reviewerId, name: viewer?.name || null } },
    { viewerId: reviewerId, isReviewer: true },
  );
};

// ── Cancel ───────────────────────────────────────────────

export const cancelRegularization = async ({
  companyId,
  viewer,
  requestId,
  RequestModel = AttendanceRegularization,
  resolveScopeIds = defaultResolveScopeIds,
  notify = defaultNotify,
  audit = writeAudit,
}) => {
  const viewerId = viewer?._id || viewer?.id;
  const row = await RequestModel.findOne({ _id: requestId, companyId });
  if (!row) throw ApiError.notFound('Regularization request not found');

  const isOwner = String(row.user) === String(viewerId);
  let isReviewer = false;
  if (!isOwner) {
    const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
    isReviewer = scopeIds.includes(String(row.user));
  }
  // Capture BEFORE the update: post-update re-reads break under
  // object-aliasing stores (31.4 lesson).
  const fromStatus = row.status;
  const refusal = cancelEligibility(row, { isOwner, isReviewer });
  if (refusal) {
    const gone = fromStatus !== REQUEST_STATUS.PENDING;
    throw gone ? ApiError.conflict(refusal) : ApiError.forbidden(refusal);
  }

  const cancelledAt = new Date();
  const updated = await RequestModel.findOneAndUpdate(
    { _id: row._id, companyId, status: REQUEST_STATUS.PENDING },
    { $set: { status: REQUEST_STATUS.CANCELLED, cancelledBy: viewerId, cancelledAt } },
    { new: true },
  );
  if (!updated) throw ApiError.conflict('Request is no longer pending');

  await audit({
    action: 'ATTENDANCE_REGULARIZATION_CANCELLED',
    resource: 'AttendanceRegularization',
    resourceId: String(row._id),
    companyId,
    actorId: String(viewerId),
    newValue: { type: row.type, attendanceDate: row.attendanceDate, from: fromStatus, to: REQUEST_STATUS.CANCELLED },
  });

  if (isOwner) {
    await safeNotify(notify, viewer.reportingTo, {
      title: 'Regularization cancelled',
      message: `${viewer?.name || 'An employee'} cancelled a pending ${TYPE_LABEL[row.type] || row.type} request for ${row.attendanceDate}`,
      link: '/app/attendance/regularizations',
      category: 'ATTENDANCE',
    });
  } else {
    await safeNotify(notify, row.user, {
      title: 'Regularization cancelled',
      message: `Your ${TYPE_LABEL[row.type] || row.type} request for ${row.attendanceDate} was cancelled by ${viewer?.name || 'your reviewer'}`,
      link: '/app/attendance/regularizations',
      category: 'ATTENDANCE',
    });
  }

  const plain = typeof updated.toObject === 'function' ? updated.toObject() : updated;
  return serializeRegularization(plain, { viewerId, isReviewer });
};
