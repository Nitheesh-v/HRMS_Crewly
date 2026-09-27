// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.8-fix — REST → SOCKET LIST-CHANGE NUDGE (data-less)
//
//  WHAT THIS IS
//    A one-way seam that lets the REST chat controllers tell connected
//    sockets "your conversation list changed — refetch it". The event
//    carries NO payload: the Mongo read path (listMyConversations) stays
//    the single source of truth for list content, cursors and unread
//    counts, so the C1 model and the privacy projection are never
//    re-expressed over the wire.
//
//  WHY
//    Socket rooms are joined per OPEN conversation only (33.5), so a
//    member whose window sits on the Chat page — but has not opened the
//    new conversation — would otherwise learn about it on the next manual
//    reload. The nudge targets each affected member's personal room
//    (chatKeys.userRoom), joined at connect time.
//
//  SHAPE / PRIVACY
//    `chat:conversations:changed` with an empty object. No ids, no names,
//    no tokens, no read state — nothing surveillance-shaped (locked 33
//    decision: no presence / typing / last-seen). A client that receives
//    it simply re-runs its list fetch.
//
//  LIFECYCLE
//    initSocketServer attach() binds the live `io`, stop() unbinds it.
//    When chat realtime is disabled or Redis is down the seam is a no-op
//    and REST keeps working unchanged (the 33.1 availability contract).
//    No import-time side effects (repo law): importing this module binds
//    nothing.
// ═══════════════════════════════════════════════════════════════════════════

import { conversationRoom, userRoom } from '../utils/chatKeys.js';

let ioRef = null;

// Called by initSocketServer.attach() once Socket.IO is live.
export const bindRealtimeNudge = (io) => {
  ioRef = io ?? null;
};

// Called by initSocketServer.stop() so a drained server never emits.
export const unbindRealtimeNudge = () => {
  ioRef = null;
};

// Fan a data-less list-change nudge out to each member's personal room.
// Returns true when a live socket server handled it, false when realtime
// is off (callers MUST treat false as fine — REST already did the work).
export const notifyConversationsChanged = (userIds = []) => {
  if (!ioRef) return false;

  const seen = new Set();
  for (const id of userIds) {
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    ioRef.to(userRoom(key)).emit('chat:conversations:changed', {});
  }

  return true;
};

/**
 * 34.6 — a removed member stops receiving the room.
 *
 * Every chat WRITE re-checks membership against Mongo, but a broadcast is a
 * room emit: a socket that is still a member of `conv:<id>` keeps receiving
 * messages even after its user was removed. Removing someone must therefore
 * take them OUT of the room, not just out of the member list.
 *
 * `io.in(personalRoom).socketsLeave(conversationRoom)` is the socket.io 4.8
 * broadcast-operator form: it matches that user's sockets and makes them leave
 * the conversation room. KNOWN LIMIT, stated rather than hidden: with the
 * Redis adapter this operator is applied by the adapter, and @socket.io/
 * redis-adapter does not fan it out across nodes — a socket of the same user
 * living on ANOTHER API instance is not evicted by this call. The client-side
 * half (the removed member's page leaves the room when its list drops the
 * conversation) covers that case in practice, and the member's next write or
 * join is refused by the membership gate regardless.
 *
 * Returns true when a live socket server handled it; false when realtime is
 * off. Callers MUST treat false as fine — the REST call already did the work.
 */
export const evictConversationMember = (conversationId, userId) => {
  if (!ioRef || conversationId == null || userId == null) return false;

  ioRef.in(userRoom(String(userId))).socketsLeave(conversationRoom(String(conversationId)));

  return true;
};
