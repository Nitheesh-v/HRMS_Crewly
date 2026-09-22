// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.1 — CHAT SOCKET REDIS ADAPTER (multi-instance fanout)
//
//  @socket.io/redis-adapter is what makes chat correct across stateless
//  API replicas: a message published on instance #1 reaches a socket held
//  by instance #2. It is therefore a HARD requirement for chat realtime —
//  the documented exception to Crewly's "Redis is coordination, never
//  truth" law (see socketAvailability.js).
//
//  VERIFIED API FACTS (this repo, this install — never guessed):
//    · @socket.io/redis-adapter 8.3.0 → createAdapter(pubClient, subClient,
//      opts?) where opts.key is the channel prefix (default 'socket.io').
//      It depends on NEITHER redis client library; it only calls
//      publish / subscribe / pSubscribe / on / off, so node-redis is fine.
//    · redis 6.2.1 → duplicate() preserves url + socket options;
//      connect() rejects when reconnectStrategy returns an Error;
//      'connect' / 'ready' / 'end' / 'error' are re-emitted on the client
//      and 'ready' fires on reconnect too; destroy() on an already-closed
//      client THROWS ClientClosedError (guarded below).
//    · rediss:// → @redis/client's parseURL sets socket.tls = true
//      automatically (client/index.js). TLS certificate verification is
//      NEVER disabled here — no rejectUnauthorized:false anywhere.
//
//  Dedicated connections (pub + sub), never the shared general client:
//  a subscribed connection is command-restricted. Same law as 32.11.
// ═══════════════════════════════════════════════════════════════════════════
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import logger from '../config/logger.js';
import { getRedisConfig } from '../config/redis.js';
import {
  CHAT_ADAPTER_READY_TIMEOUT_MS,
  CHAT_RECONNECT_BASE_MS,
  CHAT_RECONNECT_MAX_MS,
  chatAdapterKey,
} from './socketConfig.js';

/** Bounded capped reconnect — mirrors config/redis.js's own strategy. */
const reconnectStrategy = (retries) =>
  Math.min(CHAT_RECONNECT_MAX_MS, CHAT_RECONNECT_BASE_MS * 2 ** retries);

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} not ready within ${ms}ms`)),
        ms,
      );

      timer.unref();
    }),
  ]);

/**
 * One option builder for BOTH connections, so pub and sub can never
 * diverge. `duplicate()` is used for the subscriber to make that
 * structurally impossible.
 */
const buildClientOptions = (url, connectTimeoutMs) => ({
  url,
  socket: {
    connectTimeout: connectTimeoutMs,
    reconnectStrategy,
    // TLS: deliberately unspecified. `rediss://` makes @redis/client set
    // socket.tls = true with node's DEFAULT verification. Setting anything
    // here would risk weakening it.
  },
});

/**
 * Never let an EventEmitter 'error' escape — node-redis emits on every
 * failed attempt and an unhandled 'error' would take the process down.
 * Logs ONE warning per outage spell (same discipline as 32.11).
 */
const attachClientLogging = (client, label, log, onDown, onUp) => {
  if (typeof client?.on !== 'function') return; // injected test stubs

  let down = false;

  client.on('error', (error) => {
    if (down) return;

    down = true;

    // Safe label only — never the message, host or URL (may embed creds).
    log.warn(`[ChatSocket] ${label} redis error: ${error?.code || 'error'}`);

    onDown?.();
  });

  client.on('ready', () => {
    if (!down) return;

    down = false;

    log.info(`[ChatSocket] ${label} redis ready again.`);

    onUp?.();
  });
};

/** Graceful close with a forced fallback; safe when never connected. */
const closeClient = async (client) => {
  if (!client) return;

  try {
    await client.quit();

    return;
  } catch {
    /* not connected / already closing — force it */
  }

  try {
    await client.destroy();
  } catch {
    /* already closed: node-redis throws ClientClosedError (verified) */
  }
};

/**
 * Builds and connects the chat adapter.
 *
 * @returns {Promise<{ok:true, adapter:Function, key:string, close:Function}
 *                  | {ok:false, reason:string}>}
 *          Never throws. `reason` is a safe word from
 *          CHAT_UNAVAILABLE_REASONS — never a URL or message.
 */
export const createChatRedisAdapter = async ({
  source = process.env,
  createRedisClient = (options) => createClient(options),
  adapterFactory = createAdapter,
  key = chatAdapterKey(),
  readyTimeoutMs = CHAT_ADAPTER_READY_TIMEOUT_MS,
  log = logger,
  onDown = () => {},
  onUp = () => {},
} = {}) => {
  // ── REUSES the repository's explicit REDIS_ENABLED parser (28.1) ──────
  const config = getRedisConfig(source);

  if (!config.enabled) {
    log.info('[ChatSocket] REDIS_ENABLED is not true — chat realtime is FEATURE_UNAVAILABLE.');

    return { ok: false, reason: 'REDIS_DISABLED' };
  }

  if (!config.hasUrl) {
    log.error('[ChatSocket] REDIS_ENABLED=true but REDIS_URL is empty — chat realtime is FEATURE_UNAVAILABLE.');

    return { ok: false, reason: 'REDIS_MISCONFIGURED' };
  }

  // Read once, locally, and never stored on any returned/logged object.
  const url = String(source.REDIS_URL).trim();
  const options = buildClientOptions(url, config.connectTimeoutMs);

  const pubClient = createRedisClient(options);
  const subClient = typeof pubClient?.duplicate === 'function'
    ? pubClient.duplicate()
    : createRedisClient(options);

  attachClientLogging(pubClient, 'adapter-pub', log, onDown, onUp);
  attachClientLogging(subClient, 'adapter-sub', log, onDown, onUp);

  try {
    await withTimeout(
      Promise.all([pubClient.connect(), subClient.connect()]),
      readyTimeoutMs,
      'chat adapter clients',
    );
  } catch (error) {
    const reason = /not ready within/.test(String(error?.message || ''))
      ? 'REDIS_CONNECT_TIMEOUT'
      : 'REDIS_ERROR';

    log.error(`[ChatSocket] adapter unavailable (${reason}) — refusing socket connections. HTTP API unaffected.`);

    await closeClient(pubClient);
    await closeClient(subClient);

    return { ok: false, reason };
  }

  log.info(`[ChatSocket] redis adapter attached (key=${key}) — cross-instance chat fanout active.`);

  return {
    ok: true,
    key,
    adapter: adapterFactory(pubClient, subClient, { key }),
    close: async () => {
      await closeClient(pubClient);
      await closeClient(subClient);
    },
  };
};
