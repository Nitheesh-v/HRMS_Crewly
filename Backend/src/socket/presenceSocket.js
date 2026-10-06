// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE SOCKET SERVER (Socket.IO namespace, foundation)
//
//  WHAT THIS IS
//    An authenticated Socket.IO namespace ('/presence') attached to
//    the existing HTTP server. When chat already owns a Socket.IO
//    Server, this namespace shares that engine and installs its own
//    Redis adapter; otherwise presence owns the Engine.IO server.
//    Product events use authenticated, server-derived user rooms; the
//    namespace does not broadcast colleague presence tenant-wide.
//
//  ROOM LAW (re-asserted)
//    Clients NEVER send a 'join' event. The server joins the socket
//    to two rooms on connect, server-derived from `socket.data`:
//      presence:company:<companyId>
//      presence:user:<userId>
//    Same convention as chat (chatKeys.js). A client can never
//    subscribe to another tenant's company room — there is no event
//    that would do so.
//
//  ATTACH-ORDER LAW
//    The same attach-order law as chat (33.1) applies. This factory's
//    `attach(httpServer)` MUST run before `server.listen()` so
//    Engine.IO's ws transport comes up correctly. server.js invokes
//    the attach only when PRESENCE_SOCKET_ENABLED=true.
//
//  SHUTDOWN LAW
//    stop() disconnects only the presence namespace and its adapter.
//    If chat owns the shared Engine.IO server, presence MUST NOT close
//    it; if presence owns it, closing the engine does not close HTTP.
// ═══════════════════════════════════════════════════════════════════════════

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import logger from '../config/logger.js';
import { getQueuePrefix } from '../config/queueConfig.js';
import { getRedisConfig, getRedisClient } from '../config/redis.js';
import {
  PRESENCE_CONNECT_TIMEOUT_MS,
  PRESENCE_FEATURE_UNAVAILABLE,
  PRESENCE_MAX_HTTP_BUFFER_BYTES,
  PRESENCE_NAMESPACE,
  PRESENCE_PING_INTERVAL_MS,
  PRESENCE_PING_TIMEOUT_MS,
  PRESENCE_SOCKET_PATH,
  PRESENCE_UNAUTHORIZED,
  isPresenceOriginAllowed,
  parsePresenceSocketEnabled,
  presenceAdapterKey,
} from './presenceSocketConfig.js';
import {
  createChatHandshakeAuth,
  verifyChatSocketToken,
} from './socketAuth.js';
import { registerPresenceSocketHandlers } from './presenceSocketHandlers.js';
import { presenceCompanyRoom, presenceUserRoom } from '../utils/presenceKeys.js';
import { setPresenceLiveStore } from '../services/presence/presenceLiveStoreRegistry.js';
import {
  createPresenceLiveStore,
} from '../services/presence/presenceLiveStore.js';
import {
  bindPresenceSocketNamespace,
  unbindPresenceSocketNamespace,
} from '../services/presence/presenceSocketPublisher.js';

/**
 * Build the Socket.IO options for the presence namespace. The same
 * security posture as chat (33.1):
 *   - serveClient: false
 *   - cookie: false
 *   - allowEIO3: false
 *   - explicit origin allowlist
 *   - bounded frames
 *   - no wildcard CORS
 *
 * The presence namespace is mounted on the SAME io instance the chat
 * uses. We pass `path` so Engine.IO knows where the WS endpoint is
 * (both namespaces share it).
 */
export const buildPresenceSocketOptions = ({
  source = process.env,
  onRefusal = () => {},
}) => ({
  path: PRESENCE_SOCKET_PATH,
  serveClient: false,
  cookie: false,
  allowEIO3: false,
  transports: ['websocket', 'polling'],
  cors: {
    origin: (origin, callback) =>
      callback(null, isPresenceOriginAllowed(origin, source)),
    credentials: false,
    methods: ['GET', 'POST'],
  },
  // THE real origin gate (runs for both transports). Same pattern as
  // chat (33.1).
  allowRequest: (req, done) => {
    if (!isPresenceOriginAllowed(req?.headers?.origin, source)) {
      onRefusal('ORIGIN_NOT_ALLOWED');
      return done('ORIGIN_NOT_ALLOWED', false);
    }
    return done(null, true);
  },
  maxHttpBufferSize: PRESENCE_MAX_HTTP_BUFFER_BYTES,
  connectTimeout: PRESENCE_CONNECT_TIMEOUT_MS,
  pingInterval: PRESENCE_PING_INTERVAL_MS,
  pingTimeout: PRESENCE_PING_TIMEOUT_MS,
  perMessageDeflate: false,
});

// Bounded capped reconnect for the adapter's dedicated connections.
const adapterReconnect = (retries) =>
  Math.min(15_000, 1_000 * 2 ** retries);

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

const closeRedisClient = async (client) => {
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
    /* already closed */
  }
};

/**
 * Create and connect the presence Redis adapter. Dedicated pub +
 * sub clients (the 21-law); never shares the shared general client.
 *
 * @returns {Promise<{ok:true, adapter:Function, key:string, close:Function}
 *                  | {ok:false, reason:string}>}
 */
const createPresenceRedisAdapter = async ({
  source = process.env,
  log = logger,
} = {}) => {
  const config = getRedisConfig(source);
  if (!config.enabled) {
    return { ok: false, reason: 'REDIS_DISABLED' };
  }
  if (!config.hasUrl) {
    return { ok: false, reason: 'REDIS_MISCONFIGURED' };
  }
  const url = String(source.REDIS_URL).trim();
  const options = {
    url,
    socket: {
      connectTimeout: config.connectTimeoutMs,
      reconnectStrategy: adapterReconnect,
    },
  };
  let pubClient;
  let subClient;
  try {
    pubClient = createClient(options);
    subClient =
      typeof pubClient?.duplicate === 'function'
        ? pubClient.duplicate()
        : createClient(options);

    let pubDown = false;
    let subDown = false;
    pubClient.on?.('error', () => {
      if (pubDown) return;
      pubDown = true;
      log.warn('[PresenceSocket] adapter-pub redis error');
    });
    subClient.on?.('error', () => {
      if (subDown) return;
      subDown = true;
      log.warn('[PresenceSocket] adapter-sub redis error');
    });
    pubClient.on?.('ready', () => {
      pubDown = false;
    });
    subClient.on?.('ready', () => {
      subDown = false;
    });

    await withTimeout(
      Promise.all([pubClient.connect(), subClient.connect()]),
      5_000,
      'presence adapter clients',
    );
  } catch (err) {
    log.error(
      `[PresenceSocket] adapter unavailable: ${err?.code || 'error'} — refusing presence socket connections.`,
    );
    await closeRedisClient(pubClient);
    await closeRedisClient(subClient);
    return { ok: false, reason: 'REDIS_ERROR' };
  }
  const key = presenceAdapterKey(getQueuePrefix(source));
  return {
    ok: true,
    key,
    adapter: createAdapter(pubClient, subClient, { key }),
    close: async () => {
      await closeRedisClient(pubClient);
      await closeRedisClient(subClient);
    },
  };
};

/**
 * Process-local presence socket owner. Explicit create/attach/stop
 * lifecycle; no import-time side effects.
 */
export const createPresenceSocketServer = ({
  enabled = parsePresenceSocketEnabled(),
  source = process.env,
  verify = verifyChatSocketToken,
  registerHandlers = registerPresenceSocketHandlers,
  createAdapterClients = createPresenceRedisAdapter,
  createServer = (httpServer, options) => new Server(httpServer, options),
  getRedisClientFn = getRedisClient,
  log = logger,
} = {}) => {
  let io = null;
  let ownsIo = false;
  let namespace = null;
  let closeAdapter = null;
  let adapterAttached = false;
  let adapterKey = null;
  let store = null;
  let attachResult = null;

  const counters = {
    connections_accepted: 0,
    connections_refused_feature_unavailable: 0,
    connections_refused_origin: 0,
    connections_refused_auth: 0,
    disconnects: 0,
  };
  const noteRefusal = (reason) => {
    if (reason === 'FEATURE_UNAVAILABLE') {
      counters.connections_refused_feature_unavailable += 1;
    } else if (reason === 'ORIGIN_NOT_ALLOWED') {
      counters.connections_refused_origin += 1;
    } else {
      counters.connections_refused_auth += 1;
    }
  };

  const wireNamespace = (httpServer, sharedIo) => {
    if (namespace) return;

    if (sharedIo) {
      // Chat already owns the Engine.IO path. Attaching a second
      // Socket.IO Server here would register two engines at /socket.io.
      io = sharedIo;
      ownsIo = false;
    } else {
      io = createServer(
        httpServer,
        buildPresenceSocketOptions({ source, onRefusal: noteRefusal }),
      );
      ownsIo = true;

      // Presence-only deployments still create Socket.IO's default `/`
      // namespace. Keep it closed: only the authenticated /presence
      // namespace is part of this feature.
      io.use?.((_socket, next) => {
        const error = new Error(PRESENCE_UNAUTHORIZED.message);
        error.data = { ...PRESENCE_UNAUTHORIZED };
        next(error);
      });
    }

    namespace = io.of(PRESENCE_NAMESPACE);

    // Keep one middleware installed even when Redis is unavailable. The
    // availability gate is dynamic, so a later attach retry can recover
    // without adding duplicate middleware or connection handlers.
    namespace.use(
      createChatHandshakeAuth({
        availability: {
          refusal: () =>
            adapterAttached && store ? null : PRESENCE_FEATURE_UNAVAILABLE,
        },
        verify,
        unauthorized: PRESENCE_UNAUTHORIZED,
        onRefusal: noteRefusal,
      }),
    );

    namespace.on('connection', (socket) => {
      counters.connections_accepted += 1;
      const companyId = String(socket.data?.companyId || '');
      const userId = String(socket.data?.userId || '');

      // Server-derived room joins. The client never sends a join event.
      if (companyId) socket.join(presenceCompanyRoom(companyId));
      if (userId) socket.join(presenceUserRoom(userId));

      log.info(
        `[PresenceSocket] connection ${socket.id} (company=${companyId} user=${userId})`,
      );

      try {
        registerHandlers({
          io: namespace,
          socket,
          store,
          counters,
          log,
        });
      } catch (err) {
        log.error(
          `[PresenceSocket] handler registration failed: ${err?.code || err?.name || 'error'}`,
        );
      }

      socket.on('disconnect', () => {
        counters.disconnects += 1;
      });
      socket.on('error', () => {
        /* a faulty frame must not take the process down */
      });
    });
  };

  const clearLiveStore = () => {
    store = null;
    setPresenceLiveStore(null);
  };

  return {
    /**
     * Attaches the presence namespace before server.listen(). Every
     * optional-infrastructure failure degrades to FEATURE_UNAVAILABLE;
     * it never takes down the HTTP API.
     */
    attach: async (httpServer, { sharedIo = null, sharedRedis = null } = {}) => {
      if (!enabled) {
        log.info(
          '[PresenceSocket] disabled (PRESENCE_SOCKET_ENABLED!=true) — no presence socket connections will be accepted.',
        );
        return { started: false, reason: 'DISABLED' };
      }
      if (!httpServer) {
        log.error('[PresenceSocket] no http server supplied — presence realtime is FEATURE_UNAVAILABLE.');
        return { started: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }
      if (adapterAttached && store && attachResult) return attachResult;

      clearLiveStore();
      try {
        wireNamespace(httpServer, sharedIo);
      } catch (err) {
        log.error(
          `[PresenceSocket] namespace setup failed: ${err?.code || err?.name || 'error'}`,
        );
        return { started: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }

      const redis = sharedRedis || getRedisClientFn();
      if (!redis) {
        log.warn(
          '[PresenceSocket] shared Redis client unavailable — presence sockets are refused; HTTP API remains available.',
        );
        return { started: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }

      let adapterResult;
      try {
        adapterResult = await createAdapterClients({ source, log });
      } catch (err) {
        log.error(
          `[PresenceSocket] adapter startup failed: ${err?.code || err?.name || 'error'}`,
        );
        return { started: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }
      if (!adapterResult?.ok) {
        log.error(
          '[PresenceSocket] redis adapter unavailable — every presence socket connection is refused as FEATURE_UNAVAILABLE. HTTP API unaffected.',
        );
        return { started: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }

      let nextStore;
      try {
        nextStore = createPresenceLiveStore({
          redis,
          prefix: getQueuePrefix(source),
        });
      } catch (err) {
        log.error(
          `[PresenceSocket] live store unavailable: ${err?.code || err?.name || 'error'}`,
        );
        try {
          await adapterResult.close?.();
        } catch {
          /* adapter clients are best-effort */
        }
        return { started: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }

      try {
        // Namespace.adapter is an adapter INSTANCE (unlike Server.adapter,
        // which is a setter for all namespaces). Install the dedicated
        // presence adapter on this namespace only so the shared chat
        // namespace keeps its own adapter and Redis channel key.
        const namespaceAdapter = adapterResult.adapter(namespace);
        if (!namespaceAdapter || typeof namespaceAdapter.close !== 'function') {
          throw new Error('PRESENCE_ADAPTER_INVALID');
        }
        namespace.adapter = namespaceAdapter;
      } catch (err) {
        log.error(
          `[PresenceSocket] adapter could not be attached: ${err?.code || err?.name || 'error'}`,
        );
        try {
          await adapterResult.close?.();
        } catch {
          /* adapter clients are best-effort */
        }
        return { started: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }

      store = nextStore;
      setPresenceLiveStore(store);
      closeAdapter = adapterResult.close || null;
      adapterKey = adapterResult.key || presenceAdapterKey(getQueuePrefix(source));
      adapterAttached = true;
      attachResult = {
        started: true,
        path: PRESENCE_SOCKET_PATH,
        namespace: PRESENCE_NAMESPACE,
        adapterKey,
      };
      bindPresenceSocketNamespace(namespace);

      log.info(
        `[PresenceSocket] namespace ready (path=${PRESENCE_SOCKET_PATH}, ns=${PRESENCE_NAMESPACE}, adapterKey=${adapterKey}).`,
      );
      return attachResult;
    },

    stop: async () => {
      const namespaceToStop = namespace;

      if (namespaceToStop) {
        try {
          await namespaceToStop.disconnectSockets?.(true);
        } catch {
          /* already gone */
        }
        try {
          await namespaceToStop.adapter?.close?.();
        } catch {
          /* adapter cleanup is best-effort */
        }
        unbindPresenceSocketNamespace(namespaceToStop);
      }

      // A shared Engine.IO server belongs to chat. Presence only closes
      // the engine it created itself, never the shared HTTP/socket server.
      if (io && ownsIo) {
        try {
          io.engine?.close();
        } catch {
          /* already gone */
        }
      }

      if (closeAdapter) {
        const closer = closeAdapter;
        closeAdapter = null;
        try {
          await closer();
        } catch {
          /* already closed */
        }
      }

      adapterAttached = false;
      adapterKey = null;
      attachResult = null;
      clearLiveStore();
      namespace = null;
      io = null;
      ownsIo = false;
      return { stopped: true };
    },

    describeDiagnostics: () => ({
      enabled: Boolean(enabled),
      attached: adapterAttached,
      counters: { ...counters },
    }),

    getIo: () => namespace,
    getUnderlyingIo: () => io,
  };
};

let singleton = null;

export const getPresenceSocketServer = () => {
  if (!singleton) {
    singleton = createPresenceSocketServer();
  }
  return singleton;
};
