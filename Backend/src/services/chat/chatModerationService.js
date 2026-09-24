// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.9 — CHAT MODERATION + ADMIN CONTROLS (service layer)
//
//  WHAT THIS IS
//    The company-level moderation layer on top of the 33.2/33.3/33.6
//    primitives:
//      · disable / re-enable a conversation (blocks send/edit/delete for
//        non-moderators; history stays readable — a read-only lock),
//      · moderator tombstone-delete of ANY message (the sender-only rule is
//        bypassed only for CHAT_MODERATE holders, via tombstoneMessage's
//        moderator flag in chatEditService),
//      · an audit trail for every moderation action.
//
//  AUTHORIZATION
//    CHAT_MODERATE (Phase 33.9 catalogue entry, SYSTEM_PERMISSION_VERSION
//    37) gates everything here. Membership is NOT required for moderators —
//    tenant scope (companyId) + the permission is the gate, resolved through
//    the repo's hasPermission (role matrices / custom roles), never through
//    client-supplied data. Group membership management (add/remove members)
//    keeps its 33.2 in-group ADMIN rule and ADDITIONALLY accepts
//    CHAT_GROUP_MANAGE — that bypass lives in chatService.js.
//
//  AUDIT SEMANTICS (privacy)
//    Every action writes one AuditLog entry: ids + metadata only. Message
//    TEXT never enters the audit (the tombstone itself nulls the text in
//    ChatMessage; the audit stores messageId/conversationId + a bounded
//    reason ≤ 200 chars). Audit writes are best-effort: a failed audit must
//    not mask a successful moderation action, but the failure IS logged.
//
//  HERMETIC TESTING
//    checkPermission / audit are injectable (repo pattern:
//    companyBrandingService) so node:test runs need no Mongo, no Redis and
//    no role provisioning; model lookups are swapped the same way the other
//    chat tests swap theirs.
// ═══════════════════════════════════════════════════════════════════════════

import AuditLog from '../../models/AuditLog.js';
import ChatConversation from '../../models/ChatConversation.js';
import User from '../../models/User.js';
import ApiError from '../../utils/ApiError.js';
import { hasPermission } from '../../utils/permissionService.js';

import { tombstoneMessage } from './chatEditService.js';

export const CHAT_MODERATION_REASON_MAX = 200;

// Bounded, trimmed, nullable. Raw request strings never reach storage.
export const boundModerationReason = (reason) => {
  const value = String(reason ?? '').trim();
  return value ? value.slice(0, CHAT_MODERATION_REASON_MAX) : null;
};

const defaultAudit = (entry) => AuditLog.create(entry);

// Repo pattern (fnfService/statutoryService): degrade CLOSED on lookup
// failure — a broken permission resolve must never become moderation power.
const defaultCheckPermission = (user, permission, companyId) =>
  hasPermission({ ...user, companyId }, permission).catch(() => false);

// Loads the tenant-scoped actor and resolves one permission for them.
// A missing actor is simply not allowed.
const resolveActor = async ({ companyId, actorId, permission, checkPermission }) => {
  const user = await User.findOne({ _id: actorId, companyId })
    .select('name email role')
    .lean();

  if (!user) return { user: null, allowed: false };

  const allowed = await checkPermission(user, permission, companyId);

  return { user, allowed: Boolean(allowed) };
};

const writeAudit = async ({
  audit,
  log,
  companyId,
  user,
  action,
  targetType,
  targetId,
  previousValue,
  newValue,
  reqMeta,
}) => {
  try {
    await audit({
      companyId,
      actor: user?._id ?? null,
      actorName: user?.name ?? '',
      actorRole: user?.role ?? '',
      action,
      method: reqMeta?.method ?? 'SOCKET',
      path: reqMeta?.path ?? 'chat:moderation',
      statusCode: 200,
      ip: reqMeta?.ip ?? '',
      targetType,
      targetId: targetId ?? null,
      previousValue,
      newValue,
    });
  } catch (error) {
    // Best-effort by design: the moderation action already succeeded and
    // must not be masked. Only the error NAME is logged — never payloads.
    log?.warn?.(
      `[ChatModeration] audit write failed (${String(error?.name || 'error')})`
    );
  }
};

// Shared lock transition. Idempotent: locking a locked conversation (or
// unlocking an open one) returns the current state with changed:false and
// writes no audit row — a retry is not a moderation event.
const setConversationLock = async ({
  companyId,
  actorId,
  conversationId,
  reason = null,
  enable = false,
  checkPermission = defaultCheckPermission,
  audit = defaultAudit,
  log = null,
  reqMeta = null,
}) => {
  const { user, allowed } = await resolveActor({
    companyId,
    actorId,
    permission: 'CHAT_MODERATE',
    checkPermission,
  });

  if (!allowed) throw ApiError.forbidden('Chat moderation permission required.');

  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    companyId,
  }).lean();

  if (!conversation) throw ApiError.notFound('Conversation not found.');

  const wasDisabled = Boolean(conversation.isDisabled);

  if (wasDisabled === !enable) {
    return { conversation, changed: false };
  }

  const updated = await ChatConversation.findOneAndUpdate(
    { _id: conversationId, companyId },
    enable
      ? { $set: { isDisabled: false, disabledAt: null, disabledByUserId: null } }
      : { $set: { isDisabled: true, disabledAt: new Date(), disabledByUserId: actorId } },
    { new: true },
  ).lean();

  await writeAudit({
    audit,
    log,
    companyId,
    user,
    action: enable ? 'CHAT_CONVERSATION_ENABLED' : 'CHAT_CONVERSATION_DISABLED',
    targetType: 'ChatConversation',
    targetId: conversation._id,
    previousValue: { isDisabled: wasDisabled },
    newValue: {
      isDisabled: !enable,
      reason: enable ? null : boundModerationReason(reason),
    },
    reqMeta,
  });

  return { conversation: updated, changed: true };
};

export const disableConversation = (args) =>
  setConversationLock({ ...args, enable: false });

export const enableConversation = (args) =>
  setConversationLock({ ...args, enable: true });

// Socket-path moderator check (injectable so handlers stay hermetic).
export const actorHasChatModerate = async ({
  companyId,
  userId,
  checkPermission = defaultCheckPermission,
}) => {
  const { allowed } = await resolveActor({
    companyId,
    actorId: userId,
    permission: 'CHAT_MODERATE',
    checkPermission,
  });

  return allowed;
};

// Moderator tombstone of ANY message in the tenant. Reuses the 33.6
// tombstone mechanics (idempotent, runValidators, text nulled) through the
// moderator flag; audits exactly once per real change.
export const moderateDeleteMessage = async ({
  companyId,
  actorId,
  conversationId,
  messageId,
  reason = null,
  checkPermission = defaultCheckPermission,
  audit = defaultAudit,
  log = null,
  reqMeta = null,
}) => {
  const { user, allowed } = await resolveActor({
    companyId,
    actorId,
    permission: 'CHAT_MODERATE',
    checkPermission,
  });

  if (!allowed) throw ApiError.forbidden('Chat moderation permission required.');

  const result = await tombstoneMessage({
    companyId,
    deleterUserId: actorId,
    conversationId,
    messageId,
    moderator: true,
  });

  if (!result.ok || !result.changed) return result;

  await writeAudit({
    audit,
    log,
    companyId,
    user,
    action: 'CHAT_MESSAGE_MODERATED_DELETE',
    targetType: 'ChatMessage',
    targetId: result.messageId,
    previousValue: null,
    newValue: {
      conversationId,
      reason: boundModerationReason(reason),
    },
    reqMeta,
  });

  return result;
};
