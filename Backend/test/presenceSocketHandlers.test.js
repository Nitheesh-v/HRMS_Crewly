// Presence socket handler regressions: REST-equivalent precedence, real
// activity timestamps, final-disconnect Offline publication, and multi-tab safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_presence_socket_handlers_test';

const {
  registerPresenceSocketHandlers,
  resolveEffectivePresence,
  _resetPresenceMemoForTests,
} = await import('../src/socket/presenceSocketHandlers.js');
const { presenceService } = await import('../src/services/presence/presenceService.js');
const {
  __setPresenceSocketNamespaceForTests,
  __resetPresenceSocketNamespaceForTests,
} = await import('../src/services/presence/presenceSocketPublisher.js');

const COMPANY = '1111111111111111111111aa';
const USER = '2222222222222222222222bb';
const NOW = new Date('2026-10-03T10:00:00.000Z');
const CONFIG = {
  enabled: true,
  statusMessagesEnabled: true,
  workLocationEnabled: true,
  wfhMode: 'self_declare',
  allowedWorkLocations: ['office', 'wfh', 'remote'],
  awayAfterMinutes: 5,
  offlineAfterMinutes: 15,
};

const connectedSnapshot = {
  connected: true,
  connectionCount: 1,
  lastHeartbeatAt: NOW.toISOString(),
  lastActivityAt: NOW.toISOString(),
};

const makeServiceFactory = ({ durable = null, leave = null } = {}) => ({ liveStore }) =>
  presenceService({
    UserPresenceModel: { findOne: async () => durable },
    tenantConfigReader: async () => CONFIG,
    leaveReader: async () => leave,
    liveStore,
  });

test('socket resolver uses REST service precedence: manual Busy beats automatic Available', async () => {
  const result = await resolveEffectivePresence({
    companyId: COMPANY,
    userId: USER,
    store: { readLive: async () => connectedSnapshot },
    serviceFactory: makeServiceFactory({
      durable: {
        manualStatus: 'busy',
        manualStatusExpiresAt: new Date('2999-10-03T17:00:00.000Z'),
      },
      leave: null,
    }),
  });
  assert.equal(result.presence, 'busy');
  assert.equal(result.presenceSource, 'manual');
});

test('socket resolver uses REST service precedence: approved Leave beats manual Busy', async () => {
  const result = await resolveEffectivePresence({
    companyId: COMPANY,
    userId: USER,
    store: { readLive: async () => connectedSnapshot },
    serviceFactory: makeServiceFactory({
      durable: {
        manualStatus: 'busy',
        manualStatusExpiresAt: new Date('2999-10-03T17:00:00.000Z'),
      },
      leave: { _id: 'leave-row' },
    }),
  });
  assert.equal(result.presence, 'on_leave');
  assert.equal(result.presenceSource, 'leave');
});

test('heartbeat does not write activity; tick re-evaluates without writing activity', async () => {
  _resetPresenceMemoForTests();
  const emissions = [];
  __setPresenceSocketNamespaceForTests({
    to: (room) => ({ emit: (event, envelope) => emissions.push({ room, event, envelope }) }),
  });
  const listeners = new Map();
  const calls = [];
  const socket = {
    id: 'socket-1',
    data: { companyId: COMPANY, userId: USER },
    on: (event, handler) => listeners.set(event, handler),
  };
  const store = {
    markConnected: async () => null,
    refreshHeartbeat: async (args) => { calls.push(['heartbeat', args]); return connectedSnapshot; },
    recordActivity: async (args) => { calls.push(['activity', args]); return connectedSnapshot; },
    markDisconnected: async () => ({ connectionCount: 1, connected: true }),
  };
  registerPresenceSocketHandlers({
    io: {},
    socket,
    store,
    resolveEffective: async () => ({ presence: 'available', presenceSource: 'automatic' }),
  });
  try {
    await listeners.get('presence:heartbeat')();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'heartbeat');
    assert.equal(calls[0][1].connectionId, 'socket-1');
    assert.equal(calls[0][1].at, undefined);
    assert.deepEqual(emissions, [], 'heartbeat never publishes a presence transition');

    await listeners.get('presence:tick')();
    assert.equal(calls.length, 1, 'tick does not write activity or heartbeat state');
    assert.equal(emissions.length, 1, 'tick can publish a newly resolved value');
    assert.equal(emissions[0].envelope.source, 'tick');
    assert.equal(emissions[0].envelope.presence, 'available');
  } finally {
    __resetPresenceSocketNamespaceForTests();
  }
});

test('activity is server-stamped; final disconnect publishes Offline, but another tab does not', async () => {
  _resetPresenceMemoForTests();
  const emissions = [];
  __setPresenceSocketNamespaceForTests({
    to: (room) => ({ emit: (event, envelope) => emissions.push({ room, event, envelope }) }),
  });
  try {
    const listeners = new Map();
    const storeCalls = [];
    let disconnectCount = 1;
    const socket = {
      id: 'socket-1',
      data: { companyId: COMPANY, userId: USER },
      on: (event, handler) => listeners.set(event, handler),
    };
    const store = {
      markConnected: async () => null,
      recordActivity: async (args) => {
        storeCalls.push(['activity', args]);
        return connectedSnapshot;
      },
      markDisconnected: async (args) => {
        storeCalls.push(['disconnect', args]);
        return { connected: disconnectCount > 0, connectionCount: disconnectCount };
      },
    };
    let effective = { presence: 'available', presenceSource: 'automatic' };
    registerPresenceSocketHandlers({
      io: {},
      socket,
      store,
      resolveEffective: async () => effective,
    });

    // A forged timestamp in the payload is ignored; only the authenticated
    // socket identity is sent to the live store.
    await listeners.get('presence:activity')({ at: '2999-01-01T00:00:00.000Z' });
    assert.equal(storeCalls[0][0], 'activity');
    assert.equal(storeCalls[0][1].connectionId, 'socket-1');
    assert.equal(storeCalls[0][1].at, undefined);
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].envelope.presence, 'available');
    assert.equal(emissions[0].envelope.presenceSource, 'automatic');

    // The same effective value with a different authoritative source
    // (e.g. manual Available over automatic Available) must still publish.
    effective = { presence: 'available', presenceSource: 'manual' };
    await listeners.get('presence:tick')();
    assert.equal(emissions.length, 2);
    assert.equal(emissions[1].envelope.presence, 'available');
    assert.equal(emissions[1].envelope.presenceSource, 'manual');

    // One remaining connection means the user is still online.
    await listeners.get('disconnect')();
    assert.equal(emissions.length, 2);

    // The last disconnect resolves through the injected effective resolver
    // and delivers an Offline envelope to the affected user's room.
    disconnectCount = 0;
    effective = { presence: 'offline', presenceSource: 'automatic' };
    await listeners.get('disconnect')();
    assert.equal(emissions.length, 3);
    assert.equal(emissions[2].event, 'presence:changed');
    assert.equal(emissions[2].room, `presence:user:${USER}`);
    assert.equal(emissions[2].envelope.presence, 'offline');
    assert.equal(emissions[2].envelope.source, 'disconnect');
  } finally {
    __resetPresenceSocketNamespaceForTests();
    _resetPresenceMemoForTests();
  }
});
