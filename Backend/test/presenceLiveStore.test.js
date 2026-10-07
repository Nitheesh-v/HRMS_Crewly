// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — EPHEMERAL PRESENCE STORE TESTS (hermetic, no live Redis)
//
//  Covers §41 backend tests #6–#19, #22.
//  All Redis interactions are exercised against an in-memory fake that
//  exposes the ioredis-shaped surface the store uses (hset, hget,
//  hgetall, multi/exec, exists, sadd, srem, scard, expire, del, pipeline).
//  No real network. No live Redis. No Mongo. No NATS.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_presence_live_test';

const { createPresenceLiveStore } = await import(
  '../src/services/presence/presenceLiveStore.js'
);
const {
  buildLiveSnapshot,
  parseLiveSnapshot,
  stringifyLiveSnapshot,
  isWithinAwayThreshold,
  isBeyondOfflineThreshold,
  deriveLivePresence,
} = await import('../src/services/presence/presenceLive.js');
const {
  presenceLiveKey,
  presenceConnectionSetKey,
  presenceExpiryIndexKey,
  presenceCompanyRoom,
  presenceUserRoom,
} = await import('../src/utils/presenceKeys.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8');

const COMPANY = 'cccccccc1111111111111111';
const COMPANY_OTHER = 'cccccccc2222222222222222';
const USER_A = 'dddddddd1111111111111111';
const USER_B = 'dddddddd2222222222222222';

// ── in-memory redis fake (ioredis-shaped surface used by the store) ─────
const createMemoryRedis = () => {
  const hashStore = new Map(); // key -> { field -> value }
  const setStore = new Map(); // key -> Set<value>
  const ttlStore = new Map(); // key -> seconds
  const sortedSetStore = new Map(); // key -> Map<member, score>
  const live = new Set();

  const ensureLive = (key) => {
    const ttl = ttlStore.get(key);
    if (ttl !== undefined && ttl <= 0) {
      hashStore.delete(key);
      setStore.delete(key);
      ttlStore.delete(key);
    }
  };

  const fake = {
    hset: async (key, value) => {
      ensureLive(key);
      const existing = hashStore.get(key) || {};
      const merged = { ...existing };
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) merged[k] = String(v);
      }
      hashStore.set(key, merged);
      return 'OK';
    },
    hget: async (key, field) => {
      ensureLive(key);
      return hashStore.get(key)?.[field] ?? null;
    },
    hgetall: async (key) => {
      ensureLive(key);
      const v = hashStore.get(key);
      if (!v) return {};
      return { ...v };
    },
    sadd: async (key, ...members) => {
      ensureLive(key);
      const s = setStore.get(key) || new Set();
      const before = s.size;
      for (const member of members) s.add(String(member));
      setStore.set(key, s);
      return s.size - before;
    },
    srem: async (key, member) => {
      ensureLive(key);
      const s = setStore.get(key) || new Set();
      const had = s.delete(String(member));
      setStore.set(key, s);
      return had ? 1 : 0;
    },
    scard: async (key) => {
      ensureLive(key);
      return (setStore.get(key) || new Set()).size;
    },
    smembers: async (key) => {
      ensureLive(key);
      return Array.from(setStore.get(key) || new Set());
    },
    exists: async (key) => {
      ensureLive(key);
      return hashStore.has(key) || setStore.has(key) ? 1 : 0;
    },
    expire: async (key, seconds) => {
      ensureLive(key);
      if (!hashStore.has(key) && !setStore.has(key)) return 0;
      ttlStore.set(key, Number(seconds));
      return 1;
    },
    del: async (key) => {
      const hashHad = hashStore.delete(key);
      const setHad = setStore.delete(key);
      const sortedHad = sortedSetStore.delete(key);
      ttlStore.delete(key);
      return hashHad || setHad || sortedHad ? 1 : 0;
    },
    zadd: async (key, score, member) => {
      const members = sortedSetStore.get(key) || new Map();
      const isNew = !members.has(String(member));
      members.set(String(member), Number(score));
      sortedSetStore.set(key, members);
      return isNew ? 1 : 0;
    },
    zrem: async (key, ...requestedMembers) => {
      const members = sortedSetStore.get(key) || new Map();
      let removed = 0;
      for (const member of requestedMembers) {
        if (members.delete(String(member))) removed += 1;
      }
      return removed;
    },
    zrangebyscore: async (key, min, max, limitToken, offset, count) => {
      const maxScore = Number(max);
      const members = [...(sortedSetStore.get(key) || new Map()).entries()]
        .filter(([, score]) => score <= maxScore)
        .sort((a, b) => a[1] - b[1])
        .slice(Number(offset) || 0, (Number(offset) || 0) + (Number(count) || 100));
      return members.map(([member]) => member);
    },
    eval: async (_script, numberOfKeys, indexKey, liveKey, connKey, member, nowMs, occurredAt, graceTtl) => {
      assert.equal(Number(numberOfKeys), 3);
      const members = sortedSetStore.get(indexKey) || new Map();
      const dueAt = members.get(String(member));
      if (dueAt === undefined || dueAt > Number(nowMs)) return 0;
      members.delete(String(member));
      setStore.delete(connKey);
      const current = hashStore.get(liveKey) || {};
      hashStore.set(liveKey, {
        ...current,
        connectionCount: '0',
        connected: 'false',
        lastHeartbeatAt: String(occurredAt),
      });
      ttlStore.set(liveKey, Number(graceTtl));
      return 1;
    },
    multi: () => {
      const ops = [];
      const chained = {
        hset(key, value) { ops.push(['hset', key, value]); return chained; },
        expire(key, s) { ops.push(['expire', key, s]); return chained; },
        sadd(key, ...members) { ops.push(['sadd', key, ...members]); return chained; },
        srem(key, m) { ops.push(['srem', key, m]); return chained; },
        del(key) { ops.push(['del', key]); return chained; },
        zadd(key, score, member) { ops.push(['zadd', key, score, member]); return chained; },
        zrem(key, member) { ops.push(['zrem', key, member]); return chained; },
        async exec() {
          for (const op of ops) {
            await fake[op[0]](...op.slice(1));
          }
          return ops.map(() => [null, 'OK']);
        },
      };
      return chained;
    },
    pipeline: () => {
      const ops = [];
      const chained = {
        hgetall(key) { ops.push(['hgetall', key]); return chained; },
        async exec() {
          const results = [];
          for (const op of ops) {
            const r = await fake[op[0]](...op.slice(1));
            results.push([null, r]);
          }
          return results;
        },
      };
      return chained;
    },
    on() { return fake; },
    status: 'ready',
  };
  live.add(fake);
  return fake;
};

// ── pure helpers ───────────────────────────────────────────────────────────

test('pure: buildLiveSnapshot normalises and freezes', () => {
  const s = buildLiveSnapshot({
    connected: true,
    connectionCount: '3', // coerces from string
    lastHeartbeatAt: '2026-10-03T10:00:00.000Z',
    lastActivityAt: '2026-10-03T10:00:00.000Z',
  });
  assert.equal(s.connected, true);
  assert.equal(s.connectionCount, 3);
  assert.equal(s.lastHeartbeatAt, '2026-10-03T10:00:00.000Z');
  // Frozen
  assert.throws(() => { s.connected = false; });
});

test('pure: parseLiveSnapshot normalises count=0/connected mismatch', () => {
  const raw = JSON.stringify({
    connected: true, // lie
    connectionCount: 0, // truth
    lastHeartbeatAt: '2026-10-03T10:00:00.000Z',
    lastActivityAt: '2026-10-03T10:00:00.000Z',
  });
  const s = parseLiveSnapshot(raw);
  assert.equal(s.connectionCount, 0);
  assert.equal(s.connected, false); // count wins
});

test('pure: parseLiveSnapshot returns null on malformed', () => {
  assert.equal(parseLiveSnapshot(null), null);
  assert.equal(parseLiveSnapshot(''), null);
  assert.equal(parseLiveSnapshot('not-json'), null);
  // '{}' is well-formed JSON; parse returns a snapshot with all-null
  // fields. The malformed cases are the ones that return null.
  const empty = parseLiveSnapshot('{}');
  assert.ok(empty, 'well-formed empty object yields a snapshot');
  assert.equal(empty.connectionCount, 0);
  assert.equal(empty.connected, false);
});

test('pure: stringifyLiveSnapshot is a tight JSON with the five allowed keys only', () => {
  const s = buildLiveSnapshot({ connected: true, connectionCount: 1 });
  const raw = stringifyLiveSnapshot(s);
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'connected',
    'connectedAt',
    'connectionCount',
    'lastActivityAt',
    'lastHeartbeatAt',
  ]);
});

test('pure: isWithinAwayThreshold respects clock skew tolerance', () => {
  const now = new Date('2026-10-03T10:00:00.000Z');
  const snap = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastActivityAt: '2026-10-03T10:00:00.000Z',
  });
  assert.equal(isWithinAwayThreshold(snap, now, 5), true);
  const farPast = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastActivityAt: '2026-10-03T09:00:00.000Z',
  });
  assert.equal(isWithinAwayThreshold(farPast, now, 5), false);
  // Clock skew tolerance (activity is in the future of `now`).
  const future = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastActivityAt: '2026-10-03T11:00:00.000Z',
  });
  assert.equal(isWithinAwayThreshold(future, now, 5), true);
});

test('pure: isBeyondOfflineThreshold: zero connection count or stale heartbeat', () => {
  const now = new Date('2026-10-03T10:00:00.000Z');
  const staleHb = buildLiveSnapshot({
    connected: false,
    connectionCount: 0,
    lastHeartbeatAt: '2026-10-03T09:00:00.000Z',
  });
  assert.equal(isBeyondOfflineThreshold(staleHb, now, 15), true);
  const fresh = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: '2026-10-03T10:00:00.000Z',
  });
  assert.equal(isBeyondOfflineThreshold(fresh, now, 15), false);
});

test('pure: deriveLivePresence covers the four states', () => {
  const now = new Date('2026-10-03T10:00:00.000Z');
  // null -> unknown
  assert.equal(deriveLivePresence({ snapshot: null, config: {}, now }), 'unknown');
  // no connection -> offline
  const noConn = buildLiveSnapshot({ connected: false, connectionCount: 0 });
  assert.equal(deriveLivePresence({ snapshot: noConn, config: {}, now }), 'offline');
  // recent activity -> available
  const recent = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: '2026-10-03T10:00:00.000Z',
    lastActivityAt: '2026-10-03T09:58:00.000Z',
  });
  assert.equal(
    deriveLivePresence({ snapshot: recent, config: { awayAfterMinutes: 5, offlineAfterMinutes: 15 }, now }),
    'available',
  );
  // older than away -> away
  const inactive = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: '2026-10-03T10:00:00.000Z',
    lastActivityAt: '2026-10-03T09:00:00.000Z',
  });
  assert.equal(
    deriveLivePresence({ snapshot: inactive, config: { awayAfterMinutes: 5, offlineAfterMinutes: 15 }, now }),
    'away',
  );
  // heartbeat older than offline -> offline
  const stale = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: '2026-10-03T09:00:00.000Z',
    lastActivityAt: '2026-10-03T09:00:00.000Z',
  });
  assert.equal(
    deriveLivePresence({ snapshot: stale, config: { awayAfterMinutes: 5, offlineAfterMinutes: 15 }, now }),
    'offline',
  );
});

// ── key namespacing ────────────────────────────────────────────────────────

test('keys: presenceLiveKey is env-namespaced and tenant scoped', () => {
  // The prefix comes from getQueuePrefix (queueConfig.js) which uses
  // BULLMQ_PREFIX if set, else crewly:<NODE_ENV>. With NODE_ENV=test
  // (set at the top of this file), the prefix is crewly:test.
  const expectedPrefix = 'crewly:test';
  assert.equal(
    presenceLiveKey(COMPANY, USER_A),
    `${expectedPrefix}:presence:${COMPANY}:${USER_A}`,
  );
  // Different user -> different key (never bleed across users)
  assert.notEqual(presenceLiveKey(COMPANY, USER_A), presenceLiveKey(COMPANY, USER_B));
  // Different company -> different key
  assert.notEqual(
    presenceLiveKey(COMPANY, USER_A),
    presenceLiveKey(COMPANY_OTHER, USER_A),
  );
});

test('keys: connection membership is env-, tenant-, and user-scoped', () => {
  const expectedPrefix = 'crewly:test';
  assert.equal(
    presenceConnectionSetKey(COMPANY, USER_A),
    `${expectedPrefix}:presence:conn:${COMPANY}:${USER_A}`,
  );
  assert.notEqual(
    presenceConnectionSetKey(COMPANY, USER_A),
    presenceConnectionSetKey(COMPANY_OTHER, USER_A),
  );
});

test('keys: room names are logical and private rooms include the tenant', () => {
  assert.equal(presenceCompanyRoom(COMPANY), `presence:company:${COMPANY}`);
  assert.equal(presenceUserRoom(COMPANY, USER_A), `presence:user:${COMPANY}:${USER_A}`);
});

// ── store behaviour ───────────────────────────────────────────────────────

const newStore = ({ redis, now = () => new Date('2026-10-03T10:00:00.000Z') } = {}) =>
  createPresenceLiveStore({
    redis,
    prefix: 'crewly:development',
    heartbeatTtlSeconds: 60,
    graceTtlSeconds: 30,
    now,
    logger: { info() {}, warn() {}, error() {} },
  });

test('#6 connection creates a liveness anchor without impersonating user activity', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  const snap = await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  assert.ok(snap, 'markConnected must return a snapshot');
  assert.equal(snap.connectionCount, 1);
  assert.equal(snap.connected, true);
  assert.equal(snap.connectedAt, '2026-10-03T10:00:00.000Z');
  assert.ok(snap.lastHeartbeatAt);
  assert.equal(snap.lastActivityAt, null, 'connect is not a user interaction');
});

test('additional tabs do not reset the idle-session anchor', async () => {
  const redis = createMemoryRedis();
  const first = newStore({ redis });
  await first.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  const second = newStore({
    redis,
    now: () => new Date('2026-10-03T10:02:00.000Z'),
  });
  const snap = await second.markConnected({
    companyId: COMPANY,
    userId: USER_A,
    connectionId: 'sock-2',
  });
  assert.equal(snap.connectionCount, 2);
  assert.equal(snap.connectedAt, '2026-10-03T10:00:00.000Z');
  assert.equal(snap.lastActivityAt, null);
});

test('#7 heartbeat refreshes correct scoped state', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  // Advance the clock 10s, then heartbeat.
  const store2 = newStore({ redis, now: () => new Date('2026-10-03T10:00:10.000Z') });
  const snap = await store2.refreshHeartbeat({ companyId: COMPANY, userId: USER_A });
  assert.ok(snap, 'heartbeat returns snapshot for live user');
  assert.equal(snap.connectionCount, 1, 'heartbeat does not change count');
  assert.equal(snap.lastHeartbeatAt, '2026-10-03T10:00:10.000Z');
  assert.equal(snap.connectedAt, '2026-10-03T10:00:00.000Z', 'heartbeat does not reset the session idle anchor');
  assert.equal(snap.lastActivityAt, null, 'heartbeat never creates or changes activity time');
});

test('heartbeat repair cannot reset the idle anchor when the live hash is lost', async () => {
  const redis = createMemoryRedis();
  const first = newStore({ redis });
  await first.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  await redis.del(presenceLiveKey(COMPANY, USER_A, 'crewly:development'));

  const heartbeat = newStore({
    redis,
    now: () => new Date('2026-10-03T10:10:00.000Z'),
  });
  const repaired = await heartbeat.refreshHeartbeat({
    companyId: COMPANY,
    userId: USER_A,
    connectionId: 'sock-1',
  });
  assert.equal(repaired.connectedAt, null, 'a heartbeat is not a new idle-session anchor');
  assert.equal(repaired.lastActivityAt, null);
  assert.equal(
    deriveLivePresence({
      snapshot: repaired,
      config: { awayAfterMinutes: 5, offlineAfterMinutes: 15 },
      now: new Date('2026-10-03T10:10:00.000Z'),
    }),
    'away',
    'repair must not make an idle user Available again',
  );
});

test('activity only updates lastActivityAt; it does not impersonate a heartbeat', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  const activityStore = newStore({
    redis,
    now: () => new Date('2026-10-03T10:00:15.000Z'),
  });
  const snap = await activityStore.recordActivity({
    companyId: COMPANY,
    userId: USER_A,
    connectionId: 'sock-1',
    at: new Date('2999-01-01T00:00:00.000Z'), // ignored: the store owns its clock
  });
  assert.equal(snap.lastActivityAt, '2026-10-03T10:00:15.000Z');
  assert.equal(snap.lastHeartbeatAt, '2026-10-03T10:00:00.000Z');
  assert.equal(snap.connectedAt, '2026-10-03T10:00:00.000Z');
});

test('#8 keys are tenant scoped — one user cannot touch another', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  await store.markConnected({ companyId: COMPANY, userId: USER_B, connectionId: 'sock-2' });
  // Reading USER_A must NOT return USER_B's data.
  const a = await store.readLive({ companyId: COMPANY, userId: USER_A });
  const b = await store.readLive({ companyId: COMPANY, userId: USER_B });
  assert.equal(a.connectionCount, 1);
  assert.equal(b.connectionCount, 1);
  // User A's hash lives at one key, user B's at another.
  assert.notEqual(presenceLiveKey(COMPANY, USER_A), presenceLiveKey(COMPANY, USER_B));
});

test('#9 Redis failure does not resolve Offline — store returns null gracefully', async () => {
  const brokenRedis = {
    hset: () => { throw new Error('ECONNREFUSED'); },
    hgetall: () => { throw new Error('ECONNREFUSED'); },
    sadd: () => { throw new Error('ECONNREFUSED'); },
    srem: () => { throw new Error('ECONNREFUSED'); },
    scard: () => { throw new Error('ECONNREFUSED'); },
    smembers: () => { throw new Error('ECONNREFUSED'); },
    exists: () => { throw new Error('ECONNREFUSED'); },
    expire: () => { throw new Error('ECONNREFUSED'); },
    del: () => { throw new Error('ECONNREFUSED'); },
    multi: () => ({
      hset() { return this; },
      expire() { return this; },
      async exec() { return []; },
    }),
    pipeline: () => ({
      hgetall() { return this; },
      async exec() { return []; },
    }),
    on() { return this; },
    status: 'ready',
  };
  const store = newStore({ redis: brokenRedis });
  const r1 = await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  const r2 = await store.readLive({ companyId: COMPANY, userId: USER_A });
  const r3 = await store.refreshHeartbeat({ companyId: COMPANY, userId: USER_A });
  const r4 = await store.recordActivity({ companyId: COMPANY, userId: USER_A });
  const r5 = await store.markDisconnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(r3, null);
  assert.equal(r4, null);
  assert.equal(r5, null);
});

test('#10 Redis failure resolves unknown / degraded semantics (resolver + store)', async () => {
  const brokenRedis = {
    hset: () => { throw new Error('ECONNREFUSED'); },
    hgetall: () => { throw new Error('ECONNREFUSED'); },
    sadd: () => { throw new Error('ECONNREFUSED'); },
    srem: () => { throw new Error('ECONNREFUSED'); },
    scard: () => { throw new Error('ECONNREFUSED'); },
    smembers: () => { throw new Error('ECONNREFUSED'); },
    exists: () => { throw new Error('ECONNREFUSED'); },
    expire: () => { throw new Error('ECONNREFUSED'); },
    del: () => { throw new Error('ECONNREFUSED'); },
    multi: () => ({ hset() { return this; }, expire() { return this; }, async exec() { return []; } }),
    pipeline: () => ({ hgetall() { return this; }, async exec() { return []; } }),
    on() { return this; },
    status: 'ready',
  };
  const store = newStore({ redis: brokenRedis });
  // Resolver treats null live as unknown.
  const { resolvePresence } = await import(
    '../src/services/presence/presenceResolver.js'
  );
  const live = await store.readLive({ companyId: COMPANY, userId: USER_A });
  assert.equal(live, null);
  const resolved = resolvePresence({
    durable: null,
    config: { awayAfterMinutes: 5, offlineAfterMinutes: 15, enabled: true },
    now: new Date(),
    live,
  });
  assert.equal(resolved.presence, 'unknown');
  assert.equal(resolved.livePresenceAvailable, false);
});

test('#11 no FLUSHALL — store source does not import it', () => {
  // Strip comments so the assertion is not poisoned by the source's
  // own negative documentation (the same pattern Phase 36 used for
  // its source-pin tests).
  const source = read('services/presence/presenceLiveStore.js');
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/flushall/i.test(stripped), false);
});

test('#12 no FLUSHDB — store source does not import it', () => {
  const source = read('services/presence/presenceLiveStore.js');
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/flushdb/i.test(stripped), false);
});

test('#13 no production KEYS scan — store source does not call redis.keys() or .scan()', () => {
  const source = read('services/presence/presenceLiveStore.js');
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // The store must not call redis.keys() or redis.scan() with a
  // wildcard. The identifier `keys` in a local variable is fine.
  assert.equal(/redis\.keys\s*\(/i.test(stripped), false);
  assert.equal(/redis\.scan\s*\(/i.test(stripped), false);
  // Also forbid the SCAN command on the redis client in any form.
  assert.equal(/\.scan\s*\(/i.test(stripped), false);
});

test('#14 no Mongo heartbeat history — store source has no model import', async () => {
  const source = read('services/presence/presenceLiveStore.js');
  // The store is a presence-only writer; it must not import any
  // Mongo model.
  assert.equal(/models\//i.test(source), false);
  assert.equal(/UserPresence\b/i.test(source), false);
  // And no mongoose import.
  assert.equal(/from\s+['"]mongoose['"]/i.test(source), false);
});

test('#15 first connection establishes live presence (count=1)', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  const snap = await store.readLive({ companyId: COMPANY, userId: USER_A });
  assert.equal(snap.connectionCount, 1);
  assert.equal(snap.connected, true);
});

test('#16 second tab increments/preserves liveness (count=2)', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-2' });
  const snap = await store.readLive({ companyId: COMPANY, userId: USER_A });
  assert.equal(snap.connectionCount, 2);
  assert.equal(snap.connected, true);
});

test('#17 closing one of two tabs does NOT produce Offline', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-2' });
  await store.markDisconnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  const snap = await store.readLive({ companyId: COMPANY, userId: USER_A });
  assert.equal(snap.connectionCount, 1, 'one tab still open');
  assert.equal(snap.connected, true, 'still live');
});

test('#18 final qualifying disconnect records confirmed Offline during the grace window', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  const after = await store.markDisconnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  assert.equal(after.connectionCount, 0);
  assert.equal(after.connected, false);
  // The key is kept alive for the grace window; the resolver will
  // still resolve 'offline' because connectionCount=0.
  const { resolvePresence } = await import(
    '../src/services/presence/presenceResolver.js'
  );
  const resolved = resolvePresence({
    durable: null,
    config: { awayAfterMinutes: 5, offlineAfterMinutes: 15, enabled: true },
    now: new Date(),
    live: after,
  });
  assert.equal(resolved.presence, 'offline');
});

test('#19 reconnect correctly restores live state', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  await store.markDisconnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  // Reconnect after the grace window.
  const t0 = await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-2' });
  assert.equal(t0.connectionCount, 1);
  assert.equal(t0.connected, true);
  const t1 = await store.readLive({ companyId: COMPANY, userId: USER_A });
  assert.equal(t1.connectionCount, 1);
  assert.equal(t1.connected, true);
});

test('reconnecting after Away starts a fresh session without fabricating activity', async () => {
  const redis = createMemoryRedis();
  const config = { awayAfterMinutes: 5, offlineAfterMinutes: 15 };
  const first = newStore({ redis, now: () => new Date('2026-10-03T10:00:00.000Z') });
  const initial = await first.markConnected({
    companyId: COMPANY,
    userId: USER_A,
    connectionId: 'sock-old',
  });
  assert.equal(
    deriveLivePresence({ snapshot: initial, config, now: new Date('2026-10-03T10:00:00.000Z') }),
    'available',
    'a new connected session starts Available without writing activity',
  );
  await first.recordActivity({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-old' });

  const idleAt = new Date('2026-10-03T10:06:00.000Z');
  const idleStore = newStore({ redis, now: () => idleAt });
  const beforeDisconnect = await idleStore.readLive({ companyId: COMPANY, userId: USER_A });
  assert.equal(deriveLivePresence({ snapshot: beforeDisconnect, config, now: idleAt }), 'away');
  await idleStore.markDisconnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-old' });

  const reconnect = newStore({ redis, now: () => idleAt });
  const reconnected = await reconnect.markConnected({
    companyId: COMPANY,
    userId: USER_A,
    connectionId: 'sock-new',
  });
  assert.equal(reconnected.connectedAt, idleAt.toISOString(), 'new session gets a fresh liveness anchor');
  assert.equal(reconnected.lastActivityAt, '2026-10-03T10:00:00.000Z', 'reconnect must not impersonate activity');
  assert.equal(deriveLivePresence({ snapshot: reconnected, config, now: idleAt }), 'available');
});

test('distributed recovery replaces stale socket members from bounded room membership', async () => {
  const redis = createMemoryRedis();
  const initial = newStore({ redis });
  await initial.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-stale' });
  await initial.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-live' });

  const reconciled = await initial.reconcileConnections({
    companyId: COMPANY,
    userId: USER_A,
    connectionIds: ['sock-live'],
    connectionId: 'sock-stale',
    isConnecting: false,
  });
  assert.equal(reconciled.connectionCount, 1);
  assert.equal(reconciled.connected, true);
  assert.deepEqual(
    await redis.smembers(presenceConnectionSetKey(COMPANY, USER_A, 'crewly:development')),
    ['sock-live'],
    'stale membership from a crashed backend is replaced without Redis cleanup',
  );
});

test('shared expiry index reports bounded candidates and atomically emits one offline claim', async () => {
  const redis = createMemoryRedis();
  const nowMs = Date.parse('2026-10-03T10:00:00.000Z');
  const store = newStore({ redis, now: () => new Date(nowMs) });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-crashed' });

  assert.deepEqual(await store.listExpiredUsers({ nowMs: nowMs + 59_999, limit: 1 }), []);
  assert.deepEqual(
    await store.listExpiredUsers({ nowMs: nowMs + 60_000, limit: 1 }),
    [{ companyId: COMPANY, userId: USER_A }],
  );
  assert.equal(await store.expireIfDue({ companyId: COMPANY, userId: USER_A, nowMs: nowMs + 59_999 }), false);
  assert.equal(await store.expireIfDue({ companyId: COMPANY, userId: USER_A, nowMs: nowMs + 60_000 }), true);
  assert.equal(
    await store.expireIfDue({ companyId: COMPANY, userId: USER_A, nowMs: nowMs + 60_000 }),
    false,
    'duplicate observer on another API instance loses the atomic claim',
  );
  const snapshot = await store.readLive({ companyId: COMPANY, userId: USER_A });
  assert.equal(snapshot.connectionCount, 0);
  assert.equal(snapshot.connected, false);
  assert.deepEqual(
    await redis.smembers(presenceConnectionSetKey(COMPANY, USER_A, 'crewly:development')),
    [],
    'expiry also removes stale socket ids without manual Redis cleanup',
  );
});

test('expiry observer removes malformed due index members so they cannot starve valid users', async () => {
  const redis = createMemoryRedis();
  const nowMs = Date.parse('2026-10-03T10:00:00.000Z');
  const store = newStore({ redis, now: () => new Date(nowMs) });
  const indexKey = presenceExpiryIndexKey('crewly:development');
  await redis.zadd(indexKey, nowMs + 60_000, 'malformed-presence-expiry-member');
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-expiry' });

  assert.deepEqual(
    await store.listExpiredUsers({ nowMs: nowMs + 60_000, limit: 1 }),
    [],
    'the malformed first result is ignored and removed',
  );
  assert.deepEqual(
    await store.listExpiredUsers({ nowMs: nowMs + 60_000, limit: 1 }),
    [{ companyId: COMPANY, userId: USER_A }],
    'a subsequent bounded read can make progress to a valid candidate',
  );
});

test('heartbeat moves the shared expiry deadline but never updates lastActivityAt', async () => {
  const redis = createMemoryRedis();
  const baseMs = Date.parse('2026-10-03T10:00:00.000Z');
  const connected = newStore({ redis, now: () => new Date(baseMs) });
  await connected.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-heartbeat' });
  const heartbeat = newStore({ redis, now: () => new Date(baseMs + 30_000) });
  const refreshed = await heartbeat.refreshHeartbeat({
    companyId: COMPANY,
    userId: USER_A,
    connectionId: 'sock-heartbeat',
  });
  assert.equal(refreshed.lastActivityAt, null);
  assert.deepEqual(await heartbeat.listExpiredUsers({ nowMs: baseMs + 60_000 }), []);
  assert.deepEqual(
    await heartbeat.listExpiredUsers({ nowMs: baseMs + 90_000 }),
    [{ companyId: COMPANY, userId: USER_A }],
  );
});

test('#22 batched read returns Offline for a successful missing key', async () => {
  const redis = createMemoryRedis();
  const store = newStore({ redis });
  await store.markConnected({ companyId: COMPANY, userId: USER_A, connectionId: 'sock-1' });
  // USER_B has no live key; Redis is healthy, so this is confirmed Offline.
  const map = await store.readLiveMany({ companyId: COMPANY, userIds: [USER_A, USER_B] });
  assert.equal(map.get(USER_A)?.connectionCount, 1);
  assert.deepEqual(map.get(USER_B), {
    connected: false,
    connectionCount: 0,
    connectedAt: null,
    lastHeartbeatAt: null,
    lastActivityAt: null,
  });
});
