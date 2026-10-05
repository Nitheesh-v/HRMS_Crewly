// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST SERVICE
//
//  Orchestration for the presence work-location (WFH) request workflow.
//  Mirrors the 31.4 attendanceWorkModeService shape but is intentionally
//  a separate service: 37.5 is presence-domain, NOT attendance-domain
//  (spec §1, §7, §39–42). It NEVER writes to Attendance, Leave, or
//  Payroll collections.
//
//  INJECTABLE DEPS
//    RequestModel               — the WorkLocationRequest Mongoose model
//    UserModel                  — the User Mongoose model (for reviewer
//                                 identity on the queue)
//    tenantConfigReader         — presenceTenantConfigService reader
//    AttendanceModel            — sentinel (tests assert NO write)
//    LeaveModel                 — sentinel (tests assert NO write)
//    PayrollSnapshotModel       — sentinel (tests assert NO write)
//    notify                     — user notification (defaults to notifySmart)
//    audit                      — durable audit (defaults to recordAudit)
//    publishInvalidation        — realtime bus publish (defaults to a
//                                 best-effort no-throw wrapper around
//                                 the 37.4 presenceBus)
//    resolveScopeIds            — org scope (defaults to utils/orgHelpers)
//    clock                      — `() => Date` for hermetic tests
//    dayKeyInZone               — timezone-aware day formatter
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import WorkLocationRequest from '../../models/WorkLocationRequest.js';
import User from '../../models/User.js';
import { getPresenceTenantConfigOrThrow } from './presenceTenantConfigService.js';
import { publishPresenceInvalidated } from './presenceBus.js';
import { notifySmart } from '../../utils/notifyPref.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { resolveScopeIds as defaultResolveScopeIds } from '../../utils/orgHelpers.js';
import {
  REQUEST_STATUS,
  MAX_DECISION_NOTE_LENGTH,
  cancelEligibility,
  findOverlappingRequest,
  isApprovalRequired,
  requestPolicyCheck,
  reviewEligibility,
  serializeRequest,
  validateDecisionNote,
  validateRequestInput,
} from './workLocationRequestRules.js';

// ── Sensible defaults ─────────────────────────────────

const defaultNotify = (userId, payload) => notifySmart(userId, payload);
const defaultAudit = (args) => recordAudit(args);

// safeNotify — fire-and-forget. Notification failure never rolls back
// a committed workflow mutation.
const safeNotify = async (notify, userId, payload) => {
  try {
    if (userId) await notify(userId, payload);
  } catch {
    /* intentionally swallowed */
  }
};

// safePublish — same posture for the realtime bus. A publish failure
// is a degraded fan-out, not a workflow failure.
const safePublish = async (publish, input) => {
  try {
    return await publish(input);
  } catch {
    return { ok: false, delivered: 'none', error: 'publish threw' };
  }
};

// Company-calendar day key. Mirrors the 31.4 dayKeyInZone — local copy
// to avoid a service import cycle. Falls back to UTC slice if Intl is
// unavailable.
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

const trimOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length === 0 ? null : trimmed;
};

const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

// ── Service factory ───────────────────────────────────

export const workLocationRequestService = (deps = {}) => {
  const RequestModel = deps.RequestModel || WorkLocationRequest;
  const UserModel = deps.UserModel || User;
  const tenantConfigReader =
    deps.tenantConfigReader || ((args) => getPresenceTenantConfigOrThrow(args));
  // The three sentinels below are the test seams: hermetic tests
  // inject models whose `create` throws, so any drift that tries to
  // write attendance/leave/payroll is caught in CI. In production
  // they are null and the service has nothing to call.
  const AttendanceModel = deps.AttendanceModel || null;
  const LeaveModel = deps.LeaveModel || null;
  const PayrollSnapshotModel = deps.PayrollSnapshotModel || null;
  const notify = deps.notify || defaultNotify;
  const audit = deps.audit || defaultAudit;
  const publishInvalidation =
    deps.publishInvalidation ||
    ((input) => publishPresenceInvalidated(input));
  const resolveScopeIds = deps.resolveScopeIds || defaultResolveScopeIds;
  const clock = deps.clock || (() => new Date());
  const dayKeyInZone = deps.dayKeyInZone || defaultDayKeyInZone;

  // ── Submit ───────────────────────────────────────────

  const submitRequest = async ({
    companyId,
    requester,
    input,
  }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!requester) throw new Error('requester is required');
    const userId = idOf(requester._id || requester.id || requester);

    const errors = validateRequestInput(input || {}, null);
    if (errors.length) {
      throw ApiError.badRequest(errors[0]);
    }

    // Read tenant policy. The same snapshot the read-path uses —
    // a request cannot be evaluated under a different config than
    // a later setMyWorkLocation.
    const config = await tenantConfigReader({ companyId });

    const policyRefusal = requestPolicyCheck(config);
    if (policyRefusal) {
      throw ApiError.forbidden(policyRefusal);
    }
    if (!isApprovalRequired(config)) {
      // wfhMode is 'self_declare' — no request needed; the
      // controller path is the setMyWorkLocation direct path. We
      // still 409 here so a client that hits this endpoint under
      // the wrong policy gets a deterministic refusal.
      throw ApiError.conflict(
        'WFH requests are only required when wfhMode is approval_required',
      );
    }

    const startDate = input.startDate;
    const endDate = input.endDate || startDate;
    const now = clock();
    const today = dayKeyInZone(now, config?.timezone);

    // Past-start rule (spec §14, plan §B.7).
    if (startDate < today) {
      throw ApiError.badRequest('startDate cannot be in the past');
    }

    // Overlap check (spec §15).
    const existing = await RequestModel.find({
      companyId,
      userId,
      status: { $in: [REQUEST_STATUS.PENDING, REQUEST_STATUS.APPROVED] },
    }).lean();
    const candidate = { companyId, userId, startDate, endDate };
    const overlap = findOverlappingRequest(candidate, existing);
    if (overlap) {
      throw ApiError.conflict(
        `Overlaps an existing ${overlap.status} request (${overlap.startDate} → ${overlap.endDate})`,
      );
    }

    // Sentinel: attendance / leave / payroll must NEVER be written.
    // The actual enforcement is the test seam: the hermetic suite
    // injects fakes whose `create` throws, so any drift is caught
    // in CI. In production these fields are null (default) and the
    // service has nothing to call. The reference here is purely
    // a code-readability aid that names the boundary.
    if (AttendanceModel && typeof AttendanceModel.create === 'function') {
      // No-op in production; tests inject a `create` that throws.
      // Wrapping the call in a future-tense stub keeps the seam
      // visible at the source level without paying any runtime
      // cost when no model is injected.
    }

    const created = await RequestModel.create({
      companyId,
      userId,
      location: 'wfh',
      startDate,
      endDate,
      status: REQUEST_STATUS.PENDING,
      requestedAt: now,
      requestedBy: userId,
    });

    await audit({
      action: 'PRESENCE_WORK_MODE_REQUEST_SUBMITTED',
      resource: 'WorkLocationRequest',
      resourceId: String(created._id),
      companyId,
      actorId: userId,
      newValue: {
        location: 'wfh',
        startDate,
        endDate,
        from: null,
        to: REQUEST_STATUS.PENDING,
      },
    });

    const day = dayKeyInZone(now, config?.timezone);
    return serializeRequest(created, { viewerId: userId, today: day });
  };

  // ── List my own ─────────────────────────────────────

  const listMyRequests = async ({ companyId, userId, today = null }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!userId) throw new Error('userId is required');
    const config = await tenantConfigReader({ companyId });
    const day = today || dayKeyInZone(clock(), config?.timezone);
    const rows = await RequestModel.find({ companyId, userId })
      .sort({ requestedAt: -1 })
      .lean();
    return {
      requests: (rows || []).map((row) =>
        serializeRequest(row, { viewerId: userId, today: day }),
      ),
    };
  };

  // ── Reviewer queue ──────────────────────────────────

  const listReviewQueue = async ({ companyId, viewer, today = null }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!viewer) throw new Error('viewer is required');
    const config = await tenantConfigReader({ companyId });
    const day = today || dayKeyInZone(clock(), config?.timezone);
    const scopeIds = await resolveScopeIds({ companyId, user: viewer });
    const rows = await RequestModel.find({
      companyId,
      status: REQUEST_STATUS.PENDING,
      userId: { $in: scopeIds },
    })
      .sort({ requestedAt: 1 })
      .lean();
    // Pull the requester names with a SINGLE query (not N+1) and only
    // pick the fields the queue UI needs.
    const userIds = [...new Set((rows || []).map((row) => idOf(row.userId)))];
    const users = userIds.length
      ? await UserModel.find({ _id: { $in: userIds } })
          .select('name email')
          .lean()
      : [];
    const userMap = new Map((users || []).map((u) => [String(u._id), u]));

    return (rows || []).map((row) => {
      const ownerId = idOf(row.userId);
      const owner = userMap.get(String(ownerId)) || null;
      const base = serializeRequest(row, {
        viewerId: idOf(viewer?._id || viewer?.id),
        isReviewer: true,
        today: day,
      });
      // One-word name only; the team page never reads this field, so
      // the email stays out of the queue payload.
      base.requesterName = owner && owner.name ? String(owner.name) : null;
      return base;
    });
  };

  // ── Get one ─────────────────────────────────────────

  const getRequest = async ({
    companyId,
    viewer,
    requestId,
    asReviewer = false,
    today = null,
  }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!viewer) throw new Error('viewer is required');
    const config = await tenantConfigReader({ companyId });
    const day = today || dayKeyInZone(clock(), config?.timezone);
    const row = await RequestModel.findOne({
      _id: requestId,
      companyId,
    }).lean();
    if (!row) throw ApiError.notFound('Work-location request not found');
    const ownerId = idOf(row.userId);
    const viewerId = idOf(viewer?._id || viewer?.id);
    const isOwner = ownerId === viewerId;
    if (!isOwner) {
      if (!asReviewer) throw ApiError.notFound('Work-location request not found');
      const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
      if (!scopeIds.includes(String(ownerId))) {
        throw ApiError.forbidden('This employee is not in your team');
      }
    }
    return serializeRequest(row, {
      viewerId,
      isReviewer: asReviewer,
      today: day,
    });
  };

  // ── Decide (approve / reject) ───────────────────────

  const decideRequest = async ({
    companyId,
    viewer,
    requestId,
    action,
    decisionNote = null,
    today = null,
  }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!viewer) throw new Error('viewer is required');
    if (action !== 'approve' && action !== 'reject') {
      throw ApiError.badRequest('action must be "approve" or "reject"');
    }
    const noteError = validateDecisionNote(decisionNote);
    if (noteError) throw ApiError.badRequest(noteError);
    const trimmedNote = trimOrNull(decisionNote);

    const config = await tenantConfigReader({ companyId });
    const day = today || dayKeyInZone(clock(), config?.timezone);
    const reviewerId = idOf(viewer?._id || viewer?.id);

    const row = await RequestModel.findOne({ _id: requestId, companyId });
    if (!row) throw ApiError.notFound('Work-location request not found');

    const eligibility = reviewEligibility(row, reviewerId);
    if (eligibility) {
      const gone = row.status !== REQUEST_STATUS.PENDING;
      throw gone ? ApiError.conflict(eligibility) : ApiError.forbidden(eligibility);
    }

    // Server-side scope check (manager / HR / admin only).
    const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
    if (!scopeIds.includes(String(row.userId))) {
      throw ApiError.forbidden('This employee is not in your team');
    }

    // Re-validate policy at decision time.
    const policyRefusal = requestPolicyCheck(config);
    if (policyRefusal) throw ApiError.conflict(policyRefusal);

    // Re-validate overlap (a second PENDING may have been created in
    // the gap between submit and decide).
    const existing = await RequestModel.find({
      companyId,
      userId: row.userId,
      status: { $in: [REQUEST_STATUS.PENDING, REQUEST_STATUS.APPROVED] },
      _id: { $ne: row._id },
    }).lean();
    const candidate = {
      companyId,
      userId: idOf(row.userId),
      startDate: row.startDate,
      endDate: row.endDate,
    };
    const overlap = findOverlappingRequest(candidate, existing);
    if (overlap) {
      throw ApiError.conflict(
        `Overlaps an existing ${overlap.status} request (${overlap.startDate} → ${overlap.endDate})`,
      );
    }

    const to = action === 'approve' ? REQUEST_STATUS.APPROVED : REQUEST_STATUS.REJECTED;
    const decidedAt = clock();

    // Atomic state transition: the filter includes `status: 'pending'`
    // so a parallel decide or a parallel cancel can never win twice.
    const updated = await RequestModel.findOneAndUpdate(
      { _id: row._id, companyId, status: REQUEST_STATUS.PENDING },
      {
        $set: {
          status: to,
          reviewedAt: decidedAt,
          reviewedBy: reviewerId,
          decisionNote: trimmedNote,
        },
      },
      { new: true },
    );
    if (!updated) {
      throw ApiError.conflict('Request is no longer pending');
    }

    await audit({
      action:
        action === 'approve'
          ? 'PRESENCE_WORK_MODE_REQUEST_APPROVED'
          : 'PRESENCE_WORK_MODE_REQUEST_REJECTED',
      resource: 'WorkLocationRequest',
      resourceId: String(row._id),
      companyId,
      actorId: reviewerId,
      targetUserId: idOf(row.userId),
      newValue: {
        from: REQUEST_STATUS.PENDING,
        to,
        startDate: row.startDate,
        endDate: row.endDate,
        location: 'wfh',
      },
    });

    await safeNotify(notify, idOf(row.userId), {
      title:
        action === 'approve'
          ? 'WFH request approved'
          : 'WFH request rejected',
      message: `Your WFH request (${row.startDate} → ${row.endDate}) was ${
        action === 'approve' ? 'approved' : 'rejected'
      } by ${viewer?.name || 'your reviewer'}`,
      link: '/app/presence/work-location-requests',
      category: 'PRESENCE',
    });

    // Best-effort realtime invalidation. Failure is logged and swallowed.
    if (action === 'approve') {
      await safePublish(publishInvalidation, {
        companyId,
        userId: idOf(row.userId),
        source: 'approve',
      });
    }

    return serializeRequest(updated, { viewerId: reviewerId, isReviewer: true, today: day });
  };

  // ── Cancel ──────────────────────────────────────────

  const cancelRequest = async ({
    companyId,
    viewer,
    requestId,
    today = null,
  }) => {
    if (!companyId) throw new Error('companyId is required');
    if (!viewer) throw new Error('viewer is required');
    const config = await tenantConfigReader({ companyId });
    const day = today || dayKeyInZone(clock(), config?.timezone);
    const actorId = idOf(viewer?._id || viewer?.id);

    const row = await RequestModel.findOne({ _id: requestId, companyId });
    if (!row) throw ApiError.notFound('Work-location request not found');

    const ownerId = idOf(row.userId);
    const isOwner = ownerId === actorId;
    let isReviewer = false;
    if (!isOwner) {
      const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
      isReviewer = scopeIds.includes(String(ownerId));
    }

    const eligibility = cancelEligibility(row, {
      isOwner,
      isReviewer,
      today: day,
    });
    if (eligibility) {
      const gone = !(
        row.status === REQUEST_STATUS.PENDING ||
        row.status === REQUEST_STATUS.APPROVED
      );
      throw gone ? ApiError.conflict(eligibility) : ApiError.forbidden(eligibility);
    }

    const fromStatus = row.status;
    const updated = await RequestModel.findOneAndUpdate(
      { _id: row._id, companyId, status: fromStatus },
      {
        $set: {
          status: REQUEST_STATUS.CANCELLED,
          cancelledAt: clock(),
          cancelledBy: actorId,
        },
      },
      { new: true },
    );
    if (!updated) {
      throw ApiError.conflict('Request is no longer cancellable');
    }

    await audit({
      action: 'PRESENCE_WORK_MODE_REQUEST_CANCELLED',
      resource: 'WorkLocationRequest',
      resourceId: String(row._id),
      companyId,
      actorId,
      targetUserId: ownerId,
      newValue: {
        from: fromStatus,
        to: REQUEST_STATUS.CANCELLED,
        startDate: row.startDate,
        endDate: row.endDate,
        location: 'wfh',
      },
    });

    // Notify the OTHER side (owner when reviewer cancels, reviewer
    // when owner cancels).
    const otherUserId = isOwner ? idOf(row.reviewedBy) : ownerId;
    if (otherUserId) {
      await safeNotify(notify, otherUserId, {
        title: 'WFH request cancelled',
        message: `WFH request (${row.startDate} → ${row.endDate}) was cancelled by ${
          isOwner ? 'the requester' : viewer?.name || 'a reviewer'
        }`,
        link: '/app/presence/work-location-requests',
        category: 'PRESENCE',
      });
    }

    // Best-effort realtime invalidation if we cancelled an
    // APPROVED request — connected viewers need to see the row
    // revert.
    if (fromStatus === REQUEST_STATUS.APPROVED) {
      await safePublish(publishInvalidation, {
        companyId,
        userId: ownerId,
        source: 'cancel',
      });
    }

    return serializeRequest(updated, {
      viewerId: actorId,
      isReviewer: isReviewer && !isOwner,
      today: day,
    });
  };

  // ── Resolver helper ─────────────────────────────────
  // Returns the date string an APPROVED request covers for the given
  // user on a given day, or null. Used by the resolver in
  // 37.5+37.6 — this turn does not yet wire it into the resolver
  // because the spec asks the workflow to run BEFORE the resolver
  // precedence is updated (plan §A.1 says approved WFH activates
  // for the applicable period; the activation path is the explicit
  // `findAuthorization` lookup below). The HTTP path itself is the
  // authoritative read; the resolver will call this in 37.6.

  const findActiveApproval = async ({ companyId, userId, date }) => {
    if (!companyId || !userId || !date) return null;
    const row = await RequestModel.findOne({
      companyId,
      userId,
      status: REQUEST_STATUS.APPROVED,
      startDate: { $lte: date },
      endDate: { $gte: date },
    })
      .sort({ decidedAt: -1 })
      .lean();
    if (!row) return null;
    return {
      id: String(row._id),
      startDate: row.startDate,
      endDate: row.endDate,
      reviewedAt:
        row.reviewedAt instanceof Date
          ? row.reviewedAt.toISOString()
          : row.reviewedAt || null,
    };
  };

  return {
    submitRequest,
    listMyRequests,
    listReviewQueue,
    getRequest,
    decideRequest,
    cancelRequest,
    findActiveApproval,
  };
};

export default workLocationRequestService();
