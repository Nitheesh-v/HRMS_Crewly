// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.1 — CHAT MESSAGE REACTIONS (Mongo-authoritative service)
//
//  The single write/read path for reactions, called by the Socket.IO handlers
//  (chat:message:react / chat:message:unreact) and by the REST history
//  projection (chatService.listMessages). Authority ({ companyId, userId })
//  always comes from the authenticated principal, never from the payload.
//
//  RULES
//    · membership + tenant + disabled, checked first (loadWritableConversation)
//      — reaction is a WRITE, so a disabled conversation refuses it exactly
//      like send/edit; history stays readable.
//    · the message must exist, inside THIS tenant and THIS conversation, and
//      must not be a tombstone. Reacting to a deleted message is refused
//      (MESSAGE_DELETED); the read path also hides reactions of tombstones, so
//      a delete is a delete.
//    · IDEMPOTENT: reacting twice with the same type writes nothing, broadcasts
//      nothing and ACKs with the CURRENT summary (changed:false). Two tabs
//      racing the same click is a duplicate-key no-op, not a second row — the
//      unique index, not the service, is the guarantee.
//    · REPLACE, not accumulate: CHAT_REACTION_MAX_PER_USER_PER_MESSAGE is 1, so
//      picking another type deletes the previous row and inserts the new one,
//      and the broadcast says so (action REPLACED with the previous type).
//    · CAPPED: after a successful insert the service counts the message's rows
//      and rolls its own row back if CHAT_REACTION_MAX_PER_MESSAGE is crossed.
//      The cap is a safety valve, not a transaction — documented as such; the
//      real bound is conversation membership.
//    · NEVER a body: a reaction carries no text, is never editable, and is
//      never written to logs, metrics or a preview field.
//
//  SUMMARY SHAPE (one definition, two consumers)
//    summarizeReactions returns Map<messageId, [{ type, count, mine }]>.
//      · REST history sends exactly that (viewer-aware `mine`).
//      · the socket broadcast sends a VIEWER-NEUTRAL form — { type, count } —
//        plus actorUserId/action/reactionType, because one room broadcast
//        cannot carry a different `mine` for every member. The client derives
//        `mine` from the ACK (its own action) or from actorUserId.
//
//  This is NOT presence. Nothing here records when a user was last active,
//  whether they are online, or that they are typing. A reaction is an event
//  about a message; it is never an event about a person.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import ChatMessage from '../../models/ChatMessage.js';
import ChatMessageReaction, {
  CHAT_REACTION_MAX_PER_MESSAGE,
  CHAT_REACTION_MAX_PER_USER_PER_MESSAGE,
  CHAT_REACTION_SUMMARY_ROW_LIMIT,
  CHAT_REACTION_TYPES,
} from '../../models/ChatMessageReaction.js';
import { loadWritableConversation } from './chatMessageService.js';

export {
  CHAT_REACTION_MAX_PER_MESSAGE,
  CHAT_REACTION_MAX_PER_USER_PER_MESSAGE,
  CHAT_REACTION_TYPES,
};

/** Stable action vocabulary for the broadcast + ACK (never human wording). */
export const CHAT_REACTION_ACTIONS = Object.freeze({
  ADDED: 'ADDED',
  REMOVED: 'REMOVED',
  REPLACED: 'REPLACED',
});

const asId = (value) =>
  mongoose.isValidObjectId(String(value ?? '')) ? new mongoose.Types.ObjectId(String(value)) : null;

/** Belt-and-braces: the validators already gate this, the service re-checks. */
export const isReactionType = (value) => CHAT_REACTION_TYPES.includes(String(value ?? ''));

/**
 * Build the per-message reaction summary for a set of messages.
 *
 * `mine` is per-viewer, so it is computed server-side against the caller's own
 * id — the REST history response can therefore carry it directly, and no
 * client has to guess.
 *
 * Bounded: only ids, three fields per row, and an explicit row limit. A page
 * with no reactions costs one empty query (which the callers skip entirely by
 * passing an empty list).
 */
export const summarizeReactions = async ({
  companyId,
  messageIds,
  viewerUserId = null,
}) => {
  const summary = new Map();

  const ids = (Array.isArray(messageIds) ? messageIds : [])
    .map(asId)
    .filter(Boolean);

  const company = asId(companyId);

  if (ids.length === 0 || !company) return summary;

  const viewer = asId(viewerUserId);

  const rows = await ChatMessageReaction.find({
    companyId: company,
    messageId: { $in: ids },
  })
    .select('messageId userId reactionType')
    .limit(CHAT_REACTION_SUMMARY_ROW_LIMIT)
    .lean();

  for (const row of rows ?? []) {
    const key = String(row.messageId);
    const list = summary.get(key) ?? [];

    let group = list.find((entry) => entry.type === row.reactionType);

    if (!group) {
      group = { type: row.reactionType, count: 0, mine: false };
      list.push(group);
    }

    group.count += 1;

    if (viewer && String(row.userId) === String(viewer)) group.mine = true;

    summary.set(key, list);
  }

  // Stable, type-ordered output so two callers cannot disagree on ordering.
  for (const [key, list] of summary) {
    summary.set(
      key,
      [...list].sort(
        (a, b) => CHAT_REACTION_TYPES.indexOf(a.type) - CHAT_REACTION_TYPES.indexOf(b.type)
      )
    );
  }

  return summary;
};

/** The viewer-neutral projection used by the socket broadcast. */
export const toNeutralSummary = (reactions = []) =>
  (Array.isArray(reactions) ? reactions : []).map((entry) => ({
    type: entry.type,
    count: entry.count,
  }));

/**
 * Resolve the two documents every reaction write needs, in the same order and
 * with the same refusal codes for add and remove (so neither can be used as a
 * tenant/ membership probe). Returns { conversation } or { ok:false, code }.
 */
const loadReactableMessage = async ({ companyId, userId, conversationId, messageId }) => {
  const conversation = await loadWritableConversation({ companyId, userId, conversationId });

  if (!conversation) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  if (conversation.isDisabled) return { ok: false, code: 'CONVERSATION_DISABLED' };

  const message = await ChatMessage.findOne({
    _id: messageId,
    companyId,
    conversationId,
  })
    .select('deletedAt type')
    .lean();

  if (!message) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  if (message.deletedAt) return { ok: false, code: 'MESSAGE_DELETED' };

  return { ok: true, conversation };
};

/** One user's rows on one message (bounded by the per-user cap). */
const myReactionRows = async ({ companyId, messageId, userId }) =>
  (await ChatMessageReaction.find({ companyId, messageId, userId })
    .select('reactionType')
    .lean()) ?? [];

const summaryFor = async ({ companyId, messageId, viewerUserId }) => {
  const map = await summarizeReactions({
    companyId,
    messageIds: [messageId],
    viewerUserId,
  });

  return map.get(String(messageId)) ?? [];
};

export const reactToMessage = async ({
  companyId,
  userId,
  conversationId,
  messageId,
  reactionType,
}) => {
  if (!isReactionType(reactionType)) return { ok: false, code: 'VALIDATION_ERROR' };

  const loaded = await loadReactableMessage({ companyId, userId, conversationId, messageId });

  if (!loaded.ok) return loaded;

  const mine = await myReactionRows({ companyId, messageId, userId });

  const alreadyHeld = mine.some((row) => row.reactionType === reactionType);

  // Idempotent: the reaction is already exactly what the caller asked for.
  // Nothing is written, nothing is broadcast — the ACK carries current truth.
  if (alreadyHeld && CHAT_REACTION_MAX_PER_USER_PER_MESSAGE === 1) {
    return {
      ok: true,
      changed: false,
      action: null,
      previousReaction: reactionType,
      myReaction: reactionType,
      reactions: await summaryFor({ companyId, messageId, viewerUserId: userId }),
    };
  }

  const previousReaction = mine[0]?.reactionType ?? null;

  // Replace semantics: a user holds at most CHAT_REACTION_MAX_PER_USER_PER_
  // MESSAGE rows here, so any other type this user previously chose goes away.
  if (CHAT_REACTION_MAX_PER_USER_PER_MESSAGE === 1) {
    await ChatMessageReaction.deleteMany({
      companyId,
      messageId,
      userId,
      reactionType: { $ne: reactionType },
    });
  }

  try {
    await ChatMessageReaction.updateOne(
      { companyId, messageId, userId, reactionType },
      { $setOnInsert: { conversationId } },
      { upsert: true }
    );
  } catch (error) {
    // A concurrent identical reaction won the upsert: that is the same
    // reaction, so it is success, not a failure. Anything else is retryable.
    if (error?.code !== 11000) return { ok: false, code: 'RETRYABLE' };
  }

  const total = await ChatMessageReaction.countDocuments({ companyId, messageId });

  if (total > CHAT_REACTION_MAX_PER_MESSAGE) {
    // The cap is a guard, not a transaction: undo this row and refuse. Two
    // simultaneous writers may briefly sit one row over, which is harmless.
    await ChatMessageReaction.deleteOne({ companyId, messageId, userId, reactionType });

    return { ok: false, code: 'REACTION_LIMIT_REACHED' };
  }

  return {
    ok: true,
    changed: true,
    action: previousReaction ? CHAT_REACTION_ACTIONS.REPLACED : CHAT_REACTION_ACTIONS.ADDED,
    previousReaction,
    myReaction: reactionType,
    reactions: await summaryFor({ companyId, messageId, viewerUserId: userId }),
  };
};

export const unreactFromMessage = async ({
  companyId,
  userId,
  conversationId,
  messageId,
  reactionType,
}) => {
  if (!isReactionType(reactionType)) return { ok: false, code: 'VALIDATION_ERROR' };

  const loaded = await loadReactableMessage({ companyId, userId, conversationId, messageId });

  if (!loaded.ok) return loaded;

  const removed = await ChatMessageReaction.deleteOne({
    companyId,
    messageId,
    userId,
    reactionType,
  });

  const changed = Number(removed?.deletedCount ?? 0) > 0;

  // Read the caller's remaining rows rather than assuming none: with the cap
  // widened later, "one type removed" would not mean "no reaction left".
  const remaining = await myReactionRows({ companyId, messageId, userId });

  const myReaction = remaining[0]?.reactionType ?? null;

  return {
    ok: true,
    changed,
    action: changed ? CHAT_REACTION_ACTIONS.REMOVED : null,
    previousReaction: changed ? reactionType : null,
    myReaction,
    reactions: await summaryFor({ companyId, messageId, viewerUserId: userId }),
  };
};
