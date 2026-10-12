import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAdapter } from '@socket.io/redis-adapter';
import { Encoder } from 'socket.io-parser';

process.env.NODE_ENV ||= 'test';

const {
  __resetPresenceSocketNamespaceForTests,
  __setPresenceSocketNamespaceForTests,
  emitPresenceSocketEvent,
} = await import('../src/services/presence/presenceSocketPublisher.js');
const { buildPresenceChangedEnvelope } = await import(
  '../src/services/presence/presenceEvents.js'
);
const { presenceUserRoom } = await import('../src/utils/presenceKeys.js');

const createInMemoryRedisPubSub = () => {
  const clients = new Set();
  const metrics = { publications: 0 };
  const matches = (pattern, channel) =>
    pattern.endsWith('*')
      ? channel.startsWith(pattern.slice(0, -1))
      : pattern === channel;

  class FakeRedisClient extends EventEmitter {
    constructor(role) {
      super();
      this.role = role;
      this.patterns = new Map();
      this.channels = new Map();
      clients.add(this);
    }
    pSubscribe(pattern, listener) { this.patterns.set(pattern, listener); }
    subscribe(channels, listener) {
      for (const channel of Array.isArray(channels) ? channels : [channels]) {
        this.channels.set(channel, listener);
      }
    }
    pUnsubscribe(pattern) { this.patterns.delete(pattern); }
    unsubscribe(channels) {
      for (const channel of Array.isArray(channels) ? channels : [channels]) {
        this.channels.delete(channel);
      }
    }
    publish(channel, message) {
      metrics.publications += 1;
      for (const client of clients) {
        for (const [pattern, listener] of client.patterns) {
          if (matches(pattern, channel)) listener(message, Buffer.from(channel));
        }
        const listener = client.channels.get(channel);
        if (listener) listener(message, Buffer.from(channel));
      }
      return Promise.resolve(clients.size);
    }
  }

  return {
    metrics,
    pair: () => [new FakeRedisClient('pub'), new FakeRedisClient('sub')],
  };
};

const createNamespace = (name) => ({
  name,
  sockets: new Map(),
  server: { encoder: new Encoder() },
});

const addRoomSocket = (namespace, adapter, id, room) => {
  const received = [];
  const socket = {
    id,
    notifyOutgoingListeners: (packet) => received.push(packet),
    client: { writeToEngine() {} },
  };
  namespace.sockets.set(id, socket);
  adapter.addAll(id, new Set([room]));
  return received;
};

test('Socket.IO Redis adapter forwards locally and across instances once, only to the tenant/user room', () => {
  const broker = createInMemoryRedisPubSub();
  const [pubA, subA] = broker.pair();
  const [pubB, subB] = broker.pair();
  const namespaceA = createNamespace('/presence');
  const namespaceB = createNamespace('/presence');
  const adapterA = createAdapter(pubA, subA, { key: 'crewly:test:presence:adapter' })(namespaceA);
  const adapterB = createAdapter(pubB, subB, { key: 'crewly:test:presence:adapter' })(namespaceB);
  const tenantAUser1 = presenceUserRoom('tenant-a', 'employee-1');
  const tenantAUser2 = presenceUserRoom('tenant-a', 'employee-2');
  const tenantBUser1 = presenceUserRoom('tenant-b', 'employee-1');

  const localTarget = addRoomSocket(namespaceA, adapterA, 'a-local', tenantAUser1);
  const localWrongTenant = addRoomSocket(namespaceA, adapterA, 'a-tenant-b', tenantBUser1);
  const remoteTarget = addRoomSocket(namespaceB, adapterB, 'b-remote', tenantAUser1);
  const remoteWrongUser = addRoomSocket(namespaceB, adapterB, 'b-user-2', tenantAUser2);
  const remoteWrongTenant = addRoomSocket(namespaceB, adapterB, 'b-tenant-b', tenantBUser1);

  const namespacePublisher = {
    to: (room) => ({
      emit: (event, envelope) => adapterA.broadcast(
        { type: 2, data: [event, envelope] },
        { rooms: new Set([room]), except: new Set(), flags: {} },
      ),
    }),
  };
  __setPresenceSocketNamespaceForTests(namespacePublisher);
  try {
    const built = buildPresenceChangedEnvelope({
      companyId: 'tenant-a',
      userId: 'employee-1',
      presence: 'available',
      presenceSource: 'automatic',
      occurredAt: '2026-10-03T10:00:00.000Z',
      source: 'activity',
    });
    const result = emitPresenceSocketEvent({
      event: 'presence:changed',
      companyId: 'tenant-a',
      envelope: built.envelope,
    });

    assert.equal(result.ok, true);
    assert.equal(localTarget.length, 1, 'the publishing API instance forwards locally');
    assert.equal(remoteTarget.length, 1, 'the existing Redis adapter forwards to another API instance');
    assert.equal(localWrongTenant.length, 0);
    assert.equal(remoteWrongUser.length, 0);
    assert.equal(remoteWrongTenant.length, 0);
    assert.equal(broker.metrics.publications, 1, 'remote receipt does not republish or echo');
    assert.equal(localTarget[0].data[0], 'presence:changed');
  } finally {
    __resetPresenceSocketNamespaceForTests();
    adapterA.close();
    adapterB.close();
  }
});

test('publisher rejects an envelope whose tenant differs from the selected tenant room', () => {
  const sent = [];
  __setPresenceSocketNamespaceForTests({
    to: (room) => ({ emit: (event, envelope) => sent.push({ room, event, envelope }) }),
  });
  try {
    const result = emitPresenceSocketEvent({
      event: 'presence:changed',
      companyId: 'tenant-a',
      envelope: { companyId: 'tenant-b', userId: 'employee-1' },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(sent, []);
  } finally {
    __resetPresenceSocketNamespaceForTests();
  }
});
