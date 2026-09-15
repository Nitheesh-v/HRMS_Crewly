// ─────────────────────────────────────────────────────────────
// Phase 31.11 — monthly attendance finalization & payroll sync.
//
// The controlled boundary: LIVE ATTENDANCE → FINALIZED ATTENDANCE
// SNAPSHOT → EMPLOYEE MONTHLY INPUT.AUTO → (29.6 engine, untouched).
// Attendance owns time/day facts; payroll owns money — this module
// never computes salary, rates, or amounts.
//
// Design laws (see the 31.11 build plan):
// - finalize freezes (validate + snapshot, NO payroll writes);
//   send-to-payroll syncs snapshots into 29.5 auto (HR entries
//   preserved). PayrollPeriod is never transitioned here.
// - One in-memory derivation feeds validation AND persistence —
//   no validate/persist window. Readiness is derived, never sent
//   by the client. No override flags exist anywhere here.
// - Concurrency via atomic Mongo claims + unique indexes (no
//   transactions, no Redis lock, no job queues — bounded sync).
// - Snapshots are $setOnInsert upserts: retries resume, versions
//   never mutate, exactly one current per employee.
// ─────────────────────────────────────────────────────────────
import Attendance from '../../models/Attendance.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import AttendancePeriod from '../../models/AttendancePeriod.js';
import AttendancePayrollSnapshot from '../../models/AttendancePayrollSnapshot.js';
import AttendanceRegularization from '../../models/AttendanceRegularization.js';
import AttendanceOvertimeRequest from '../../models/AttendanceOvertimeRequest.js';
import Company from '../../models/Company.js';
import Department from '../../models/Department.js';
import EmployeeMonthlyInput from '../../models/EmployeeMonthlyInput.js';
import Holiday from '../../models/Holiday.js';
import Leave from '../../models/Leave.js';
import PayrollPeriod from '../../models/PayrollPeriod.js';
import PayrollPayment from '../../models/PayrollPayment.js';
import PayrollPaymentBatch from '../../models/PayrollPaymentBatch.js';
import PayrollReview from '../../models/PayrollReview.js';
import PayrollRun from '../../models/PayrollRun.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import Payslip from '../../models/Payslip.js';
import Resignation from '../../models/Resignation.js';
import Shift from '../../models/Shift.js';
import ShiftAssignment from '../../models/ShiftAssignment.js';
import User from '../../models/User.js';
import WorkSchedule from '../../models/WorkSchedule.js';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import notifySmart from '../../utils/notifyPref.js';
import { getSubtreeIds } from '../../utils/orgHelpers.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import { dayKeyInZone } from './attendancePolicyRules.js';
import { deriveMonths, resolveTimezone } from './attendanceTimesheetService.js';
import { enumerateMonthDates, isValidMonth } from './attendanceTimesheetRules.js';
import monthlyInputService, {
  CACHE_NAMESPACE as PAYROLL_INPUT_CACHE_NAMESPACE,
  CACHE_VERSION as PAYROLL_INPUT_CACHE_VERSION,
} from '../payroll/monthlyInputService.js';
import { resolveNotificationAudience } from '../payroll/payrollReviewService.js';
import {
  buildTenantCacheKey,
  deleteCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';
import {
  FINALIZATION_ISSUE,
  FINALIZATION_STATUS,
  ISSUE_SEVERITY,
  ISSUE_WORKFLOW,
  aggregateMonth,
  buildAutoFromSnapshot,
  canTransition,
  deriveEmployeeSnapshot,
  fingerprintOf,
  isBlocker,
  nextVersion,
  payrollGates,
  readinessOf,
  transitionError,
  validateDay,
} from './attendanceFinalizationRules.js';

const MAX_ISSUES = 200;
// A FINALIZING claim older than this is a crashed run — resumable.
const CLAIM_STALE_MS = 30 * 60 * 1000;

const NOTIFICATION_AUDIENCE = {
  ATTENDANCE_FINALIZED: ['PAYROLL_INPUT_MANAGE'],
  ATTENDANCE_SENT_TO_PAYROLL: ['PAYROLL_INPUT_MANAGE'],
  ATTENDANCE_REOPENED: ['PAYROLL_INPUT_MANAGE', 'ATTENDANCE_FINALIZATION_READ'],
};

const NOTIFICATION_COPY = {
  ATTENDANCE_FINALIZED: (month, version) =>
    `Attendance for ${month} finalized (v${version}) — ready to send to payroll`,
  ATTENDANCE_SENT_TO_PAYROLL: (month, version) =>
    `Finalized attendance v${version} for ${month} synced to payroll inputs`,
  ATTENDANCE_REOPENED: (month, version) =>
    `Attendance finalization v${version} for ${month} reopened for corrections`,
};

const defaultDeps = () => ({
  UserModel: User,
  ResignationModel: Resignation,
  AttendanceModel: Attendance,
  AttendanceEventModel: AttendanceEvent,
  LeaveModel: Leave,
  RegularizationModel: AttendanceRegularization,
  OvertimeRequestModel: AttendanceOvertimeRequest,
  DepartmentModel: Department,
  CompanyModel: Company,
  ShiftAssignmentModel: ShiftAssignment,
  ShiftModel: Shift,
  WorkScheduleModel: WorkSchedule,
  HolidayModel: Holiday,
  AttendancePeriodModel: AttendancePeriod,
  SnapshotModel: AttendancePayrollSnapshot,
  PayrollPeriodModel: PayrollPeriod,
  PayrollRunModel: PayrollRun,
  PayrollReviewModel: PayrollReview,
  PaymentBatchModel: PayrollPaymentBatch,
  PayrollPaymentModel: PayrollPayment,
  PayslipModel: Payslip,
  EmployeeMonthlyInputModel: EmployeeMonthlyInput,
  PayrollSetupModel: PayrollSetup,
  policyReader: (args) => getCurrentPolicy(args),
  subtreeReader: (companyId, managerId) => getSubtreeIds(companyId, managerId),
  periodEnsurer: (args) => monthlyInputService.ensurePeriod(args),
  audit: recordAudit,
  audience: resolveNotificationAudience,
  notify: ({ userId, title, message, link }) =>
    notifySmart(userId, { title, message, link, category: 'PAYROLL' }),
  cache: {
    buildKey: buildTenantCacheKey,
    del: async (key) => {
      const removed = await deleteCache(key);
      if (removed) noteCacheInvalidation();
      return removed;
    },
  },
  now: () => new Date(),
});

const strId = (value) => {
  if (value === null || value === undefined) return '';
  return String(value?._id || value);
};

const dayKeyOf = (value, timezone) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  try {
    return dayKeyInZone(value instanceof Date ? value : new Date(value), timezone);
  } catch {
    return '';
  }
};

const requireContext = ({ companyId, actor }) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const actorId = strId(actor?._id || actor?.id);
  if (!actorId) throw ApiError.badRequest('Actor context is required');
  return actorId;
};

const requireMonth = (month) => {
  const value = typeof month === 'string' ? month.trim() : '';
  if (!isValidMonth(value)) throw ApiError.badRequest('month must be YYYY-MM');
  return value;
};

// ── Shared derivation ──────────────────────────────────────────
// ONE company-wide derivation feeds validation, preview, and
// finalization: policy → timezone → population (+ employment
// windows) → 31.10 months → scoped snapshot bodies + issues.
// Scope = applicable days STRICTLY before company-today.

const deriveCompanyFacts = async ({ companyId, month, full }) => {
  const { policy } = await full.policyReader({ companyId });
  const timezone = await resolveTimezone({ companyId, policy, CompanyModel: full.CompanyModel });
  const today = dayKeyInZone(full.now(), timezone);
  const dates = enumerateMonthDates(month);
  const elapsed = dates.filter((date) => date < today);

  // Population: ACTIVE company users (29.5/29.6 parity — payroll
  // locks ERROR on inactive rows, and FNF owns exit settlement).
  const users = await full.UserModel.find({ companyId, status: 'ACTIVE' })
    .select('_id name employeeCode designation department dateOfJoining')
    .sort({ name: 1, _id: 1 })
    .lean();
  const userIds = (users || []).map((person) => person._id);

  const [resignations, shiftSetup, scheduleSetup] = await Promise.all([
    userIds.length
      ? full.ResignationModel.find({ companyId, user: { $in: userIds }, status: 'APPROVED' })
        .select('user lastWorkingDate')
        .lean()
      : [],
    full.ShiftModel.exists({ companyId }),
    full.WorkScheduleModel.exists({ companyId }),
  ]);
  const hasScheduleSetup = Boolean(shiftSetup || scheduleSetup);

  const lwdByUser = new Map();
  for (const row of resignations || []) {
    const key = dayKeyOf(row?.lastWorkingDate, timezone);
    if (!key) continue;
    const uid = strId(row.user);
    if (!lwdByUser.get(uid) || lwdByUser.get(uid) < key) lwdByUser.set(uid, key);
  }

  const months = userIds.length
    ? await deriveMonths({
      companyId, users, dates, today, timezone, policy, full,
    })
    : new Map();

  const employees = [];
  const issues = [];
  for (const person of users || []) {
    const uid = strId(person._id);
    const dojKey = dayKeyOf(person.dateOfJoining, timezone);
    const lwdKey = lwdByUser.get(uid) || '';
    const entry = months.get(uid);
    const days = entry?.days || [];
    const scoped = [];
    let preJoiningDays = 0;
    let postExitDays = 0;
    for (const day of days) {
      if (day.date >= today) continue;
      if (dojKey && day.date < dojKey) {
        preJoiningDays += 1;
        continue;
      }
      if (lwdKey && day.date > lwdKey) {
        postExitDays += 1;
        continue;
      }
      scoped.push(day);
    }
    const body = deriveEmployeeSnapshot({ days: scoped, hasScheduleSetup });
    body.preJoiningDays = preJoiningDays;
    body.postExitDays = postExitDays;
    employees.push({
      employeeId: uid,
      employeeName: person.name || '',
      employeeCode: person.employeeCode || '',
      body,
    });
    for (const day of scoped) {
      for (const issue of validateDay({ day, applicable: true, hasScheduleSetup })) {
        issues.push({
          employeeId: uid,
          employeeName: person.name || '',
          employeeCode: person.employeeCode || '',
          date: day.date,
          code: issue.code,
          severity: issue.severity,
          workflow: ISSUE_WORKFLOW[issue.code] || 'attendance',
        });
      }
    }
  }

  const readiness = readinessOf(issues);
  const fingerprint = fingerprintOf(employees.map(({ employeeId, body }) => ({ employeeId, body })));
  return {
    policy, timezone, today, dates, elapsed,
    hasScheduleSetup, employees, issues, readiness, fingerprint,
  };
};

// ── Payroll state (gates) ──────────────────────────────────────

const loadPayrollState = async ({ companyId, month, full }) => {
  const [period, run, review, batches, paid, payslip] = await Promise.all([
    full.PayrollPeriodModel.findOne({ companyId, month }).select('status').lean(),
    full.PayrollRunModel.findOne({ companyId, month }).select('status').lean(),
    full.PayrollReviewModel.findOne({ companyId, month }).select('status').lean(),
    full.PaymentBatchModel.find({ companyId, month }).select('status').lean(),
    full.PayrollPaymentModel.exists({ companyId, month, status: 'PAID' }),
    full.PayslipModel.exists({
      companyId, month, status: { $in: ['GENERATED', 'EMAILED', 'DOWNLOADED'] },
    }),
  ]);
  // Any blocking batch blocks: the most advanced status decides.
  const batchRank = (status) =>
    ['PAID', 'PARTIALLY_PAID', 'PROCESSING', 'DOWNLOADED', 'FILE_GENERATED', 'READY'].indexOf(status);
  let paymentBatchStatus = null;
  for (const batch of batches || []) {
    if (batchRank(batch?.status) !== -1
      && (paymentBatchStatus === null || batchRank(batch.status) < batchRank(paymentBatchStatus))) {
      paymentBatchStatus = batch.status;
    }
  }
  return {
    periodStatus: period?.status || null,
    runStatus: run?.status || null,
    reviewStatus: review?.status || null,
    paymentBatchStatus,
    anyEmployeePaid: Boolean(paid),
    anyPayslipReleased: Boolean(payslip),
  };
};

// ── Audit / notify / cache helpers ─────────────────────────────

const writeAudit = async (full, payload) => {
  try {
    await full.audit(payload);
  } catch {
    // Auditing must never break a finalization write.
  }
};

const notifyAudience = async (full, { companyId, type, month, version, actorId }) => {
  const permissions = NOTIFICATION_AUDIENCE[type] || [];
  if (!permissions.length) return 0;
  let recipients = [];
  try {
    recipients = (await full.audience({ companyId, permissions })) || [];
  } catch {
    return 0;
  }
  const copy = (NOTIFICATION_COPY[type] || (() => ''))(month, version);
  let sent = 0;
  for (const userId of [...new Set(recipients.map(String))].filter((id) => id && id !== String(actorId || ''))) {
    try {
      await full.notify({
        userId,
        title: 'Attendance finalization',
        message: copy,
        link: '/app/attendance/team-timesheets',
      });
      sent += 1;
    } catch {
      // One bad recipient must not stop the others.
    }
  }
  return sent;
};

const invalidatePayrollInputs = async (full, companyId, month) => {
  try {
    const key = typeof full.cache?.buildKey === 'function'
      ? full.cache.buildKey({
        companyId,
        namespace: PAYROLL_INPUT_CACHE_NAMESPACE,
        version: PAYROLL_INPUT_CACHE_VERSION,
        segments: [String(month || 'current')],
      })
      : null;
    if (key && typeof full.cache?.del === 'function') await full.cache.del(key);
  } catch {
    // Redis failure must never corrupt state.
  }
};

// ── Status (GET — never mutates) ───────────────────────────────

const serializePeriod = ({ period, month, payroll }) => ({
  month,
  status: period?.status || FINALIZATION_STATUS.OPEN,
  currentVersion: period?.currentVersion || 0,
  lastSyncError: period?.lastSyncError || '',
  syncedEmployees: period?.syncedEmployees || 0,
  versions: (period?.versions || []).map((entry) => ({
    version: entry.version,
    finalizedAt: entry.finalizedAt || null,
    finalizedBy: strId(entry.finalizedBy) || null,
    fingerprint: entry.fingerprint || '',
    summary: entry.summary || null,
    sentToPayrollAt: entry.sentToPayrollAt || null,
    reopenedAt: entry.reopenedAt || null,
    reopenedBy: strId(entry.reopenedBy) || null,
    reopenReason: entry.reopenReason || '',
  })),
  payroll: payroll || null,
});

export const getFinalizationStatus = async ({ companyId, actor, month, deps = {} }) => {
  requireContext({ companyId, actor });
  const target = requireMonth(month);
  const full = { ...defaultDeps(), ...deps };
  const [period, payrollState] = await Promise.all([
    full.AttendancePeriodModel.findOne({ companyId, month: target }).lean(),
    loadPayrollState({ companyId, month: target, full }),
  ]);
  const gates = payrollGates(payrollState);
  return serializePeriod({
    period,
    month: target,
    payroll: {
      ...payrollState,
      gates: {
        reopen: gates.reopen,
        finalize: gates.finalize,
        send: gates.send,
      },
    },
  });
};

// ── Validation + preview (GET — never mutate) ──────────────────

export const validateFinalization = async ({ companyId, actor, month, deps = {} }) => {
  requireContext({ companyId, actor });
  const target = requireMonth(month);
  const full = { ...defaultDeps(), ...deps };
  const [facts, period, payrollState] = await Promise.all([
    deriveCompanyFacts({ companyId, month: target, full }),
    full.AttendancePeriodModel.findOne({ companyId, month: target }).lean(),
    loadPayrollState({ companyId, month: target, full }),
  ]);
  const gates = payrollGates(payrollState);
  return {
    month: target,
    status: period?.status || FINALIZATION_STATUS.OPEN,
    currentVersion: period?.currentVersion || 0,
    scopeThrough: facts.elapsed.length ? facts.elapsed[facts.elapsed.length - 1] : null,
    employees: facts.employees.length,
    hasScheduleSetup: facts.hasScheduleSetup,
    readiness: facts.readiness,
    blockers: facts.issues.filter(isBlocker).slice(0, MAX_ISSUES),
    warnings: facts.issues.filter((issue) => !isBlocker(issue)).slice(0, MAX_ISSUES),
    issueCounts: {
      blockers: facts.readiness.blockers,
      warnings: facts.readiness.warnings,
      truncated: facts.issues.length > MAX_ISSUES * 2,
    },
    gates: { reopen: gates.reopen, finalize: gates.finalize, send: gates.send },
  };
};

export const previewFinalization = async ({ companyId, actor, month, deps = {} }) => {
  requireContext({ companyId, actor });
  const target = requireMonth(month);
  const full = { ...defaultDeps(), ...deps };
  const [facts, period, payrollState] = await Promise.all([
    deriveCompanyFacts({ companyId, month: target, full }),
    full.AttendancePeriodModel.findOne({ companyId, month: target }).lean(),
    loadPayrollState({ companyId, month: target, full }),
  ]);
  const gates = payrollGates(payrollState);
  return {
    month: target,
    status: period?.status || FINALIZATION_STATUS.OPEN,
    currentVersion: period?.currentVersion || 0,
    scopeThrough: facts.elapsed.length ? facts.elapsed[facts.elapsed.length - 1] : null,
    employees: facts.employees.length,
    readiness: facts.readiness,
    summary: aggregateMonth(facts.employees.map((row) => row.body)),
    gates: { reopen: gates.reopen, finalize: gates.finalize, send: gates.send },
  };
};

// ── Finalize ───────────────────────────────────────────────────
// Atomic claim → derive → backend revalidate → persist immutable
// version → FINALIZED. No payroll writes. Retries resume the same
// version; blockers abort back to the pre-claim state.

const claimFinalization = async ({ companyId, target, actorId, full }) => {
  const existing = await full.AttendancePeriodModel.findOne({ companyId, month: target }).lean();
  if (existing?.status === FINALIZATION_STATUS.FINALIZED
    || existing?.status === FINALIZATION_STATUS.SENT_TO_PAYROLL) {
    return { already: true, period: existing };
  }
  if (existing?.status === FINALIZATION_STATUS.FINALIZING) {
    const claimedAt = existing.claimedAt ? new Date(existing.claimedAt).getTime() : 0;
    const stale = !claimedAt || full.now().getTime() - claimedAt > CLAIM_STALE_MS;
    if (!stale) {
      throw ApiError.conflict('Finalization is already in progress for this month. Retry shortly.');
    }
    const resumed = await full.AttendancePeriodModel.findOneAndUpdate(
      {
        companyId,
        month: target,
        status: FINALIZATION_STATUS.FINALIZING,
        claimedVersion: existing.claimedVersion,
        claimedAt: { $lt: new Date(full.now().getTime() - CLAIM_STALE_MS) },
      },
      { $set: { claimedAt: full.now(), claimedBy: actorId, updatedBy: actorId } },
      { new: true },
    ).lean();
    if (!resumed) {
      throw ApiError.conflict('Finalization is already in progress for this month. Retry shortly.');
    }
    return { period: resumed, version: resumed.claimedVersion, resumed: true };
  }
  const expectedVersion = Number(existing?.currentVersion) || 0;
  const from = existing ? [existing.status] : [FINALIZATION_STATUS.OPEN, FINALIZATION_STATUS.REOPENED];
  if (existing && ![FINALIZATION_STATUS.OPEN, FINALIZATION_STATUS.REOPENED].includes(existing.status)) {
    throw ApiError.conflict(transitionError(existing.status, FINALIZATION_STATUS.FINALIZING));
  }
  let claimed = null;
  try {
    claimed = await full.AttendancePeriodModel.findOneAndUpdate(
      { companyId, month: target, status: { $in: from }, currentVersion: expectedVersion },
      {
        $set: {
          status: FINALIZATION_STATUS.FINALIZING,
          claimedVersion: expectedVersion + 1,
          claimedAt: full.now(),
          claimedBy: actorId,
          updatedBy: actorId,
          lastSyncError: '',
        },
        $setOnInsert: { companyId, month: target, currentVersion: 0, versions: [] },
      },
      { new: true, upsert: true },
    ).lean();
  } catch (error) {
    if (error?.code === 11000) {
      throw ApiError.conflict('Finalization is already in progress for this month. Retry shortly.');
    }
    throw error;
  }
  if (!claimed) {
    throw ApiError.conflict('Finalization is already in progress for this month. Retry shortly.');
  }
  return { period: claimed, version: claimed.claimedVersion, resumed: false };
};

const abortClaim = async ({ companyId, target, version, full }) => {
  const fallback = version <= 1 ? FINALIZATION_STATUS.OPEN : FINALIZATION_STATUS.REOPENED;
  await full.AttendancePeriodModel.findOneAndUpdate(
    { companyId, month: target, status: FINALIZATION_STATUS.FINALIZING, claimedVersion: version },
    {
      $set: { status: fallback, updatedBy: null },
      $unset: { claimedVersion: '', claimedAt: '', claimedBy: '' },
    },
  ).lean();
};

export const finalizeMonth = async ({ companyId, actor, month, deps = {}, req = null }) => {
  const actorId = requireContext({ companyId, actor });
  const target = requireMonth(month);
  const full = { ...defaultDeps(), ...deps };

  const payrollState = await loadPayrollState({ companyId, month: target, full });
  const gates = payrollGates(payrollState);
  if (!gates.finalize.allowed) {
    throw ApiError.conflict(gates.finalize.reasons[0] || 'Finalization is blocked by payroll state.');
  }

  const claim = await claimFinalization({ companyId, target, actorId, full });
  if (claim.already) {
    return {
      month: target,
      version: claim.period.currentVersion,
      alreadyFinalized: true,
      status: claim.period.status,
      summary: (claim.period.versions || []).find((entry) => entry.version === claim.period.currentVersion)?.summary || null,
    };
  }
  const { version } = claim;

  const facts = await deriveCompanyFacts({ companyId, month: target, full });
  if (!facts.elapsed.length) {
    await abortClaim({ companyId, target, version, full });
    throw ApiError.badRequest('There are no elapsed days to finalize yet.');
  }
  if (!facts.readiness.ready) {
    await abortClaim({ companyId, target, version, full });
    const error = ApiError.conflict(
      `${facts.readiness.blockers} blocker(s) must be resolved before finalization.`,
    );
    error.details = {
      blockers: facts.issues.filter(isBlocker).slice(0, MAX_ISSUES),
      warnings: facts.readiness.warnings,
    };
    throw error;
  }

  const finalizedAt = full.now();
  const policy = facts.policy || {};
  // One current per employee: previous versions stop being current
  // first (never deleted); the upserts below then complete the set.
  // A crash between flip and completion leaves NO current for some
  // employees — resume detects it by count and completes it.
  const populationIds = facts.employees.map((row) => row.employeeId);
  if (populationIds.length) {
    await full.SnapshotModel.updateMany(
      { companyId, month: target, employeeId: { $in: populationIds } },
      { $set: { isCurrent: false } },
    );
  }
  for (const row of facts.employees) {
    await full.SnapshotModel.updateOne(
      { companyId, month: target, employeeId: row.employeeId, version },
      {
        $setOnInsert: {
          companyId,
          month: target,
          employeeId: row.employeeId,
          version,
          isCurrent: true,
          policyId: policy.id || null,
          policyVersion: Number(policy.version) || 0,
          policyConfigVersion: Number(policy.configVersion) || 0,
          ...row.body,
          fingerprint: facts.fingerprint,
          finalizedAt,
          finalizedBy: actorId,
        },
      },
      { upsert: true },
    );
  }

  const summary = aggregateMonth(facts.employees.map((row) => row.body));
  const completed = await full.AttendancePeriodModel.findOneAndUpdate(
    { companyId, month: target, status: FINALIZATION_STATUS.FINALIZING, claimedVersion: version },
    {
      $set: {
        status: FINALIZATION_STATUS.FINALIZED,
        currentVersion: version,
        updatedBy: actorId,
      },
      $unset: { claimedVersion: '', claimedAt: '', claimedBy: '' },
      $push: {
        versions: {
          version,
          finalizedAt,
          finalizedBy: actorId,
          fingerprint: facts.fingerprint,
          summary,
          sentToPayrollAt: null,
          sentBy: null,
          reopenedAt: null,
          reopenedBy: null,
          reopenReason: '',
        },
      },
    },
    { new: true },
  ).lean();
  if (!completed) {
    throw ApiError.conflict('Finalization claim was lost. Retry finalize to resume.');
  }

  await writeAudit(full, {
    req,
    action: 'ATTENDANCE_FINALIZED',
    companyId,
    resource: 'AttendancePeriod',
    resourceId: completed._id,
    previousValue: { status: version <= 1 ? 'OPEN' : 'REOPENED' },
    newValue: { month: target, version, employees: facts.employees.length, summary },
  });
  await notifyAudience(full, {
    companyId, type: 'ATTENDANCE_FINALIZED', month: target, version, actorId,
  });

  return { month: target, version, status: FINALIZATION_STATUS.FINALIZED, summary, fingerprint: facts.fingerprint };
};

// ── Send to payroll ────────────────────────────────────────────
// Syncs CURRENT snapshots (never live attendance) into the 29.5
// auto blocks. Idempotent: upserts by unique key, no-op when
// already SENT, resume-safe after partial failure.

export const sendToPayroll = async ({ companyId, actor, month, deps = {}, req = null }) => {
  const actorId = requireContext({ companyId, actor });
  const target = requireMonth(month);
  const full = { ...defaultDeps(), ...deps };

  const period = await full.AttendancePeriodModel.findOne({ companyId, month: target }).lean();
  if (!period) throw ApiError.badRequest('Attendance is not finalized for this month yet.');
  if (period.status === FINALIZATION_STATUS.SENT_TO_PAYROLL) {
    return {
      month: target, version: period.currentVersion, alreadySent: true,
      status: FINALIZATION_STATUS.SENT_TO_PAYROLL, syncedEmployees: period.syncedEmployees || 0,
    };
  }
  if (period.status !== FINALIZATION_STATUS.FINALIZED) {
    throw ApiError.conflict(transitionError(period.status, FINALIZATION_STATUS.SENT_TO_PAYROLL));
  }

  const payrollState = await loadPayrollState({ companyId, month: target, full });
  const gates = payrollGates(payrollState);
  if (!gates.send.allowed) {
    throw ApiError.conflict(gates.send.reasons[0] || 'Sending to payroll is blocked by payroll state.');
  }

  const version = period.currentVersion;
  const snapshots = await full.SnapshotModel.find({
    companyId, month: target, version, isCurrent: true,
  }).lean();
  const population = await full.UserModel.find({ companyId, status: 'ACTIVE' }).select('_id').lean();
  if ((snapshots || []).length !== (population || []).length) {
    throw ApiError.conflict('Finalization is incomplete for this version. Retry finalize to resume.');
  }
  const stored = (period.versions || []).find((entry) => entry.version === version);
  const entries = (snapshots || []).map((snap) => ({
    employeeId: strId(snap.employeeId),
    body: {
      scheduledWorkingDays: snap.scheduledWorkingDays,
      scopedDays: snap.scopedDays,
      preJoiningDays: snap.preJoiningDays,
      postExitDays: snap.postExitDays,
      equivalents: snap.equivalents,
      dayCounts: snap.dayCounts,
      leaveUnitsByType: snap.leaveUnitsByType,
      leaveIds: snap.leaveIds,
      workedMinutes: snap.workedMinutes,
      breakMinutes: snap.breakMinutes,
      lateDays: snap.lateDays,
      earlyExitDays: snap.earlyExitDays,
      approvedOtMinutes: snap.approvedOtMinutes,
      compOffDays: snap.compOffDays,
      workedOnHolidayDays: snap.workedOnHolidayDays,
      workedOnWeeklyOffDays: snap.workedOnWeeklyOffDays,
      overnightScheduledDays: snap.overnightScheduledDays,
      regularizedDays: snap.regularizedDays,
      days: snap.days,
    },
  }));
  if (stored?.fingerprint && fingerprintOf(entries) !== stored.fingerprint) {
    throw ApiError.conflict('Snapshot integrity check failed. Retry finalize to rebuild this version.');
  }

  const payrollPeriod = await full.periodEnsurer({ companyId, month: target, actor, req });
  const setup = full.PayrollSetupModel
    ? await full.PayrollSetupModel.findOne({ companyId, isCurrent: true }).select('overtimePolicy').lean()
    : null;

  const syncedAt = full.now();
  let synced = 0;
  let failed = 0;
  let firstError = '';
  for (const snap of snapshots || []) {
    const auto = buildAutoFromSnapshot({ snapshot: snap, otPolicy: setup?.overtimePolicy || null });
    auto.attendanceSource = { version, finalizedAt: stored?.finalizedAt || null, syncedAt };
    try {
      await full.EmployeeMonthlyInputModel.updateOne(
        { companyId, month: target, employeeId: snap.employeeId },
        {
          $set: { auto, periodId: payrollPeriod?._id || null, updatedBy: actorId },
          $setOnInsert: {
            companyId, month: target, employeeId: snap.employeeId,
            entries: [], status: 'PENDING', createdBy: actorId,
          },
        },
        { upsert: true },
      );
      synced += 1;
    } catch (error) {
      failed += 1;
      if (!firstError) firstError = error?.message || 'sync failed';
    }
  }

  if (failed > 0) {
    await full.AttendancePeriodModel.updateOne(
      { companyId, month: target },
      { $set: { lastSyncError: `${failed} employee(s) failed to sync: ${firstError}`.slice(0, 500), syncedEmployees: synced } },
    );
    await writeAudit(full, {
      req,
      action: 'ATTENDANCE_SEND_FAILED',
      companyId,
      resource: 'AttendancePeriod',
      resourceId: period._id,
      previousValue: { status: FINALIZATION_STATUS.FINALIZED, version },
      newValue: { month: target, version, synced, failed },
    });
    const error = ApiError.badRequest(
      `Payroll sync incomplete (${synced} synced, ${failed} failed). Retry send to resume.`,
    );
    throw error;
  }

  if (payrollPeriod?._id) {
    await full.PayrollPeriodModel.updateOne(
      { companyId, month: target },
      { $set: { attendanceImportedAt: syncedAt, updatedBy: actorId } },
    );
  }
  const marked = await full.AttendancePeriodModel.findOneAndUpdate(
    { companyId, month: target, status: FINALIZATION_STATUS.FINALIZED, currentVersion: version },
    {
      $set: {
        status: FINALIZATION_STATUS.SENT_TO_PAYROLL,
        lastSyncError: '',
        syncedEmployees: synced,
        updatedBy: actorId,
        'versions.$[entry].sentToPayrollAt': syncedAt,
        'versions.$[entry].sentBy': actorId,
      },
    },
    { new: true, arrayFilters: [{ 'entry.version': version }] },
  ).lean();
  if (!marked) {
    const fresh = await full.AttendancePeriodModel.findOne({ companyId, month: target }).lean();
    if (fresh?.status === FINALIZATION_STATUS.SENT_TO_PAYROLL && fresh?.currentVersion === version) {
      return {
        month: target, version, alreadySent: true,
        status: FINALIZATION_STATUS.SENT_TO_PAYROLL, syncedEmployees: synced,
      };
    }
    throw ApiError.conflict('Send claim was lost. Retry send to resume.');
  }

  await invalidatePayrollInputs(full, companyId, target);
  await writeAudit(full, {
    req,
    action: 'ATTENDANCE_SENT_TO_PAYROLL',
    companyId,
    resource: 'AttendancePeriod',
    resourceId: marked._id,
    previousValue: { status: FINALIZATION_STATUS.FINALIZED, version },
    newValue: { month: target, version, syncedEmployees: synced },
  });
  await notifyAudience(full, {
    companyId, type: 'ATTENDANCE_SENT_TO_PAYROLL', month: target, version, actorId,
  });

  return {
    month: target, version, status: FINALIZATION_STATUS.SENT_TO_PAYROLL, syncedEmployees: synced,
  };
};

// ── Reopen ─────────────────────────────────────────────────────

export const reopenMonth = async ({ companyId, actor, month, reason = '', deps = {}, req = null }) => {
  const actorId = requireContext({ companyId, actor });
  const target = requireMonth(month);
  const cleanReason = String(reason || '').trim().slice(0, 500);
  if (!cleanReason) throw ApiError.badRequest('A reopen reason is required.');
  const full = { ...defaultDeps(), ...deps };

  const period = await full.AttendancePeriodModel.findOne({ companyId, month: target }).lean();
  if (!period) throw ApiError.badRequest('Attendance is not finalized for this month yet.');
  if (!canTransition(period.status, FINALIZATION_STATUS.REOPENED)) {
    throw ApiError.conflict(transitionError(period.status, FINALIZATION_STATUS.REOPENED));
  }

  const payrollState = await loadPayrollState({ companyId, month: target, full });
  const gates = payrollGates(payrollState);
  if (!gates.reopen.allowed) {
    throw ApiError.conflict(gates.reopen.reasons[0] || 'Reopen is blocked by payroll state.');
  }

  const reopenedAt = full.now();
  const reopened = await full.AttendancePeriodModel.findOneAndUpdate(
    {
      companyId,
      month: target,
      currentVersion: period.currentVersion,
      status: { $in: [FINALIZATION_STATUS.FINALIZED, FINALIZATION_STATUS.SENT_TO_PAYROLL] },
    },
    {
      $set: {
        status: FINALIZATION_STATUS.REOPENED,
        lastSyncError: '',
        updatedBy: actorId,
        'versions.$[entry].reopenedAt': reopenedAt,
        'versions.$[entry].reopenedBy': actorId,
        'versions.$[entry].reopenReason': cleanReason,
      },
    },
    { new: true, arrayFilters: [{ 'entry.version': period.currentVersion }] },
  ).lean();
  if (!reopened) {
    throw ApiError.conflict('Reopen claim was lost. Reload and retry.');
  }

  await writeAudit(full, {
    req,
    action: 'ATTENDANCE_REOPENED',
    companyId,
    resource: 'AttendancePeriod',
    resourceId: reopened._id,
    previousValue: { status: period.status, version: period.currentVersion },
    newValue: { month: target, version: period.currentVersion, reason: cleanReason },
  });
  await notifyAudience(full, {
    companyId, type: 'ATTENDANCE_REOPENED', month: target, version: period.currentVersion, actorId,
  });

  return { month: target, version: period.currentVersion, status: FINALIZATION_STATUS.REOPENED };
};

export { FINALIZATION_STATUS, FINALIZATION_ISSUE, ISSUE_SEVERITY };
