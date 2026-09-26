// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.11 — CHAT DIAGNOSTICS (ops view, numbers and safe words only)
//
//  WHERE THIS SURFACES
//    The EXISTING platform diagnostics endpoint (32.12) already reports
//    process/Mongo/Redis state, the 32.11 realtime gateway and the bounded
//    counters. 33.11 adds ONE more block to that same payload — no new
//    endpoint, no /metrics, no new vendor (prompt §B-2).
//
//  WHAT IT ANSWERED BEFORE
//    Nothing. The chat socket availability gate (33.1) lived only in memory
//    and in log lines, so "is chat realtime up on THIS instance, and why
//    not?" required reading logs. The runbooks' DETECT steps pointed at log
//    lines for want of anything better.
//
//  WHAT IT ANSWERS NOW
//    · realtime — state (READY/DISABLED/UNAVAILABLE/STOPPED), the SAFE reason
//      word, local connection count and the process counters. Whether chat is
//      even switched on is visible; whether Redis broke it is visible.
//    · payload — the transport cap against the product's worst-case legal
//      frame, i.e. whether a maximum-length message can actually be carried.
//    · limits — the rate-limit policy in force (action → window and maximum),
//      so an operator can answer "why did this 429?" without reading code.
//
//  WHAT IT CAN NEVER CONTAIN
//    Ids of any kind (no companyId/userId list), limiter keys, Redis URLs,
//    sockets, message content, filenames, tokens. Every value here is a
//    number, a boolean or a word from a frozen vocabulary.
// ═══════════════════════════════════════════════════════════════════════════

import { getChatSocketServer } from '../../socket/initSocketServer.js';
import { CHAT_MAX_HTTP_BUFFER_BYTES } from '../../socket/socketConfig.js';
import { describeFrameCaps } from '../../utils/chatPayloadCaps.js';
import { CHAT_REST_LIMITS, CHAT_SOCKET_LIMITS } from './chatRateLimitService.js';

/**
 * Compact view of the limit policy: action → "maximum per windowSeconds".
 * A string keeps the payload small and readable; no identities are involved.
 */
const summariseLimits = (table) =>
  Object.fromEntries(
    Object.entries(table).map(([action, policy]) => [
      action,
      {
        maximum: policy.maximum,
        windowSeconds: Math.round(policy.windowMs / 1000),
        ...(policy.event ? { event: policy.event } : {}),
      },
    ]),
  );

/**
 * The chat block for the platform diagnostics payload. Never throws: an
 * unexpected failure returns a safe, self-describing state instead of taking
 * the whole diagnostics response down (32.12's rule for every provider).
 */
export const getChatDiagnostics = () => {
  try {
    return {
      realtime: getChatSocketServer().describeDiagnostics(),
      payload: describeFrameCaps(CHAT_MAX_HTTP_BUFFER_BYTES),
      limits: {
        rest: summariseLimits(CHAT_REST_LIMITS),
        socket: summariseLimits(CHAT_SOCKET_LIMITS),
      },
    };
  } catch {
    return {
      realtime: { enabled: false, state: 'UNAVAILABLE', reason: 'ADAPTER_FAILURE' },
      payload: null,
      limits: null,
    };
  }
};

export default getChatDiagnostics;
