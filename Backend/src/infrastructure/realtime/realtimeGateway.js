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
import env from '../../config/env.js';
import { getRedisClient, createRedisOptions } from '../../config/redis.js';
import { getQueuePrefix } from '../../config/queueConfig.js';
import { parseRealtimeEnabled, REALTIME_HEARTBEAT_MS, realtimeChannelName } from './realtimeConfig.js';
import { createRealtimeRegistry } from './realtimeRegistry.js';
import { buildRealtimeEnvelope, parseRealtimeEnvelope, formatSseFrame, SSE_HEARTBEAT_FRAME } from './realtimeProtocol.js';

export const createRealtimeGateway = ({
  enabled = false,
  channel = realtimeChannelName(),
  heartbeatMs = REALTIME_HEARTBEAT_MS,
  registry = createRealtimeRegistry(),
  publisher = null, // injectable (tests); default: dedicated ioredis connection
  subscriber = null, // injectable (tests); default: dedicated ioredis connection
  log = logger,
} = {}) => {
  let started = false;
  let heartbeatTimer = null;

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
      const realPublisher = publisher || new Redis(String(env.REDIS_URL).trim(), createRedisOptions('realtime-publisher'));
      const realSubscriber = subscriber || new Redis(String(env.REDIS_URL).trim(), createRedisOptions('realtime-subscriber'));

      publisher = realPublisher;
      subscriber = realSubscriber;

      subscriber.on('message', onPubSubMessage);

      try {
        await subscriber.subscribe(channel);
      } catch (error) {
        // Redis unavailable at start: the subscription retries in the
        // background (bounded retryStrategy); publishing falls back to
        // local-only delivery until it lands. Streams still require the
        // shared ticket store, so establishment stays fail-closed.
        log.warn(`[Realtime] pub/sub subscribe deferred (Redis unavailable): ${error?.code || error?.message || 'error'}`);
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
          if (receivers > 0) return { delivered: 'pubsub', receivers };
        } catch {
          /* fall through to local delivery */
        }
      }

      // Redis unavailable → local-only degraded delivery (documented §22).
      const locals = deliverLocal(envelope);
      return { delivered: 'local', receivers: locals };
    },

    /** Test/inspection seam — identities only, never responses/tokens. */
    describeConnections() {
      return registry.describe();
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
