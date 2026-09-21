// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.11 — REALTIME GATEWAY (explicit create/start/stop lifecycle)
//
// The per-process realtime owner: local stream admission, SSE wiring,
// heartbeat, pub/sub fan-out, and bounded drain. NO import-time side
// effects (§86) — the module only exports factories; the process singleton
// is created lazily and started explicitly by server.js when
// REALTIME_ENABLED=true.
//
// Fan-out law (§19–§22): this process owns its sockets; shared Redis
// pub/sub carries bounded envelopes so an event born anywhere reaches the
// instance holding the target connection. Dedicated publisher/subscriber
// ioredis connections — never the cache client, BullMQ, rate limiter, or
// worker heartbeat. Redis down → publish degrades to LOCAL-only delivery;
// new streams fail closed (tickets need the shared store); HTTP is
// unaffected. Realtime delivery is EPHEMERAL — never business truth.
//
// HEARTBEAT ≠ EMPLOYEE PRESENCE: the 15s comment frame proves transport
// liveness ONLY. No employee state is written by this module, ever (§30/§64).
// ─────────────────────────────────────────────────────────────────────────────
import Redis from 'ioredis';
import logger from '../../config/logger.js';
import { getRedisClient, createRedisOptions } from '../../config/redis.js';
import { getQueuePrefix } from '../../config/queueConfig.js';
import { parseRealtimeEnabled, REALTIME_HEARTBEAT_MS, realtimeChannelName } from './realtimeConfig.js';
import { createRealtimeRegistry } from './realtimeRegistry.js';
import { buildRealtimeEnvelope, parseRealtimeEnvelope, formatSseFrame, SSE_HEARTBEAT_FRAME } from './realtimeProtocol.js';
import { createMetricsRegistry } from '../observability/metricsRegistry.js';

// Pure URL-resolution contract (regression-pinned): NEVER returns the
// string "undefined". Absent or blank REDIS_URL → null, meaning the
// gateway runs in local-only delivery mode (publish() already treats a
// null publisher exactly that way). Root cause of the 32.11 localhost
// defect: config/env.js is a SIX-KEY snapshot with NO REDIS_URL, so
// reading the snapshot yielded `undefined`, and `new Redis("undefined")`
// dialed the literal host "undefined" (ENOTFOUND, unbounded unhandled
// error spam).
// The URL must come from the same live source the shared client uses:
// process.env (see src/config/redis.js).
export const resolveRealtimeRedisUrl = (source = process.env) => {
  const url = String(source?.REDIS_URL ?? '').trim();

  return url || null;
};

// Dedicated §21 connections previously carried NO 'error' handler —
// every retry attempt printed an "Unhandled error event" stack. Log ONE
// warning per outage spell; the next successful connect resets it.
const attachDedicatedRedisLogging = (connection, label, log) => {
  if (typeof connection?.on !== 'function') return; // injected test stubs

  let down = false;

  connection.on('error', (error) => {
    if (down) return;

    down = true;

    log.warn(`[Realtime] ${label} redis error: ${error?.code || error?.message || 'error'}`);
  });

  connection.on('connect', () => {
    down = false;
  });
};

// Bounded wait for a dedicated connection's 'ready' event. Stubs (no
// status, or no event emitter) are treated as already ready — the
// hermetic suite injects plain objects. Real ioredis connections start
// at status 'connecting' and must be waited out before any command.
const awaitConnectionReady = (connection, timeoutMs) =>
  new Promise((resolve, reject) => {
    if (!connection || connection.status == null || connection.status === 'ready') {
      resolve();

      return;
    }

    if (typeof connection.once !== 'function') {
      resolve();

      return;
    }

    const cleanup = () => {
      clearTimeout(timer);

      connection.off('ready', onReady);

      connection.off('end', onEnd);
    };

    const timer = setTimeout(() => {
      cleanup();

      reject(new Error(`dedicated subscriber not ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const onReady = () => {
      cleanup();

      resolve();
    };

    const onEnd = () => {
      cleanup();

      reject(new Error('dedicated subscriber connection ended'));
    };

    connection.once('ready', onReady);

    connection.once('end', onEnd);
  });

export const createRealtimeGateway = ({
  enabled = false,
  channel = realtimeChannelName(),
  heartbeatMs = REALTIME_HEARTBEAT_MS,
  subscribeReadyTimeoutMs = 5000,
  registry = createRealtimeRegistry(),
  publisher = null, // injectable (tests); default: dedicated ioredis connection
  subscriber = null, // injectable (tests); default: dedicated ioredis connection
  log = logger,
  } = {}) => {
  let started = false;
  let heartbeatTimer = null;

  // Phase 32.12 — aggregate counters (bounded cardinality; see §40).
  const metrics = createMetricsRegistry();
  const notePublished = (kind) => metrics.increment('realtime.events_published', { kind });
  const noteRefused = (reason) => metrics.increment('realtime.connections_refused', { reason });

  const writeFrame = (stream, frame) => {
    try {
      stream.res.write(frame);
      return true;
    } catch {
      // Dead socket — registry removal happens via the request 'close'
      // listener; ending here too is safe and immediate.
      registry.remove(stream.id);
      return false;
    }
  };

  /** Deliver one validated envelope to matching LOCAL connections only. */
  const deliverLocal = (envelope) => {
    const targets = registry
      .byCompany(envelope.companyId)
      .filter((stream) => envelope.userId === null || stream.userId === envelope.userId);

    const frame = formatSseFrame(envelope);
    for (const stream of targets) writeFrame(stream, frame);
    return targets.length;
  };

  const onPubSubMessage = (channelName, raw) => {
    if (channelName !== channel) return;
    const envelope = parseRealtimeEnvelope(raw);
    if (!envelope) return; // malformed/foreign frame — ignored safely (§34)
    deliverLocal(envelope);
  };

  return {
    /** Explicit lifecycle start — safe no-op when disabled. */
    async start() {
      if (!enabled) {
        log.info('[Realtime] disabled (REALTIME_ENABLED!=true) — no connections will be accepted.');
        return { started: false, reason: 'DISABLED' };
      }
      if (started) return { started: true };

      // Dedicated connections (§21): pub/sub MUST NOT reuse the shared
      // cache client (subscriber mode is command-restricted) nor BullMQ's.
      // URL LAW: resolve from process.env (NEVER the env.js snapshot —
      // it has no REDIS_URL key). No URL → supported local-only state
      // (null publisher), never a garbage dial.
      const redisUrl = resolveRealtimeRedisUrl(process.env);

      if (!redisUrl && !publisher) {
        log.warn(
          '[Realtime] pub/sub unavailable: REDIS_URL is not set — local-only delivery (single-instance fan-out).',
        );
      } else {
        const realPublisher =
          publisher || new Redis(redisUrl, createRedisOptions('realtime-publisher'));
        const realSubscriber =
          subscriber || new Redis(redisUrl, createRedisOptions('realtime-subscriber'));

        publisher = realPublisher;
        subscriber = realSubscriber;

        attachDedicatedRedisLogging(realPublisher, 'publisher', log);
        attachDedicatedRedisLogging(realSubscriber, 'subscriber', log);

        subscriber.on('message', onPubSubMessage);

        // SUBSCRIBE TIMING LAW: enableOfflineQueue=false makes ioredis
        // REJECT any command sent before the connection is ready — and a
        // rejected command is never replayed (retryStrategy re-establishes
        // the TCP connection, not the command). The 32.11 localhost log
        // "Stream isn't writeable and enableOfflineQueue options is false"
        // meant the channel was silently never joined. So: wait for the
        // 'ready' event (bounded) BEFORE subscribing; if that fails, defer
        // to the next 'ready' (reconnect) with a one-shot retry.
        try {
          await awaitConnectionReady(subscriber, subscribeReadyTimeoutMs);
          await subscriber.subscribe(channel);
          log.info('[Realtime] pub/sub subscribed — cross-instance fan-out active.');
        } catch (error) {
          log.warn(
            `[Realtime] pub/sub subscribe deferred (${error?.code || error?.message || 'error'}): ` +
              'will subscribe when the dedicated connection is ready.',
          );

          if (typeof subscriber.once === 'function') {
            subscriber.once('ready', () => {
              if (!started) return; // gateway stopped meanwhile

              subscriber
                .subscribe(channel)
                .then(() => log.info('[Realtime] pub/sub subscribed (after ready) — cross-instance fan-out active.'))
                .catch(() => log.warn('[Realtime] pub/sub still unavailable — local-only delivery continues.'));
            });
          }
        }
      }

      heartbeatTimer = setInterval(() => {
        for (const stream of registry.describe()) {
          const record = registry.get(stream.id);
          if (record) writeFrame(record, SSE_HEARTBEAT_FRAME);
        }
      }, heartbeatMs);
      heartbeatTimer.unref();

      started = true;
      log.info(`[Realtime] gateway started (channel=${channel}, heartbeat=${heartbeatMs}ms). Transport liveness only — NOT employee presence.`);
      return { started: true };
    },

    /**
     * Bounded drain (§48/§81): refuse new streams, end every local stream
     * (clients reconnect with backoff, landing on any instance), close the
     * owned pub/sub connections. Idempotent; safe when never started.
     */
    async stop() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      const streams = registry.clear();
      for (const stream of streams) {
        try {
          stream.res.end();
        } catch {
          /* already gone */
        }
      }

      const closeConn = async (conn) => {
        if (!conn) return;
        try {
          await conn.quit();
        } catch {
          try {
            conn.disconnect();
          } catch {
            /* already closed */
          }
        }
      };

      await closeConn(subscriber);
      await closeConn(publisher);
      subscriber = null;
      publisher = null;

      if (started) log.info(`[Realtime] gateway drained (${streams.length} stream(s) closed).`);
      started = false;
      return { closed: streams.length };
    },

    isStarted() {
      return started;
    },

    /** Admission for the stream route: bounded registry + ready frame. */
    admitStream({ companyId, userId, res }) {
      const admission = registry.add({ companyId, userId, res });

      if (!admission.ok) {
        // Bounded refusal — the client backs off and retries later.
        res.status(503);
        res.end();
        noteRefused(String(admission.reason || 'unknown').slice(0, 40));
        return { ok: false, reason: admission.reason };
      }

      res.on('close', () => registry.remove(admission.stream.id));

      // Headers already sent by the route before admission; start the
      // stream with the infrastructure-only ready event.
      const envelope = buildRealtimeEnvelope({
        type: 'connection:ready',
        companyId,
        userId,
        payload: { connectionId: admission.stream.id },
      });
      writeFrame(admission.stream, formatSseFrame(envelope));

      return { ok: true, stream: admission.stream };
    },

    /**
     * INTERNAL event publisher — the ONLY publish path. There is
     * deliberately NO HTTP broadcast endpoint (§36): tests and future
     * internal infrastructure call this directly.
     */
    async publish({ type, companyId, userId = null, payload = {} }) {
      const envelope = buildRealtimeEnvelope({ type, companyId, userId, payload });
      const raw = JSON.stringify(envelope);

      if (publisher) {
        try {
          const receivers = await publisher.publish(channel, raw);
          if (receivers > 0) {
            notePublished(envelope.type);
            return { delivered: 'pubsub', receivers };
          }
        } catch {
          /* fall through to local delivery */
        }
      }

      // Redis unavailable → local-only degraded delivery (documented §22).
      const locals = deliverLocal(envelope);
      if (locals > 0) notePublished(envelope.type);
      return { delivered: 'local', receivers: locals };
    },

    /** Test/inspection seam — identities only, never responses/tokens. */
    describeConnections() {
      return registry.describe();
    },

    /**
     * Phase 32.12 — bounded AGGREGATE diagnostics for the protected
     * operations surface. Connection COUNTS only — never a user list,
     * never presence or employee state, never per-user activity (§40/§41).
     * Counters are process-local (§74 multi-instance law).
     */
    describeDiagnostics() {
      return {
        enabled: Boolean(enabled),
        started: started,
        localConnections: registry.size(),
        counters: metrics.snapshot(),
      };
    },
  };
};

// ── Process singleton (lazy, no import-time side effects) ────────────────
let singleton = null;

export const getRealtimeGateway = () => {
  if (!singleton) {
    singleton = createRealtimeGateway({ enabled: parseRealtimeEnabled() });
  }
  return singleton;
};

export const realtimeChannel = () => realtimeChannelName(getQueuePrefix());

// Shared-store accessor for the ticket service (normal command connection —
// never a pub/sub connection; §21 lifecycle separation).
export { getRedisClient as realtimeSharedRedis };
