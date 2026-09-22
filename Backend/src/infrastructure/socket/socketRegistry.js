// ─────────────────────────────────────────────────────────────────────────────
// Phase 33.1A — SOCKET REGISTRY (bounded, process-local)
//
// Counts live sockets per user and per process so a single account (or a
// misbehaving client) cannot exhaust the instance. Deliberately PROCESS-LOCAL:
// identity and routing live in each instance's own memory, exactly like the
// 32.11 SSE registry — the shared Redis adapter distributes EVENTS, never
// connection state (§32.1 replica law: no shared per-connection truth).
//
// Pure and injectable: no I/O, no globals, so tests can pin the bounds without
// opening a socket.
// ─────────────────────────────────────────────────────────────────────────────
import {
  SOCKET_MAX_SOCKETS_PER_PROCESS,
  SOCKET_MAX_SOCKETS_PER_USER,
} from './socketConfig.js';

export const createSocketRegistry = ({
  maxPerProcess = SOCKET_MAX_SOCKETS_PER_PROCESS,
  maxPerUser = SOCKET_MAX_SOCKETS_PER_USER,
} = {}) => {
  const byUser = new Map(); // userId -> live connection count

  let total = 0;

  // Admission is all-or-nothing: a refused socket is never half-registered.
  const admit = (userId) => {
    if (!userId) return { ok: false, reason: 'UNKNOWN_IDENTITY' };

    if (total >= maxPerProcess) return { ok: false, reason: 'PROCESS_LIMIT' };

    const current = byUser.get(String(userId)) || 0;

    if (current >= maxPerUser) return { ok: false, reason: 'USER_LIMIT' };

    byUser.set(String(userId), current + 1);
    total += 1;

    return { ok: true };
  };

  // Idempotent release: a double disconnect can never drive the count
  // negative (the counter is diagnostic truth, not a lock).
  const release = (userId) => {
    const key = String(userId || '');

    const current = byUser.get(key) || 0;

    if (current <= 1) byUser.delete(key);
    else byUser.set(key, current - 1);

    if (total > 0) total -= 1;
  };

  const reset = () => {
    byUser.clear();
    total = 0;
  };

  return {
    admit,
    release,
    reset,
    total: () => total,
    countFor: (userId) => byUser.get(String(userId || '')) || 0,
    bounds: () => ({ maxPerProcess, maxPerUser }),
  };
};

export default createSocketRegistry;
