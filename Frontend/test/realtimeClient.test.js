import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { test } from 'node:test';
import api from '../src/services/api.js';
import {
  isRealtimeSessionActive,
  onRealtimeEvent,
  startRealtimeSession,
  stopRealtimeSession,
} from '../src/services/realtime/realtimeClient.js';

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, envelope) {
    this.listeners.get(type)?.({ data: JSON.stringify(envelope) });
  }

  close() {
    this.closed = true;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('one app-session stream delivers only matching allowlisted Helpdesk nudges and closes cleanly', async (t) => {
  const previousEventSource = globalThis.EventSource;
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource;
  t.after(() => {
    stopRealtimeSession();
    globalThis.EventSource = previousEventSource;
  });

  let ticketRequests = 0;
  t.mock.method(api, 'post', async (path) => {
    assert.equal(path, '/realtime/ticket');
    ticketRequests += 1;
    return { ticket: 'opaque-single-use-ticket' };
  });

  const observed = [];
  const unsubscribe = onRealtimeEvent((event) => observed.push(event));
  t.after(unsubscribe);

  startRealtimeSession();
  startRealtimeSession();
  await tick();

  assert.equal(ticketRequests, 1);
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(isRealtimeSessionActive(), true);
  const [stream] = FakeEventSource.instances;
  assert.match(stream.url, /\/api\/realtime\/stream\?ticket=opaque-single-use-ticket$/);

  stream.emit('helpdesk:notifications:changed', { type: 'not-the-event', payload: {} });
  assert.deepEqual(observed, [], 'event-name/type mismatch is ignored');
  stream.emit('helpdesk:notifications:changed', {
    type: 'helpdesk:notifications:changed',
    payload: { ticketNumber: 'must-not-cross-the-stream' },
  });
  assert.deepEqual(observed, [], 'non-empty Helpdesk payload is rejected client-side');
  const nudge = {
    id: 'event-id',
    type: 'helpdesk:notifications:changed',
    companyId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    ts: 123,
    payload: {},
  };
  stream.emit('helpdesk:notifications:changed', nudge);
  assert.deepEqual(observed, [nudge]);

  stopRealtimeSession();
  assert.equal(stream.closed, true);
  assert.equal(isRealtimeSessionActive(), false);
});

test('a late ticket response from a stopped session cannot open a stale user stream', async (t) => {
  const previousEventSource = globalThis.EventSource;
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource;
  t.after(() => {
    stopRealtimeSession();
    globalThis.EventSource = previousEventSource;
  });

  let releaseOldTicket;
  let ticketRequests = 0;
  t.mock.method(api, 'post', async () => {
    ticketRequests += 1;
    if (ticketRequests === 1) {
      return new Promise((resolve) => { releaseOldTicket = resolve; });
    }
    return { ticket: 'current-session-ticket' };
  });

  startRealtimeSession();
  stopRealtimeSession();
  startRealtimeSession();
  await tick();
  releaseOldTicket({ ticket: 'stale-session-ticket' });
  await tick();

  assert.equal(ticketRequests, 2);
  assert.equal(FakeEventSource.instances.length, 1);
  assert.match(FakeEventSource.instances[0].url, /current-session-ticket$/);
  assert.doesNotMatch(FakeEventSource.instances[0].url, /stale-session-ticket/);
});
