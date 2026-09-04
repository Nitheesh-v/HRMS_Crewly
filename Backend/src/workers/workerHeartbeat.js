// ============================================================
// ⏱️ PHASE 28.8 — WORKER HEARTBEAT (ops visibility)
//
// The worker process writes a short-lived Redis key so the
// Super Admin "Background Operations" page can show whether a
// worker is ONLINE / SHUTTING_DOWN / OFFLINE:
//
//   key:     crewly:ops:worker:<env>:<workerId>
//   value:   {"state":"online"|"shutting_down","ts":<epochMs>}
//   TTL:     OPS_WORKER_HEARTBEAT_TTL_SECONDS (default 60s)
//   beat:    every OPS_WORKER_HEARTBEAT_INTERVAL_MS (default 15s)
//
// SAFETY RULES:
//   - workerId is "worker-<randomUUID>" — NO hostname, pid,
//     username, or other host-specific detail in Redis or UI.
//   - Ephemeral by design: the key simply expires when the
//     process dies (crash => OFFLINE once the TTL lapses).
//   - One timer per process (single worker process runs all
//     seven queues — one heartbeat represents the process).
//   - Uses a worker-owned ioredis connection (passed in),
//     never the API's 28.1 client. A heartbeat failure is
//     logged safely and never crashes the worker.
//   - A small SET (crewly:ops:workers:<env>) lists known
//     worker ids so the API can discover them WITHOUT KEYS/SCAN.
//     Members are removed on graceful stop; the set is capped.
// ============================================================

import { randomUUID } from 'node:crypto';
import logger from '../config/logger.js';
import { getQueuePrefix } from '../config/queueConfig.js';

const clampInt = (value, fallback, min, max) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const envLabel = () => {
  // prefix is "crewly:<env>" — the env part is safe to expose.
  const prefix = String(getQueuePrefix() || 'crewly:local');
  return prefix.replace(/^crewly:/, '') || 'local';
};

export const heartbeatKeyFor = (workerId) =>
  `crewly:ops:worker:${envLabel()}:${workerId}`;

export const workerMemberKey = () =>
  `crewly:ops:workers:${envLabel()}`;

const MAX_MEMBER_SET_SIZE = 200;
const SHUTTING_DOWN_TTL_SECONDS = 10;

// --- Stale member cleanup (Phase 30.1.2) --------------------------
//
// A worker removes itself from the discovery set on a GRACEFUL stop. A killed
// process (nodemon restarts, a container SIGKILL, a laptop sleep) leaves its
// id behind forever: the heartbeat KEY expires with its TTL, but a set member
// cannot expire. That is not a correctness bug - the ops UI already reports
// those as OFFLINE - but it makes every discovery read (ops page, doctor)
// walk a growing list of ghosts, up to the 200-member ceiling.
//
// So the heartbeat owner, which is already connected and already beating,
// tidies up: occasionally, if the set is bigger than a live fleet can explain,
// it asks for every member's heartbeat value in ONE MGET and drops the ids
// whose key is gone. Bounded by cadence and by batch size, never touches a
// key another worker still holds, and is fully best-effort.
const PRUNE_MIN_MEMBERS = 4;
const DEFAULT_PRUNE_EVERY_NTH_BEAT = 10; // ~150s at the default 15s interval
const MAX_PRUNE_PER_BEAT = 25;

/**
 * Remove member ids whose heartbeat key no longer exists.
 * @param {import('ioredis')} connection
 * @param {string} memberKey
 * @param {string} selfId  this worker's id - never pruned
 * @returns {Promise<{checked:number, pruned:number}>}
 */
export const pruneStaleMembers = async (connection, memberKey, selfId) => {
  const empty = { checked: 0, pruned: 0 };
  if (!connection) return empty;
  try {
    const ids = await connection.smembers(memberKey);
    if (!Array.isArray(ids) || ids.length <= PRUNE_MIN_MEMBERS) {
      return { checked: ids?.length ?? 0, pruned: 0 };
    }
    // One round trip for the whole fleet: a missing value means the key's TTL
    // lapsed, i.e. that process is gone.
    const values = await connection.mget(ids.map((id) => heartbeatKeyFor(id)));
    if (!Array.isArray(values)) return { checked: ids.length, pruned: 0 };
    const stale = [];
    ids.forEach((id, index) => {
      if (id === selfId) return;
      if (values[index] === null || values[index] === undefined) stale.push(id);
    });
    if (stale.length === 0) return { checked: ids.length, pruned: 0 };
    const batch = stale.slice(0, MAX_PRUNE_PER_BEAT);
    for (const id of batch) {
      await connection.srem(memberKey, id);
    }
    logger.debug(
      `[Worker] Heartbeat member set pruned (${batch.length} dead worker id(s) removed, ${stale.length - batch.length} left for a later beat)`
    );
    return { checked: ids.length, pruned: batch.length };
  } catch {
    // Cleanup is visibility hygiene; it must never affect job processing.
    return empty;
  }
};

/**
 * Start the process heartbeat.
 * @param {import('ioredis')} connection worker-owned ioredis instance
 * @returns {{workerId:string, stop:Function, markShuttingDown:Function}}
 */
export const startWorkerHeartbeat = (connection, source = process.env) => {
  const intervalMs = clampInt(
    source.OPS_WORKER_HEARTBEAT_INTERVAL_MS, 15000, 5000, 60000
  );
  // Ops override (1 = sweep on every beat, useful right after a crash loop to
  // watch the ghost list collapse); clampInt keeps invalid values at default.
  const pruneEveryNthBeat = clampInt(
    source.OPS_WORKER_HEARTBEAT_PRUNE_EVERY_N_BEATS,
    DEFAULT_PRUNE_EVERY_NTH_BEAT,
    1,
    1000
  );
  const ttlSeconds = clampInt(
    source.OPS_WORKER_HEARTBEAT_TTL_SECONDS, 60, 15, 300
  );
  const workerId = `worker-${randomUUID()}`;

  let timer = null;
  let stopped = false;
  let inFlight = false;
  let beatCount = 0;
  let lastFailureLog = 0;
  const FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;

  const beat = async () => {
    if (stopped || !connection || inFlight) return;
    inFlight = true;
    try {
      const key = heartbeatKeyFor(workerId);
      await connection.set(
        key,
        JSON.stringify({ state: 'online', ts: Date.now() }),
        'EX',
        ttlSeconds
      );
      const memberKey = workerMemberKey();
      const added = await connection.sadd(memberKey, workerId);
      // Bound the discovery set (crash loops must not grow it):
      // if we were not a new member and the set is huge, drop
      // ourselves — a fresh beat will re-add on next interval.
      if (added === 0) {
        const size = await connection.scard(memberKey);
        if (size > MAX_MEMBER_SET_SIZE) {
          await connection.srem(memberKey, workerId);
        }
      }
      // Occasionally sweep the ghosts a killed process left behind.
      beatCount += 1;
      if (beatCount % pruneEveryNthBeat === 0) {
        await pruneStaleMembers(connection, memberKey, workerId);
      }
    } catch {
      // Heartbeat is best-effort visibility; a Redis blip must
      // never take down job processing. Absence of the key is
      // itself the truth the ops UI shows. Log the first failure,
      // then at most one line per 5 minutes (no log storm).
      const now = Date.now();
      if (now - lastFailureLog >= FAILURE_LOG_INTERVAL_MS) {
        lastFailureLog = now;
        logger.warn(
          '[Worker] Heartbeat skipped (Redis unavailable — ops UI will show OFFLINE)'
        );
      }
    } finally {
      inFlight = false;
    }
  };

  // Immediate first beat, then a single interval timer.
  void beat();
  timer = setInterval(() => void beat(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  const markShuttingDown = async () => {
    try {
      await connection.set(
        heartbeatKeyFor(workerId),
        JSON.stringify({ state: 'shutting_down', ts: Date.now() }),
        'EX',
        SHUTTING_DOWN_TTL_SECONDS
      );
    } catch {
      /* best-effort */
    }
  };

  const stop = async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    try {
      await connection.del(heartbeatKeyFor(workerId));
      await connection.srem(workerMemberKey(), workerId);
    } catch {
      /* best-effort — the key expires anyway */
    }
  };

  return { workerId, stop, markShuttingDown };
};

/**
 * Classify one worker from its heartbeat key state (pure —
 * exported for hermetic tests).
 * @param {number} ttlMs  PTTL result: -2 missing, -1 no expiry, >0 ms left
 * @param {string} payloadState parsed "state" field (or '')
 */
export const classifyWorkerState = (ttlMs, payloadState) => {
  if (ttlMs === -2 || ttlMs < 0) return 'OFFLINE';
  if (payloadState === 'shutting_down') return 'SHUTTING_DOWN';
  if (payloadState === 'online') return 'ONLINE';
  // Key exists but payload is unexpected — treat as offline
  // rather than claiming a healthy worker.
  return 'OFFLINE';
};
