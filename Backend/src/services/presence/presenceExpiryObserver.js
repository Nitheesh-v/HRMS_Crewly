// ═══════════════════════════════════════════════════════════════════════════
// PHASE 37.8 — SHARED PRESENCE EXPIRY OBSERVER
//
// One process-level bounded sweep per API instance reads the sorted expiry
// index maintained by presenceLiveStore. Redis Lua atomically claims each due
// user, so duplicate workers cannot publish the same expiry transition.
// This is not a per-employee timer, a keyspace-notification dependency, or a
// Redis key scan. The emitted invalidation is user-scoped; REST remains the
// authority for the effective state and the team page retains its batched
// polling recovery path.
// ═══════════════════════════════════════════════════════════════════════════

import { publishPresenceInvalidated } from './presenceBus.js';

export const PRESENCE_EXPIRY_SWEEP_INTERVAL_MS = 15_000;
export const PRESENCE_EXPIRY_SWEEP_BATCH_SIZE = 100;

export const createPresenceExpiryObserver = ({
  store,
  publish = publishPresenceInvalidated,
  logger = { warn() {} },
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = PRESENCE_EXPIRY_SWEEP_INTERVAL_MS,
  batchSize = PRESENCE_EXPIRY_SWEEP_BATCH_SIZE,
} = {}) => {
  let timer = null;
  let running = false;
  let stopped = false;

  const runOnce = async () => {
    if (stopped || running || typeof store?.listExpiredUsers !== 'function') {
      return { scanned: 0, expired: 0 };
    }
    running = true;
    let expiredCount = 0;
    try {
      const candidates = await store.listExpiredUsers({
        nowMs: now(),
        limit: batchSize,
      });
      for (const candidate of candidates || []) {
        if (stopped) break;
        if (!candidate?.companyId || !candidate?.userId) continue;
        const occurredAtMs = now();
        const expired = await store.expireIfDue({
          companyId: candidate.companyId,
          userId: candidate.userId,
          nowMs: occurredAtMs,
        });
        if (!expired) continue;
        expiredCount += 1;
        try {
          await publish({
            companyId: candidate.companyId,
            userId: candidate.userId,
            source: 'lease_expiry',
            occurredAt: new Date(occurredAtMs).toISOString(),
          });
        } catch {
          // Realtime is best-effort; HTTP/reconnect/team reads recover.
        }
      }
      return { scanned: (candidates || []).length, expired: expiredCount };
    } catch (error) {
      // Never log a Redis URL, key, employee identity, or raw error message.
      logger.warn(
        `[PresenceExpiry] sweep unavailable (${error?.code || 'error'}); REST remains authoritative.`,
      );
      return { scanned: 0, expired: expiredCount };
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
      if (stopped || timer) return false;
      timer = setIntervalFn(() => {
        void runOnce();
      }, intervalMs);
      timer?.unref?.();
      void runOnce();
      return true;
    },
    stop: () => {
      stopped = true;
      if (timer) clearIntervalFn(timer);
      timer = null;
      return { stopped: true };
    },
    runOnce,
    describeDiagnostics: () => ({ running, scheduled: Boolean(timer), stopped }),
  };
};
