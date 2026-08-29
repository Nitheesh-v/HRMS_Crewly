// ============================================================
// 🧱 PHASE 28.1 — REDIS FOUNDATION (infrastructure only)
//
// Provider-neutral Redis connection layer for Crewly.
// Works against Redis Cloud, local Redis, or any managed Redis
// through the private REDIS_URL in Backend/.env (redis:// or
// rediss://). Changing providers later = environment change
// only, no code change.
//
// Scope in 28.1:
//   - connection lifecycle + state tracking
//   - safe health mapping (up / down / disabled)
//   - bounded reconnect with safe auth-failure handling
//   - graceful, bounded close
//
// OUT OF SCOPE in 28.1 (by design):
//   - BullMQ / queues / workers / jobs
//   - caching, rate-limit migration, session migration
//   - any business keys (future key prefix: crewly:...,
//     every tenant-scoped key MUST include trusted companyId)
//
// SECURITY:
//   - REDIS_URL is treated as a secret: never logged, never
//     returned by APIs, never embedded in error messages.
//   - TLS certificate validation stays ON (rediss:// works
//     out of the box). rejectUnauthorized: false is forbidden.
//   - No public API exposes arbitrary Redis commands.
//
// Pure ESM — matches the rest of the Backend.
// ============================================================

import Redis from 'ioredis';
import logger from './logger.js';

// --- Tunables ----------------------------------------------------
const MIN_CONNECT_TIMEOUT_MS = 1000;
const MAX_CONNECT_TIMEOUT_MS = 60000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

// closeRedis() is bounded so shutdown can never hang.
const CLOSE_TIMEOUT_MS = 3000;

// Bounded exponential backoff for background reconnect:
// 500ms → 1s → 2s → 4s → 5s (cap). No tight loops, no log storm.
const RECONNECT_BASE_MS = 500;
const RECONNECT_FACTOR = 2;
const RECONNECT_MAX_MS = 5000;

// Explicit boolean parsing — never Boolean(process.env.X),
// because Boolean("false") === true.
const ENABLED_VALUES = new Set(['true', '1', 'yes', 'on']);
const DISABLED_VALUES = new Set(['false', '0', 'no', 'off', '']);

// Internal connection states (never exposed raw to the API).
// DISABLED | CONNECTING | READY | RECONNECTING | DOWN | CLOSING | CLOSED
let state = 'DISABLED';
// Safe, secret-free failure classification:
// 'misconfigured' | 'auth_failed' | 'timeout' | 'connection_refused'
// | 'dns_resolution_failed' | 'connection_error' | 'closed' | null
let downReason = null;
let intentionalClose = false;
let client = null;
let initPromise = null;

// --- Configuration ------------------------------------------------

// Safe REDIS_ENABLED parser. Invalid values warn once and fall back
// to disabled (the safe default for an optional dependency).
export const parseRedisEnabled = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (ENABLED_VALUES.has(normalized)) return true;
  if (DISABLED_VALUES.has(normalized)) return false;
  logger.warn(
    `[Redis] Invalid REDIS_ENABLED value "${value}" — treating Redis as disabled.`
  );
  return false;
};

const clampConnectTimeout = (raw) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONNECT_TIMEOUT_MS;
  return Math.min(
    MAX_CONNECT_TIMEOUT_MS,
    Math.max(MIN_CONNECT_TIMEOUT_MS, Math.trunc(parsed))
  );
};

// Parsed config. NOTE: the URL itself is intentionally never part of
// this object so no config-shaped value can leak the secret.
export const getRedisConfig = (source = process.env) => ({
  enabled: parseRedisEnabled(source.REDIS_ENABLED),
  hasUrl: String(source.REDIS_URL ?? '').trim().length > 0,
  connectTimeoutMs: clampConnectTimeout(source.REDIS_CONNECT_TIMEOUT_MS),
});

// --- Connection options (28.2 reuses this factory) ----------------

// ONE option factory for every future connection:
//
//   purpose = 'general'        → API-side infrastructure client.
//                                Bounded command retries and no offline
//                                queue, so pings/health fail fast while
//                                the connection is not ready.
//   purpose = 'bullmq-producer' → 28.2 Queue connections.
//   purpose = 'bullmq-worker'   → 28.2 Worker connections.
//                                BullMQ requires maxRetriesPerRequest:
//                                null on its own connections.
//
// 28.2 creates DEDICATED connections per purpose from REDIS_URL via
// this factory — never shares this module's general client socket.
export const createRedisOptions = (purpose = 'general', source = process.env) => {
  const forBullMQ = purpose === 'bullmq-producer' || purpose === 'bullmq-worker';

  const options = {
    // Visible in `CLIENT LIST` on the server for operations.
    connectionName: `crewly-${purpose}`,
    connectTimeout: clampConnectTimeout(source.REDIS_CONNECT_TIMEOUT_MS),
    // BullMQ requires null; the general client keeps bounded retries.
    maxRetriesPerRequest: forBullMQ ? null : 2,
  };

  if (!forBullMQ) {
    // Fail fast instead of silently queueing commands while down.
    options.enableOfflineQueue = false;
    options.retryStrategy = (times) =>
      Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * RECONNECT_FACTOR ** times);
  }

  return options;
};

// --- Safe error classification (secret-free) ----------------------

const isAuthError = (error) => {
  const text = `${error?.code || ''} ${error?.message || ''}`.toUpperCase();
  return (
    text.includes('NOAUTH') ||
    text.includes('WRONGPASS') ||
    text.includes('ERRNOAUTH') ||
    text.includes('AUTHENTICATION')
  );
};

// Maps a raw socket/auth error to a safe, human-readable label.
// Only the category is returned — never the message, host, or URL.
export const classifySafeReason = (error) => {
  if (isAuthError(error)) return 'auth_failed';
  switch (error?.code) {
    case 'ENOTFOUND':
      return 'dns_resolution_failed';
    case 'ECONNREFUSED':
      return 'connection_refused';
    case 'ETIMEDOUT':
    case 'EAI_AGAIN':
    case 'ECONNRESET':
    case 'EPIPE':
      return 'timeout';
    default:
      return 'connection_error';
  }
};

// --- Lifecycle -----------------------------------------------------

const attachEventHandlers = (instance) => {
  // 'error' MUST always have a listener — an unhandled 'error' event
  // crashes Node. This handler only logs safe classifications.
  instance.on('error', (error) => {
    if (intentionalClose) return;

    if (isAuthError(error)) {
      if (downReason !== 'auth_failed') {
        downReason = 'auth_failed';
        state = 'DOWN';
        logger.error(
          '[Redis] Authentication failed — reconnect attempts stopped. ' +
            'Verify REDIS_URL privately in Backend/.env and restart.'
        );
        // Stop immediately: never hammer bad credentials in a loop.
        try {
          instance.disconnect();
        } catch {
          /* already closing */
        }
      }
      return;
    }

    downReason = classifySafeReason(error);
    if (state === 'READY') state = 'RECONNECTING';
    else if (state !== 'CLOSING') state = 'DOWN';
    // No per-error log line here: the 'reconnecting' event already logs
    // each bounded attempt once, avoiding a log storm on flaky networks.
  });

  instance.on('ready', () => {
    if (intentionalClose) return;
    state = 'READY';
    downReason = null;
    logger.info('[Redis] Ready');
  });

  // ioredis emits `reconnecting(delay)` — one bounded line per attempt
  // (delay is capped at RECONNECT_MAX_MS, so no log storm).
  instance.on('reconnecting', (delay) => {
    if (intentionalClose) return;
    if (state !== 'RECONNECTING') {
      state = 'RECONNECTING';
      logger.warn(`[Redis] Reconnecting (next attempt in ${delay}ms)`);
    }
  });

  instance.on('close', () => {
    if (intentionalClose) {
      state = 'CLOSED';
      return;
    }
    if (state === 'READY' || state === 'CONNECTING') {
      state = 'RECONNECTING';
      logger.warn('[Redis] Connection closed — reconnecting in background');
    }
  });

  instance.on('end', () => {
    state = 'CLOSED';
  });
};

const waitForReady = (instance, timeoutMs) =>
  new Promise((resolve, reject) => {
    if (instance.status === 'ready') {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      instance.off('ready', onReady);
      reject(new Error('REDIS_CONNECT_TIMEOUT'));
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    instance.once('ready', onReady);
  });

// Create the single Redis client for the API process.
// Idempotent: concurrent/repeated calls never spawn uncontrolled
// connections. Never throws — Phase 28.1 Redis is optional
// infrastructure, so every failure degrades to a safe DOWN state
// while the Mongo-backed HRMS keeps running.
export const initializeRedis = async (source = process.env) => {
  if (client) return client;
  if (initPromise) return initPromise;

  const config = getRedisConfig(source);

  if (!config.enabled) {
    state = 'DISABLED';
    downReason = null;
    logger.info('[Redis] Disabled');
    return null;
  }

  if (!config.hasUrl) {
    state = 'DOWN';
    downReason = 'misconfigured';
    logger.error(
      '[Redis] REDIS_ENABLED=true but REDIS_URL is empty — Redis marked ' +
        'down (misconfigured). Add REDIS_URL privately to Backend/.env.'
    );
    return null;
  }

  state = 'CONNECTING';
  downReason = null;
  intentionalClose = false;
  logger.info('[Redis] Connecting');

  const instance = new Redis(String(source.REDIS_URL).trim(), {
    ...createRedisOptions('general', source),
  });
  attachEventHandlers(instance);
  client = instance;
  initPromise = null;

  try {
    await waitForReady(instance, config.connectTimeoutMs);
    logger.info('[Redis] Connected');
    return instance;
  } catch {
    // Startup timeout/failure: keep the client alive in the background
    // (bounded reconnect continues) and let the API run degraded.
    if (downReason === null) downReason = 'timeout';
    if (state === 'CONNECTING') state = 'DOWN';
    logger.error(
      '[Redis] Unavailable — Crewly continues in degraded mode with ' +
        'background reconnect active. Health reports redis: down.'
    );
    return instance;
  }
};

// The live client (or null when disabled / misconfigured / closed).
export const getRedisClient = () => client;

// Detailed internal state (debug/ops). Secret-free by construction.
export const getRedisStatus = () => ({ state, reason: downReason });

// Safe health mapping used by GET /api/health:
//   "disabled" — intentionally off (not a fault)
//   "up"       — connected and usable
//   "down"     — enabled but unavailable / misconfigured (+ safe reason)
export const getRedisHealth = () => {
  if (state === 'DISABLED') return { status: 'disabled' };
  if (state === 'READY') return { status: 'up' };
  const reason =
    downReason || (state === 'CONNECTING' ? 'connecting' : 'unavailable');
  return { status: 'down', reason };
};

// Internal PING — no public API can trigger arbitrary Redis commands.
export const pingRedis = async () => {
  if (!client || state === 'DISABLED' || state === 'CLOSED') return false;
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
};

const withTimeout = (promise, ms) =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(finish, ms);
    promise.then(finish, finish);
  });

// Bounded, idempotent close. Safe when Redis is disabled, the client
// was never connected, or close was already performed:
//   1. quit() — graceful drain of pending commands when connected
//      (bounded by CLOSE_TIMEOUT_MS).
//   2. disconnect() — hard stop. REQUIRED: with enableOfflineQueue off,
//      quit() cannot cancel the background reconnect loop; only
//      disconnect() clears the reconnect timer and force-closes.
export const closeRedis = async () => {
  if (!client) {
    if (state !== 'DISABLED') state = 'CLOSED';
    return;
  }
  if (state === 'CLOSING' || state === 'CLOSED') return;

  const instance = client;
  client = null;
  initPromise = null;
  state = 'CLOSING';
  intentionalClose = true;
  logger.info('[Redis] Closing');

  await withTimeout(
    Promise.resolve(instance.quit()).catch(() => {
      /* rejects while not connected — handled by the hard stop below */
    }),
    CLOSE_TIMEOUT_MS
  );

  try {
    instance.disconnect();
  } catch {
    /* already closed */
  }

  intentionalClose = false;
  state = 'CLOSED';
  downReason = 'closed';
  logger.info('[Redis] Closed');
};

// Test-only: clear module state between hermetic unit tests.
export const _resetRedisForTests = () => {
  const instance = client;
  client = null;
  initPromise = null;
  intentionalClose = false;
  state = 'DISABLED';
  downReason = null;
  if (instance) {
    try {
      instance.disconnect();
    } catch {
      /* ignore */
    }
  }
};
