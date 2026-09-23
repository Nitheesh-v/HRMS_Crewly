// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.7 — READ MARKERS + UNREAD COUNTS (C1 read cursor model)
//
//  WHAT THIS IS
//    The conversation-level read cursor: each member entry on
//    ChatConversation carries lastReadSeq; unread for the requesting member
//    is lastMessageSeq minus their effective cursor. Cursors scale with
//    members; there are NO per-message receipt arrays anywhere (a readBy
//    array would scale with readers × messages — the wrong shape).
//
//  C1 FORMULA (repo truth, ChatConversation model header)
//    effectiveRead = max(lastReadSeq ?? 0, joinedAtSeq ?? 0)
//    unreadCount   = max(0, lastMessageSeq - effectiveRead)
//    joinedAtSeq matters so a late joiner is never shown the entire backlog
//    as unread (addMembers seeds both at join time; the max is the
//    defense-in-depth the 33.2 model header promises).
//
//  MONOTONIC + CLAMPED
//    lastReadSeq can only increase, and never past lastMessageSeq ("reading
//    past the end" is meaningless and would break the C1 invariant). The
//    write is read → compute → positional $set, and if a concurrent writer
//    (same user, second device) moved the cursor in between, we re-read and
//    retry ONCE — bounded, never a loop. Mongo stays authoritative; no
//    Redis involvement.
//
//  PRIVACY
//    sanitizeConversationForMember strips every member's lastReadSeq /
//    joinedAtSeq before a conversation leaves the service: another person's
//    read state is privacy-sensitive and would become presence-ish
//    surveillance. The caller's own cursor is re-exposed as myLastReadSeq.
//    Read state is never broadcast on the socket either (33.7's
//    chat:readUpTo ACKs to the sender only).
// ═══════════════════════════════════════════════════════════════════════════

import ChatConversation from '../../models/ChatConversation.js';

// Pure C1 computation, exported for hermetic tests.
export const computeUnreadCount = ({ lastMessageSeq, lastReadSeq, joinedAtSeq }) => {
  const end = Math.max(0, Number(lastMessageSeq ?? 0) || 0);
  const read = Math.max(
    0,
    Number(lastReadSeq ?? 0) || 0,
    Number(joinedAtSeq ?? 0) || 0
  );

  return Math.max(0, end - read);
};

// Read-side projection: keep membership bookkeeping (userId, role, joinedAt)
// but never another member's cursor. Adds the caller's own cursor + the C1
// unread count at the top level.
export const sanitizeConversationForMember = (conversation, userId) => {
  const members = Array.isArray(conversation.members) ? conversation.members : [];
  const mine = members.find((member) => String(member.userId) === String(userId));

  const myLastReadSeq = mine?.lastReadSeq ?? 0;
  const lastMessageSeq = conversation.lastMessageSeq ?? 0;

  return {
    ...conversation,
    members: members.map(({ lastReadSeq, joinedAtSeq, ...rest }) => rest),
    myLastReadSeq,
    lastMessageSeq,
    unreadCount: computeUnreadCount({
      lastMessageSeq,
      lastReadSeq: myLastReadSeq,
      joinedAtSeq: mine?.joinedAtSeq,
    }),
  };
};

// Monotonic, clamped, tenant- and membership-scoped cursor advance.
// Returns { ok:true, conversationId, myLastReadSeq, lastMessageSeq,
//           unreadCount }
// or { ok:false, code:'NOT_FOUND_OR_FORBIDDEN' } — the miss shape reveals
// nothing about tenant or existence.
export const updateReadMarker = async ({
  companyId,
  userId,
  conversationId,
  lastReadSeq,
}) => {
  const attempt = async () => {
    const conversation = await ChatConversation.findOne({
      _id: conversationId,
      companyId,
      'members.userId': userId,
    }).lean();

    if (!conversation) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

    const lastMessageSeq = conversation.lastMessageSeq ?? 0;
    const mine = conversation.members.find(
      (member) => String(member.userId) === String(userId)
    );
    const current = mine?.lastReadSeq ?? 0;

    // Clamp to the end of the conversation, then keep the higher of the two
    // so the cursor can never move backwards.
    const target = Math.min(Math.max(0, lastReadSeq), lastMessageSeq);
    const next = Math.max(current, target);

    if (next > current) {
      await ChatConversation.updateOne(
        { _id: conversationId, companyId, 'members.userId': userId },
        { $set: { 'members.$.lastReadSeq': next } }
      );
    }

    // Re-read the cursor: a concurrent writer on another device may have
    // advanced it further; the C1 count must reflect the stored truth.
    const refreshed = await ChatConversation.findOne({
      _id: conversationId,
      companyId,
      'members.userId': userId,
    }).lean();

    const stored = refreshed?.members.find(
      (member) => String(member.userId) === String(userId)
    )?.lastReadSeq ?? next;

    return {
      ok: true,
      conversationId,
      myLastReadSeq: stored,
      lastMessageSeq: refreshed?.lastMessageSeq ?? lastMessageSeq,
      unreadCount: computeUnreadCount({
        lastMessageSeq: refreshed?.lastMessageSeq ?? lastMessageSeq,
        lastReadSeq: stored,
        joinedAtSeq: mine?.joinedAtSeq,
      }),
    };
  };

  const first = await attempt();

  if (!first.ok) return first;

  // Bounded monotonic retry: if a concurrent device left the stored cursor
  // below what this call intended (it can only be above), apply once more.
  if (first.myLastReadSeq < Math.min(Math.max(0, lastReadSeq), first.lastMessageSeq)) {
    return attempt();
  }

  return first;
};
