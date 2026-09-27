// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.3 — CHAT MENTION SERVICE (resolve · store · notify)
//
//  Called by the ONE write path (chatMessageService.persistMessage) before a
//  message is created, and by nothing else. It answers two questions:
//
//    1. MAY these people be mentioned?  → resolveMentions
//       Every id must resolve to a user in the SAME company who IS a member of
//       THIS conversation. Anything else refuses the whole send with
//       VALIDATION_ERROR: you cannot ping somebody who cannot read the message,
//       and an id from another tenant must not be a way to test whether that id
//       exists. One query answers both (the tenant filter and the $in).
//
//    2. WHICH of them get told?  → notifyMentionedUsers
//       In-app only (no email: utils/notifySmart queues email and is therefore
//       deliberately NOT used here), the actor is excluded, the payload has NO
//       message text, and the whole thing is best-effort — a notification
//       failure must never fail a send, exactly like utils/notify.js.
//
//  PRIVACY POSTURE
//    · the notification carries a title, the actor's name, a conversation
//      label and a frontend link. Never the body: a notification row would
//      otherwise be a SECOND copy of user content living outside the chat
//      collection, with a different retention story.
//    · nothing here records who read a mention, when, or whether they looked.
//      A mention is an event about a message, never an observation of a person.
// ═══════════════════════════════════════════════════════════════════════════

import User from '../../models/User.js';
import logger from '../../config/logger.js';
import { notifyUsers } from '../../utils/notify.js';
import {
  CHAT_MENTION_MAX_PER_MESSAGE,
  mentionTokenFor,
  tokenAppearsInText,
} from '../../utils/chatMentionRules.js';

export const CHAT_MENTION_MESSAGES = Object.freeze({
  NOT_A_MEMBER: 'You can only mention people who are in this conversation.',
  UNKNOWN:
    'One of the people you mentioned could not be found. Refresh the conversation and try again.',
  TOO_MANY: `A message can mention at most ${CHAT_MENTION_MAX_PER_MESSAGE} people.`,
});

/** The frontend route a mention notification opens. Ids only — no tokens, no PII. */
export const chatConversationLink = (conversationId) => `/app/chat/${String(conversationId)}`;

/**
 * Resolve the ids a sender asked to mention into the rows that will be STORED.
 *
 * Returns:
 *   { ok:true, mentions:[{ userId, token }] }  — possibly FEWER than asked:
 *        an id that resolves to a member, but whose visible token is not in the
 *        body, is dropped (the visibility rule in chatMentionRules).
 *   { ok:false, code:'VALIDATION_ERROR', message } — an id that is unknown,
 *        from another tenant, or not a member of this conversation.
 *
 * No work at all when the sender mentioned nobody: the query is skipped, so a
 * normal send costs exactly what it cost before this unit.
 */
export const resolveMentions = async ({
  companyId,
  conversation,
  text,
  mentionUserIds = [],
  // The sender, included in the SAME lookup so the notification can name them
  // without a second round trip.
  actorUserId = null,
  // Injectable for hermetic tests; the default is the real tenant-scoped lookup.
  findUsers = (filter) => User.find(filter).select('_id name status').lean(),
}) => {
  const ids = [...new Set((mentionUserIds ?? []).map((value) => String(value ?? '')))].filter(
    Boolean
  );

  if (ids.length === 0) return { ok: true, mentions: [], actorName: null };

  if (ids.length > CHAT_MENTION_MAX_PER_MESSAGE) {
    return { ok: false, code: 'VALIDATION_ERROR', message: CHAT_MENTION_MESSAGES.TOO_MANY };
  }

  // ONE query: the tenant filter and the $in together, with the sender riding
  // along. An id that is not in this company simply does not come back — the
  // same shape as an id that does not exist, so this cannot be used to probe
  // another tenant.
  const lookupIds = actorUserId ? [...new Set([...ids, String(actorUserId)])] : ids;

  const users = (await findUsers({ _id: { $in: lookupIds }, companyId })) ?? [];

  const byId = new Map((users ?? []).map((user) => [String(user._id), user]));

  const actorName = actorUserId ? byId.get(String(actorUserId))?.name ?? null : null;

  const memberIds = new Set(
    (conversation?.members ?? []).map((member) => String(member.userId ?? member))
  );

  const mentions = [];

  for (const id of ids) {
    const user = byId.get(id);

    // Unknown id, or a user of another company: refuse the whole send. This is
    // the safer policy in 34.3 — a client that sends a foreign id is either
    // buggy or probing, and neither should silently half-succeed.
    if (!user) {
      return { ok: false, code: 'VALIDATION_ERROR', message: CHAT_MENTION_MESSAGES.UNKNOWN };
    }

    // The anti-ping rule: mentioning somebody who cannot read this conversation
    // would notify them about a message they can never open.
    if (!memberIds.has(id)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: CHAT_MENTION_MESSAGES.NOT_A_MEMBER,
      };
    }

    const token = mentionTokenFor(user.name);

    // The visibility rule: only a mention the reader can SEE is stored (and
    // therefore only a visible mention can ever notify).
    if (!tokenAppearsInText(text, token)) continue;

    mentions.push({ userId: user._id, token });
  }

  return { ok: true, mentions, actorName };
};

/**
 * In-app notification for everyone who was mentioned, minus the actor.
 *
 * Best-effort by construction: notifyUsers never throws, and this function
 * still guards, because a chat send must not be able to fail because a bell
 * could not ring. Called ONLY for a genuinely created message — an idempotent
 * retry re-uses the stored row and must not notify twice.
 */
export const notifyMentionedUsers = async ({
  companyId,
  conversation,
  mentions = [],
  actorUserId,
  actorName = null,
}) => {
  const recipients = (mentions ?? [])
    .map((mention) => String(mention.userId))
    .filter((userId) => userId && userId !== String(actorUserId));

  if (recipients.length === 0) return 0;

  const where = conversation?.type === 'DIRECT'
    ? 'a direct message'
    : conversation?.title
      ? `"${conversation.title}"`
      : 'a conversation';

  const who = actorName || 'A colleague';

  try {
    // No body text, ever — see the privacy note in the file header.
    await notifyUsers(companyId, recipients, {
      type: 'CHAT',
      title: 'You were mentioned in chat',
      message: `${who} mentioned you in ${where}`,
      link: chatConversationLink(conversation?._id ?? conversation?.id),
    });
  } catch (error) {
    // notifyUsers swallows its own failures; this is defense in depth only.
    logger.warn(`[ChatMention] notify failed (${String(error?.name || 'error')})`);
  }

  return recipients.length;
};
