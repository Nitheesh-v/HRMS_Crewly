// ─────────────────────────────────────────────────────────────
// Recruitment audit writer.
// Writes BOTH:
//   1. RecruitmentEvent — entity timeline (candidate / requisition …)
//   2. AuditLog         — the existing company-wide audit trail
//      (AuditLog requires method + path, so they are always filled)
//
// NEVER throws — an audit failure must not break a hiring action.
// ─────────────────────────────────────────────────────────────
import RecruitmentEvent from '../../models/RecruitmentEvent.js';
import AuditLog from '../../models/AuditLog.js';
import logger from '../../config/logger.js';

const label = (action) =>
  String(action || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

export const recordRecruitmentEvent = async ({
  req = null,
  companyId,
  action,
  entityType,
  entityId = null,
  entityCode = '',
  actor = null,
  actorName = '',
  actorRole = '',
  actorKind = 'USER',
  previousState = null,
  newState = null,
  metadata = {},
}) => {
  try {
    if (!companyId || !action || !entityType) return;

    const resolvedActor = actor || req?.user?._id || null;

    const resolvedName = actorName || req?.user?.name || (actorKind === 'SYSTEM' ? 'Crewly' : '');

    const resolvedRole = actorRole || req?.user?.role || actorKind;

    await RecruitmentEvent.create({
      companyId,
      action,
      entityType,
      entityId,
      entityCode,
      actor: resolvedActor,
      actorName: resolvedName,
      actorRole: resolvedRole,
      actorKind,
      previousState,
      newState,
      metadata,
    });

    await AuditLog.create({
      companyId,
      actor: resolvedActor,
      actorName: resolvedName,
      actorRole: resolvedRole,
      action: label(action),
      // AuditLog requires method + path — always provide safe fallbacks.
      method: req?.method || 'SYSTEM',
      path: req?.originalUrl || `internal:/recruitment/${entityType.toLowerCase()}`,
      statusCode: 200,
      ip: req?.ip || '',
      targetType: entityType,
      targetId: entityId,
      previousValue: previousState,
      newValue: newState,
      metadata: { ...metadata, entityCode, recruitmentAction: action },
      userAgent: req?.headers?.['user-agent'] || '',
    });
  } catch (error) {
    logger.warn(`🗂 recruitment audit failed (${action}): ${error.message}`);
  }
};

export const listRecruitmentEvents = async ({
  companyId,
  entityType,
  entityId,
  limit = 100,
}) =>
  RecruitmentEvent.find({ companyId, entityType, entityId })
    .sort('-createdAt')
    .limit(Math.min(Number(limit) || 100, 500))
    .lean();

export default { recordRecruitmentEvent, listRecruitmentEvents };
