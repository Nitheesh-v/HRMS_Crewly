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
  async issue({ userId, companyId }) {
    const ticket = random();
    await redis.set(
      realtimeTicketKeyLocal(prefix, ticket),
      JSON.stringify({ userId: String(userId), companyId: String(companyId) }),
      'EX',
      ttlSeconds
    );
    return { ticket, expiresInSeconds: ttlSeconds };
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
});

// Local import indirection keeps the key shape in ONE place (config module
// owns the law) without a circular import.
import { realtimeTicketKey as realtimeTicketKeyLocal } from './realtimeConfig.js';
