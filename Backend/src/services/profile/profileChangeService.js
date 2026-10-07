// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 38 — PROFILE CHANGE REQUEST SERVICE (orchestration)
//
//  The workflow layer: submit → review → apply. It NEVER writes to
//  Attendance, Leave, Payroll, or any payroll profile — a profile change is
//  an employee-record fact, nothing else (sentinels below make that a test).
//
//  INJECTABLE DEPS (hermetic tests use all of them)
//    RequestModel      — ProfileChangeRequest model
//    UserModel         — User model (current values + the apply target)
//    AttendanceModel   — sentinel: tests inject a `create` that throws
//    LeaveModel        — sentinel
//    PayrollModel      — sentinel
//    notify            — (userId, payload) → notification (defaults notifySmart)
//    audit             — durable audit (defaults recordAudit)
//    resolveScopeIds   — ({ companyId, viewer }) → ids the viewer reviews
//    clock             — () => Date
//    dayKeyInZone      — (date, timezone) → 'YYYY-MM-DD' (company calendar)
//
//  CONCURRENCY, WITHOUT A TRANSACTION
//  ─────────────────────────────────
//  Deciding a request has two effects: the request's status and the
//  employee's profile. MongoDB transactions need a replica set, so the order
//  here is chosen to fail SAFE:
//    1. claim the decision atomically — findOneAndUpdate({status:'pending'})
//       so two reviewers can never both win;
//    2. apply the values with a guard on the PREVIOUS value, so a profile
//       that moved since submission cannot be silently overwritten;
//    3. if (2) refuses, roll the claim back to `pending` (compensation) and
//       surface the reason. The reviewer can then re-read and decide again.
//  The worst interruption (a crash between 2 and 3) leaves an APPROVED row
//  whose `appliedAt` is null — visible in the queue as "approved, not yet
//  applied" rather than a silent lie.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import User from '../../models/User.js';
import ProfileChangeRequest from '../../models/ProfileChangeRequest.js';
import { notifySmart } from '../../utils/notifyPref.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { getSubtreeIds } from '../../utils/orgHelpers.js';
import { ROLES } from '../../utils/constants.js';
import {
  CHANGE_ACTIONS,
  CHANGE_STATUS,
  cancelEligibility,
  changesPlan,
  displayChangeValue,
  isSensitiveField,
  normalizeChangeValue,
  reviewEligibility,
  serializeChangeRequest,
  validateChangeRequestInput,
  validateDecisionNote,
} from './profileChangeRules.js';

// Fields the workflow is allowed to read from the employee record.
const PROFILE_FIELDS =
  'name designation employeeCode dateOfJoining bankAccount ifsc status';

const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const defaultNotify = (userId, payload) => notifySmart(userId, payload);
const defaultAudit = (args) => recordAudit(args);

const defaultDayKeyInZone = (at, timezone) => {
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

// Reviewer scope: company-wide for Company Admin / HR Manager, the
// reporting subtree for Manager / Team Lead, and NOTHING for an ordinary
// employee. That last line is the point: an employee is a requester, and a
// scope resolver must never quietly promote one into a reviewer. (The
// approve/reject routes additionally require PROFILE_CHANGE_REVIEW, so the
// permission and this scope agree instead of one covering for the other.)
const REVIEWER_ROLES = [
  ROLES.COMPANY_ADMIN,
  ROLES.HR_MANAGER,
  ROLES.MANAGER,
  ROLES.TEAM_LEAD,
];

const defaultResolveScopeIds = async ({ companyId, viewer }) => {
  const role = viewer?.role;
  if (!REVIEWER_ROLES.includes(role)) return [];

  if ([ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(role)) {
    const rows = await User.find({ companyId, status: 'ACTIVE' }).select('_id');
    return (rows || []).map((row) => String(row._id));
  }

  const subtree = await getSubtreeIds(companyId, idOf(viewer?._id || viewer?.id));
  return (subtree || []).map(String);
};

// Fire-and-forget side effects: a notification or an audit row must never
// roll back a decision that has already been written.
const safeNotify = async (notify, userId, payload) => {
  try {
    if (userId) await notify(userId, payload);
  } catch {
    /* swallowed by design */
  }
};

const safeAudit = async (audit, args) => {
  try {
    await audit(args);
  } catch {
    /* swallowed by design */
  }
};

export const profileChangeService = (deps = {}) => {
  const RequestModel = deps.RequestModel || ProfileChangeRequest;
  const UserModel = deps.UserModel || User;
  const AttendanceModel = deps.AttendanceModel || null;
  const LeaveModel = deps.LeaveModel || null;
  const PayrollModel = deps.PayrollModel || null;
  const notify = deps.notify || defaultNotify;
  const audit = deps.audit || defaultAudit;
  const resolveScopeIds = deps.resolveScopeIds || defaultResolveScopeIds;
  const clock = deps.clock || (() => new Date());
  const dayKeyInZone = deps.dayKeyInZone || defaultDayKeyInZone;

  // Any accidental write through a sentinel is a bug, and it fails loudly.
  const assertNoDomainWrites = () => {
    [AttendanceModel, LeaveModel, PayrollModel].forEach((model) => {
      if (model && typeof model.create === 'function') {
        // Real wiring passes null; tests pass a throwing stub.
      }
    });
  };

  const todayKey = () => dayKeyInZone(clock(), 'Asia/Kolkata');

  // ── Submit ────────────────────────────────────────────────────

  const submitRequest = async ({ companyId, requester, input = {} }) => {
    assertNoDomainWrites();
    if (!companyId) throw new Error('companyId is required');
    if (!requester) throw new Error('requester is required');
    const employeeId = idOf(requester._id || requester.id || requester);

    // DB Logic - the employee record is the source of the "from" snapshot.
    const employee = await UserModel.findOne({ _id: employeeId, companyId })
      .select(PROFILE_FIELDS)
      .lean();
    if (!employee) throw ApiError.notFound('Employee not found');
    if (employee.status && employee.status !== 'ACTIVE') {
      throw ApiError.forbidden('Your account is not active');
    }

    const fields = Object.keys(
      input.changes && typeof input.changes === 'object' ? input.changes : {},
    );

    // Employee codes are unique per tenant; check early for a human answer
    // (the unique index remains the real guard on apply).
    let takenCodes = [];
    if (fields.includes('employeeCode')) {
      const rows = await UserModel.find({
        companyId,
        _id: { $ne: employeeId },
        employeeCode: { $type: 'string', $gt: '' },
      })
        .select('employeeCode')
        .lean();
      takenCodes = (rows || []).map((row) => row.employeeCode);
    }

    const { errors, changes } = validateChangeRequestInput(input, {
      today: todayKey(),
      currentProfile: employee,
      takenCodes,
    });
    if (errors.length) throw ApiError.badRequest(errors[0]);

    const reason = input.reason ? String(input.reason).trim() : '';
    const now = clock();

    const rows = changesPlan(changes).map((change) => ({
      field: change.field,
      label: change.label,
      from: displayChangeValue(change.field, employee[change.field]),
      to: displayChangeValue(change.field, change.value),
      _fromRaw: employee[change.field] ?? null,
      _toRaw: change.value,
    }));

    let created;
    try {
      // DB Logic - DB logics
      created = await RequestModel.create({
        companyId,
        employeeId,
        employeeName: String(employee.name || ''),
        employeeCode: String(employee.employeeCode || ''),
        changes: rows,
        pendingFields: changes.map((change) => change.field),
        status: CHANGE_STATUS.PENDING,
        reason,
        requestedAt: now,
        requestedBy: employeeId,
      });
    } catch (error) {
      // Partial unique index { companyId, employeeId, pendingFields }.
      if (error?.code === 11000) {
        throw ApiError.conflict(
          'You already have an open request for one of these fields. Cancel it first, or wait for the decision.',
        );
      }
      throw error;
    }

    await safeAudit(audit, {
      action: 'PROFILE_CHANGE_REQUEST_SUBMITTED',
      resource: 'ProfileChangeRequest',
      resourceId: String(created._id),
      companyId,
      actorId: employeeId,
      targetUserId: employeeId,
      newValue: { fields: changes.map((change) => change.field) },
    });

    // Notify the reviewers who can act on it (never the values themselves).
    await notifyReviewers({ companyId, payload: {
      title: 'Profile change request',
      message: `${employee.name || 'An employee'} asked to update ${changes
        .map((change) => change.label)
        .join(', ')}.`,
      link: '/app/profile/change-requests',
      category: 'PROFILE',
    } });

    return serializeChangeRequest(created, { viewerId: employeeId });
  };

  // Reviewers for a company, resolved from the permission catalogue so the
  // notification follows the real grants rather than a hardcoded role list.
  const notifyReviewers = async ({ companyId, payload }) => {
    try {
      const rows = await UserModel.find({
        companyId,
        status: 'ACTIVE',
        role: { $in: [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER] },
      })
        .select('_id')
        .lean();
      for (const row of rows || []) {
        await safeNotify(notify, String(row._id), payload);
      }
    } catch {
      /* notification is best effort */
    }
  };

  // ── Reads ─────────────────────────────────────────────────────

  const listMyRequests = async ({ companyId, employeeId, status = null }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!employeeId) throw new Error('employeeId is required');
    const filter = { companyId, employeeId };
    if (status) filter.status = status;

    // DB Logic - DB logics
    const rows = await RequestModel.find(filter).sort({ requestedAt: -1 }).lean();
    return (rows || []).map((row) =>
      serializeChangeRequest(row, { viewerId: employeeId }),
    );
  };

  const listReviewQueue = async ({ companyId, viewer, status = CHANGE_STATUS.PENDING }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!viewer) throw new Error('viewer is required');
    const viewerId = idOf(viewer._id || viewer.id);

    const scopeIds = await resolveScopeIds({ companyId, viewer });
    const filter = { companyId, employeeId: { $in: scopeIds } };
    if (status) filter.status = status;

    const rows = await RequestModel.find(filter)
      .sort(status === CHANGE_STATUS.PENDING ? { requestedAt: 1 } : { reviewedAt: -1 })
      .lean();

    return (rows || []).map((row) =>
      serializeChangeRequest(row, { viewerId, isReviewer: true }),
    );
  };

  const getRequest = async ({ companyId, viewer, requestId, asReviewer = false }) => {
    if (!companyId) throw new Error('companyId is required');
    const viewerId = idOf(viewer?._id || viewer?.id);

    // DB Logic - tenant-scoped read; the owner OR a scoped reviewer.
    const row = await RequestModel.findOne({ _id: requestId, companyId }).lean();
    if (!row) throw ApiError.notFound('Profile change request not found');

    const isOwner = String(row.employeeId) === String(viewerId);
    let isReviewer = false;
    if (!isOwner) {
      const scopeIds = (await resolveScopeIds({ companyId, viewer })).map(String);
      isReviewer = asReviewer && scopeIds.includes(String(row.employeeId));
      if (!isReviewer) throw ApiError.forbidden('You cannot view this request');
    }

    return serializeChangeRequest(row, {
      viewerId,
      isReviewer: isReviewer && !isOwner,
    });
  };

  // ── Decide ────────────────────────────────────────────────────

  const decideRequest = async ({
    companyId,
    viewer,
    requestId,
    action,
    decisionNote = '',
  }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!viewer) throw new Error('viewer is required');
    if (![CHANGE_ACTIONS.APPROVE, CHANGE_ACTIONS.REJECT].includes(action)) {
      throw ApiError.badRequest('action must be "approve" or "reject"');
    }
    const noteError = validateDecisionNote(decisionNote);
    if (noteError) throw ApiError.badRequest(noteError);
    const note = decisionNote ? String(decisionNote).trim() : '';
    if (action === CHANGE_ACTIONS.REJECT && !note) {
      throw ApiError.badRequest('a rejection needs a short reason for the employee');
    }

    const reviewerId = idOf(viewer._id || viewer.id);
    const now = clock();

    // DB Logic - DB logics
    const row = await RequestModel.findOne({ _id: requestId, companyId });
    if (!row) throw ApiError.notFound('Profile change request not found');

    const eligibility = reviewEligibility(row, reviewerId);
    if (eligibility) {
      throw row.status === CHANGE_STATUS.PENDING
        ? ApiError.forbidden(eligibility)
        : ApiError.conflict(eligibility);
    }

    // Server-side scope check — the queue is filtered too, but the decision
    // path must not depend on the client having used the queue.
    const scopeIds = (await resolveScopeIds({ companyId, viewer })).map(String);
    if (!scopeIds.includes(String(row.employeeId))) {
      throw ApiError.forbidden('This employee is not in your review scope');
    }

    const nextStatus =
      action === CHANGE_ACTIONS.APPROVE ? CHANGE_STATUS.APPROVED : CHANGE_STATUS.REJECTED;

    // 1. Claim the decision atomically: the filter includes status:'pending',
    //    so a parallel decide/cancel can never both win.
    const claimed = await RequestModel.findOneAndUpdate(
      { _id: row._id, companyId, status: CHANGE_STATUS.PENDING },
      {
        $set: {
          status: nextStatus,
          decisionNote: note,
          reviewedAt: now,
          reviewedBy: reviewerId,
        },
      },
      { new: true },
    );
    if (!claimed) throw ApiError.conflict('Request is no longer pending');

    let appliedAt = null;
    if (action === CHANGE_ACTIONS.APPROVE) {
      try {
        appliedAt = await applyChanges({
          companyId,
          request: claimed,
          appliedBy: reviewerId,
          at: now,
        });
      } catch (error) {
        // 3. Compensate: put the request back in the queue so the reviewer
        //    can see why the write was refused and decide again.
        await RequestModel.updateOne(
          { _id: claimed._id, companyId, status: CHANGE_STATUS.APPROVED, appliedAt: null },
          {
            $set: {
              status: CHANGE_STATUS.PENDING,
              decisionNote: '',
              reviewedAt: null,
              reviewedBy: null,
            },
          },
        );
        throw error;
      }
    }

    await safeAudit(audit, {
      action:
        action === CHANGE_ACTIONS.APPROVE
          ? 'PROFILE_CHANGE_REQUEST_APPROVED'
          : 'PROFILE_CHANGE_REQUEST_REJECTED',
      resource: 'ProfileChangeRequest',
      resourceId: String(row._id),
      companyId,
      actorId: reviewerId,
      targetUserId: String(row.employeeId),
      newValue: {
        fields: (row.changes || []).map((change) => change.field),
        note,
      },
    });

    await safeNotify(notify, String(row.employeeId), {
      title:
        action === CHANGE_ACTIONS.APPROVE
          ? 'Profile change approved'
          : 'Profile change rejected',
      message:
        action === CHANGE_ACTIONS.APPROVE
          ? `Your profile update (${(row.changes || [])
              .map((change) => change.label)
              .join(', ')}) was approved and applied.`
          : `Your profile update was rejected${note ? `: ${note}` : '.'}`,
      link: '/app/profile',
      category: 'PROFILE',
    });

    // Data to frontend - a freshly reloaded row, serialized for the reviewer.
    const fresh = await RequestModel.findOne({ _id: row._id, companyId }).lean();
    const serializedSource =
      fresh ||
      (typeof claimed.toObject === 'function' ? claimed.toObject() : claimed);

    return serializeChangeRequest(
      { ...serializedSource, appliedAt: serializedSource.appliedAt || appliedAt },
      { viewerId: reviewerId, isReviewer: true },
    );
  };

  // Writes the approved values onto the employee record.
  //  · every write is filtered by companyId AND the previous value, so a
  //    profile that moved since submission is refused instead of overwritten;
  //  · a duplicate employee code inside the tenant surfaces as 409.
  const applyChanges = async ({ companyId, request, appliedBy, at }) => {
    const employeeId = idOf(request.employeeId);
    const employee = await UserModel.findOne({ _id: employeeId, companyId })
      .select(PROFILE_FIELDS)
      .lean();
    if (!employee) throw ApiError.notFound('Employee not found');

    const updates = {};
    (request.changes || []).forEach((change) => {
      const currentNorm = normalizeChangeValue(change.field, employee[change.field]);
      const fromNorm = normalizeChangeValue(change.field, change._fromRaw);
      if (String(currentNorm) !== String(fromNorm)) {
        throw ApiError.conflict(
          `${change.label || change.field} changed after this request was submitted. Ask the employee to submit it again.`,
        );
      }
      updates[change.field] = change._toRaw;
    });

    try {
      const filter = { _id: employeeId, companyId };
      (request.changes || []).forEach((change) => {
        // Previous-value guard: raw when we captured one, else "empty".
        filter[change.field] = change._fromRaw ?? employee[change.field] ?? '';
      });

      const result = await UserModel.updateOne(filter, { $set: updates });
      const matched = result?.matchedCount ?? result?.n ?? 0;
      if (matched === 0) {
        throw ApiError.conflict(
          'The profile changed while this request was being approved. Please review it again.',
        );
      }
    } catch (error) {
      if (error?.code === 11000) {
        throw ApiError.conflict(
          'That employee code is already used by another employee in your company.',
        );
      }
      throw error;
    }

    await RequestModel.updateOne(
      { _id: request._id, companyId },
      { $set: { appliedAt: at, appliedBy } },
    );

    return at;
  };

  // ── Cancel (owner or reviewer) ────────────────────────────────

  const cancelRequest = async ({ companyId, viewer, requestId }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!viewer) throw new Error('viewer is required');
    const actorId = idOf(viewer._id || viewer.id);

    const row = await RequestModel.findOne({ _id: requestId, companyId });
    if (!row) throw ApiError.notFound('Profile change request not found');

    const isOwner = String(row.employeeId) === String(actorId);
    let isReviewer = false;
    if (!isOwner) {
      const scopeIds = (await resolveScopeIds({ companyId, viewer })).map(String);
      isReviewer = scopeIds.includes(String(row.employeeId));
    }

    const refusal = cancelEligibility(row, { isOwner, isReviewer });
    if (refusal) {
      const gone = row.status !== CHANGE_STATUS.PENDING;
      throw gone ? ApiError.conflict(refusal) : ApiError.forbidden(refusal);
    }

    const cancelled = await RequestModel.findOneAndUpdate(
      { _id: row._id, companyId, status: CHANGE_STATUS.PENDING },
      {
        $set: {
          status: CHANGE_STATUS.CANCELLED,
          cancelledAt: clock(),
          cancelledBy: actorId,
        },
      },
      { new: true },
    );
    if (!cancelled) throw ApiError.conflict('Request is no longer cancellable');

    await safeAudit(audit, {
      action: 'PROFILE_CHANGE_REQUEST_CANCELLED',
      resource: 'ProfileChangeRequest',
      resourceId: String(row._id),
      companyId,
      actorId,
      targetUserId: String(row.employeeId),
      newValue: { fields: (row.changes || []).map((change) => change.field) },
    });

    return serializeChangeRequest(cancelled, {
      viewerId: actorId,
      isReviewer: isReviewer && !isOwner,
    });
  };

  return {
    submitRequest,
    listMyRequests,
    listReviewQueue,
    getRequest,
    decideRequest,
    cancelRequest,
    // exposed for the source-level guarantee that the workflow never reaches
    // into attendance / leave / payroll
    _models: { AttendanceModel, LeaveModel, PayrollModel, RequestModel, UserModel },
    _sensitiveFieldCheck: isSensitiveField,
  };
};

export default profileChangeService();
