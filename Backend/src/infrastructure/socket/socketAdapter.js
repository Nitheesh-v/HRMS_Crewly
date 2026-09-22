// ─────────────────────────────────────────────────────────────────────────────
// Phase 33.1A — SOCKET.IO REDIS ADAPTER (cross-replica fan-out)
//
// PURPOSE
// A chat event must reach every member's socket, and those sockets live on
// DIFFERENT API replicas (no sticky sessions — §32.1). The adapter publishes
// each broadcast to Redis and every replica re-emits it locally. Without it,
// a message is delivered only to the members that happen to share the sending
// replica's process.
//
// WHY node-redis HERE (and ioredis everywhere else — user-approved decision)
// @socket.io/redis-adapter's documented client for `createAdapter(pubClient,
// subClient)` is the `redis` package (node-redis v4/v5), so the adapter gets
// its OWN dedicated connections. ioredis stays the client for BullMQ, cache,
// rate limits, tickets, heartbeats and the SSE gateway — none of those
// connections are touched or replaced by this module.
//
// LAWS
//  · DEDICATED connections: a subscriber connection can only run (P)SUBSCRIBE
//    commands, so it can never be shared with a command client. Publisher and
//    subscriber are separate clients (`duplicate()`), exactly like 32.11.
//  · Namespaced key `crewly:<env>:chat` — staging can never receive
//    production fan-out.
//  · The Redis URL is a SECRET: it is never logged, never returned, never
//    embedded in an error message. Only a classifiable error code is logged.
//  · Connect failure is not fatal to the process: the gateway treats a
//    missing adapter as FEATURE_UNAVAILABLE (connections refused) rather than
//    degrading to a silent single-replica chat.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import logger from '../../config/logger.js';
import {
  SOCKET_ADAPTER_REQUESTS_TIMEOUT_MS,
  socketAdapterKey,
} from './socketConfig.js';

// Safe error description: a code/name only — never message text, which can
// contain the connection string.
const safeErrorLabel = (error) =>
  error?.code || error?.name || 'redis_error';

/**
 * Builds the adapter plus its two dedicated connections. Pure wiring — no
 * sockets are opened until connect() is called.
 */
export const buildSocketAdapter = ({
  url,
  keyPrefix,
  requestsTimeout = SOCKET_ADAPTER_REQUESTS_TIMEOUT_MS,
  log = logger,
  clientFactory = createClient,
} = {}) => {
  const pubClient = clientFactory({ url });
  const subClient = pubClient.duplicate();

  // node-redis REQUIRES an 'error' listener: an unhandled client error is an
  // unhandled exception that would take the API process down.
  const noteError = (label) => (error) => {
    log.warn(`[Socket] ${label} redis error (${safeErrorLabel(error)})`);
  };

  pubClient.on('error', noteError('publisher'));
  subClient.on('error', noteError('subscriber'));

  const adapter = createAdapter(pubClient, subClient, {
    key: socketAdapterKey(keyPrefix),
    requestsTimeout,
  });

  const closeClient = async (client) => {
    try {
      // quit() flushes and closes cleanly; a client that never connected (or
      // already errored) is torn down with disconnect() instead.
      if (client?.isOpen) await client.quit();
      else client?.disconnect?.();
    } catch {
      try {
        client?.disconnect?.();
      } catch {
        // Nothing further can be done — never let teardown throw.
      }
    }
  };

  return {
    adapter,
    pubClient,
    subClient,

    async connect() {
      await Promise.all([pubClient.connect(), subClient.connect()]);
      return true;
    },

    async close() {
      await Promise.all([closeClient(pubClient), closeClient(subClient)]);
    },
  };
};

export default buildSocketAdapter;
