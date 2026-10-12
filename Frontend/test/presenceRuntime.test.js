// ═══════════════════════════════════════════════════════════════════════════
//  PRESENCE RUNTIME TESTS
//
//  Covers runtime lifecycle safety, reducer validation, and the own-user
//  invalidation dispatches without a live Redis or Socket.IO server.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';

const runtimeMod = await import(
  '../src/services/realtime/presenceRuntime.js'
);
const { __resetPresenceRuntimeForTests } = runtimeMod;

// Reset all module state before each lifecycle test.
test('presence runtime: startPresenceRuntime is a no-op when the channel is unavailable', async () => {
  __resetPresenceRuntimeForTests();
  // Force a refusal: no api ticket reachable in this Node env.
  // The runtime catches the underlying null and remains "started"
  // (so a later retry is possible), but does NOT throw.
  const result = await runtimeMod.startPresenceRuntime();
  // Either it returns false (StrictMode guard) or true (started
  // but with no socket). Either way, no throw.
  assert.ok(typeof result === 'boolean');
  runtimeMod.stopPresenceRuntime();
});

test('presence runtime: idempotent — two starts do not double-attach', async () => {
  __resetPresenceRuntimeForTests();
  await runtimeMod.startPresenceRuntime();
  const second = await runtimeMod.startPresenceRuntime();
  // Second call returns false because `started` is true.
  assert.equal(second, false);
  runtimeMod.stopPresenceRuntime();
});

test('presence runtime: stop is safe to call before start', () => {
  __resetPresenceRuntimeForTests();
  // Should not throw.
  runtimeMod.stopPresenceRuntime();
});

test('presence runtime: stop clears the runtime flag', async () => {
  __resetPresenceRuntimeForTests();
  await runtimeMod.startPresenceRuntime();
  runtimeMod.stopPresenceRuntime();
  assert.equal(runtimeMod.isPresenceRuntimeActive(), false);
});

// ────────────────────────────────────────────────────────────────────────
//  REDUX PURE-REDUCER TESTS
//
//  These run WITHOUT a real socket. We import the slice, dispatch
//  presenceTicked / presenceInvalidateTeam, and assert the
//  resulting state shape.
// ────────────────────────────────────────────────────────────────────────

test('presenceTicked reducer: updates current.presence', async () => {
  const presenceSlice = await import(
    '../src/redux/slices/presenceSlice.js'
  );
  const { presenceTicked } = presenceSlice;
  const initial = presenceSlice.default(undefined, { type: '@@INIT' });
  assert.ok(initial.current);

  const env = {
    schemaVersion: 1,
    companyId: 'c1',
    userId: 'u1',
    presence: 'away',
    presenceSource: 'automatic',
    occurredAt: '2026-10-03T10:00:00.000Z',
    source: 'activity',
  };
  const next = presenceSlice.default(initial, presenceTicked(env));
  assert.equal(next.current.presence, 'away');
  assert.equal(next.current.presenceSource, 'automatic');
  assert.equal(next.current.lastLiveAt, '2026-10-03T10:00:00.000Z');
  assert.equal(next.current.lastLiveSource, 'activity');
});

test('presenceTicked reducer: is idempotent on no-op', async () => {
  const presenceSlice = await import(
    '../src/redux/slices/presenceSlice.js'
  );
  const { presenceTicked } = presenceSlice;
  const base = presenceSlice.default(undefined, { type: '@@INIT' });
  const env = {
    schemaVersion: 1,
    companyId: 'c1',
    userId: 'u1',
    presence: base.current.presence,
    presenceSource: 'none',
    occurredAt: '2026-10-03T10:00:00.000Z',
    source: 'activity',
  };
  // Same presence → no field change.
  const before = JSON.stringify(base);
  const after = presenceSlice.default(base, presenceTicked(env));
  const afterStr = JSON.stringify(after);
  assert.equal(afterStr, before);
});

test('presenceTicked reducer: drops unknown schemaVersion', async () => {
  const presenceSlice = await import(
    '../src/redux/slices/presenceSlice.js'
  );
  const { presenceTicked } = presenceSlice;
  const base = presenceSlice.default(undefined, { type: '@@INIT' });
  const before = JSON.stringify(base);
  const after = presenceSlice.default(
    base,
    presenceTicked({ schemaVersion: 999, userId: 'u1', presence: 'busy' }),
  );
  assert.equal(JSON.stringify(after), before);
});

test('presenceTicked reducer: drops malformed envelopes (no schemaVersion)', async () => {
  const presenceSlice = await import(
    '../src/redux/slices/presenceSlice.js'
  );
  const { presenceTicked } = presenceSlice;
  const base = presenceSlice.default(undefined, { type: '@@INIT' });
  const before = JSON.stringify(base);
  const after = presenceSlice.default(
    base,
    presenceTicked({ userId: 'u1', presence: 'busy' }),
  );
  assert.equal(JSON.stringify(after), before);
});

test('presenceInvalidateTeam reducer: stamps teamBumpedAt', async () => {
  const presenceSlice = await import(
    '../src/redux/slices/presenceSlice.js'
  );
  const { presenceInvalidateTeam } = presenceSlice;
  const base = presenceSlice.default(undefined, { type: '@@INIT' });
  assert.equal(base.teamBumpedAt, null);
  const after = presenceSlice.default(base, presenceInvalidateTeam());
  assert.ok(after.teamBumpedAt);
  // The stamp is a parseable ISO date.
  const t = new Date(after.teamBumpedAt).getTime();
  assert.ok(!Number.isNaN(t));
});

test('presenceInvalidateTeam reducer: each dispatch produces a new timestamp', async () => {
  const presenceSlice = await import(
    '../src/redux/slices/presenceSlice.js'
  );
  const { presenceInvalidateTeam } = presenceSlice;
  const a = presenceSlice.default(
    presenceSlice.default(undefined, { type: '@@INIT' }),
    presenceInvalidateTeam(),
  );
  // Sleep a millisecond so the timestamps differ.
  await new Promise((r) => setTimeout(r, 2));
  const b = presenceSlice.default(a, presenceInvalidateTeam());
  assert.notEqual(a.teamBumpedAt, b.teamBumpedAt);
});

test('presence:changed drops a cross-tenant frame before self or team dispatches', async () => {
  __resetPresenceRuntimeForTests();
  const storeMod = await import('../src/redux/store.js');
  const store = storeMod.default;
  const originalGetState = store.getState;
  const originalDispatch = store.dispatch;
  const dispatched = [];
  store.getState = () => ({ auth: { user: { _id: 'u1', companyId: 'tenant-a' } } });
  store.dispatch = (action) => { dispatched.push(action); return action; };

  try {
    runtimeMod.__onPresenceChangedForTests({
      schemaVersion: 1,
      companyId: 'tenant-b',
      userId: 'u1',
      presence: 'busy',
      presenceSource: 'manual',
      occurredAt: '2026-10-03T10:00:00.000Z',
      source: 'resolver',
    });
    assert.deepEqual(dispatched, [], 'cross-tenant envelopes trigger no Redux work');

    runtimeMod.__onPresenceChangedForTests({
      schemaVersion: 1,
      companyId: 'tenant-a',
      userId: 'u1',
      presence: 'busy',
      presenceSource: 'manual',
      occurredAt: '2026-10-03T10:00:01.000Z',
      source: 'resolver',
    });
    assert.equal(dispatched.length, 2, 'same-tenant user status refetches the authority');
  } finally {
    __resetPresenceRuntimeForTests();
    store.getState = originalGetState;
    store.dispatch = originalDispatch;
  }
});

test('presence:invalidated refetches the signed-in user work-location requests', async () => {
  __resetPresenceRuntimeForTests();
  const storeMod = await import('../src/redux/store.js');
  const presenceSlice = await import('../src/redux/slices/presenceSlice.js');
  const requestServiceMod = await import(
    '../src/services/presence/workLocationRequestService.js'
  );
  const store = storeMod.default;
  const originalGetState = store.getState;
  const originalDispatch = store.dispatch;
  const originalMine = requestServiceMod.default.mine;
  const dispatched = [];
  let mineCalls = 0;
  let requestFetchPromise;

  store.getState = () => ({
    auth: { user: { _id: 'u1', companyId: 'c1' } },
  });
  requestServiceMod.default.mine = async () => {
    mineCalls += 1;
    return { requests: [] };
  };
  store.dispatch = (action) => {
    dispatched.push(action);
    if (typeof action === 'function') {
      const thunkDispatches = dispatched.filter((item) => typeof item === 'function').length;
      // Execute the work-location fetch thunk, but keep the separate
      // presence snapshot load from making a network request in this test.
      if (thunkDispatches === 1) {
        requestFetchPromise = originalDispatch(action);
        return requestFetchPromise;
      }
      return Promise.resolve();
    }
    return originalDispatch(action);
  };

  try {
    runtimeMod.__onPresenceInvalidatedForTests({
      schemaVersion: 1,
      companyId: 'c1',
      userId: 'u1',
      occurredAt: '2026-10-03T10:00:00.000Z',
      source: 'approve',
    });
    await requestFetchPromise;

    assert.equal(dispatched.length, 3);
    assert.equal(dispatched[0].type, presenceSlice.presenceWlrInvalidateForUser().type);
    assert.equal(typeof dispatched[1], 'function', 'fetchMyWorkLocationRequests thunk is dispatched');
    assert.equal(typeof dispatched[2], 'function', 'authoritative self-presence reload is dispatched');
    assert.equal(mineCalls, 1, 'request cache is refreshed from the service');
  } finally {
    runtimeMod.stopPresenceRuntime();
    store.getState = originalGetState;
    store.dispatch = originalDispatch;
    requestServiceMod.default.mine = originalMine;
  }
});
