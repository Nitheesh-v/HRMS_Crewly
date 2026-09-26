// ============================================================
//  PHASE 33.9-fix — CHAT SOCKET RESILIENCE (HERMETIC).
//
//  WHY THIS SUITE EXISTS
//    socket.io invokes listeners through EventEmitter and ignores the
//    returned promise. A rejected async listener therefore becomes an
//    unhandledRejection, and the 32.x process policy drains the whole API on
//    one. That is exactly what happened live: a mongoose ValidationError
//    thrown by the TEXT-edit update (33.6's query-scope validator bug,
//    fixed in src/models/ChatMessage.js) escaped chat:message:edit and the
//    server shut itself down.
//
//  WHAT IS PINNED
//    · a throwing service produces a RETRYABLE ACK — the listener never
//      rejects, for send / edit / delete / readUpTo / join
//    · the guard logs the error NAME only (no message, no payload, no stack)
//    · the success path is unchanged: a normal ack still flows through
//    · the handler file routes every listener through the guard (source pin)
//
//  No Redis, no Mongo, no socket.io-client: the real handler registration
//  runs against a mock socket with injected services.
// ============================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_resilience';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();

const COMPANY = id();
const USER = id();

const makeSocket = () => {
  const handlers = {};

  return {
    id: 'sock-resilience',
    data: { companyId: COMPANY, userId: USER },
    on: (event, fn) => {
      handlers[event] = fn;
    },
    join: async () => {},
    leave: () => {},
    trigger: (event, payload) =>
      new Promise((resolve) => {
        handlers[event](payload, resolve);
      }),
  };
};

const makeIo = () => ({
  to: () => ({ emit: () => {} }),
});

// A logger that records what the guard reports.
const makeLog = () => {
  const entries = [];

  return {
    entries,
    error: (message) => entries.push(message),
    warn: (message) => entries.push(message),
  };
};

const boom = () => {
  const error = new Error('internal detail that must never reach the client');
  error.name = 'ValidationError';
  return error;
};

const boot = ({ log, ...services }) => {
  const socket = makeSocket();

  registerChatSocketHandlers({
    io: makeIo(),
    socket,
    log,
    loadConversation: async () => null,
    sendMessage: async () => ({ ok: false, code: 'RETRYABLE' }),
    editMessage: async () => ({ ok: false, code: 'RETRYABLE' }),
    deleteMessage: async () => ({ ok: false, code: 'RETRYABLE' }),
    markRead: async () => ({ ok: false, code: 'RETRYABLE' }),
    resolveModerator: async () => false,
    ...services,
  });

  return socket;
};

test('a throwing send service becomes a RETRYABLE ack, never a rejection', async () => {
  const log = makeLog();
  const socket = boot({ log, sendMessage: async () => { throw boom(); } });

  const ack = await socket.trigger('chat:message:send', {
    conversationId: id(),
    clientMessageId: 'c-1',
    text: 'hello',
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'RETRYABLE');
  assert.ok(!JSON.stringify(ack).includes('internal detail'), 'no internal text in the ack');
});

test('a throwing edit service (the live crash) becomes a RETRYABLE ack', async () => {
  const log = makeLog();
  const socket = boot({ log, editMessage: async () => { throw boom(); } });

  const ack = await socket.trigger('chat:message:edit', {
    conversationId: id(),
    messageId: id(),
    expectedEditVersion: 0,
    newText: 'hih',
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'RETRYABLE');
});

test('a throwing delete service becomes a RETRYABLE ack', async () => {
  const log = makeLog();
  const socket = boot({ log, deleteMessage: async () => { throw boom(); } });

  const ack = await socket.trigger('chat:message:delete', {
    conversationId: id(),
    messageId: id(),
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'RETRYABLE');
});

test('a throwing read-marker service becomes a RETRYABLE ack', async () => {
  const log = makeLog();
  const socket = boot({ log, markRead: async () => { throw boom(); } });

  const ack = await socket.trigger('chat:readUpTo', {
    conversationId: id(),
    lastReadSeq: 3,
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'RETRYABLE');
});

test('the guard reports the error NAME only — never the message or a stack', async () => {
  const log = makeLog();
  const socket = boot({ log, editMessage: async () => { throw boom(); } });

  await socket.trigger('chat:message:edit', {
    conversationId: id(),
    messageId: id(),
    expectedEditVersion: 0,
    newText: 'hih',
  });

  assert.equal(log.entries.length, 1);
  assert.match(log.entries[0], /^\[ChatSocket\] chat:message:edit failed \(ValidationError\)$/);
  assert.ok(!log.entries[0].includes('internal detail'));
});

test('the success path is untouched: a normal ack still flows through', async () => {
  const log = makeLog();
  const socket = boot({
    log,
    deleteMessage: async ({ messageId }) => ({
      ok: true,
      messageId,
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      changed: false,
    }),
  });

  const ack = await socket.trigger('chat:message:delete', {
    conversationId: id(),
    messageId: id(),
  });

  assert.equal(ack.ok, true);
  assert.equal(log.entries.length, 0);
});

test('every authenticated listener is registered through the guard (source pin)', async () => {
  const source = await readFile(
    new URL('../src/socket/chatSocketHandlers.js', import.meta.url),
    'utf8',
  );

  for (const event of [
    'chat:join',
    'chat:leave',
    'chat:message:send',
    'chat:message:edit',
    'chat:message:delete',
    'chat:readUpTo',
  ]) {
    assert.match(
      source,
      new RegExp(`guard\\(socket, log, '${event}'`),
      `${event} must run inside the guard`,
    );
  }

  // The only raw registrations allowed are the SYNCHRONOUS
  // "no authenticated principal" stubs that just ack UNAUTHORIZED — a sync
  // listener cannot produce an unhandled rejection. Any raw ASYNC listener
  // would be an unguarded await, which is the crash we are pinning away.
  assert.ok(
    !/socket\.on\('chat:[^']+',\s*async/.test(source),
    'no chat listener may be registered as a raw async function',
  );

  // And the unauthenticated stubs must stay the only raw chat listeners.
  const rawRegistrations = [...source.matchAll(/socket\.on\('(chat:[^']+)'/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(
    rawRegistrations.sort(),
    [
      'chat:join',
      'chat:message:delete',
      'chat:message:edit',
      'chat:message:send',
      // 33.10 — the FILE stub is unauthenticated-raw like the others.
      'chat:message:sendFile',
      'chat:readUpTo',
    ],
    'raw registrations must be exactly the unauthenticated stubs',
  );
});
