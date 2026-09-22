// ─────────────────────────────────────────────────────────────────────────────
// Phase 33.1A — SOCKET.IO GATEWAY (explicit create/start/stop lifecycle)
//
// ADDITIVE. The 32.11 SSE gateway keeps serving /api/realtime/* exactly as it
// does today: it is not replaced, not imported here, and not modified. Socket.IO
// is a second, independent transport reserved for Chat (33.5+).
//
// LAWS HONOURED HERE
//  · Attaches to the EXISTING http.Server handed over by server.js — no second
//    port, no second process, nothing added to the §32.1 topology.
//  · Tenant-only handshake (socketAuth.js): the tenant comes from the VERIFIED
//    token + user document. The client never sends companyId/userId. Kiosk,
//    verifier and platform principals are refused. Refusals are generic codes;
//    the internal reason word stays in the log line only.
//  · No cookies, ever: `cookie: false`, and the token rides the handshake auth
//    payload. Cookies + this API do not mix (no ambient-credential CSRF surface).
//  · Websocket-only: HTTP long-polling requires sticky sessions, which the
//    multi-replica law forbids — so a polling client is refused rather than
//    "sometimes working". No connection state recovery for the same reason.
//  · Truthful degradation: Redis (adapter) is REQUIRED. Disabled or down ⇒
//    every handshake is refused with FEATURE_UNAVAILABLE, because a local-only
//    chat would silently drop messages for members on other replicas. Checked
//    at START and re-checked on EVERY handshake, so a mid-life outage stops
//    new connections instead of half-serving them.
//  · Bounded: 16 KB payloads, 5 sockets/user, 500 sockets/process.
//  · No message content is ever logged — only counts, codes and reasons.
//
// WHY stop() NEVER CALLS io.close(): socket.io's close() also closes the
// http.Server it was attached to (node_modules/socket.io/dist/index.js:489-501).
// That would pre-empt the bounded 32.2 graceful shutdown, which must own the
// server. stop() therefore disconnects clients and closes the adapter's Redis
// connections, leaving the server itself to the existing shutdown path.
// ─────────────────────────────────────────────────────────────────────────────
import { Server } from 'socket.io';
import env from '../../config/env.js';
import logger from '../../config/logger.js';
import { getRedisHealth } from '../../config/redis.js';
import { getQueuePrefix } from '../../config/queueConfig.js';
import { originAllowed } from '../../config/corsOrigins.js';
import User from '../../models/User.js';
import SecuritySession from '../../models/SecuritySession.js';
import { createMetricsRegistry } from '../observability/metricsRegistry.js';
import { resolveRealtimeRedisUrl } from '../realtime/realtimeGateway.js';
import {
  parseSocketEnabled,
  SOCKET_ERROR_CODES,
  SOCKET_MAX_PAYLOAD_BYTES,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_PING_TIMEOUT_MS,
  SOCKET_HANDSHAKE_TIMEOUT_MS,
  SOCKET_UPGRADE_TIMEOUT_MS,
  SOCKET_UNAVAILABLE_MESSAGE,
} from './socketConfig.js';
import { createSocketRegistry } from './socketRegistry.js';
import { verifySocketHandshake } from './socketAuth.js';
import { buildSocketAdapter } from './socketAdapter.js';
import { buildSocketFrame, parseSocketCommand } from './socketProtocol.js';

// Error objects handed to socket.io. `data` is the ONLY thing the client sees,
// so it carries a code and nothing else (no reason, no ids, no stack).
const socketRefusal = (code) => {
  const error = new Error(
    code === SOCKET_ERROR_CODES.FEATURE_UNAVAILABLE
      ? SOCKET_UNAVAILABLE_MESSAGE
      : 'Socket connection refused',
  );

  error.data = { code };

  return error;
};

export const createSocketGateway = ({
  enabled = parseSocketEnabled(),
  registry = createSocketRegistry(),
  verify = verifySocketHandshake,
  adapterBuilder = buildSocketAdapter,
  // Availability is Redis-backed by contract; injectable so hermetic tests can
  // pin both branches without a live server.
  redisAvailable = () => getRedisHealth().status === 'up',
  // Resolved lazily from process.env (never the env.js snapshot, which has no
  // REDIS_URL). Injectable so hermetic tests can exercise the wired path
  // without a broker — the availability LAW itself is not weakened.
  resolveRedisUrl = (source) => resolveRealtimeRedisUrl(source),
  originCheck = originAllowed,
  keyPrefix = getQueuePrefix(),
  UserModel = User,
  SecuritySessionModel = SecuritySession,
  jwtSecret = env.JWT_SECRET,
  log = logger,
  ioFactory = (options) => new Server(options),
} = {}) => {
  const metrics = createMetricsRegistry();

  let io = null;
  let adapterHandle = null;
  let started = false;

  const adapterReady = () => Boolean(adapterHandle);

  // The single availability question. Both conditions matter: no adapter means
  // cross-replica fan-out is impossible, so chat must not open.
  const isAvailable = () => started && adapterReady() && redisAvailable();

  const closeAdapter = async () => {
    const handle = adapterHandle;

    adapterHandle = null;

    if (!handle) return;

    try {
      await handle.close();
    } catch {
      // Teardown is best-effort: a failed close must never break shutdown.
    }
  };

  const start = async (httpServer) => {
    if (!enabled) return { started: false, reason: 'DISABLED' };

    if (started) return { started: true, reason: 'ALREADY_STARTED' };

    if (!httpServer) {
      return { started: false, reason: 'NO_HTTP_SERVER' };
    }

    const options = {
      // Token-in-handshake, never cookies.
      cookie: false,
      // Never serve the client bundle from the API.
      serveClient: false,
      // Polling needs sticky sessions → websocket only (see module banner).
      transports: ['websocket'],
      // No sticky sessions ⇒ no cross-replica session recovery.
      connectionStateRecovery: {},
      maxHttpBufferSize: SOCKET_MAX_PAYLOAD_BYTES,
      pingInterval: SOCKET_PING_INTERVAL_MS,
      pingTimeout: SOCKET_PING_TIMEOUT_MS,
      upgradeTimeout: SOCKET_UPGRADE_TIMEOUT_MS,
      // Strict CORS: the SAME allowlist the Express layer enforces.
      cors: {
        origin: (origin, callback) =>
          originCheck(origin)
            ? callback(null, true)
            : callback(new Error('Origin is not allowed by CORS')),
        credentials: false,
      },
    };

    io = ioFactory(httpServer, options);
    started = true;

    // Wire the shared adapter BEFORE any client can connect. A failure here is
    // NOT fatal: the gateway stays up and refuses handshakes truthfully.
    const redisUrl = resolveRedisUrl(process.env);

    if (redisAvailable() && redisUrl) {
      try {
        adapterHandle = adapterBuilder({ url: redisUrl, keyPrefix, log });

        await adapterHandle.connect();

        io.adapter(adapterHandle.adapter);
      } catch (error) {
        log.warn(
          `[Socket] Redis adapter unavailable (${error?.code || error?.name || 'error'}) — chat refused until Redis is ready`,
        );
        await closeAdapter();
      }
    } else {
      log.warn(
        '[Socket] Redis is not ready — chat will refuse connections (FEATURE_UNAVAILABLE)',
      );
    }

    // ── Handshake pipeline: availability → authentication → capacity ────────
    io.use(async (socket, next) => {
      if (!isAvailable()) {
        metrics.increment('socket.connections_refused', { reason: 'unavailable' });
        return next(socketRefusal(SOCKET_ERROR_CODES.FEATURE_UNAVAILABLE));
      }

      const token = socket?.handshake?.auth?.token;

      const verified = await verify({
        token,
        jwtSecret,
        UserModel,
        SecuritySessionModel,
      });

      if (!verified?.ok) {
        // Reason is logged WITHOUT any token material, and never sent.
        log.warn(`[Socket] handshake refused (${verified?.reason || 'invalid'})`);
        metrics.increment('socket.connections_refused', { reason: 'unauthorized' });
        return next(socketRefusal(SOCKET_ERROR_CODES.UNAUTHORIZED));
      }

      const admitted = registry.admit(verified.identity.userId);

      if (!admitted.ok) {
        log.warn(`[Socket] handshake refused (${admitted.reason})`);
        metrics.increment('socket.connections_refused', { reason: 'capacity' });
        return next(socketRefusal(SOCKET_ERROR_CODES.CAPACITY));
      }

      // Identity is server-derived; carried on the socket for later units.
      socket.data.identity = verified.identity;

      return next();
    });

    // ── Connection lifecycle (infrastructure events only in 33.1A) ─────────
    io.on('connection', (socket) => {
      const identity = socket.data?.identity || {};

      metrics.increment('socket.connections_opened', {});

      socket.emit('connection:ready', buildSocketFrame({ type: 'connection:ready' }));

      // Bounded liveness echo. `parseSocketCommand` drops anything unknown or
      // oversized, so this handler cannot be used as a data path.
      socket.on('system:ping', (raw, ack) => {
        const command = parseSocketCommand(raw);

        if (!command || command.type !== 'system:ping') return;

        const frame = buildSocketFrame({ type: 'system:ping' });

        if (typeof ack === 'function') return ack(frame);

        return socket.emit('system:ping', frame);
      });

      socket.on('disconnect', () => {
        if (identity.userId) registry.release(identity.userId);

        metrics.increment('socket.connections_closed', {});
      });
    });

    log.info(
      `[Socket] chat transport listening (adapter: ${adapterReady() ? 'ready' : 'unavailable'})`,
    );

    return { started: true, reason: 'STARTED', adapterReady: adapterReady() };
  };

  const stop = async () => {
    if (!started) {
      await closeAdapter();
      return { stopped: false, reason: 'NOT_STARTED' };
    }

    const openSockets = io?.sockets?.sockets?.size || 0;

    try {
      // Force-close transports so no client keeps the HTTP server alive.
      io.disconnectSockets(true);
    } catch {
      // Best-effort: shutdown continues either way.
    }

    await closeAdapter();

    try {
      // Detach our handlers; the http.Server itself stays owned by server.js.
      io.removeAllListeners();
    } catch {
      // Ignore — nothing depends on this succeeding.
    }

    io = null;
    started = false;
    registry.reset();

    return { stopped: true, closed: openSockets };
  };

  return {
    start,
    stop,
    isStarted: () => started,
    isAvailable,
    isAdapterReady: adapterReady,
    getIo: () => io,
    getRegistry: () => registry,
    getMetrics: () => metrics.snapshot ? metrics.snapshot() : metrics,
  };
};

// ── Process singleton (lazy; no side effects at import time) ────────────────
let singleton = null;

export const getSocketGateway = () => {
  if (!singleton) singleton = createSocketGateway();

  return singleton;
};

// Test seam: drop the singleton so each suite builds a fresh gateway.
export const resetSocketGatewayForTests = () => {
  singleton = null;
};

export default createSocketGateway;
