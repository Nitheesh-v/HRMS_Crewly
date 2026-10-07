import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { createPresenceExpiryObserver } = await import(
  '../src/services/presence/presenceExpiryObserver.js'
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(
  path.join(HERE, '..', 'src', 'services', 'presence', 'presenceExpiryObserver.js'),
  'utf8',
);

test('expiry observer publishes one bounded lease-expiry invalidation after the atomic claim', async () => {
  const calls = [];
  const nowMs = Date.parse('2026-10-03T10:00:00.000Z');
  const store = {
    listExpiredUsers: async ({ limit }) => {
      assert.equal(limit, 10);
      return [
        { companyId: 'tenant-a', userId: 'employee-1' },
        { companyId: 'tenant-b', userId: 'employee-2' },
      ];
    },
    expireIfDue: async ({ companyId }) => companyId === 'tenant-a',
  };
  const observer = createPresenceExpiryObserver({
    store,
    publish: async (event) => { calls.push(event); return { ok: true }; },
    now: () => nowMs,
    batchSize: 10,
    logger: { warn() {} },
  });

  assert.deepEqual(await observer.runOnce(), { scanned: 2, expired: 1 });
  assert.deepEqual(calls, [{
    companyId: 'tenant-a',
    userId: 'employee-1',
    source: 'lease_expiry',
    occurredAt: '2026-10-03T10:00:00.000Z',
  }]);
});

test('expiry observer treats unavailable Redis as no claim, never as mass Offline', async () => {
  const published = [];
  const warnings = [];
  const observer = createPresenceExpiryObserver({
    store: {
      listExpiredUsers: async () => [],
      expireIfDue: async () => false,
    },
    publish: async (event) => published.push(event),
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(await observer.runOnce(), { scanned: 0, expired: 0 });
  assert.deepEqual(published, []);
  assert.deepEqual(warnings, []);
});

test('expiry observer is process-level, idempotently scheduled, and stops cleanly', async () => {
  const intervals = [];
  const cleared = [];
  const observer = createPresenceExpiryObserver({
    store: { listExpiredUsers: async () => [], expireIfDue: async () => false },
    publish: async () => ({ ok: true }),
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, unref() { this.unrefCalled = true; } };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => cleared.push(timer),
    intervalMs: 12_000,
  });

  assert.equal(observer.start(), true);
  assert.equal(observer.start(), false);
  assert.equal(intervals.length, 1, 'one sweep timer is shared by the process');
  assert.equal(intervals[0].delay, 12_000);
  assert.equal(intervals[0].unrefCalled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observer.stop().stopped, true);
  assert.deepEqual(cleared, [intervals[0]]);
  assert.deepEqual(observer.describeDiagnostics(), { running: false, scheduled: false, stopped: true });
});

test('source guard: expiry observer uses no per-employee timers or Redis scans', () => {
  assert.doesNotMatch(SOURCE, /setTimeout\s*\(/);
  assert.doesNotMatch(SOURCE, /redis\.keys\s*\(|redis\.scan\s*\(|\.scan\s*\(/i);
  assert.match(SOURCE, /listExpiredUsers/);
  assert.match(SOURCE, /expireIfDue/);
});
