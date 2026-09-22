// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.11 — REALTIME CONNECTION REGISTRY (process-local, bounded)
//
// Each realtime process legitimately owns its active connections in memory
// (§19). This registry is that ownership, with hard bounds: a per-process
// stream cap and a per-user stream cap (multi-device stays bounded). Pure
// and injectable — fully hermetically testable, no I/O of any kind.
//
// The registry is NEVER authorization: it only knows which local responses
// belong to which server-derived {companyId, userId} identity.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';

export const createRealtimeRegistry = ({
  maxStreams = 500,
  maxPerUser = 5,
  idFactory = () => crypto.randomUUID(),
} = {}) => {
  // companyId → userId → Set<streamRecord>
  const byTenant = new Map();
  // streamId → streamRecord (reverse index for O(1) removal)
  const byId = new Map();

  const remove = (streamId) => {
    const record = byId.get(streamId);
    if (!record) return false;

    byId.delete(streamId);

    const users = byTenant.get(record.companyId);
    const set = users?.get(record.userId);

    if (set) {
      set.delete(record);
      if (set.size === 0) users.delete(record.userId);
      if (users.size === 0) byTenant.delete(record.companyId);
    }

    return true;
  };

  return {
    /** Returns { ok, stream, reason? } — bounded admission. */
    add({ companyId, userId, res }) {
      if (byId.size >= maxStreams) {
        return { ok: false, reason: 'PROCESS_STREAM_LIMIT' };
      }

      const userSet = byTenant.get(companyId)?.get(userId);
      if (userSet && userSet.size >= maxPerUser) {
        return { ok: false, reason: 'USER_STREAM_LIMIT' };
      }

      const stream = { id: idFactory(), companyId: String(companyId), userId: String(userId), res };

      if (!byTenant.has(stream.companyId)) byTenant.set(stream.companyId, new Map());
      const users = byTenant.get(stream.companyId);
      if (!users.has(stream.userId)) users.set(stream.userId, new Set());
      users.get(stream.userId).add(stream);

      byId.set(stream.id, stream);

      return { ok: true, stream };
    },

    remove,

    has(streamId) {
      return byId.has(streamId);
    },

    get(streamId) {
      return byId.get(streamId) || null;
    },

    /** Every local stream for a tenant — the fan-out delivery set. */
    byCompany(companyId) {
      const users = byTenant.get(String(companyId));
      if (!users) return [];
      const all = [];
      for (const set of users.values()) all.push(...set);
      return all;
    },

    /** Streams for one user across their (bounded) devices. */
    forUser(companyId, userId) {
      const set = byTenant.get(String(companyId))?.get(String(userId));
      return set ? [...set] : [];
    },

    size() {
      return byId.size;
    },

    /** Test/diagnostics view — ids and identities only, never responses. */
    describe() {
      return [...byId.values()].map((s) => ({ id: s.id, companyId: s.companyId, userId: s.userId }));
    },

    /** Drain: remove every stream; returns them so the gateway can end responses. */
    clear() {
      const all = [...byId.values()];
      byTenant.clear();
      byId.clear();
      return all;
    },
  };
};
