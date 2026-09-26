// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.11 — CHAT PAYLOAD CAPS (one place, one law)
//
//  WHAT THIS IS
//    Every bound that limits how much a chat client can push through the API
//    or the socket, in ONE module, so a future change to a product cap cannot
//    silently outgrow the TRANSPORT cap (that is exactly what happened in
//    33.10-fix4: captions made a legitimate max-length FILE frame 16,330 bytes
//    against a 16,384-byte Engine.IO bound — 54 bytes of headroom *before*
//    framing, i.e. a payload the transport would drop with no ACK).
//
//  THE LAW (pinned by test/chatHardening.test.js)
//
//      CHAT_MAX_HTTP_BUFFER_BYTES  >=  2 x worstCaseFrameBytes()
//
//    Worst case means: the largest LEGAL payload the product accepts, encoded
//    as reasonably as it can be — 4 bytes per character for text (astral
//    plane), the maximum client message id, the maximum attachment id list,
//    plus a bounded envelope allowance for the event name, JSON punctuation,
//    the ack id and the Engine.IO packet prefix.
//
//  NOTHING HERE IS ENV-TUNABLE. These are product safety bounds: an operator
//  cannot loosen them by accident with an environment variable (§60/§72).
// ═══════════════════════════════════════════════════════════════════════════

import { CHAT_MESSAGE_TEXT_MAX } from '../models/ChatMessage.js';
import { CHAT_ATTACHMENT_MAX_PER_MESSAGE } from './chatFileRules.js';

// ── product caps (re-exported; the sources of truth are not duplicated) ────
export { CHAT_MESSAGE_TEXT_MAX };
export { CHAT_ATTACHMENT_MAX_PER_MESSAGE };

/** Mongoose ObjectId hex length — an attachment/user id is exactly this. */
export const CHAT_OBJECT_ID_LENGTH = 24;

/** socket/chatSocketValidators.js — the client's idempotency key bound. */
export const CHAT_CLIENT_MESSAGE_ID_MAX = 80;

/** socket/chatSocketValidators.js — a moderation reason bound. */
export const CHAT_DELETE_REASON_MAX = 200;

/** validators/chat/chatValidators.js — a conversation title bound. */
export const CHAT_CONVERSATION_TITLE_MAX = 120;

/**
 * Envelope allowance: event name, JSON quoting/punctuation, the socket.io ack
 * id, the Engine.IO packet prefix and the ids a payload carries by shape
 * (conversationId + messageId + up to five attachment ids). Deliberately
 * generous — this number only has to be an UPPER bound.
 */
export const CHAT_FRAME_ENVELOPE_BYTES = 1024;

/**
 * The largest legal inbound frame, in bytes. Text is counted at the worst
 * UTF-8 length a single character can occupy (4), because the product caps
 * CHARACTERS, not bytes — an emoji-heavy message is the worst case.
 */
export const worstCaseFrameBytes = ({
  textMax = CHAT_MESSAGE_TEXT_MAX,
  attachmentMax = CHAT_ATTACHMENT_MAX_PER_MESSAGE,
} = {}) =>
  4 * textMax +
  4 * CHAT_CLIENT_MESSAGE_ID_MAX +
  attachmentMax * CHAT_OBJECT_ID_LENGTH +
  CHAT_FRAME_ENVELOPE_BYTES;

/** The headroom law itself, as a predicate (used by the test and by ops). */
export const CHAT_FRAME_CAP_HEADROOM_FACTOR = 2;

export const frameCapIsSufficient = (capBytes, options = {}) =>
  Number(capBytes) >= CHAT_FRAME_CAP_HEADROOM_FACTOR * worstCaseFrameBytes(options);

/**
 * Human-readable summary — used in the docs and by `npm run config:check`
 * style diagnostics. Numbers only: no payload ever passes through here.
 */
export const describeFrameCaps = (capBytes) => ({
  worstCaseFrameBytes: worstCaseFrameBytes(),
  headroomFactor: CHAT_FRAME_CAP_HEADROOM_FACTOR,
  capBytes: Number(capBytes),
  sufficient: frameCapIsSufficient(capBytes),
  headroomBytes: Number(capBytes) - worstCaseFrameBytes(),
});
