// ─────────────────────────────────────────────────────────────
// Requisition service — Phase 27.1 / 27.2
// Holds the state machine, reference-code generation and the
// permission-aware tenant scope. Controllers stay thin.
// ─────────────────────────────────────────────────────────────
import JobRequisition from '../../models/JobRequisition.js';
import ApiError from '../../utils/ApiError.js';
import { hasPermission } from '../../utils/permissionService.js';

export const DECISIONS = ['APPROVE', 'REJECT', 'SEND_BACK'];

const DECISION_TARGET = {
  APPROVE: 'APPROVED',
  REJECT: 'REJECTED',
  SEND_BACK: 'SENT_BACK',
};

// Statuses the requester is still allowed to edit.
export const EDITABLE_STATUSES = ['DRAFT', 'SENT_BACK'];

// Statuses HR can act on.
export const REVIEWABLE_STATUSES = ['SUBMITTED', 'PENDING_HR'];

export const buildHistoryEntry = ({ req, action, fromStatus, toStatus, reason = '' }) => ({
  action,
  fromStatus,
  toStatus,
  actor: req?.user?._id || null,
  actorName: req?.user?.name || '',
  actorRole: req?.user?.role || '',
  reason,
  at: new Date(),
});

// JR-2026-0007 — unique per company, retried on collision.
export const generateRequisitionCode = async (companyId) => {
  const year = new Date().getFullYear();

  const prefix = `JR-${year}-`;

  const last = await JobRequisition.findOne({
    companyId,
    code: { $regex: `^${prefix}` },
  })
    .sort({ code: -1 })
    .select('code')
    .lean();

  const lastSeq = last ? Number(String(last.code).split('-')[2]) || 0 : 0;

  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`;
};

/*
 * Scope rule (RBAC, backend enforced):
 *   REQUISITION_READ       → every requisition of the company
 *   REQUISITION_READ_SELF  → only the ones the user raised
 * Company scope always comes from req.companyId.
 */
export const buildScopeFilter = async (req, extra = {}) => {
  const filter = { companyId: req.companyId, ...extra };

  const canReadAll = await hasPermission(req.user, 'REQUISITION_READ');

  if (!canReadAll) {
    filter.requester = req.user._id;
  }

  return filter;
};

export const findRequisitionOr404 = async (req, id, { lean = false } = {}) => {
  const query = JobRequisition.findOne({ _id: id, companyId: req.companyId });

  const requisition = lean ? await query.lean() : await query;

  if (!requisition) throw ApiError.notFound('Requisition not found');

  return requisition;
};

export const assertCanView = async (req, requisition) => {
  const canReadAll = await hasPermission(req.user, 'REQUISITION_READ');

  const isOwner = String(requisition.requester?._id || requisition.requester) === String(req.user._id);

  if (!canReadAll && !isOwner) {
    throw ApiError.forbidden('You can only view hiring requests you raised');
  }
};

export const assertCanEdit = async (req, requisition) => {
  const isOwner = String(requisition.requester) === String(req.user._id);

  const canUpdateAny = await hasPermission(req.user, 'REQUISITION_UPDATE');

  if (!isOwner && !canUpdateAny) {
    throw ApiError.forbidden('You can only edit hiring requests you raised');
  }

  if (!EDITABLE_STATUSES.includes(requisition.status)) {
    throw ApiError.badRequest(
      `A ${requisition.status.replace('_', ' ').toLowerCase()} request can no longer be edited`,
    );
  }
};

export const assertCanSubmit = (req, requisition) => {
  if (String(requisition.requester) !== String(req.user._id)) {
    throw ApiError.forbidden('Only the requester can submit this hiring request');
  }

  if (!EDITABLE_STATUSES.includes(requisition.status)) {
    throw ApiError.badRequest('This hiring request was already submitted');
  }

  if (!requisition.position || !requisition.openings) {
    throw ApiError.badRequest('Position and number of openings are required before submitting');
  }
};

export const assertCanDecide = (requisition, decision) => {
  if (!DECISIONS.includes(decision)) {
    throw ApiError.badRequest('Invalid decision');
  }

  if (!REVIEWABLE_STATUSES.includes(requisition.status)) {
    throw ApiError.badRequest(
      `This request is already ${requisition.status.replace('_', ' ').toLowerCase()}`,
    );
  }

  return DECISION_TARGET[decision];
};

export const summarise = (rows = []) => {
  const counts = {
    DRAFT: 0,
    PENDING_HR: 0,
    APPROVED: 0,
    REJECTED: 0,
    SENT_BACK: 0,
    CLOSED: 0,
    total: 0,
    openings: 0,
  };

  rows.forEach((row) => {
    const key = row.status === 'SUBMITTED' ? 'PENDING_HR' : row.status;

    if (counts[key] !== undefined) counts[key] += 1;

    counts.total += 1;

    if (['PENDING_HR', 'SUBMITTED', 'APPROVED'].includes(row.status)) {
      counts.openings += row.openings || 0;
    }
  });

  return counts;
};

export default {
  DECISIONS,
  EDITABLE_STATUSES,
  REVIEWABLE_STATUSES,
  generateRequisitionCode,
  buildScopeFilter,
  buildHistoryEntry,
  findRequisitionOr404,
  assertCanView,
  assertCanEdit,
  assertCanSubmit,
  assertCanDecide,
  summarise,
};
