// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.11 — REALTIME TICKETS RUNTIME (process singleton)
//
// Binds the ticket service to the SHARED Redis command client (never a
// pub/sub connection — §21 lifecycle separation) and the env-namespaced
// key prefix. Fails closed: with the shared store unavailable, no new
// stream can be established (issue → 503) and consumes return null —
// documented degraded behavior (§22).
// ─────────────────────────────────────────────────────────────────────────────
import { getRedisClient } from '../../config/redis.js';
import { getQueuePrefix } from '../../config/queueConfig.js';
import ApiError from '../../utils/ApiError.js';
import { createRealtimeTickets } from './realtimeTickets.js';

export const getRealtimeTickets = () => {
  const client = getRedisClient();

  if (!client) {
    return {
      issue: async () => {
        throw new ApiError(503, 'Realtime delivery is not enabled on this instance');
      },
      consume: async () => null,

      // 33.14 — the socket handshake's read-only consume. Same fail-closed
      // answer when the shared store is not configured on this instance.
      consumeReusable: async () => null,
    };
  }

  return createRealtimeTickets({ redis: client, prefix: getQueuePrefix() });
};
