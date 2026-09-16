// ─────────────────────────────────────────────────────────────
// Phase 31.8 — overtime / comp-off service (injectable).
//
// Recorded extra (31.1–31.7 facts) → eligible (policy gate) →
// human-approved TIME. Money is never calculated here: an OT
// approval republishes the day's approved minutes onto
// Attendance.overtimeMinutes (the existing 29.5 seam), and a
// comp-off approval credits whole leave days consumed by the
// existing Leave workflow. No PayrollResult is ever touched.
//
// Mongo is authoritative for every guard: the partial unique
// index blocks double claims, status-filtered CAS transitions
// block double decisions. No Redis correctness locks.
// ─────────────────────────────────────────────────────────────
import ApiError from '../../utils/ApiError.js';
import { bumpAttendanceAnalyticsGeneration } from '../analyticsCacheInvalidation.js';
import Attendance from '../../models/Attendance.js';
import AttendanceOvertimeRequest from '../../models/AttendanceOvertimeRequest.js';
import Leave from '../../models/Leave.js';
import PayrollPeriod from '../../models/PayrollPeriod.js';
import User from '../../models/User.js';
import { ROLES } from '../../utils/constants.js';
import { resolveScopeIds as defaultResolveScopeIds } from '../../utils/orgHelpers.js';
import { getHolidaysForUser, getWorkingDaysForUser, holidayOnDate } from '../../utils/scheduleEngine.js';
import { notifySmart } from '../../utils/notifyPref.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import { resolveEmployeeSchedule } from './attendanceScheduleService.js';
import { resolveDay as resolveReconciliationDay } from './attendanceReconciliationService.js';
import {
  DAY_TYPE,
  OVERTIME_STATUS,
  OVERTIME_TYPE,
  OT_BENEFIT,
  blockingConflicts,
  compOffDaysFor,
  compOffMinutesPerDay,
  deriveEligibleMinutes,
  eachDayInRange,
  isValidDayString,
  monthOf,
  recordedExtraMinutes,
  resolveBenefit,
  transitionError,
  validateApprovedMinutes,
  validateDayRange,
  validateReason,
  validateRequestedMinutes,
} from './attendanceOvertimeRules.js';

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
  getWorkingDaysForUser,
  getHolidaysForUser,
  holidayOnDate,
});

const defaultResolveSchedule = ({ companyId, user, attendanceDate, timezone }) =>
  resolveEmployeeSchedule({ companyId, user, attendanceDate, timezone });

const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const TYPE_LABEL = Object.freeze({
  OVERTIME: 'Overtime',
  COMP_OFF: 'Comp-off',
});

const LOCKED_PERIOD_STATUSES = ['LOCKED', 'SENT_TO_PAYROLL'];

// Payroll boundary (31.5 precedent): a month whose period is LOCKED
// or SENT_TO_PAYROLL refuses OVERTIME submission and approval —
// approved minutes could otherwise silently miss a frozen payroll.
// COMP_OFF is leave-side and stays available. Read-only: payroll
// is never mutated here.
const periodLockRefusal = async ({ PayrollPeriodModel, companyId, attendanceDate }) => {
  if (!PayrollPeriodModel?.findOne) return { locked: false, refusal: null };
  const month = monthOf(attendanceDate);
  if (!month) return { locked: false, refusal: null };
  const period = await PayrollPeriodModel.findOne({ companyId, month }).lean();
  if (period && LOCKED_PERIOD_STATUSES.includes(period.status)) {
    return {
      locked: true,
      refusal: `Payroll for ${month} is already ${String(period.status).toLowerCase().replace(/_/g, ' ')} — overtime for that month is frozen`,
    };
  }
  return { locked: false, refusal: null };
};

const readPolicy = async ({ companyId, policy, policyReader, AttendancePolicyModel }) => {
  if (policy) return { policy, configured: true };
  if (policyReader) return policyReader({ companyId });
  return getCurrentPolicy({ companyId, AttendancePolicyModel });
};

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
    await Promise.all((bosses || []).map((boss) => safeNotify(notify, boss._id, payload)));
  } catch {
    // Notification discovery failure never blocks the workflow.
  }
};

// ── Serialize ────────────────────────────────────────────

export const serializeOvertimeRequest = (row, options = {}) => {
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
    status: obj.status,
    recordedMinutes: Number(obj.recordedMinutes) || 0,
    eligibleMinutes: Number(obj.eligibleMinutes) || 0,
    requestedMinutes: Number(obj.requestedMinutes) || 0,
    approvedMinutes: obj.approvedMinutes ?? null,
    compOffDays: obj.compOffDays ?? null,
    calendar: obj.calendar || null,
    schedule: obj.schedule || null,
    reason: obj.reason || '',
    reviewReason: obj.reviewReason || null,
    reviewedBy: obj.reviewedBy
      ? { id: idOf(obj.reviewedBy), name: obj.reviewedBy?.name || null }
      : null,
    reviewedAt: obj.reviewedAt || null,
    createdAt: obj.createdAt || null,
    employee:
      obj.user && typeof obj.user === 'object' && obj.user.name
        ? {
            id: String(obj.user._id || ''),
            name: obj.user.name || '',
            email: obj.user.email || null,
            designation: obj.user.designation || null,
          }
        : null,
    canCancel: obj.status === OVERTIME_STATUS.PENDING && (isOwner || isReviewer),
  };
};

// ── Eligibility ──────────────────────────────────────────
// Read-only: computes one day's candidate from authoritative
// Mongo facts. Never throws for data states — blockers describe
// them; only malformed input throws.

export const computeDayEligibility = async ({
  companyId,
  user = null,
  userId = null,
  attendanceDate,
  policy = null,
  policyReader = null,
  AttendancePolicyModel,
  AttendanceModel = Attendance,
  RequestModel = AttendanceOvertimeRequest,
  LeaveModel = Leave,
  PayrollPeriodModel = PayrollPeriod,
  resolveSchedule = defaultResolveSchedule,
  engine = null,
  // Approval revalidation passes the request under review so its
  // own live row does not self-block.
  ignoreRequestId = null,
}) => {
  const uid = idOf(user?._id || user || userId);
  if (!companyId || !uid) throw ApiError.badRequest('Company and employee context are required');
  if (!isValidDayString(attendanceDate)) throw ApiError.badRequest('attendanceDate must be YYYY-MM-DD');

  const fail = (code, message, extra = {}) => ({
    attendanceDate,
    requestable: false,
    type: null,
    benefit: OT_BENEFIT.NONE,
    calendarPrimary: null,
    workedMinutes: 0,
    scheduledMinutes: null,
    scheduleResolved: false,
    recordedMinutes: 0,
    eligibleMinutes: 0,
    compOffDaysAtEligible: 0,
    blockers: [{ code, message }],
    existingRequest: null,
    payrollLocked: false,
    effectiveIn: null,
    effectiveOut: null,
    shiftName: null,
    scheduleName: null,
    ...extra,
  });

  const { policy: current, configured } = await readPolicy({
    companyId,
    policy,
    policyReader,
    AttendancePolicyModel,
  });
  if (!configured || !current) {
    return fail('NO_POLICY', 'No attendance policy is configured for this company');
  }
  const overtime = current.overtime || {};
  const timezone = current.timezone || 'Asia/Kolkata';
  const activeEngine = engine || defaultEngine();

  const control = await AttendanceModel.findOne({ companyId, user: uid, date: attendanceDate }).lean();
  const existing =
    (await RequestModel.findOne({
      companyId,
      user: uid,
      attendanceDate,
      status: { $in: [OVERTIME_STATUS.PENDING, OVERTIME_STATUS.APPROVED] },
    }).lean()) || null;
  const existingBlocked = existing && String(existing._id || existing.id) !== String(ignoreRequestId || '');

  if (!control) {
    return fail('NO_CONTROL', 'No attendance was recorded for this day yet', {
      existingRequest: existingBlocked ? serializeOvertimeRequest(existing) : null,
    });
  }

  const workedMinutes = Math.max(0, Math.trunc(Number(control.workMinutes) || 0));
  const shared = {
    controlId: idOf(control._id || control.id) || null,
    workedMinutes,
    existingRequest: existingBlocked ? serializeOvertimeRequest(existing) : null,
    effectiveIn: control.regularization?.correctedIn ?? control.punchIn ?? null,
    effectiveOut: control.regularization?.correctedOut ?? control.punchOut ?? null,
  };
  if (workedMinutes <= 0) {
    return fail('NO_WORK', 'No worked time was recorded for this day', shared);
  }

  // Stored schedule wins (later Shift edits cannot rewrite the
  // day); otherwise dated re-resolution for the business date.
  let scheduledMinutes = control.scheduleSnapshot?.scheduledMinutes ?? null;
  let shiftName = control.scheduleSnapshot?.shiftName ?? null;
  let scheduleName = control.scheduleSnapshot?.scheduleName ?? null;
  let scheduledStartAt = control.scheduleSnapshot?.scheduledStartAt ?? null;
  let scheduledEndAt = control.scheduleSnapshot?.scheduledEndAt ?? null;
  let scheduleCtx = null;
  if (scheduledMinutes === null || scheduledMinutes === undefined) {
    try {
      scheduleCtx = await resolveSchedule({ companyId, user: user || { _id: uid }, attendanceDate, timezone });
    } catch {
      scheduleCtx = null;
    }
    if (scheduleCtx?.status === 'RESOLVED') {
      scheduledMinutes = scheduleCtx.scheduledMinutes ?? null;
      shiftName = scheduleCtx.shiftName ?? shiftName;
      scheduleName = scheduleCtx.scheduleName ?? scheduleName;
      scheduledStartAt = scheduleCtx.scheduledStartAt ?? null;
      scheduledEndAt = scheduleCtx.scheduledEndAt ?? null;
    }
  }

  const resolved = await resolveReconciliationDay({
    companyId,
    userId: uid,
    user: user || { _id: uid },
    attendanceDate,
    control,
    schedule: scheduleCtx?.status === 'RESOLVED' ? scheduleCtx : null,
    LeaveModel,
    engine: activeEngine,
  });
  const calendarPrimary = resolved?.calendar?.primary || DAY_TYPE.WORK_DAY;
  const withFacts = {
    ...shared,
    calendarPrimary,
    calendar: resolved?.calendar || null,
    scheduledMinutes,
    shiftName,
    scheduleName,
    scheduledStartAt,
    scheduledEndAt,
    nonWorkingDayWorked: resolved?.nonWorkingDayWorked === true,
  };

  if (resolved?.outcome === 'UNRESOLVED') {
    return fail('UNRESOLVED_DAY', 'This day has an unresolved missing punch — regularize it first', withFacts);
  }
  const conflicts = blockingConflicts(resolved?.conflicts);
  if (conflicts.length) {
    return fail(
      'CONFLICT',
      'This day has an unresolved leave/attendance conflict — resolve it first',
      { ...withFacts, conflicts },
    );
  }

  const recorded = recordedExtraMinutes({ calendarPrimary, workedMinutes, scheduledMinutes });
  if (!recorded.scheduleResolved) {
    return fail('SCHEDULE_UNRESOLVED', 'No schedule could be resolved for this day', {
      ...withFacts,
      recordedMinutes: 0,
    });
  }

  const benefit = resolveBenefit({ calendarPrimary, overtime });
  if (benefit === OT_BENEFIT.NONE) {
    return fail(
      !overtime?.trackingEnabled
        ? 'TRACKING_DISABLED'
        : 'BENEFIT_NONE',
      !overtime?.trackingEnabled
        ? 'Overtime tracking is not enabled in the attendance policy'
        : 'Company policy does not grant overtime or comp-off for this day',
      { ...withFacts, benefit, scheduleResolved: true, recordedMinutes: recorded.extraMinutes },
    );
  }

  const { eligibleMinutes } = deriveEligibleMinutes({
    recordedExtra: recorded.extraMinutes,
    calendarPrimary,
    overtime,
  });
  const minimum = Math.max(0, Math.trunc(Number(overtime.minimumExtraMinutes) || 0));
  if (eligibleMinutes <= 0) {
    return fail('BELOW_THRESHOLD', `Extra time is below the ${minimum}-minute policy minimum`, {
      ...withFacts,
      benefit,
      scheduleResolved: true,
      recordedMinutes: recorded.extraMinutes,
    });
  }

  const type = benefit === OT_BENEFIT.COMP_OFF ? OVERTIME_TYPE.COMP_OFF : OVERTIME_TYPE.OVERTIME;
  const compOffDaysAtEligible = compOffDaysFor({ approvedMinutes: eligibleMinutes, overtime });
  if (type === OVERTIME_TYPE.COMP_OFF && compOffDaysAtEligible < 1) {
    return fail(
      'COMP_OFF_BELOW_ONE_DAY',
      `Needs at least ${compOffMinutesPerDay(overtime)} eligible minutes to earn 1 comp-off day`,
      {
        ...withFacts,
        benefit,
        scheduleResolved: true,
        recordedMinutes: recorded.extraMinutes,
        eligibleMinutes,
        type,
        compOffDaysAtEligible,
      },
    );
  }

  const { locked, refusal } = await periodLockRefusal({ PayrollPeriodModel, companyId, attendanceDate });
  if (type === OVERTIME_TYPE.OVERTIME && locked) {
    return fail('PAYROLL_LOCKED', refusal, {
      ...withFacts,
      benefit,
      scheduleResolved: true,
      recordedMinutes: recorded.extraMinutes,
      eligibleMinutes,
      type,
      compOffDaysAtEligible,
      payrollLocked: true,
    });
  }

  if (existingBlocked) {
    return fail('ALREADY_REQUESTED', `A ${existing.status.toLowerCase()} request already exists for this day`, {
      ...withFacts,
      benefit,
      scheduleResolved: true,
      recordedMinutes: recorded.extraMinutes,
      eligibleMinutes,
      type,
      compOffDaysAtEligible,
      payrollLocked: locked,
    });
  }

  return {
    ...withFacts,
    requestable: true,
    type,
    benefit,
    scheduleResolved: true,
    recordedMinutes: recorded.extraMinutes,
    eligibleMinutes,
    compOffDaysAtEligible,
    blockers: [],
    payrollLocked: locked,
    policyId: current._id || current.id || null,
    policyVersion: current.version ?? null,
    minimumExtraMinutes: minimum,
    compOffMinutesPerDay: compOffMinutesPerDay(overtime),
  };
};

export const listMyEligibility = async ({
  companyId,
  user,
  from,
  to,
  policy = null,
  policyReader = null,
  AttendancePolicyModel,
  AttendanceModel = Attendance,
  RequestModel = AttendanceOvertimeRequest,
  LeaveModel = Leave,
  PayrollPeriodModel = PayrollPeriod,
  resolveSchedule = defaultResolveSchedule,
  engine = null,
}) => {
  const range = validateDayRange({ from, to });
  if (range.error) throw ApiError.badRequest(range.error);
  const loaded = await readPolicy({ companyId, policy, policyReader, AttendancePolicyModel });
  const days = [];
  for (const day of eachDayInRange(range.from, range.to)) {
    days.push(
      await computeDayEligibility({
        companyId,
        user,
        attendanceDate: day,
        policy: loaded.policy,
        AttendanceModel,
        RequestModel,
        LeaveModel,
        PayrollPeriodModel,
        resolveSchedule,
        engine,
      }),
    );
  }
  return { from: range.from, to: range.to, days };
};

// ── Submit ───────────────────────────────────────────────

export const submitOvertimeRequest = async ({
  companyId,
  requester,
  type,
  attendanceDate,
  requestedMinutes,
  reason,
  policy = null,
  policyReader = null,
  AttendancePolicyModel,
  AttendanceModel = Attendance,
  RequestModel = AttendanceOvertimeRequest,
  LeaveModel = Leave,
  PayrollPeriodModel = PayrollPeriod,
  UserModel = User,
  resolveSchedule = defaultResolveSchedule,
  engine = null,
  notify = defaultNotify,
  audit = writeAudit,
}) => {
  const userId = requester?._id || requester?.id;
  if (!userId) throw ApiError.badRequest('Employee context is required');
  if (!Object.values(OVERTIME_TYPE).includes(type)) {
    throw ApiError.badRequest('type must be OVERTIME or COMP_OFF');
  }
  const reasonError = validateReason(reason);
  if (reasonError) throw ApiError.badRequest(reasonError);

  const candidate = await computeDayEligibility({
    companyId,
    user: requester,
    attendanceDate,
    policy,
    policyReader,
    AttendancePolicyModel,
    AttendanceModel,
    RequestModel,
    LeaveModel,
    PayrollPeriodModel,
    resolveSchedule,
    engine,
  });
  if (!candidate.requestable) {
    throw ApiError.conflict(candidate.blockers[0]?.message || 'This day is not eligible');
  }
  if (candidate.type !== type) {
    throw ApiError.badRequest(
      `Only ${candidate.type === OVERTIME_TYPE.COMP_OFF ? 'comp-off' : 'overtime'} requests are allowed for this day`,
    );
  }
  const { policy: current } = await readPolicy({ companyId, policy, policyReader, AttendancePolicyModel });
  const minutesError = validateRequestedMinutes({
    requestedMinutes,
    eligibleMinutes: candidate.eligibleMinutes,
    type,
    overtime: current?.overtime || {},
  });
  if (minutesError) throw ApiError.badRequest(minutesError);

  let created = null;
  try {
    created = await RequestModel.create({
      companyId,
      user: userId,
      // History anchor: the control whose facts produced this
      // eligibility (submit already proved it exists).
      ...(candidate.controlId ? { attendance: candidate.controlId } : {}),
      attendanceDate,
      type,
      status: OVERTIME_STATUS.PENDING,
      recordedMinutes: candidate.recordedMinutes,
      eligibleMinutes: candidate.eligibleMinutes,
      requestedMinutes: Number(requestedMinutes),
      calendar: {
        primary: candidate.calendarPrimary,
        alsoWeeklyOff: candidate.calendar?.alsoWeeklyOff === true,
        holidayName: candidate.calendar?.holiday?.name || null,
        holidayType: candidate.calendar?.holiday?.type || null,
        nonWorkingDayWorked: candidate.nonWorkingDayWorked === true,
      },
      schedule: {
        scheduledStartAt: candidate.scheduledStartAt || null,
        scheduledEndAt: candidate.scheduledEndAt || null,
        scheduledMinutes: candidate.scheduledMinutes ?? null,
        shiftName: candidate.shiftName || null,
        scheduleName: candidate.scheduleName || null,
      },
      policyId: candidate.policyId || null,
      policyVersion: candidate.policyVersion ?? null,
      minimumExtraMinutes: candidate.minimumExtraMinutes ?? null,
      compOffMinutesPerDay: candidate.compOffMinutesPerDay ?? null,
      reason: String(reason).trim(),
    });
  } catch (error) {
    // The partial unique index is the double-submit guard: the
    // loser of a concurrent race lands here, never in Redis.
    if (error?.code === 11000) {
      throw ApiError.conflict('A live request already exists for this day');
    }
    throw error;
  }

  await audit({
    action: 'ATTENDANCE_OVERTIME_REQUESTED',
    resource: 'AttendanceOvertimeRequest',
    resourceId: String(created._id || created.id),
    companyId,
    actorId: String(userId),
    targetUserId: String(userId),
    newValue: {
      type,
      attendanceDate,
      requestedMinutes: Number(requestedMinutes),
      eligibleMinutes: candidate.eligibleMinutes,
      calendarPrimary: candidate.calendarPrimary,
    },
  });

  const label = TYPE_LABEL[type];
  await notifyApprovers({
    UserModel,
    notify,
    companyId,
    requester,
    payload: {
      title: `New ${label.toLowerCase()} request`,
      message: `${requester?.name || 'An employee'} requested ${label.toLowerCase()} for ${attendanceDate} — ${requestedMinutes} minute(s) of ${candidate.eligibleMinutes} eligible`,
      link: '/app/attendance/overtime',
      category: 'ATTENDANCE',
    },
  });

  const plain = typeof created.toObject === 'function' ? created.toObject() : created;
  return serializeOvertimeRequest(plain, { viewerId: userId });
};

// ── Reads ────────────────────────────────────────────────

export const listMyOvertimeRequests = async ({ companyId, userId, RequestModel = AttendanceOvertimeRequest }) => {
  const rows = await RequestModel.find({ companyId, user: userId }).sort({ createdAt: -1 }).lean();
  return (rows || []).map((row) => serializeOvertimeRequest(row, { viewerId: userId }));
};

export const listPendingOvertimeRequests = async ({
  companyId,
  viewer,
  RequestModel = AttendanceOvertimeRequest,
  resolveScopeIds = defaultResolveScopeIds,
}) => {
  const scopeIds = await resolveScopeIds({ companyId, user: viewer });
  const rows = await RequestModel.find({
    companyId,
    status: OVERTIME_STATUS.PENDING,
    user: { $in: scopeIds },
  })
    .populate({ path: 'user', select: 'name email designation' })
    .sort({ createdAt: 1 })
    .lean();
  return (rows || []).map((row) =>
    serializeOvertimeRequest(row, { viewerId: viewer?._id, isReviewer: true }),
  );
};

export const getOvertimeRequest = async ({
  companyId,
  viewer,
  requestId,
  asReviewer = false,
  RequestModel = AttendanceOvertimeRequest,
  resolveScopeIds = defaultResolveScopeIds,
}) => {
  const row = await RequestModel.findOne({ _id: requestId, companyId })
    .populate({ path: 'user', select: 'name email designation' })
    .populate({ path: 'reviewedBy', select: 'name' })
    .lean();
  if (!row) throw ApiError.notFound('Overtime request not found');
  const viewerId = viewer?._id || viewer?.id;
  const isOwner = String(row.user?._id || row.user) === String(viewerId);
  if (!isOwner) {
    if (!asReviewer) throw ApiError.notFound('Overtime request not found');
    const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
    if (!scopeIds.includes(String(row.user?._id || row.user))) {
      throw ApiError.forbidden('This employee is not in your team');
    }
  }
  return serializeOvertimeRequest(row, { viewerId, isReviewer: asReviewer });
};

// ── Cancel ───────────────────────────────────────────────

export const cancelOvertimeRequest = async ({
  companyId,
  viewer,
  requestId,
  asReviewer = false,
  RequestModel = AttendanceOvertimeRequest,
  UserModel = User,
  resolveScopeIds = defaultResolveScopeIds,
  notify = defaultNotify,
  audit = writeAudit,
  now = null,
}) => {
  const actorId = viewer?._id || viewer?.id;
  const row = await RequestModel.findOne({ _id: requestId, companyId }).lean();
  if (!row) throw ApiError.notFound('Overtime request not found');
  const isOwner = String(row.user?._id || row.user) === String(actorId);
  if (!isOwner) {
    if (!asReviewer) throw ApiError.forbidden('You can only cancel your own requests');
    const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
    if (!scopeIds.includes(String(row.user?._id || row.user))) {
      throw ApiError.forbidden('This employee is not in your team');
    }
  }
  const blocked = transitionError(row.status, 'CANCEL');
  if (blocked) throw ApiError.conflict(blocked);
  const updated = await RequestModel.findOneAndUpdate(
    { _id: row._id, companyId, status: OVERTIME_STATUS.PENDING },
    { $set: { status: OVERTIME_STATUS.CANCELLED, reviewedBy: actorId, reviewedAt: now || new Date() } },
    { new: true },
  ).lean();
  if (!updated) throw ApiError.conflict('This request is no longer pending');
  await audit({
    action: 'ATTENDANCE_OVERTIME_CANCELLED',
    resource: 'AttendanceOvertimeRequest',
    resourceId: String(row._id),
    companyId,
    actorId: String(actorId),
    targetUserId: String(row.user?._id || row.user),
    newValue: { type: row.type, attendanceDate: row.attendanceDate },
  });
  if (isOwner) {
    await notifyApprovers({
      UserModel,
      notify,
      companyId,
      requester: viewer,
      payload: {
        title: 'Overtime request withdrawn',
        message: `${viewer?.name || 'An employee'} withdrew their ${TYPE_LABEL[row.type]?.toLowerCase() || 'overtime'} request for ${row.attendanceDate}`,
        link: '/app/attendance/overtime',
        category: 'ATTENDANCE',
      },
    });
  } else {
    await safeNotify(notify, row.user?._id || row.user, {
      title: 'Overtime request cancelled',
      message: `Your ${TYPE_LABEL[row.type]?.toLowerCase() || 'overtime'} request for ${row.attendanceDate} was cancelled by ${viewer?.name || 'a reviewer'}`,
      link: '/app/attendance/overtime',
      category: 'ATTENDANCE',
    });
  }
  return serializeOvertimeRequest(updated, { viewerId: actorId, isReviewer: asReviewer });
};

// ── Decide ───────────────────────────────────────────────
// Approval revalidates authoritative eligibility (attendance may
// have changed since submit via a 31.5 correction). Stale numbers
// are refused — never silently adjusted up or down.

const reviewGuards = async ({ row, viewer, companyId, action, resolveScopeIds }) => {
  const reviewerId = viewer?._id || viewer?.id;
  if (String(row.user?._id || row.user) === String(reviewerId)) {
    throw ApiError.forbidden('You cannot review your own request');
  }
  const blocked = transitionError(row.status, action);
  if (blocked) {
    throw row.status === OVERTIME_STATUS.PENDING
      ? ApiError.forbidden(blocked)
      : ApiError.conflict(blocked);
  }
  const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
  if (!scopeIds.includes(String(row.user?._id || row.user))) {
    throw ApiError.forbidden('This employee is not in your team');
  }
  return reviewerId;
};

// Idempotent payroll-seam republish: the day's approved OT minutes
// are recomputed from Mongo (sum of APPROVED OVERTIME rows), so a
// retried approval converges to the same record value. COMP_OFF
// approvals never touch this field (time → leave, not money).
export const republishApprovedOtMinutes = async ({
  companyId,
  userId,
  attendanceDate,
  AttendanceModel = Attendance,
  RequestModel = AttendanceOvertimeRequest,
}) => {
  const approved = await RequestModel.find({
    companyId,
    user: userId,
    attendanceDate,
    type: OVERTIME_TYPE.OVERTIME,
    status: OVERTIME_STATUS.APPROVED,
  })
    .select('approvedMinutes')
    .lean();
  const total = (approved || []).reduce((sum, row) => sum + (Number(row.approvedMinutes) || 0), 0);
  await AttendanceModel.findOneAndUpdate(
    { companyId, user: userId, date: attendanceDate },
    { $set: { overtimeMinutes: total } },
  );
  return total;
};

export const approveOvertimeRequest = async ({
  companyId,
  viewer,
  requestId,
  approvedMinutes,
  reviewReason = null,
  policy = null,
  policyReader = null,
  AttendancePolicyModel,
  AttendanceModel = Attendance,
  RequestModel = AttendanceOvertimeRequest,
  LeaveModel = Leave,
  PayrollPeriodModel = PayrollPeriod,
  resolveSchedule = defaultResolveSchedule,
  engine = null,
  resolveScopeIds = defaultResolveScopeIds,
  notify = defaultNotify,
  audit = writeAudit,
  now = null,
}) => {
  const row = await RequestModel.findOne({ _id: requestId, companyId }).lean();
  if (!row) throw ApiError.notFound('Overtime request not found');
  const reviewerId = await reviewGuards({ row, viewer, companyId, action: 'APPROVE', resolveScopeIds });

  const candidate = await computeDayEligibility({
    companyId,
    user: { _id: row.user },
    attendanceDate: row.attendanceDate,
    policy,
    policyReader,
    AttendancePolicyModel,
    AttendanceModel,
    RequestModel,
    LeaveModel,
    PayrollPeriodModel,
    resolveSchedule,
    engine,
    ignoreRequestId: row._id,
  });
  if (!candidate.requestable) {
    throw ApiError.conflict(
      `${candidate.blockers[0]?.message || 'This day is no longer eligible'} — ask the employee to resubmit`,
    );
  }
  if (candidate.type !== row.type) {
    throw ApiError.conflict(
      `Policy now allows only ${candidate.type === OVERTIME_TYPE.COMP_OFF ? 'comp-off' : 'overtime'} for this day — ask the employee to resubmit`,
    );
  }
  const { policy: current } = await readPolicy({ companyId, policy, policyReader, AttendancePolicyModel });
  const minutesError = validateApprovedMinutes({
    approvedMinutes,
    requestedMinutes: row.requestedMinutes,
    eligibleMinutes: candidate.eligibleMinutes,
    type: row.type,
    overtime: current?.overtime || {},
  });
  if (minutesError) throw ApiError.conflict(minutesError);
  const approved = Number(approvedMinutes);
  const compOffDays =
    row.type === OVERTIME_TYPE.COMP_OFF
      ? compOffDaysFor({ approvedMinutes: approved, overtime: current?.overtime || {} })
      : null;

  const updated = await RequestModel.findOneAndUpdate(
    { _id: row._id, companyId, status: OVERTIME_STATUS.PENDING },
    {
      $set: {
        status: OVERTIME_STATUS.APPROVED,
        approvedMinutes: approved,
        compOffDays,
        eligibleMinutes: candidate.eligibleMinutes,
        recordedMinutes: candidate.recordedMinutes,
        reviewReason: typeof reviewReason === 'string' ? reviewReason.trim().slice(0, 300) : '',
        reviewedBy: reviewerId,
        reviewedAt: now || new Date(),
      },
    },
    { new: true },
  ).lean();
  // Lost a concurrent decision race: the row is decided, and the
  // winner's post-commit effects already ran exactly once.
  if (!updated) throw ApiError.conflict('This request was already decided by another reviewer');

  if (row.type === OVERTIME_TYPE.OVERTIME) {
    await republishApprovedOtMinutes({
      companyId,
      userId: row.user,
      attendanceDate: row.attendanceDate,
      AttendanceModel,
      RequestModel,
    });
  }

  const ownerId = row.user?._id || row.user;
  await audit({
    action: 'ATTENDANCE_OVERTIME_APPROVED',
    resource: 'AttendanceOvertimeRequest',
    resourceId: String(row._id),
    companyId,
    actorId: String(reviewerId),
    targetUserId: String(ownerId),
    newValue: {
      type: row.type,
      attendanceDate: row.attendanceDate,
      requestedMinutes: row.requestedMinutes,
      approvedMinutes: approved,
      ...(compOffDays ? { compOffDays } : {}),
    },
  });
  if (row.type === OVERTIME_TYPE.COMP_OFF) {
    await audit({
      action: 'COMP_OFF_ENTITLEMENT_CREATED',
      resource: 'AttendanceOvertimeRequest',
      resourceId: String(row._id),
      companyId,
      actorId: String(reviewerId),
      targetUserId: String(ownerId),
      newValue: { attendanceDate: row.attendanceDate, compOffDays, sourceMinutes: approved },
    });
  }

  await safeNotify(notify, ownerId, {
    title: row.type === OVERTIME_TYPE.COMP_OFF ? 'Comp-off credited' : 'Overtime approved',
    message:
      row.type === OVERTIME_TYPE.COMP_OFF
        ? `Your comp-off for ${row.attendanceDate} was approved — ${compOffDays} day(s) credited to your leave balance`
        : `Your overtime for ${row.attendanceDate} was approved — ${approved} minute(s)`,
    link: row.type === OVERTIME_TYPE.COMP_OFF ? '/app/leaves' : '/app/attendance/overtime',
    category: 'ATTENDANCE',
  });

  const fresh = await RequestModel.findOne({ _id: row._id, companyId })
    .populate({ path: 'user', select: 'name email designation' })
    .populate({ path: 'reviewedBy', select: 'name' })
    .lean();
  // 31.15 — approval changes attendance facts: retire cached analytics.
  bumpAttendanceAnalyticsGeneration(companyId).catch(() => {});
  return serializeOvertimeRequest(fresh || updated, { viewerId: reviewerId, isReviewer: true });
};

export const rejectOvertimeRequest = async ({
  companyId,
  viewer,
  requestId,
  reviewReason = null,
  RequestModel = AttendanceOvertimeRequest,
  resolveScopeIds = defaultResolveScopeIds,
  notify = defaultNotify,
  audit = writeAudit,
  now = null,
}) => {
  const row = await RequestModel.findOne({ _id: requestId, companyId }).lean();
  if (!row) throw ApiError.notFound('Overtime request not found');
  const reviewerId = await reviewGuards({ row, viewer, companyId, action: 'REJECT', resolveScopeIds });
  const updated = await RequestModel.findOneAndUpdate(
    { _id: row._id, companyId, status: OVERTIME_STATUS.PENDING },
    {
      $set: {
        status: OVERTIME_STATUS.REJECTED,
        reviewReason: typeof reviewReason === 'string' ? reviewReason.trim().slice(0, 300) : '',
        reviewedBy: reviewerId,
        reviewedAt: now || new Date(),
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw ApiError.conflict('This request was already decided by another reviewer');
  const ownerId = row.user?._id || row.user;
  await audit({
    action: 'ATTENDANCE_OVERTIME_REJECTED',
    resource: 'AttendanceOvertimeRequest',
    resourceId: String(row._id),
    companyId,
    actorId: String(ownerId),
    newValue: { type: row.type, attendanceDate: row.attendanceDate },
  });
  await safeNotify(notify, ownerId, {
    title: 'Overtime request rejected',
    message: `Your ${TYPE_LABEL[row.type]?.toLowerCase() || 'overtime'} request for ${row.attendanceDate} was rejected by ${viewer?.name || 'a reviewer'}`,
    link: '/app/attendance/overtime',
    category: 'ATTENDANCE',
  });
  // 31.15 — rejection changes the OT funnel: retire cached analytics.
  bumpAttendanceAnalyticsGeneration(companyId).catch(() => {});
  return serializeOvertimeRequest(updated, { viewerId: reviewerId, isReviewer: true });
};

// ── Comp-off entitlement ─────────────────────────────────
// The APPROVED COMP_OFF rows ARE the entitlement ledger (no second
// model). All-time scoped: earned days never expire (§21 — no
// expiry exists in Leave) and year-scoped spending would double-
// count across a year boundary.

export const earnedCompOffDays = async ({ companyId, userId, RequestModel = AttendanceOvertimeRequest }) => {
  const rows = await RequestModel.find({
    companyId,
    user: userId,
    type: OVERTIME_TYPE.COMP_OFF,
    status: OVERTIME_STATUS.APPROVED,
  })
    .select('compOffDays')
    .lean();
  return (rows || []).reduce((sum, row) => sum + (Number(row.compOffDays) || 0), 0);
};
