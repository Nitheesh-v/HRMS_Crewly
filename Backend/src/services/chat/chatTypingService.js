// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.5 — TYPING INDICATORS (EPHEMERAL, CONVERSATION-SCOPED)
//
//  WHAT THIS MODULE IS
//    The wire names for the typing events plus the ONE piece of state the
//    server keeps: a per-SOCKET throttle. Nothing else. There is no store, no
//    TTL bookkeeping, no "who is typing" map — the server relays a frame and
//    forgets it, and the moment it forgets, the indicator is gone.
//
//  WHY IT IS NOT THE 33.11 IDENTITY LIMITER
//    Every other chat write rides a shared Redis budget (chatRateLimitService)
//    because a send/edit/reaction has a durable consequence worth counting
//    across instances. A typing frame has NONE: it writes nothing, it notifies
//    nobody, and its whole lifetime is one room broadcast. Paying a Redis hop
//    per keystroke-burst to count something nobody stores would be cost with
//    no benefit — so the throttle here is per-socket and in-memory, exactly
//    like the 33.5 write burst guard, and it dies with the socket. That is not
//    a weaker guarantee for the product: the resource being protected is the
//    RELAY, and the relay is per-socket by construction.
//    (Pinned: the handler test asserts the typing path adds NO identity-limiter
//    action, so a future edit cannot quietly put Redis back on this path.)
//
//  WHAT IT IS NOT
//    Typing is not presence, not availability, not "last seen", not an
//    activity log. It is a boolean about THIS conversation that expires on its
//    own, and it must never become a field anywhere. No model gains a typing
//    field in this unit; a test in chatModels.test.js forbids one.
// ═══════════════════════════════════════════════════════════════════════════

// The wire names ('chat:typing:start' / 'chat:typing:stop' / 'chat:typing')
// stay LITERAL in chatSocketHandlers.js, like every other chat event in this
// codebase: the socket-layer source pins scan for those literals, and a
// constant would make the scans blind (a silent weakening of a guard pin).
// test/chatTyping.test.js cross-checks the literal in the handler against the
// literal in the socket client, so the two ends cannot drift apart.

// The smallest gap between two RELAYED starts in the same conversation. The
// client's heartbeat is 3 s, so a well-behaved client is never throttled; a
// client that loops is. `stop` is deliberately exempt (locked decision): a
// stop is how the room goes quiet, and delaying it would leave a ghost.
export const CHAT_TYPING_MIN_INTERVAL_MS = 1000;

// A frame ceiling per socket, both directions of the pair. This is the
// abuse stop: a socket that spams start AND stop cannot turn the relay into a
// broadcast amplifier. Exceeding it is IGNORED, never an error — a typing
// frame is decoration, and an error ACK on a keystroke path would only teach a
// client to retry. The receiver's TTL is what cleans up after an ignored stop.
export const CHAT_TYPING_FRAME_WINDOW_MS = 10_000;
export const CHAT_TYPING_FRAME_MAX = 60;

// Bounded memory: one socket can only be "typing" in the conversations it has
// actually spoken in, and an unbounded map is a leak (33.11 law).
export const CHAT_TYPING_MAX_CONVERSATIONS = 50;

/**
 * A per-socket typing throttle.
 *
 * `allowFrame()` is the whole-pair ceiling; `allowStart(conversationId)` is the
 * per-conversation minimum gap; `forget(conversationId)` clears a
 * conversation's stamp when the room is told the typing stopped, so the next
 * session in that room is never delayed by the previous one's remainder.
 *
 * Pure in-memory, pure per-connection: it survives no reconnect and is visible
 * to no other socket — which is the property that makes it safe on a path that
 * must never accumulate history about a person.
 */
export const createTypingThrottle = ({
  minIntervalMs = CHAT_TYPING_MIN_INTERVAL_MS,
  frameWindowMs = CHAT_TYPING_FRAME_WINDOW_MS,
  frameMax = CHAT_TYPING_FRAME_MAX,
  maxConversations = CHAT_TYPING_MAX_CONVERSATIONS,
  now = () => Date.now(),
} = {}) => {
  // conversationId -> last relayed start (insertion-ordered for eviction).
  const lastStartAt = new Map();

  let frameWindowStart = now();
  let frameCount = 0;

  const allowFrame = () => {
    const at = now();

    if (at - frameWindowStart >= frameWindowMs) {
      frameWindowStart = at;
      frameCount = 0;
    }

    frameCount += 1;

    return frameCount <= frameMax;
  };

  const allowStart = (conversationId) => {
    const key = String(conversationId ?? '');
    const at = now();
    const previous = lastStartAt.get(key);

    if (previous !== undefined && at - previous < minIntervalMs) return false;

    // Re-inserting moves the key to the newest position, so eviction always
    // drops the least recently used conversation.
    lastStartAt.delete(key);
    lastStartAt.set(key, at);

    while (lastStartAt.size > maxConversations) {
      const oldest = lastStartAt.keys().next().value;

      lastStartAt.delete(oldest);
    }

    return true;
  };

  const forget = (conversationId) => {
    lastStartAt.delete(String(conversationId ?? ''));
  };

  return { allowFrame, allowStart, forget };
};
