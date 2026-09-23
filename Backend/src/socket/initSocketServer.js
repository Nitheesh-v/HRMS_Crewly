// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.1 — CHAT SOCKET.IO SERVER (foundation only)
//
//  WHAT THIS IS
//    A Socket.IO server attached to the SAME Node HTTP server as Express,
//    JWT-authenticated for TENANT USERS ONLY, fanned out across API
//    replicas by @socket.io/redis-adapter, and refused outright
//    (FEATURE_UNAVAILABLE) whenever Redis is not usable.
//
//  WHAT THIS IS NOT
//    There is NO chat product surface here: no rooms, no join/send/edit/
//    delete events, no unread counters, no models, no REST routes, no
//    presence/typing/last-seen. Those are 33.2+. A connected socket in
//    33.1 can do nothing except exist and be counted.
//
//  ── ATTACH-ORDER LAW (verified, not stylistic) ──────────────────────────
//  Engine.IO creates its WebSocket engine inside `init()`, which it runs
//  on the HTTP server's 'listening' event (engine.io/build/server.js:479,
//  registered at :676). Attaching AFTER listen() therefore silently leaves
//  the ws transport dead while polling still appears to work. So this
//  module's `attach(httpServer)` MUST be called before `server.listen()`.
//
//  Engine.IO also caches and re-registers the server's existing 'request'
//  listeners (engine.io/build/server.js:673-690), delegating every
//  non-`/socket.io` request back to Express — so Express routing,
//  helmet/CORS, the 32.2 drain gate and the 32.16 default-deny
//  Cache-Control are all untouched.
//
//  ── SHUTDOWN LAW ────────────────────────────────────────────────────────
//  `io.close()` ALSO closes the underlying HTTP server
//  (socket.io/dist/index.js:501). Calling it inside our stop() would rip
//  the HTTP listener out from under 32.2's bounded graceful shutdown and
//  kill in-flight requests. So stop() disconnects sockets and closes the
//  engine + adapter clients, and deliberately NEVER calls io.close().
// ═══════════════════════════════════════════════════════════════════════════
import { Server } from 'socket.io';
import logger from '../config/logger.js';
import {
  CHAT_CONNECT_TIMEOUT_MS,
  CHAT_FEATURE_UNAVAILABLE,
  CHAT_MAX_HTTP_BUFFER_BYTES,
  CHAT_PING_INTERVAL_MS,
  CHAT_PING_TIMEOUT_MS,
  CHAT_SOCKET_PATH,
  CHAT_UNAUTHORIZED,
  chatAllowedOrigins,
  isChatOriginAllowed,
  parseChatSocketEnabled,
} from './socketConfig.js';
import {
  createChatHandshakeAuth,
  verifyChatSocketToken,
} from './socketAuth.js';
import { createChatRedisAdapter } from './socketRedisAdapter.js';
import {
  CHAT_REALTIME_STATES,
  createChatSocketAvailability,
} from './socketAvailability.js';
import { registerChatSocketHandlers } from './chatSocketHandlers.js';

/**
 * Builds the Socket.IO server options. Exported for hermetic assertion:
 * the security posture (cookie:false, no wildcard CORS, bounded frames,
 * no served client bundle) is pinned by tests reading this object.
 */
export const buildChatSocketOptions = ({
  availability,
  source = process.env,
  onRefusal = () => {},
  path = CHAT_SOCKET_PATH,
}) => ({
  path,

  // The API must never serve the bundled browser client — the frontend
  // ships its own pinned socket.io-client build (33.8).
  serveClient: false,

  // NO COOKIES. Engine.IO's `cookie` defaults to false and a falsy value
  // skips Set-Cookie entirely (engine.io/build/server.js:318). Declared
  // explicitly so the posture is intentional and pinned, not incidental.
  cookie: false,

  // Legacy EIO3 clients refused; no compatibility surface.
  allowEIO3: false,

  // Both transports: ws first, polling as the fallback for proxies that
  // cannot upgrade. The origin gate below covers BOTH (browser CORS does
  // not apply to WebSocket upgrades, so `cors` alone is not a gate).
  transports: ['websocket', 'polling'],

  // Browser-enforced CORS for the polling transport only. Allowlist from
  // the same CLIENT_URL source as src/app.js; NEVER '*'; no credentials.
  cors: {
    origin: chatAllowedOrigins(source),
    credentials: false,
    methods: ['GET', 'POST'],
  },

  // THE real origin gate (runs for both transports).
  allowRequest: (req, done) => {
    const refusal = availability.refusal();

    if (refusal) {
      onRefusal('FEATURE_UNAVAILABLE');

      return done(CHAT_FEATURE_UNAVAILABLE.code, false);
    }

    if (!isChatOriginAllowed(req?.headers?.origin, source)) {
      onRefusal('ORIGIN_NOT_ALLOWED');

      return done('ORIGIN_NOT_ALLOWED', false);
    }

    return done(null, true);
  },

  // Hard frame cap. express.json's 10 kb limit does NOT bound socket
  // frames; Engine.IO's own default is 1 MB.
  maxHttpBufferSize: CHAT_MAX_HTTP_BUFFER_BYTES,

  connectTimeout: CHAT_CONNECT_TIMEOUT_MS,

  // Transport liveness ONLY. This is NOT employee presence and writes no
  // employee state anywhere — no surveillance (locked decision).
  pingInterval: CHAT_PING_INTERVAL_MS,
  pingTimeout: CHAT_PING_TIMEOUT_MS,

  // Compression stays off: the edge/CDN owns compression (32.16), and
  // permessage-deflate on tiny control frames is pure CPU cost.
  perMessageDeflate: false,
});

/**
 * Creates the process-local chat socket owner.
 * Explicit create/attach/stop lifecycle — NO import-time side effects
 * (repo law §86), so importing this module never opens a port or a Redis
 * connection and stays hermetically testable.
 */
export const createChatSocketServer = ({
  enabled = parseChatSocketEnabled(),
  source = process.env,
  availability = createChatSocketAvailability(),
  createAdapterClients = createChatRedisAdapter,
  createServer = (httpServer, options) => new Server(httpServer, options),
  verify = verifyChatSocketToken,
  // 33.5 wires the chat product events (join/leave/send). Injectable so the
  // foundation stays hermetically testable with a no-op registrar.
  registerSocketHandlers = registerChatSocketHandlers,
  log = logger,
} = {}) => {
  let io = null;
  let closeAdapter = null;
  let adapterAttached = false;

  // Aggregate counters only — bounded cardinality, never per-user
  // activity, never message content (§40/§41 observability law).
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

      return;
    }

    if (reason === 'ORIGIN_NOT_ALLOWED') {
      counters.connections_refused_origin += 1;

      return;
    }

    counters.connections_refused_auth += 1;
  };

  return {
    /**
     * Attaches Socket.IO to the existing HTTP server.
     * MUST run before server.listen() — see the attach-order law above.
     * Never throws: every failure mode degrades to FEATURE_UNAVAILABLE.
     */
    attach: async (httpServer) => {
      if (!enabled) {
        availability.markDisabled();

        log.info(
          '[ChatSocket] disabled (CHAT_SOCKET_ENABLED!=true) — no socket connections will be accepted.',
        );

        return { started: false, reason: 'DISABLED' };
      }

      if (!httpServer) {
        availability.markUnavailable('ADAPTER_FAILURE');

        log.error('[ChatSocket] no HTTP server supplied — chat realtime is FEATURE_UNAVAILABLE.');

        return { started: false, reason: CHAT_FEATURE_UNAVAILABLE.code };
      }

      // Redis adapter FIRST: if it cannot be built, no connection is ever
      // admitted. NOTE this does NOT skip creating the Server below —
      // owning the /socket.io path is what lets a client receive the
      // stable FEATURE_UNAVAILABLE refusal instead of a generic Express
      // 404 from the notFound handler.
      const adapterResult = await createAdapterClients({
        source,
        log,
        onDown: () => {
          availability.markUnavailable('REDIS_ERROR');

          log.warn('[ChatSocket] redis lost — chat realtime is FEATURE_UNAVAILABLE until it recovers.');
        },
        onUp: () => {
          // Recovery may only re-open the gate while an adapter is
          // actually attached: single-instance fanout would silently drop
          // cross-replica delivery, which is worse than refusing.
          if (!adapterAttached) return;

          availability.markReady();

          log.info('[ChatSocket] redis recovered — chat realtime is READY again.');
        },
      });

      io = createServer(
        httpServer,
        buildChatSocketOptions({ availability, source, onRefusal: noteRefusal }),
      );

      // Handshake authentication = the socket re-expression of `protect`
      // + `tenantContext`. Nothing else in the Express chain runs here.
      io.use(
        createChatHandshakeAuth({
          availability,
          verify,
          unauthorized: CHAT_UNAUTHORIZED,
          onRefusal: noteRefusal,
        }),
      );

      io.on('connection', (socket) => {
        counters.connections_accepted += 1;

        // Metadata ONLY: ids and the server-derived tenant. Never a
        // token, never message content, never a user agent dump.
        log.info(
          `[ChatSocket] connection ${socket.id} ` +
            `(company=${socket.data?.companyId} user=${socket.data?.userId})`,
        );

        // 33.5 — chat product events (join/leave/send). Authority stays in
        // socket.data; the handlers re-check membership against Mongo on
        // every event. Guarded so a faulty handler can never drop the socket
        // listener registration for the whole process.
        try {
          registerSocketHandlers({ io, socket, log });
        } catch (error) {
          log.error(`[ChatSocket] handler registration failed (${String(error?.name || 'error')})`);
        }

        socket.on('disconnect', (reason) => {
          counters.disconnects += 1;

          log.info(`[ChatSocket] disconnect ${socket.id} (${String(reason).slice(0, 40)})`);
        });

        // 33.1 registers NO product events. A socket-level error is
        // swallowed so a faulty frame can never take the process down.
        socket.on('error', () => {});
      });

      if (!adapterResult.ok) {
        availability.markUnavailable(adapterResult.reason);

        log.error(
          '[ChatSocket] redis unavailable — every socket connection is refused as ' +
            'FEATURE_UNAVAILABLE. The HTTP API is unaffected.',
        );

        return { started: false, reason: CHAT_FEATURE_UNAVAILABLE.code };
      }

      // Attaching can throw (a malformed adapter is not a constructor).
      // That must degrade to FEATURE_UNAVAILABLE — never crash the API.
      try {
        io.adapter(adapterResult.adapter);
      } catch (error) {
        availability.markUnavailable('ADAPTER_FAILURE');

        log.error(
          `[ChatSocket] adapter could not be attached (${String(error?.name || 'error')}) — ` +
            'chat realtime is FEATURE_UNAVAILABLE. The HTTP API is unaffected.',
        );

        try {
          await adapterResult.close?.();
        } catch {
          /* clients already closed */
        }

        return { started: false, reason: CHAT_FEATURE_UNAVAILABLE.code };
      }

      closeAdapter = adapterResult.close;
      adapterAttached = true;

      availability.markReady();

      log.info(
        `[ChatSocket] foundation ready (path=${CHAT_SOCKET_PATH}, ` +
          `adapterKey=${adapterResult.key}). No chat product events exist in 33.1.`,
      );

      return { started: true, path: CHAT_SOCKET_PATH, adapterKey: adapterResult.key };
    },

    /**
     * Bounded drain. Disconnects sockets and closes the engine + adapter
     * clients — and NEVER calls io.close(), which would close the shared
     * HTTP server out from under 32.2's graceful shutdown.
     */
    stop: async () => {
      availability.markStopped();

      if (io) {
        try {
          io.disconnectSockets(true);
        } catch {
          /* already gone */
        }

        try {
          io.engine?.close();
        } catch {
          /* already gone */
        }

        try {
          await io.of('/').adapter?.close?.();
        } catch {
          /* adapter cleanup is best-effort */
        }

        io = null;
      }

      if (closeAdapter) {
        const closer = closeAdapter;

        closeAdapter = null;
        adapterAttached = false;

        try {
          await closer();
        } catch {
          /* clients already closed */
        }
      }

      adapterAttached = false;

      return { stopped: true };
    },

    /** Ops/diagnostics view — counts and state only. */
    describeDiagnostics: () => ({
      enabled: Boolean(enabled),
      ...availability.getState(),
      localConnections: io ? io.engine?.clientsCount ?? 0 : 0,
      counters: { ...counters },
    }),

    /** Test/inspection seams. */
    getAvailability: () => availability,
    getIo: () => io,
    getStates: () => CHAT_REALTIME_STATES,
  };
};

// ── Process singleton (lazy; no import-time side effects) ───────────────────
let singleton = null;

export const getChatSocketServer = () => {
  if (!singleton) {
    singleton = createChatSocketServer();
  }

  return singleton;
};
