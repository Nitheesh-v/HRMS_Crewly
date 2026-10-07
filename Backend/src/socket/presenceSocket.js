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
//    only to a private server-derived tenant/user room:
//      presence:user:<companyId>:<userId>
//    Company-wide presence broadcasts are intentionally absent; the
//    frontend's authorized batched REST path remains authoritative for
//    visible team rows.
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
import { presenceUserRoom } from '../utils/presenceKeys.js';
import { setPresenceLiveStore } from '../services/presence/presenceLiveStoreRegistry.js';
import {
  createPresenceLiveStore,
} from '../services/presence/presenceLiveStore.js';
import { createPresenceExpiryObserver } from '../services/presence/presenceExpiryObserver.js';
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

export const PRESENCE_SOCKET_RECONCILE_TIMEOUT_MS = 1_500;
export const PRESENCE_SOCKET_MAX_RECONCILED_CONNECTIONS = 64;
export const PRESENCE_ADAPTER_SETUP_TIMEOUT_MS = 6_000;
export const PRESENCE_ADAPTER_RETRY_BASE_MS = 1_000;
export const PRESENCE_ADAPTER_RETRY_MAX_MS = 30_000;

// Bounded capped reconnect for the adapter's dedicated connections.
const adapterReconnect = (retries) =>
  Math.min(15_000, 1_000 * 2 ** retries);

const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} not ready within ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

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
export const createPresenceRedisAdapter = async ({
  source = process.env,
  log = logger,
  onUp = () => {},
  onDown = () => {},
  createClientFn = createClient,
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
  let pubReady = false;
  let subReady = false;
  try {
    pubClient = createClientFn(options);
    subClient =
      typeof pubClient?.duplicate === 'function'
        ? pubClient.duplicate()
        : createClientFn(options);

    let pubDown = false;
    let subDown = false;
    let lastReportedReady = null;
    const reportReadiness = () => {
      const ready = pubReady && subReady;
      if (lastReportedReady === null && !ready) return;
      if (lastReportedReady === ready) return;
      lastReportedReady = ready;
      if (ready) onUp();
      else onDown();
    };
    pubClient.on?.('error', () => {
      pubReady = false;
      if (!pubDown) log.warn('[PresenceSocket] adapter-pub redis error');
      pubDown = true;
      reportReadiness();
    });
    subClient.on?.('error', () => {
      subReady = false;
      if (!subDown) log.warn('[PresenceSocket] adapter-sub redis error');
      subDown = true;
      reportReadiness();
    });
    pubClient.on?.('ready', () => {
      pubDown = false;
      pubReady = true;
      reportReadiness();
    });
    subClient.on?.('ready', () => {
      subDown = false;
      subReady = true;
      reportReadiness();
    });
    pubClient.on?.('reconnecting', () => {
      pubReady = false;
      reportReadiness();
    });
    subClient.on?.('reconnecting', () => {
      subReady = false;
      reportReadiness();
    });
    pubClient.on?.('end', () => {
      pubReady = false;
      reportReadiness();
    });
    subClient.on?.('end', () => {
      subReady = false;
      reportReadiness();
    });

    await withTimeout(
      Promise.all([pubClient.connect(), subClient.connect()]),
      5_000,
      'presence adapter clients',
    );
    pubReady = true;
    subReady = true;
    reportReadiness();
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
    isReady: () => Boolean(pubReady && subReady),
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
  adapterRetryBaseMs = PRESENCE_ADAPTER_RETRY_BASE_MS,
  adapterRetryMaxMs = PRESENCE_ADAPTER_RETRY_MAX_MS,
  log = logger,
} = {}) => {
  let io = null;
  let ownsIo = false;
  let namespace = null;
  let closeAdapter = null;
  let adapterAttached = false;
  let adapterHealthy = false;
  let adapterKey = null;
  let store = null;
  let expiryObserver = null;
  let attachResult = null;
  let adapterAttemptPromise = null;
  let retryTimer = null;
  let retryCount = 0;
  let lifecycleToken = 0;
  let stopped = false;
  let attachedHttpServer = null;
  let attachedSharedIo = null;
  let sharedRedisClient = null;
  const wiredNamespaces = new WeakSet();

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

  const setAdapterUnavailable = (token) => {
    if (token !== lifecycleToken || stopped) return;
    const wasHealthy = adapterHealthy;
    adapterHealthy = false;
    if (adapterAttached && wasHealthy) {
      unbindPresenceSocketNamespace(namespace);
      log.warn('[PresenceSocket] redis adapter unavailable; socket admission and fan-out are degraded.');
    }
  };

  const setAdapterAvailable = (token) => {
    if (token !== lifecycleToken || stopped) return;
    const wasHealthy = adapterHealthy;
    adapterHealthy = true;
    if (adapterAttached && namespace) bindPresenceSocketNamespace(namespace);
    if (adapterAttached && !wasHealthy) {
      log.info('[PresenceSocket] redis adapter recovered; socket fan-out is ready.');
    }
  };

  const fetchUserConnectionIds = async ({ companyId, userId } = {}) => {
    if (
      !companyId ||
      !userId ||
      !namespace ||
      !adapterAttached ||
      !adapterHealthy ||
      typeof namespace.in !== 'function'
    ) return null;
    try {
      const remoteSockets = await withTimeout(
        namespace.in(presenceUserRoom(String(companyId), String(userId))).fetchSockets(),
        PRESENCE_SOCKET_RECONCILE_TIMEOUT_MS,
        'presence room reconciliation',
      );
      if (
        !Array.isArray(remoteSockets) ||
        remoteSockets.length > PRESENCE_SOCKET_MAX_RECONCILED_CONNECTIONS
      ) return null;
      return remoteSockets
        .filter((remoteSocket) =>
          String(remoteSocket?.data?.companyId || '') === String(companyId) &&
          String(remoteSocket?.data?.userId || '') === String(userId),
        )
        .map((remoteSocket) => String(remoteSocket?.id || ''))
        .filter(Boolean);
    } catch {
      // Membership uncertainty is not treated as Offline. The handler uses
      // the bounded single-instance mutation path and the shared TTL observer
      // remains the crash-recovery backstop.
      return null;
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
    if (wiredNamespaces.has(namespace)) return;
    wiredNamespaces.add(namespace);

    // Keep one middleware installed even when Redis is unavailable. The
    // availability gate is dynamic, so a later attach retry can recover
    // without adding duplicate middleware or connection handlers.
    namespace.use(
      createChatHandshakeAuth({
        availability: {
          refusal: () =>
            adapterAttached && adapterHealthy && store
              ? null
              : PRESENCE_FEATURE_UNAVAILABLE,
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

      // The event room is private to the server-derived tenant/user pair.
      // Team-wide/company-wide presence broadcasts are intentionally absent.
      if (companyId && userId) socket.join(presenceUserRoom(companyId, userId));

      log.info('[PresenceSocket] authenticated connection accepted.');

      try {
        registerHandlers({
          io: namespace,
          socket,
          store,
          getConnectionIds: fetchUserConnectionIds,
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
    expiryObserver?.stop?.();
    expiryObserver = null;
    store = null;
    setPresenceLiveStore(null);
  };

  const installLiveStore = (redis) => {
    if (store || !redis) return store;
    try {
      store = createPresenceLiveStore({
        redis,
        prefix: getQueuePrefix(source),
      });
      setPresenceLiveStore(store);
      startExpiryObserver();
      return store;
    } catch (error) {
      log.error(
        `[PresenceSocket] live store unavailable: ${error?.code || error?.name || 'error'}`,
      );
      return null;
    }
  };

  const currentStatus = () => {
    const ready = Boolean(adapterAttached && adapterHealthy && store);
    return {
      started: ready,
      ready,
      pending: !ready && !stopped,
      ...(ready ? {} : { reason: PRESENCE_FEATURE_UNAVAILABLE.code }),
      path: PRESENCE_SOCKET_PATH,
      namespace: PRESENCE_NAMESPACE,
      adapterKey: adapterKey || presenceAdapterKey(getQueuePrefix(source)),
    };
  };

  const scheduleAdapterRetry = (token) => {
    if (stopped || token !== lifecycleToken || retryTimer || adapterAttached) return;
    const delayMs = Math.min(
      adapterRetryMaxMs,
      adapterRetryBaseMs * (2 ** Math.min(retryCount, 5)),
    );
    retryCount += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void startAdapterAttach(token);
    }, delayMs);
    retryTimer.unref?.();
  };

  const startExpiryObserver = () => {
    if (expiryObserver || !store) return;
    expiryObserver = createPresenceExpiryObserver({ store, logger: log });
    expiryObserver.start();
  };

  const startAdapterAttach = async (token) => {
    if (stopped || token !== lifecycleToken || adapterAttached) return currentStatus();
    if (adapterAttemptPromise) return adapterAttemptPromise;

    const attempt = (async () => {
      const redis = sharedRedisClient || getRedisClientFn();
      if (!redis) {
        setAdapterUnavailable(token);
        log.warn('[PresenceSocket] shared Redis unavailable; realtime remains degraded while HTTP stays available.');
        scheduleAdapterRetry(token);
        return currentStatus();
      }
      const liveStore = installLiveStore(redis);
      if (!liveStore) {
        setAdapterUnavailable(token);
        scheduleAdapterRetry(token);
        return currentStatus();
      }

      let adapterResult;
      try {
        adapterResult = await withTimeout(
          Promise.resolve().then(() =>
            createAdapterClients({
              source,
              log,
              onUp: () => setAdapterAvailable(token),
              onDown: () => setAdapterUnavailable(token),
            }),
          ),
          PRESENCE_ADAPTER_SETUP_TIMEOUT_MS,
          'presence adapter setup',
        );
      } catch (error) {
        if (token !== lifecycleToken || stopped) return currentStatus();
        log.warn(
          `[PresenceSocket] adapter startup deferred (${error?.code || error?.name || 'error'}); retry is bounded.`,
        );
        setAdapterUnavailable(token);
        scheduleAdapterRetry(token);
        return currentStatus();
      }

      if (token !== lifecycleToken || stopped) {
        try { await adapterResult?.close?.(); } catch { /* stale attempt cleanup */ }
        return currentStatus();
      }
      if (!adapterResult?.ok) {
        setAdapterUnavailable(token);
        scheduleAdapterRetry(token);
        return currentStatus();
      }

      try {
        // Namespace.adapter is an adapter INSTANCE, unlike Server.adapter(),
        // and is installed only on /presence so chat keeps its own adapter.
        const namespaceAdapter = adapterResult.adapter(namespace);
        if (!namespaceAdapter || typeof namespaceAdapter.close !== 'function') {
          throw new Error('PRESENCE_ADAPTER_INVALID');
        }
        // When chat owns the shared Server, Namespace construction creates
        // an inherited chat-adapter instance before /presence is wired.
        // Close that instance before replacement so it does not retain an
        // extra Redis subscription or duplicate cross-node delivery.
        const inheritedAdapter = namespace.adapter;
        if (inheritedAdapter && inheritedAdapter !== namespaceAdapter) {
          await inheritedAdapter.close?.();
        }
        namespace.adapter = namespaceAdapter;
      } catch (error) {
        log.warn(
          `[PresenceSocket] adapter attachment deferred (${error?.code || error?.name || 'error'}).`,
        );
        try { await adapterResult.close?.(); } catch { /* cleanup */ }
        setAdapterUnavailable(token);
        scheduleAdapterRetry(token);
        return currentStatus();
      }

      closeAdapter = adapterResult.close || null;
      adapterKey = adapterResult.key || presenceAdapterKey(getQueuePrefix(source));
      adapterAttached = true;
      adapterHealthy =
        typeof adapterResult.isReady === 'function'
          ? Boolean(adapterResult.isReady())
          : true;
      retryCount = 0;
      attachResult = currentStatus();
      if (adapterHealthy) {
        bindPresenceSocketNamespace(namespace);
      } else {
        unbindPresenceSocketNamespace(namespace);
      }
      startExpiryObserver();

      log.info(
        `[PresenceSocket] namespace adapter attached (path=${PRESENCE_SOCKET_PATH}, ns=${PRESENCE_NAMESPACE}, adapterKey=${adapterKey}, ready=${adapterHealthy}).`,
      );
      return attachResult;
    })();

    adapterAttemptPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (adapterAttemptPromise === attempt) adapterAttemptPromise = null;
    }
  };

  return {
    /**
     * Mounts /presence synchronously before server.listen(), then starts
     * Redis adapter setup in the background. Slow/unavailable optional Redis
     * never blocks unrelated HRMS startup. Retries use bounded backoff.
     */
    attach: async (httpServer, { sharedIo = null, sharedRedis = null } = {}) => {
      if (!enabled) {
        log.info(
          '[PresenceSocket] disabled (PRESENCE_SOCKET_ENABLED!=true) — no presence socket connections will be accepted.',
        );
        return { started: false, pending: false, reason: 'DISABLED' };
      }
      if (!httpServer) {
        log.error('[PresenceSocket] no http server supplied — presence realtime is FEATURE_UNAVAILABLE.');
        return { started: false, pending: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }
      if (namespace) {
        if (attachedHttpServer !== httpServer || attachedSharedIo !== sharedIo) {
          log.warn('[PresenceSocket] duplicate attach ignored; existing namespace owner is retained.');
        }
        return currentStatus();
      }
      stopped = false;
      lifecycleToken += 1;
      retryCount = 0;
      attachedHttpServer = httpServer;
      attachedSharedIo = sharedIo;
      sharedRedisClient = sharedRedis || null;
      try {
        wireNamespace(httpServer, sharedIo);
      } catch (error) {
        log.error(
          `[PresenceSocket] namespace setup failed: ${error?.code || error?.name || 'error'}`,
        );
        return { started: false, pending: false, reason: PRESENCE_FEATURE_UNAVAILABLE.code };
      }

      // Make Redis-backed HTTP reads available independently of the optional
      // cross-instance socket adapter. Redis failures still resolve Unknown.
      installLiveStore(sharedRedisClient || getRedisClientFn());
      const token = lifecycleToken;
      void startAdapterAttach(token);
      return currentStatus();
    },

    stop: async () => {
      stopped = true;
      lifecycleToken += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      adapterAttemptPromise = null;
      const namespaceToStop = namespace;
      expiryObserver?.stop?.();
      expiryObserver = null;

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
      adapterHealthy = false;
      adapterKey = null;
      attachResult = null;
      clearLiveStore();
      namespace = null;
      io = null;
      ownsIo = false;
      attachedHttpServer = null;
      attachedSharedIo = null;
      sharedRedisClient = null;
      retryCount = 0;
      return { stopped: true };
    },

    describeDiagnostics: () => ({
      enabled: Boolean(enabled),
      namespaceAttached: Boolean(namespace),
      attached: adapterAttached,
      adapterHealthy,
      retryScheduled: Boolean(retryTimer),
      expiryObserver: expiryObserver?.describeDiagnostics?.() || null,
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
