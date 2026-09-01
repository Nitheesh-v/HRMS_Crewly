// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.7 — PAYROLL REVIEW SERVICE (tenant-safe orchestration)
//
//  Write order: validate → authorize (route) → tenant → dependencies → save
//  → invalidate cache → audit → notify.
//
//  THIS PHASE NEVER CALCULATES (§21). Every number it shows comes from a
//  29.6 PayrollResult snapshot. Review adds: validation, checklist, lock,
//  finance approval, remarks, difference reports and exports.
//
//  REDIS (§20): namespace 'payroll-review', tenant key convention,
//  invalidated on lock / unlock / approval / rejection / recalculation.
//
//  BULLMQ (§21): export generation is dispatched to the `payroll` queue and
//  built by the worker. Without Redis the same pure builder runs inline —
//  the API is allowed to run without Redis (28.1).
//
//  Dependency injection keeps the hermetic suite free of MongoDB and Redis.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import {
  BULK_REVIEW_ACTIONS,
  CHECKLIST_ITEMS,
  EXPORT_REPORTS,
  PER_EMPLOYEE_REVIEW_FLAGS,
  audiencePermissions,
  notificationCopy,
  buildExport,
  canTransition,
  checklistComplete,
  checklistProgress,
  criticalErrors,
  diffResults,
  emptyChecklist,
  isReadOnly,
  reviewKpis,
  summarizeErrors,
  summaryReport,
  transitionError,
  validateEmployeeForReview,
} from './payrollReviewRules.js';
import { isValidMonth } from './monthlyInputRules.js';
import { REVIEW_CACHE_NAMESPACE, REVIEW_CACHE_VERSION } from './payrollReviewCache.js';

// The namespace and version live in payrollReviewCache.js so the 29.6 engine
// can invalidate the same keys when it recalculates (§20).
export const CACHE_NAMESPACE = REVIEW_CACHE_NAMESPACE;
export const CACHE_VERSION = REVIEW_CACHE_VERSION;

const MIN_CACHE_TTL_SECONDS = 10;
const MAX_CACHE_TTL_SECONDS = 3600;
const DEFAULT_CACHE_TTL_SECONDS = 300;

export const MAX_EXPORT_CONTENT_BYTES = 4 * 1024 * 1024;

export const getPayrollReviewCacheTtlSeconds = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.PAYROLL_REVIEW_CACHE_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, parsed));
};

const CHECKLIST_KEYS = CHECKLIST_ITEMS.map((item) => item.key);
const REVIEWED_STATES = ['PENDING', 'REVIEWED'];

export const makePayrollReviewService = ({
  PayrollReviewModel,
  PayrollResultModel,
  PayrollRunModel,
  PayrollExportModel = null,
  PayrollPeriodModel = null,
  EmployeePayrollProfileModel,
  UserModel,
  DepartmentModel = null,
  cache = {},
  audit = async () => null,
  notify = async () => null,
  // §22 — who receives a workflow notification, resolved by permission so a
  // delegated approver is included. Returns user ids; the actor is filtered
  // out by the caller.
  audience = async () => [],
  dispatch = async () => ({ queued: false }),
  buildExportNow = null,
  ttlSeconds = getPayrollReviewCacheTtlSeconds(),
} = {}) => {
  const buildCacheKey = (companyId, month, suffix = 'dashboard') => {
    if (typeof cache.buildKey !== 'function') return null;
    return cache.buildKey({
      companyId,
      namespace: CACHE_NAMESPACE,
      version: CACHE_VERSION,
      segments: [String(month || 'current'), suffix],
    });
  };

  const invalidate = async (companyId, month) => {
    if (typeof cache.del !== 'function') return false;
    const keys = ['dashboard', 'errors', 'differences']
      .map((suffix) => buildCacheKey(companyId, month, suffix))
      .filter(Boolean);
    if (!keys.length) return false;
    try {
      await Promise.all(keys.map((key) => cache.del(key)));
      return true;
    } catch {
      return false;
    }
  };

  const writeAudit = async (payload) => {
    try {
      await audit(payload);
    } catch {
      // Auditing must never break a review action.
    }
  };

  // §22 — notifications are addressed by permission, not by role name, and
  // are best-effort: a failed notification never rolls back an approval.
  const notifyAudience = async ({ companyId, type, payload = {}, actorId = null }) => {
    const permissions = audiencePermissions(type);
    if (!permissions.length) return 0;

    let recipients = [];
    try {
      recipients = (await audience({ companyId, permissions })) || [];
    } catch {
      return 0;
    }

    const unique = [...new Set(recipients.map((id) => String(id)))].filter(
      (id) => id && String(actorId || '') !== id,
    );

    let sent = 0;
    for (const userId of unique) {
      try {
        await notify({ companyId, userId, type, payload });
        sent += 1;
      } catch {
        // One bad recipient must not stop the others.
      }
    }
    return sent;
  };

  // ── reads ────────────────────────────────────────────────────────────────

  const loadDepartmentNames = async (companyId) => {
    if (!DepartmentModel) return new Map();
    try {
      const rows = await DepartmentModel.find({ companyId }).select('name').lean();
      return new Map((rows || []).map((row) => [String(row._id), row.name]));
    } catch {
      return new Map();
    }
  };

  const loadResults = async ({ companyId, month, allowedEmployeeIds = null }) => {
    const filter = { companyId, month, isCurrent: true };
    if (Array.isArray(allowedEmployeeIds)) filter.employeeId = { $in: allowedEmployeeIds };
    const rows = await PayrollResultModel.find(filter).lean();
    const departments = await loadDepartmentNames(companyId);
    return rows.map((row) => ({
      ...row,
      departmentName: departments.get(String(row.departmentId || '')) || '',
    }));
  };

  const buildErrorRows = async ({ companyId, month, results }) => {
    const employeeIds = results.map((row) => row.employeeId);
    const [profiles, employees] = await Promise.all([
      EmployeePayrollProfileModel.find({ companyId, employeeId: { $in: employeeIds }, isCurrent: true }).lean(),
      UserModel.find({ companyId, _id: { $in: employeeIds } })
        .select('name employeeCode department status')
        .lean(),
    ]);

    const profileBy = new Map(profiles.map((row) => [String(row.employeeId), row]));
    const employeeBy = new Map(employees.map((row) => [String(row._id), row]));

    return results.map((row) => {
      const id = String(row.employeeId);
      const errors = validateEmployeeForReview({
        employee: employeeBy.get(id) || null,
        profile: profileBy.get(id) || null,
        results: [row],
      });

      return {
        employeeId: id,
        employeeName: row.employeeName || employeeBy.get(id)?.name || '',
        employeeCode: row.employeeCode || employeeBy.get(id)?.employeeCode || '',
        departmentName: row.departmentName || '',
        errors,
      };
    });
  };

  const ensureReview = async ({ companyId, month, actor, run = null }) => {
    const existing = await PayrollReviewModel.findOne({ companyId, month });
    if (existing) return existing;

    const freshRun =
      run ||
      (PayrollRunModel ? await PayrollRunModel.findOne({ companyId, month }).lean() : null);

    return PayrollReviewModel.create({
      companyId,
      month,
      status: 'CALCULATED',
      runId: freshRun?._id || null,
      runVersion: Number(freshRun?.version || 0),
      checklist: emptyChecklist(),
      employeeReviews: [],
      remarks: [],
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });
  };

  const getReview = async ({ companyId, month, actor, allowedEmployeeIds = null }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');

    const run = PayrollRunModel
      ? await PayrollRunModel.findOne({ companyId, month }).lean()
      : null;

    const review = await ensureReview({ companyId, month, actor, run });
    const results = await loadResults({ companyId, month, allowedEmployeeIds });
    const errorRows = await buildErrorRows({ companyId, month, results });

    const kpis = reviewKpis({ results, errorRows });
    const summary = summaryReport({ results });
    const errors = summarizeErrors(errorRows);

    // The checklist auto-tracks the error count; HR cannot forget to tick it.
    const checklist = {
      ...emptyChecklist(),
      ...(review.checklist || {}),
      ERROR_COUNT_ZERO: errors.critical === 0,
    };

    return {
      review,
      run,
      kpis,
      summary,
      errors,
      checklist,
      checklistProgress: checklistProgress(checklist),
      canLock:
        checklistComplete(checklist) &&
        !isReadOnly(review.status) &&
        ['CALCULATED', 'UNDER_REVIEW', 'REOPENED'].includes(review.status),
      results,
      errorRows,
    };
  };

  // §20 — the dashboard reads through the cache, every action invalidates it.
  // §20 — read-through cache. The contract is the one every payroll phase
  // uses: getOrSet(key, { ttlSeconds, version, loader }) → { value, cache },
  // with a bypass when caching is off and a bypass if Redis misbehaves.
  const readThrough = async (key, loader) => {
    if (!key || typeof cache.getOrSet !== 'function') {
      return { value: await loader(), cache: 'BYPASS' };
    }
    try {
      return await cache.getOrSet(key, { ttlSeconds, version: CACHE_VERSION, loader });
    } catch {
      return { value: await loader(), cache: 'BYPASS' };
    }
  };

  const getReviewDashboard = async ({ companyId, month, actor, allowedEmployeeIds = null }) => {
    const key = buildCacheKey(companyId, month, 'dashboard');
    const { value } = await readThrough(key, async () => {
      const payload = await getReview({ companyId, month, actor, allowedEmployeeIds });
      // Results and error rows are lists — they stay out of the cached blob.
      return { ...payload, results: undefined, errorRows: undefined };
    });

    return value || (await getReview({ companyId, month, actor, allowedEmployeeIds }));
  };

  const listErrorRows = async ({ companyId, month, actor, allowedEmployeeIds = null }) => {
    const results = await loadResults({ companyId, month, allowedEmployeeIds });
    const errorRows = await buildErrorRows({ companyId, month, results });
    return { errorRows, errors: summarizeErrors(errorRows) };
  };

  // §17 — compare the current snapshot with the one before it.
  const getDifferences = async ({ companyId, month, allowedEmployeeIds = null }) => {
    const filter = { companyId, month };
    if (Array.isArray(allowedEmployeeIds)) filter.employeeId = { $in: allowedEmployeeIds };

    const all = await PayrollResultModel.find(filter).lean();
    const byEmployee = new Map();
    (all || []).forEach((row) => {
      const key = String(row.employeeId);
      if (!byEmployee.has(key)) byEmployee.set(key, []);
      byEmployee.get(key).push(row);
    });

    const rows = [];
    byEmployee.forEach((versions) => {
      const sorted = versions.slice().sort((a, b) => Number(a.version || 0) - Number(b.version || 0));
      if (sorted.length < 2) return;
      const previous = sorted.at(-2);
      const current = sorted.at(-1);
      const diff = diffResults(previous, current);
      if (!diff.changed) return;
      rows.push({
        employeeId: String(current.employeeId),
        employeeName: current.employeeName || '',
        employeeCode: current.employeeCode || '',
        fromVersion: Number(previous.version || 0),
        toVersion: Number(current.version || 0),
        ...diff,
      });
    });

    return {
      rows,
      totalDifference: Math.round(rows.reduce((sum, row) => sum + Number(row.netDifference || 0), 0) * 100) / 100,
    };
  };

  // ── state transitions (§6 / §12 / §13 / §14) ─────────────────────────────

  const move = async ({
    companyId,
    month,
    to,
    actor,
    req,
    reason = '',
    auditAction,
    notification = null,
    extra = {},
    allowedEmployeeIds = null,
  }) => {
    const review = await ensureReview({ companyId, month, actor });
    const from = review.status;

    if (from !== to && !canTransition(from, to)) {
      throw ApiError.badRequest(transitionError(from, to));
    }

    const previousValue = { status: from };
    review.status = to;
    review.updatedBy = actor?._id || null;

    if (to === 'LOCKED') {
      review.lockedAt = new Date();
      review.lockedBy = actor?._id || null;
      review.lockCount = Number(review.lockCount || 0) + 1;
      review.rejectedAt = null;
      review.rejectedBy = null;
      review.rejectionReason = '';
      // §12 — locking the payroll also freezes the monthly inputs (29.5).
      if (PayrollPeriodModel) {
        await PayrollPeriodModel.updateOne(
          { companyId, month },
          { $set: { status: 'SENT_TO_PAYROLL' } },
        );
      }
    }

    if (to === 'PENDING_FINANCE_APPROVAL') {
      review.submittedAt = new Date();
      review.submittedBy = actor?._id || null;
    }

    if (to === 'APPROVED') {
      review.approvedAt = new Date();
      review.approvedBy = actor?._id || null;
      review.rejectedAt = null;
      review.rejectedBy = null;
      review.rejectionReason = '';
    }

    if (to === 'REJECTED') {
      review.rejectedAt = new Date();
      review.rejectedBy = actor?._id || null;
      review.rejectionReason = String(reason || '').trim().slice(0, 1000);
    }

    if (to === 'REOPENED') {
      review.reopenedAt = new Date();
      review.reopenedBy = actor?._id || null;
      review.reopenReason = String(reason || '').trim().slice(0, 1000);
      review.approvedAt = null;
      review.approvedBy = null;
      review.lockedAt = null;
      review.lockedBy = null;
      // §13 — reopening returns the monthly inputs to editable in 29.5.
      // COLLECTING_INPUTS is the editable state (29.5 refuses writes in both
      // LOCKED and SENT_TO_PAYROLL), and it is the same target 29.5's own
      // authorized reopen uses. We write it directly because 29.5's period
      // table deliberately has no exit from SENT_TO_PAYROLL — that exit IS
      // this authorized reopen.
      if (PayrollPeriodModel) {
        await PayrollPeriodModel.updateOne(
          { companyId, month },
          { $set: { status: 'COLLECTING_INPUTS' } },
        );
      }
    }

    Object.entries(extra || {}).forEach(([key, value]) => {
      review[key] = value;
    });

    await review.save();
    await invalidate(companyId, month);

    if (reason) {
      await addRemark({
        companyId,
        month,
        actor,
        message: reason,
        channel: to === 'REJECTED' ? 'FINANCE' : 'SYSTEM',
        statusAtTime: to,
        skipInvalidate: true,
        req,
      });
    }

    await writeAudit({
      req,
      action: auditAction,
      companyId,
      resource: 'PayrollReview',
      resourceId: review._id,
      previousValue,
      newValue: { status: to, month, reason: reason || null },
    });

    if (notification) {
      await notifyAudience({
        companyId,
        type: notification,
        payload: { month, status: to, reason: reason || '' },
        actorId: actor?._id || null,
      });
    }

    return getReview({ companyId, month, actor, allowedEmployeeIds });
  };

  // §12 — lock. The checklist must be complete and no critical errors may
  // remain: the rule is enforced here, not only in the UI (§29).
  const lock = async ({ companyId, month, actor, req, allowedEmployeeIds = null }) => {
    const state = await getReview({ companyId, month, actor, allowedEmployeeIds });

    if (isReadOnly(state.review.status)) {
      throw ApiError.badRequest('This payroll is already locked or approved. Reopen it first.');
    }
    if (state.errors.critical > 0) {
      throw ApiError.badRequest(
        `${state.errors.critical} critical error(s) must be resolved before locking`,
        { issues: state.errorRows.filter((row) => criticalErrors(row.errors).length > 0) },
      );
    }
    if (!checklistComplete(state.checklist)) {
      throw ApiError.badRequest('Complete the review checklist before locking payroll');
    }

    return move({
      companyId,
      month,
      to: 'LOCKED',
      actor,
      req,
      auditAction: 'PAYROLL_LOCKED',
      notification: 'PAYROLL_LOCKED',
      allowedEmployeeIds,
    });
  };

  // §13 — reopen: always with a reason, always audited, never silent.
  const reopen = async ({ companyId, month, reason, actor, req, allowedEmployeeIds = null }) => {
    if (!String(reason || '').trim()) {
      throw ApiError.badRequest('A reason is required to reopen payroll');
    }

    return move({
      companyId,
      month,
      to: 'REOPENED',
      actor,
      req,
      reason,
      auditAction: 'PAYROLL_REOPENED',
      notification: 'PAYROLL_REOPENED',
      allowedEmployeeIds,
    });
  };

  const submitForApproval = async ({ companyId, month, actor, req, allowedEmployeeIds = null }) => {
    const review = await ensureReview({ companyId, month, actor });
    if (review.status !== 'LOCKED') {
      throw ApiError.badRequest('Lock the payroll before sending it to finance');
    }

    return move({
      companyId,
      month,
      to: 'PENDING_FINANCE_APPROVAL',
      actor,
      req,
      auditAction: 'PAYROLL_SUBMITTED_FOR_APPROVAL',
      notification: 'PAYROLL_PENDING_APPROVAL',
      allowedEmployeeIds,
    });
  };

  const approve = async ({ companyId, month, actor, req, allowedEmployeeIds = null }) => {
    const review = await ensureReview({ companyId, month, actor });
    if (review.status !== 'PENDING_FINANCE_APPROVAL') {
      throw ApiError.badRequest('Only a payroll awaiting finance approval can be approved');
    }

    return move({
      companyId,
      month,
      to: 'APPROVED',
      actor,
      req,
      auditAction: 'PAYROLL_APPROVED',
      notification: 'PAYROLL_APPROVED',
      allowedEmployeeIds,
    });
  };

  // §14 — a rejection without a reason is useless to HR, so it is required.
  const reject = async ({ companyId, month, reason, actor, req, allowedEmployeeIds = null }) => {
    if (!String(reason || '').trim()) {
      throw ApiError.badRequest('Explain why the payroll is being rejected');
    }
    const review = await ensureReview({ companyId, month, actor });
    if (review.status !== 'PENDING_FINANCE_APPROVAL') {
      throw ApiError.badRequest('Only a payroll awaiting finance approval can be rejected');
    }

    return move({
      companyId,
      month,
      to: 'REJECTED',
      actor,
      req,
      reason,
      auditAction: 'PAYROLL_REJECTED',
      notification: 'PAYROLL_REJECTED',
      allowedEmployeeIds,
    });
  };

  // ── checklist, remarks, per-employee review (§11 / §15 / §18) ─────────────

  // §6 — CALCULATED only ever moves to UNDER_REVIEW, and there is no
  // "start review" button to click: the review begins the moment HR first
  // touches the payroll (a checklist tick, a per-employee review, a bulk
  // action). Locking therefore always happens from UNDER_REVIEW, which is
  // what the transition table allows.
  const startReview = async (review) => {
    if (review.status !== 'CALCULATED') return false;
    review.status = 'UNDER_REVIEW';
    return true;
  };

  const setChecklist = async ({ companyId, month, item, value, actor, req, allowedEmployeeIds = null }) => {
    if (!CHECKLIST_KEYS.includes(item)) throw ApiError.badRequest('Unknown checklist item');
    if (item === 'ERROR_COUNT_ZERO') {
      throw ApiError.badRequest('The error count is verified by the engine, not by hand');
    }

    const review = await ensureReview({ companyId, month, actor });
    if (isReadOnly(review.status)) {
      throw ApiError.badRequest('This payroll is locked. Reopen it before reviewing.');
    }

    const previous = { ...(review.checklist || {}) };
    await startReview(review);
    review.checklist = { ...emptyChecklist(), ...previous, [item]: Boolean(value) };
    review.updatedBy = actor?._id || null;
    await review.save();

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: 'PAYROLL_REVIEWED',
      companyId,
      resource: 'PayrollReview',
      resourceId: review._id,
      previousValue: { checklist: previous },
      newValue: { checklist: review.checklist, item, value: Boolean(value) },
    });

    return getReview({ companyId, month, actor, allowedEmployeeIds });
  };

  // §15 — remarks are append-only. Previous remarks are never overwritten.
  const addRemark = async ({
    companyId,
    month,
    actor,
    message,
    channel = 'HR',
    statusAtTime = '',
    skipInvalidate = false,
    req = null,
  }) => {
    const text = String(message || '').trim();
    if (!text) throw ApiError.badRequest('Write something before saving the remark');

    const review = await ensureReview({ companyId, month, actor });
    const remark = {
      message: text.slice(0, 2000),
      role: actor?.role || '',
      authorId: actor?._id || null,
      authorName: actor?.name || '',
      channel: ['HR', 'FINANCE', 'SYSTEM'].includes(channel) ? channel : 'HR',
      statusAtTime: statusAtTime || review.status,
      createdAt: new Date(),
    };

    review.remarks = [...(review.remarks || []), remark];
    review.updatedBy = actor?._id || null;
    await review.save();

    if (!skipInvalidate) await invalidate(companyId, month);

    await writeAudit({
      req,
      action: 'PAYROLL_REMARK_ADDED',
      companyId,
      resource: 'PayrollReview',
      resourceId: review._id,
      previousValue: null,
      newValue: { month, channel, length: text.length },
    });

    return review;
  };

  const reviewEmployee = async ({
    companyId,
    month,
    employeeId,
    state,
    note,
    actor,
    req,
    allowedEmployeeIds = null,
  }) => {
    const review = await ensureReview({ companyId, month, actor });
    if (isReadOnly(review.status)) {
      throw ApiError.badRequest('This payroll is locked. Reopen it before reviewing employees.');
    }

    await startReview(review);

    const rows = review.employeeReviews || [];
    const index = rows.findIndex((row) => String(row.employeeId) === String(employeeId));
    const current = index >= 0 ? rows[index] : { employeeId, state: 'PENDING' };

    const next = {
      ...current,
      state: REVIEWED_STATES.includes(state) ? state : current.state,
      note: note === undefined ? current.note || '' : String(note || '').slice(0, 500),
      reviewedBy: actor?._id || null,
      reviewedAt: new Date(),
    };

    if (index >= 0) review.employeeReviews[index] = next;
    else review.employeeReviews = [...rows, next];

    review.updatedBy = actor?._id || null;
    await review.save();

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: 'PAYROLL_REVIEWED',
      companyId,
      resource: 'PayrollReview',
      resourceId: review._id,
      previousValue: { employeeId, state: current.state || 'PENDING' },
      newValue: { employeeId, state: next.state },
    });

    return getReview({ companyId, month, actor, allowedEmployeeIds });
  };

  // §18 — bulk actions never touch a salary value.
  const bulkAction = async ({
    companyId,
    month,
    action,
    employeeIds = [],
    actor,
    req,
    allowedEmployeeIds = null,
  }) => {
    if (!BULK_REVIEW_ACTIONS.includes(action)) throw ApiError.badRequest('Unknown review action');

    const review = await ensureReview({ companyId, month, actor });
    if (isReadOnly(review.status) && action !== 'EXPORT_ERROR_LIST' && action !== 'DOWNLOAD_PAYROLL_SUMMARY') {
      throw ApiError.badRequest('This payroll is locked. Reopen it before running review actions.');
    }

    // §18 — these two do not touch a review row at all: they hand back a
    // report. They are also the only bulk actions allowed on a locked month,
    // because reading the numbers is fine while they are frozen.
    if (action === 'EXPORT_ERROR_LIST' || action === 'DOWNLOAD_PAYROLL_SUMMARY') {
      const reportKey = action === 'EXPORT_ERROR_LIST' ? 'ERROR_LIST' : 'SALARY_SUMMARY';
      const outcome = await createExport({ companyId, month, reportKey, actor, allowedEmployeeIds });

      await writeAudit({
        req,
        action: 'PAYROLL_EXPORT_REQUESTED',
        companyId,
        resource: 'PayrollReview',
        resourceId: review._id,
        previousValue: null,
        newValue: { reportKey, via: 'BULK_ACTION', queued: outcome.queued },
      });

      return {
        ...(await getReview({ companyId, month, actor, allowedEmployeeIds })),
        action,
        touched: [],
        export: outcome.export || null,
        content: outcome.content || '',
        queued: Boolean(outcome.queued),
      };
    }

    const scope = Array.isArray(allowedEmployeeIds)
      ? employeeIds.filter((id) => allowedEmployeeIds.some((allowed) => String(allowed) === String(id)))
      : employeeIds;

    await startReview(review);

    const rows = review.employeeReviews || [];
    const touched = [];

    review.employeeReviews = rows.map((row) => {
      if (!scope.some((id) => String(id) === String(row.employeeId))) return row;
      const next = { ...row };
      if (action === 'MARK_ALL_REVIEWED') {
        next.state = 'REVIEWED';
        next.reviewedBy = actor?._id || null;
        next.reviewedAt = new Date();
      }
      if (action === 'VERIFY_BANK_DETAILS') next.bankVerified = true;
      if (action === 'VERIFY_PAN') next.panVerified = true;
      touched.push(String(row.employeeId));
      return next;
    });

    // Employees without a review row yet still get one.
    scope.forEach((id) => {
      const exists = rows.some((row) => String(row.employeeId) === String(id));
      if (exists) return;
      const next = {
        employeeId: id,
        state: action === 'MARK_ALL_REVIEWED' ? 'REVIEWED' : 'PENDING',
        reviewedBy: action === 'MARK_ALL_REVIEWED' ? actor?._id || null : null,
        reviewedAt: action === 'MARK_ALL_REVIEWED' ? new Date() : null,
        bankVerified: action === 'VERIFY_BANK_DETAILS',
        panVerified: action === 'VERIFY_PAN',
        issues: [],
        note: '',
      };
      review.employeeReviews = [...(review.employeeReviews || []), next];
      touched.push(String(id));
    });

    review.updatedBy = actor?._id || null;
    await review.save();

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: 'PAYROLL_REVIEWED',
      companyId,
      resource: 'PayrollReview',
      resourceId: review._id,
      previousValue: null,
      newValue: { action, employees: touched.length },
    });

    return { ...(await getReview({ companyId, month, actor, allowedEmployeeIds })), action, touched };
  };

  // ── exports (§19 / §21) ──────────────────────────────────────────────────

  const buildExportContent = async ({ companyId, month, reportKey, allowedEmployeeIds = null }) => {
    const report = EXPORT_REPORTS.find((row) => row.key === reportKey);
    if (!report) throw ApiError.badRequest('Unknown report');

    const results = await loadResults({ companyId, month, allowedEmployeeIds });
    const { errorRows } = await listErrorRows({ companyId, month, allowedEmployeeIds });

    const content = buildExport(reportKey, { results, errorRows });
    if (Buffer.byteLength(content, 'utf8') > MAX_EXPORT_CONTENT_BYTES) {
      throw ApiError.badRequest('This report is too large to export — narrow the month');
    }

    return { content, rowCount: results.length, label: report.label };
  };

  const createExport = async ({
    companyId,
    month,
    reportKey,
    actor,
    allowedEmployeeIds = null,
  }) => {
    if (!EXPORT_REPORTS.some((row) => row.key === reportKey)) {
      throw ApiError.badRequest('Unknown report');
    }

    const report = EXPORT_REPORTS.find((row) => row.key === reportKey);
    let exportRow = null;

    if (PayrollExportModel) {
      exportRow = await PayrollExportModel.create({
        companyId,
        month,
        reportKey,
        label: report.label,
        status: 'QUEUED',
        requestedBy: actor?._id || null,
      });
    }

    // §21 — the report is built by the worker when Redis is available.
    let queued = false;
    let jobId = '';
    try {
      const outcome = await dispatch({
        companyId,
        month,
        exportId: exportRow ? String(exportRow._id) : '',
        reportKey,
        actorId: actor?._id ? String(actor._id) : null,
      });
      queued = Boolean(outcome?.queued);
      jobId = outcome?.jobId || '';
    } catch {
      queued = false;
    }

    if (exportRow) {
      exportRow.queued = queued;
      exportRow.jobId = jobId;
      await exportRow.save();
    }

    // No queue (28.1 degraded mode): build it now so the user is not blocked.
    if (!queued) {
      const built = await buildExportContent({ companyId, month, reportKey, allowedEmployeeIds });
      if (exportRow) {
        exportRow.status = 'READY';
        exportRow.content = built.content;
        exportRow.rowCount = built.rowCount;
        exportRow.completedAt = new Date();
        await exportRow.save();
      }
      return { export: exportRow, queued, content: built.content, label: built.label };
    }

    return { export: exportRow, queued, content: '', label: report.label };
  };

  // The worker calls this: it rebuilds the report from Mongo, never from the
  // job payload (28.2/28.4 discipline — revalidate server-side state).
  const processExport = async ({ companyId, month, exportId, reportKey }) => {
    if (!PayrollExportModel || !exportId) {
      return buildExportContent({ companyId, month, reportKey });
    }

    const exportRow = await PayrollExportModel.findOne({ companyId, _id: exportId });
    if (!exportRow) throw ApiError.notFound('Export not found');

    exportRow.status = 'PROCESSING';
    await exportRow.save();

    try {
      const built = await buildExportContent({ companyId, month, reportKey });
      exportRow.status = 'READY';
      exportRow.content = built.content;
      exportRow.rowCount = built.rowCount;
      exportRow.completedAt = new Date();
      await exportRow.save();
      return built;
    } catch (error) {
      exportRow.status = 'FAILED';
      exportRow.error = String(error?.message || 'Export failed').slice(0, 500);
      await exportRow.save();
      throw error;
    }
  };

  const getExport = async ({ companyId, exportId }) => {
    if (!PayrollExportModel) throw ApiError.notFound('Export not found');
    const row = await PayrollExportModel.findOne({ companyId, _id: exportId }).lean();
    if (!row) throw ApiError.notFound('Export not found');
    return row;
  };

  return {
    getReview,
    getReviewDashboard,
    listErrorRows,
    getDifferences,
    lock,
    reopen,
    submitForApproval,
    approve,
    reject,
    setChecklist,
    addRemark,
    reviewEmployee,
    bulkAction,
    createExport,
    processExport,
    getExport,
    invalidate,
    buildExportContent,
  };
};

import Department from '../../models/Department.js';
import EmployeePayrollProfile from '../../models/EmployeePayrollProfile.js';
import PayrollExport from '../../models/PayrollExport.js';
import PayrollPeriod from '../../models/PayrollPeriod.js';
import PayrollResult from '../../models/PayrollResult.js';
import PayrollReview from '../../models/PayrollReview.js';
import PayrollRun from '../../models/PayrollRun.js';
import User from '../../models/User.js';
import CompanyRole from '../../models/CompanyRole.js';
import Permission from '../../models/Permission.js';
import {
  buildTenantCacheKey,
  deleteCache,
  getOrSetCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';
import { recordAudit } from '../../utils/securityauditService.js';
import notifySmart from '../../utils/notifyPref.js';
import { dispatchPayrollExport } from './payrollExportDispatcher.js';

// §22 — resolve a notification audience by PERMISSION, not by role name.
// Company roles hold the permission list, so this is two indexed reads plus
// one user lookup; per-user ALLOW overrides are honoured for authorization
// but are not enumerated here — fan-out is best-effort by design.
const resolveAudience = async ({ companyId, permissions = [] }) => {
  const names = (permissions || []).filter((name) => typeof name === 'string');
  if (!companyId || !names.length) return [];

  const permissionDocs = await Permission.find({ name: { $in: names } }).select('_id').lean();
  if (!permissionDocs.length) return [];

  const roles = await CompanyRole.find({
    companyId,
    isActive: true,
    permissions: { $in: permissionDocs.map((doc) => doc._id) },
  })
    .select('code systemRoleKey')
    .lean();

  const roleKeys = [
    ...new Set(roles.map((role) => role.systemRoleKey || role.code).filter(Boolean)),
  ];
  if (!roleKeys.length) return [];

  const users = await User.find({ companyId, status: 'ACTIVE', role: { $in: roleKeys } })
    .select('_id')
    .lean();

  return users.map((user) => user._id);
};

const defaultService = makePayrollReviewService({
  PayrollReviewModel: PayrollReview,
  PayrollResultModel: PayrollResult,
  PayrollRunModel: PayrollRun,
  PayrollExportModel: PayrollExport,
  PayrollPeriodModel: PayrollPeriod,
  EmployeePayrollProfileModel: EmployeePayrollProfile,
  UserModel: User,
  DepartmentModel: Department,
  cache: {
    buildKey: buildTenantCacheKey,
    getOrSet: getOrSetCache,
    del: async (key) => {
      const removed = await deleteCache(key);
      if (removed) noteCacheInvalidation();
      return removed;
    },
  },
  audit: recordAudit,
  // §22 — one notification per recipient. The recipient is a real user id
  // resolved from the permission, so the message actually reaches the people
  // who can act on it (finance on submit, payroll/HR on approve or reject).
  notify: ({ userId, type, payload = {} }) =>
    notifySmart(userId, {
      title: 'Payroll review',
      message: notificationCopy(type, payload),
      link: `/app/payroll/review?month=${payload?.month || ''}`,
      category: 'PAYROLL',
      metadata: { type, ...payload },
    }),
  audience: resolveAudience,
  dispatch: dispatchPayrollExport,
});

export default defaultService;
