// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.11 — ONE-TIME REALTIME TICKETS (shared handshake store)
//
// Browser EventSource cannot send an Authorization header, and raw JWTs in
// URLs leak into logs/history/proxies (§12). The safest supported handshake
// without a new dependency:
//
//   1. Authenticated HTTP call (normal protect + tenant chain, JWT in the
//      Authorization header — never a URL).
//   2. Server verifies identity and issues a crypto-random 256-bit ticket,
//      stored SHARED (Redis) with a 30s TTL, bound to the VERIFIED
//      {userId, companyId}.
//   3. The stream request carries only this opaque single-use ticket; ANY
//      instance validates it against the shared store and deletes it
//      atomically (MULTI get+del) — identity remains 100% server-derived
//      and one ticket can never authenticate twice.
//
// Leakage tradeoff (documented): a ticket in a URL is worthless after its
// first use or 30 seconds, and grants nothing but this realtime stream.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';

const TICKET_PATTERN = /^[0-9a-f]{64}$/;

export const isValidTicketShape = (ticket) =>
  typeof ticket === 'string' && TICKET_PATTERN.test(ticket);

export const createRealtimeTickets = ({
  redis,
  prefix,
  ttlSeconds = 30,
  random = () => crypto.randomBytes(32).toString('hex'),
} = {}) => ({
  /**
   * Binds a fresh single-use ticket to a VERIFIED identity. Fails closed
   * (throws) when the shared store is unavailable — no stream can be
   * established without shared ticket state (documented Redis-down
   * degradation: existing streams continue, new ones cannot start).
   */
  async issue({ userId, companyId, sessionId, tokenVersion, reusable = false, ttl } = {}) {
    const ticket = random();
    const ticketTtlSeconds = ttl || ttlSeconds;

    // Bound to the VERIFIED identity only. `sessionId`/`tokenVersion` are
    // optional extras used by the chat handshake (33.14) so the socket can
    // re-run the exact same Mongo gates as `protect`; the SSE stream keeps
    // issuing the two-field ticket it always has.
    await redis.set(
      realtimeTicketKeyLocal(prefix, ticket),
      JSON.stringify({
        userId: String(userId),
        companyId: String(companyId),
        ...(sessionId ? { sessionId: String(sessionId) } : {}),
        ...(tokenVersion === undefined || tokenVersion === null
          ? {}
          : { tokenVersion: Number(tokenVersion) }),
        // The flag is only written when it is TRUE, so a default (SSE) ticket
        // keeps the exact two/three-field payload 32.11 always had.
        ...(reusable ? { reusable: true } : {}),
      }),
      'EX',
      ticketTtlSeconds
    );
    return { ticket, expiresInSeconds: ticketTtlSeconds };
  },

  /**
   * Atomic single-use consume. Returns the bound identity or null
   * (unknown/expired/already-used/malformed/shared-store-down). The
   * GET+DEL pair runs inside MULTI/EXEC so two instances racing the same
   * ticket cannot both win.
   */
  async consume(ticket) {
    if (!isValidTicketShape(ticket)) return null;

    try {
      const results = await redis
        .multi()
        .get(realtimeTicketKeyLocal(prefix, ticket))
        .del(realtimeTicketKeyLocal(prefix, ticket))
        .exec();

      const raw = results?.[0]?.[1];
      if (!raw) return null;

      const identity = JSON.parse(raw);
      if (!identity?.userId || !identity?.companyId) return null;
      return identity;
    } catch {
      // Shared store unavailable → fail closed, leak nothing.
      return null;
    }
  },

  /**
   * 33.14 — READ-ONLY consume for the CHAT SOCKET HANDSHAKE.
   *
   * A socket reconnects on its own (flaky network, laptop slept, proxy
   * recycle) and the client cannot mint a ticket mid-reconnect, so a chat
   * ticket is valid for its whole short TTL instead of exactly once. It is
   * NOT ambient authority: the browser must send it explicitly in the
   * handshake payload (a cookie would be attached automatically — that is
   * the CSRF surface 33.1 locked out), and it grants nothing but a socket
   * for an identity the shared store already verified.
   *
   * A ticket issued for the SSE stream (`reusable:false`, the default) is
   * REFUSED here — the single-use contract of §12/§15 is untouched, and the
   * payload's own mode decides, not the caller.
   */
  async consumeReusable(ticket) {
    if (!isValidTicketShape(ticket)) return null;

    try {
      const raw = await redis.get(realtimeTicketKeyLocal(prefix, ticket));
      if (!raw) return null;

      const identity = JSON.parse(raw);
      if (!identity?.userId || !identity?.companyId) return null;
      if (identity.reusable !== true) return null;

      return identity;
    } catch {
      return null;
    }
  },
});

// Local import indirection keeps the key shape in ONE place (config module
// owns the law) without a circular import.
import { realtimeTicketKey as realtimeTicketKeyLocal } from './realtimeConfig.js';
