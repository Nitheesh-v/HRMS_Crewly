// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE SOCKET SERVER (Socket.IO namespace, foundation)
//
//  WHAT THIS IS
//    A Socket.IO namespace ('/presence') attached to the SAME http
//    server chat uses. JWT-or-ticket authenticated, fanned out across
//    API replicas by the SAME @socket.io/redis-adapter chat already
//    uses (we instantiate a second adapter for the presence channel;
//    the underlying Redis URL is the same, the connections are
//    dedicated and isolated per the 21-law).
//
//  WHAT THIS IS NOT
//    No presence product surface in this file: no events, no room
//    joins, no models. The handlers file owns the events. A connected
//    socket in 37.4 has access to the three events listed in
//    presenceSocketHandlers.js.
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
//    Engine.IO's ws transport comes up correctly. server.js handles
//    this by calling `getPresenceSocketServer().attach(server)`
//    before listen().
//
//  SHUTDOWN LAW
//    Same as chat: stop() disconnects sockets and closes the engine
//    + adapter clients, and NEVER calls io.close() (which would
//    close the shared http server and kill in-flight requests).
// ═══════════════════════════════════════════════════════════════════════════

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import logger from '../config/logger.js';
import { getRedisConfig } from '../config/redis.js';
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
import { setPresenceLiveStore } from '../services/presence/presenceLiveStoreRegistry.js';
import {
  createPresenceLiveStore,
} from '../services/presence/presenceLiveStore.js';
import { getRedisClient } from '../config/redis.js';

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
    origin: isPresenceOriginAllowed.bind(null, undefined, source),
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
    try {
      await pubClient?.quit();
    } catch {
      /* not connected */
    }
    try {
      await subClient?.quit();
    } catch {
      /* not connected */
    }
    return { ok: false, reason: 'REDIS_ERROR' };
  }
  const key = presenceAdapterKey();
  return {
    ok: true,
    key,
    adapter: createAdapter(pubClient, subClient, { key }),
    close: async () => {
      try {
        await pubClient.quit();
      } catch {
        /* not connected */
      }
      try {
        await subClient.quit();
      } catch {
        /* not connected */
      }
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
  log = logger,
} = {}) => {
  let io = null;
  let namespace = null;
  let closeAdapter = null;
  let adapterAttached = false;
  let store = null;

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

  return {
    /**
     * Attaches the presence namespace to the existing http server.
     * Must run before server.listen() (attach-order law, chat 33.1).
     * Never throws: every failure mode degrades to FEATURE_UNAVAILABLE.
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

      // Redis-backed ephemeral liveness store. The shared general
      // client (config/redis.js#getRedisClient) is the right source —
      // it follows the 28.1 enabled/disabled/down state. If the
      // shared client is null (Redis disabled), the store still
      // instantiates but every read returns null (the resolver
      // returns 'unknown', the HRMS keeps running).
      const redis = sharedRedis || getRedisClient();
      store = createPresenceLiveStore({
        redis,
        prefix: 'crewly:development',
      });
      setPresenceLiveStore(store);

      // Build (or accept) the Socket.IO instance. Reusing the chat
      // io keeps a single port; building our own is for tests that
      // need a fresh server.
      io = sharedIo || new Server(httpServer, buildPresenceSocketOptions({ source, onRefusal: noteRefusal }));
      namespace = io.of(PRESENCE_NAMESPACE);

      // 37.4 — presence adapter. If Redis is unavailable, refuse
      // every connection as FEATURE_UNAVAILABLE (mirrors chat 33.1).
      const adapterResult = await createAdapterClients({ source, log });
      if (!adapterResult.ok) {
        log.error(
          '[PresenceSocket] redis unavailable — every presence socket connection is refused as FEATURE_UNAVAILABLE. HTTP API unaffected.',
        );
        return { started: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }
      try {
        namespace.adapter(adapterResult.adapter);
      } catch (err) {
        log.error(
          `[PresenceSocket] adapter could not be attached: ${err?.code || 'error'}`,
        );
        try {
          await adapterResult.close?.();
        } catch {
          /* already closed */
        }
        return { started: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }
      closeAdapter = adapterResult.close;
      adapterAttached = true;

      // Handshake auth: reuse chat's handshake middleware verbatim.
      // The 33.1 contract re-runs `protect`'s gates (Mongo User +
      // SecuritySession + Company status). Presence rides the SAME
      // ticket / JWT path — no parallel auth surface.
      namespace.use(
        createChatHandshakeAuth({
          availability: { refusal: () => null }, // never FEATURE_UNAVAILABLE here
          verify,
          unauthorized: PRESENCE_UNAUTHORIZED,
          onRefusal: noteRefusal,
        }),
      );

      namespace.on('connection', (socket) => {
        counters.connections_accepted += 1;
        const companyId = String(socket.data?.companyId || '');
        const userId = String(socket.data?.userId || '');

        // Server-derived room join. The client never sends a join
        // event. (presenceKeys.js)
        if (companyId) socket.join(`presence:company:${companyId}`);
        if (userId) socket.join(`presence:user:${userId}`);

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
            `[PresenceSocket] handler registration failed: ${err?.code || 'error'}`,
          );
        }

        socket.on('disconnect', () => {
          counters.disconnects += 1;
        });
        socket.on('error', () => {
          /* a faulty frame must not take the process down */
        });
      });

      log.info(
        `[PresenceSocket] namespace ready (path=${PRESENCE_SOCKET_PATH}, ns=${PRESENCE_NAMESPACE}, adapterKey=${adapterResult.key}).`,
      );
      return {
        started: true,
        path: PRESENCE_SOCKET_PATH,
        namespace: PRESENCE_NAMESPACE,
        adapterKey: adapterResult.key,
      };
    },

    stop: async () => {
      if (namespace) {
        try {
          namespace.disconnectSockets?.(true);
        } catch {
          /* already gone */
        }
      }
      if (io) {
        try {
          io.engine?.close();
        } catch {
          /* already gone */
        }
        io = null;
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
      if (store) {
        setPresenceLiveStore(null);
        store = null;
      }
      return { stopped: true };
    },

    describeDiagnostics: () => ({
      enabled: Boolean(enabled),
      attached: adapterAttached,
      counters: { ...counters },
    }),

    getIo: () => namespace,
  };
};

let singleton = null;

export const getPresenceSocketServer = () => {
  if (!singleton) {
    singleton = createPresenceSocketServer();
  }
  return singleton;
};
