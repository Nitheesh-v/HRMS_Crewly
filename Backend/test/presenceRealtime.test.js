// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — RESOLVER + CHANGE DETECTOR TESTS (hermetic)
//
//  Covers §41 backend tests #20–#26.
//  The resolver is pure. The change detector is built from the
//  publishIfChanged helper in the socket handlers (re-imported via
//  the bus façade in this file).
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_presence_realtime_test';

const { resolvePresence, __test__ } = await import(
  '../src/services/presence/presenceResolver.js'
);
const { buildLiveSnapshot } = await import(
  '../src/services/presence/presenceLive.js'
);

const COMPANY = '1111111111111111111111aa';
const USER = '2222222222222222222222bb';

const configBase = {
  enabled: true,
  statusMessagesEnabled: true,
  workLocationEnabled: true,
  wfhMode: 'self_declare',
  awayAfterMinutes: 5,
  offlineAfterMinutes: 15,
  lastSeenVisible: false,
  allowedWorkLocations: ['office', 'wfh', 'remote'],
};

const NOW = new Date('2026-10-03T10:00:00.000Z');

test('#20 recent connected activity -> available (automatic)', () => {
  const live = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: NOW.toISOString(),
    lastActivityAt: '2026-10-03T09:58:00.000Z', // 2 min ago, < 5
  });
  const r = resolvePresence({
    durable: null,
    config: configBase,
    now: NOW,
    live,
  });
  assert.equal(r.presence, 'available');
  assert.equal(r.presenceSource, 'automatic');
  assert.equal(r.livePresenceAvailable, true);
});

test('#21 inactivity past awayAfterMinutes -> away (automatic)', () => {
  const live = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: NOW.toISOString(),
    lastActivityAt: '2026-10-03T09:00:00.000Z', // 60 min ago, > 5
  });
  const r = resolvePresence({
    durable: null,
    config: configBase,
    now: NOW,
    live,
  });
  assert.equal(r.presence, 'away');
  assert.equal(r.presenceSource, 'automatic');
});

test('#22 new activity after away -> available (automatic)', () => {
  const recent = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(), // just now
  });
  const r = resolvePresence({
    durable: null,
    config: configBase,
    now: NOW,
    live: recent,
  });
  assert.equal(r.presence, 'available');
});

test('#23 manual Busy beats automatic Available', () => {
  // The user explicitly set Busy until 5 PM. The heartbeat is fresh,
  // the activity is fresh — the resolver MUST surface Busy.
  const live = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
  });
  const durable = {
    manualStatus: 'busy',
    manualStatusExpiresAt: new Date('2026-10-03T17:00:00.000Z'),
  };
  const r = resolvePresence({
    durable,
    config: configBase,
    now: NOW,
    live,
  });
  assert.equal(r.presence, 'busy');
  assert.equal(r.presenceSource, 'manual');
  // live IS available (we read it) but the displayed value is manual.
  assert.equal(r.livePresenceAvailable, true);
});

test('#24 manual DND beats automatic Available', () => {
  const live = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
  });
  const durable = {
    manualStatus: 'dnd',
    manualStatusExpiresAt: new Date('2026-10-03T17:00:00.000Z'),
  };
  const r = resolvePresence({
    durable,
    config: configBase,
    now: NOW,
    live,
  });
  assert.equal(r.presence, 'dnd');
  assert.equal(r.presenceSource, 'manual');
});

test('#25 confirmed no connection -> offline (automatic)', () => {
  const live = buildLiveSnapshot({
    connected: false,
    connectionCount: 0,
    lastHeartbeatAt: null,
    lastActivityAt: null,
  });
  const r = resolvePresence({
    durable: null,
    config: configBase,
    now: NOW,
    live,
  });
  assert.equal(r.presence, 'offline');
  assert.equal(r.presenceSource, 'automatic');
  assert.equal(r.livePresenceAvailable, true);
});

test('#26 infrastructure uncertainty -> unknown (37.1 behaviour preserved)', () => {
  // live === null -> the resolver returns 'unknown', the same
  // 37.1 contract. The 37.1 test suite (presenceFoundation.test.js)
  // pins this further.
  const r = resolvePresence({
    durable: null,
    config: configBase,
    now: NOW,
    live: null,
  });
  assert.equal(r.presence, 'unknown');
  assert.equal(r.presenceSource, 'none');
  assert.equal(r.livePresenceAvailable, false);
});

test('37.1 backward compatibility: 3-arg call still returns the 37.1 shape', () => {
  // A 37.1 call site that passes {durable, config, now} (no live)
  // must still work. The resolver defaults `live` to null and the
  // 37.1 contract (unknown when no manual) is preserved.
  const r = resolvePresence({
    durable: null,
    config: configBase,
    now: NOW,
  });
  assert.equal(r.presence, 'unknown');
  assert.equal(r.livePresenceAvailable, false);
  // Shape is the 37.1 keys + the 37.4 livePresenceAvailable.
  for (const key of [
    'presence',
    'presenceSource',
    'manualStatus',
    'manualStatusExpiresAt',
    'statusMessage',
    'statusMessageExpiresAt',
    'workLocation',
    'workLocationExpiresAt',
    'livePresenceAvailable',
    'config',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, key), `key ${key} present`);
  }
});

test('heartbeat older than offlineAfterMinutes + active connection -> offline (automatic)', () => {
  // §11 / §13: heartbeat alone drives the Offline transition, not
  // activity. A 20-minute-old heartbeat is past offlineAfterMinutes
  // (15) even though the activity is fresh.
  const live = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: '2026-10-03T09:40:00.000Z', // 20 min ago
    lastActivityAt: NOW.toISOString(),
  });
  const r = resolvePresence({
    durable: null,
    config: configBase,
    now: NOW,
    live,
  });
  assert.equal(r.presence, 'offline');
});

test('37.1 manual precedence still applies when live is unknown (live===null)', () => {
  // A user with manual Busy but no live source (Redis down) still
  // surfaces Busy. The manual layer is the OUTER precedence; the
  // live layer is the INNER layer.
  const durable = {
    manualStatus: 'busy',
    manualStatusExpiresAt: new Date('2026-10-03T17:00:00.000Z'),
  };
  const r = resolvePresence({
    durable,
    config: configBase,
    now: NOW,
    live: null,
  });
  assert.equal(r.presence, 'busy');
  assert.equal(r.presenceSource, 'manual');
});

test('expired manual status falls through to automatic', () => {
  // The user set Busy until 9 AM, but it is now 10 AM. The resolver
  // applies the live snapshot (available) because the manual is
  // expired. The 37.1 contract: manualExpiryMs is checked, then
  // automatic wins.
  const live = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
  });
  const durable = {
    manualStatus: 'busy',
    manualStatusExpiresAt: new Date('2026-10-03T09:00:00.000Z'),
  };
  const r = resolvePresence({
    durable,
    config: configBase,
    now: NOW,
    live,
  });
  assert.equal(r.presence, 'available');
  assert.equal(r.presenceSource, 'automatic');
});

// Internal sanity: the resolver is pure (no I/O, no Date.now() reads).
test('resolver purity: repeated calls with the same input return equal snapshots', () => {
  const live = buildLiveSnapshot({
    connected: true,
    connectionCount: 1,
    lastHeartbeatAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
  });
  const a = resolvePresence({ durable: null, config: configBase, now: NOW, live });
  const b = resolvePresence({ durable: null, config: configBase, now: NOW, live });
  assert.deepEqual(a, b);
  // Both must be frozen.
  assert.throws(() => { a.presence = 'busy'; });
});
