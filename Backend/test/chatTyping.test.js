// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.5 — TYPING INDICATORS (HERMETIC).
//
//  No Redis, no Mongo, no socket.io-client. The REAL handler registration
//  (chatSocketHandlers.js) runs against a mock socket + mock io with an
//  in-memory fake of the ONE model the typing path may touch (ChatConversation,
//  for the membership read) — and that fake is wired to FAIL LOUDLY if the
//  typing path ever tries to write.
//
//  Pinned behaviour:
//    · a non-member, another tenant and a missing conversation are ONE refusal
//      (NOT_FOUND_OR_FORBIDDEN) and NOTHING is relayed
//    · a disabled conversation stays quiet (CONVERSATION_DISABLED)
//    · an unauthenticated socket gets UNAUTHORIZED (the 33.1 stub contract)
//    · a malformed frame is refused BEFORE the membership read
//    · a member's start is relayed to the conversation room MINUS the sender,
//      with exactly {conversationId, userId, isTyping} — nothing else
//    · repeated starts inside the minimum gap are ignored, not refused, and a
//      later start is relayed again; a stop is NEVER start-throttled and
//      releases the conversation's stamp
//    · the frame ceiling ignores the excess instead of erroring
//    · NOTHING is written and NOTHING is logged on this path (source pins)
//    · the two ends of the wire agree on the event names (handler vs client)
// ═══════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_typing';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';
import { conversationRoom, userRoom } from '../src/utils/chatKeys.js';
import {
  CHAT_TYPING_FRAME_MAX,
  CHAT_TYPING_MAX_CONVERSATIONS,
  CHAT_TYPING_MIN_INTERVAL_MS,
  createTypingThrottle,
} from '../src/services/chat/chatTypingService.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();
const same = (a, b) => String(a) === String(b);

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

const readSource = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');

const COMPANY_A = id();
const COMPANY_B = id();
const ALICE = id();
const BOB = id();
const MALLORY = id(); // company B

// ── the membership read, and a fake that REFUSES to be written to ─────────

const installConversationFake = ({ conversations, onWrite }) => {
  const original = {
    findOne: ChatConversation.findOne,
    findOneAndUpdate: ChatConversation.findOneAndUpdate,
    updateOne: ChatConversation.updateOne,
    updateMany: ChatConversation.updateMany,
    create: ChatConversation.create,
  };

  ChatConversation.findOne = (filter) => ({
    lean: async () =>
      conversations.find((doc) => {
        if (filter._id && !same(doc._id, filter._id)) return false;
        if (filter.companyId && !same(doc.companyId, filter.companyId)) return false;

        const member = filter['members.userId'];

        if (member && !doc.members.some((entry) => same(entry.userId, member))) return false;

        return true;
      }) ?? null,
  });

  // A typing frame must never write. Anything below is a bug, so it throws
  // instead of quietly "succeeding" against a fake.
  const refuse = (name) => async () => {
    onWrite.push(name);
    throw new Error(`the typing path must not call ChatConversation.${name}`);
  };

  ChatConversation.findOneAndUpdate = refuse('findOneAndUpdate');
  ChatConversation.updateOne = refuse('updateOne');
  ChatConversation.updateMany = refuse('updateMany');
  ChatConversation.create = refuse('create');

  return () => Object.assign(ChatConversation, original);
};

// ── mock socket + io ──────────────────────────────────────────────────────

const makeSocket = ({ companyId, userId }) => {
  const handlers = {};
  const rooms = new Set();
  const broadcasts = [];

  return {
    id: 'sock-typing',
    // MIRROR PRODUCTION: socketAuth.js writes the server-derived identity as
    // STRINGS (socket.data.companyId/userId). A mock that handed over ObjectIds
    // would let a type bug in the relay payload go unnoticed.
    data: { companyId: String(companyId ?? ''), userId: String(userId ?? '') },
    rooms,
    broadcasts,
    handlers,
    on: (event, fn) => {
      handlers[event] = fn;
    },
    join: async (room) => {
      rooms.add(room);
    },
    leave: (room) => {
      rooms.delete(room);
    },
    // socket.to(room) = broadcast to the room MINUS this socket, which is what
    // the handler calls. The fake records both surfaces separately, so a test
    // can prove the relay NEVER went through io.to (which would have echoed to
    // the sender) and never touched the personal room.
    to: (room) => ({
      emit: (event, payload) => {
        broadcasts.push({ room, event, payload, excludedSender: true });
      },
    }),
    trigger: (event, payload) =>
      new Promise((resolve) => {
        const handler = handlers[event];

        if (!handler) {
          resolve({ ok: false, code: 'NO_LISTENER' });
          return;
        }

        handler(payload, resolve);
      }),
  };
};

const makeIo = (broadcasts) => ({
  to: (room) => ({
    emit: (event, payload) => {
      broadcasts.push({ room, event, payload, excludedSender: false });
    },
  }),
});

const mount = (socket) => {
  // io.to(...) is the WIDE surface (it includes the sender). Anything appearing
  // here on the typing path is a bug: typing must use socket.to.
  const ioBroadcasts = [];

  registerChatSocketHandlers({
    io: makeIo(ioBroadcasts),
    socket,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  return { broadcasts: socket.broadcasts, ioBroadcasts };
};

const seedConversation = ({ companyId = COMPANY_A, members, isDisabled = false }) => ({
  _id: id(),
  companyId,
  type: 'GROUP',
  title: 'Design',
  members,
  isDisabled,
  lastMessageSeq: 0,
});

// ═══════════════════════════════════════════════════════════════════════════
//  1. THE GATE
// ═══════════════════════════════════════════════════════════════════════════

test('a member typing is relayed to the conversation room, sender excluded', async () => {
  const conversation = seedConversation({
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  const writes = [];
  const restore = installConversationFake({ conversations: [conversation], onWrite: writes });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    const { broadcasts, ioBroadcasts } = mount(socket);

    await socket.trigger('chat:join', { conversationId: String(conversation._id) });

    // A client may try to declare WHO is typing (or a name to show). The frame
    // carries only a conversation id, and the relay always speaks with the
    // socket's own server-derived identity — a payload can never impersonate.
    await socket.trigger('chat:typing:start', {
      conversationId: String(conversation._id),
      userId: String(MALLORY),
      name: 'Mallory',
      isTyping: false,
    });

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].room, conversationRoom(conversation._id));
    assert.equal(broadcasts[0].event, 'chat:typing');
    assert.deepEqual(broadcasts[0].payload, {
      conversationId: String(conversation._id),
      userId: String(ALICE),
      isTyping: true,
    });

    // Three keys, exactly: no name, no timestamp, no seq, nothing to grow into
    // an activity record later.
    assert.deepEqual(
      Object.keys(broadcasts[0].payload).sort(),
      ['conversationId', 'isTyping', 'userId'],
    );

    // The relay never touches the personal room (a nudge room is for list
    // changes, not for "someone is typing") and NEVER uses io.to, which would
    // have echoed the frame back to its own author.
    assert.ok(!broadcasts.some((entry) => entry.room === userRoom(ALICE)));
    assert.deepEqual(ioBroadcasts, [], 'the typing relay is socket.to only');

    assert.deepEqual(writes, [], 'typing never writes');
  } finally {
    restore();
  }
});

test('a non-member cannot type, and the refusal is identical to a missing conversation', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }] });

  const restore = installConversationFake({ conversations: [conversation], onWrite: [] });

  try {
    const stranger = makeSocket({ companyId: COMPANY_A, userId: BOB });
    const { broadcasts } = mount(stranger);

    const denied = await stranger.trigger('chat:typing:start', {
      conversationId: String(conversation._id),
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'NOT_FOUND_OR_FORBIDDEN');

    // Same answer for a conversation that simply does not exist: the socket
    // surface must stay a non-oracle.
    const missing = await stranger.trigger('chat:typing:start', {
      conversationId: String(id()),
    });

    assert.deepEqual(
      { ok: missing.ok, code: missing.code, message: missing.message },
      { ok: denied.ok, code: denied.code, message: denied.message },
    );

    assert.deepEqual(broadcasts, [], 'a refused frame relays nothing');
  } finally {
    restore();
  }
});

test('another tenant cannot type into a conversation it can name exactly', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }] });

  const restore = installConversationFake({ conversations: [conversation], onWrite: [] });

  try {
    const mallory = makeSocket({ companyId: COMPANY_B, userId: MALLORY });
    const { broadcasts } = mount(mallory);

    const ack = await mallory.trigger('chat:typing:start', {
      conversationId: String(conversation._id),
    });

    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'NOT_FOUND_OR_FORBIDDEN');
    assert.deepEqual(broadcasts, []);
  } finally {
    restore();
  }
});

test('a disabled conversation stays quiet', async () => {
  const conversation = seedConversation({
    members: [{ userId: ALICE }],
    isDisabled: true,
  });

  const restore = installConversationFake({ conversations: [conversation], onWrite: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    const { broadcasts, ioBroadcasts } = mount(socket);

    const ack = await socket.trigger('chat:typing:start', {
      conversationId: String(conversation._id),
    });

    assert.equal(ack.code, 'CONVERSATION_DISABLED');
    assert.deepEqual(broadcasts, []);
  } finally {
    restore();
  }
});

test('a malformed frame is refused before the membership read', async () => {
  let reads = 0;

  const restore = installConversationFake({
    conversations: [
      seedConversation({ members: [{ userId: ALICE }] }),
    ],
    onWrite: [],
  });

  // Count the reads by wrapping the fake we just installed.
  const originalFindOne = ChatConversation.findOne;
  ChatConversation.findOne = (filter) => {
    reads += 1;

    return originalFindOne(filter);
  };

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    const { broadcasts, ioBroadcasts } = mount(socket);

    for (const payload of [undefined, {}, { conversationId: 'nope' }, { conversationId: 42 }]) {
      const ack = await socket.trigger('chat:typing:start', payload);

      assert.equal(ack.ok, false);
      assert.equal(ack.code, 'VALIDATION_ERROR');
    }

    assert.equal(reads, 0, 'a refused frame never reaches a query');
    assert.deepEqual(broadcasts, []);
  } finally {
    restore();
  }
});

test('an unauthenticated socket is refused and cannot reach the relay', async () => {
  const socket = makeSocket({ companyId: undefined, userId: undefined });

  mount(socket);

  for (const event of ['chat:typing:start', 'chat:typing:stop']) {
    const ack = await socket.trigger(event, { conversationId: String(id()) });

    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'UNAUTHORIZED');
  }

  assert.deepEqual(socket.broadcasts, []);
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. THE THROTTLE
// ═══════════════════════════════════════════════════════════════════════════

test('repeated starts inside the minimum gap are ignored, then relayed again', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }] });

  const restore = installConversationFake({ conversations: [conversation], onWrite: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    const { broadcasts, ioBroadcasts } = mount(socket);

    const payload = { conversationId: String(conversation._id) };

    const first = await socket.trigger('chat:typing:start', payload);
    const second = await socket.trigger('chat:typing:start', payload);

    assert.equal(first.ok, true);
    assert.equal(first.data.relayed, true);
    assert.equal(second.ok, true, 'a throttled start is IGNORED, not an error');
    assert.equal(second.data.relayed, false);
    assert.equal(broadcasts.length, 1, 'the second start never reached the room');

    // The heartbeat the real client sends is 3 s apart; after the gap the same
    // start is relayed again (so a long typing session keeps the indicator
    // alive on the other side).
    const throttle = createTypingThrottle();
    let clock = 0;
    const timed = createTypingThrottle({ now: () => clock });

    assert.equal(timed.allowStart('room'), true);
    assert.equal(timed.allowStart('room'), false);
    clock += CHAT_TYPING_MIN_INTERVAL_MS;
    assert.equal(timed.allowStart('room'), true, 'the gap reopens the relay');
    assert.equal(typeof throttle.allowStart, 'function');
  } finally {
    restore();
  }
});

test('a stop is never start-throttled and releases the stamp for the next session', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }] });

  const restore = installConversationFake({ conversations: [conversation], onWrite: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    const { broadcasts, ioBroadcasts } = mount(socket);

    const payload = { conversationId: String(conversation._id) };

    await socket.trigger('chat:typing:start', payload);

    const stop = await socket.trigger('chat:typing:stop', payload);

    assert.equal(stop.data.relayed, true, 'a stop is always relayed');
    assert.equal(broadcasts.at(-1).payload.isTyping, false);

    // The stop cleared the conversation's stamp, so an immediate new session is
    // not delayed by the previous one.
    const restart = await socket.trigger('chat:typing:start', payload);

    assert.equal(restart.data.relayed, true, 'a new session starts immediately after a stop');
    assert.equal(broadcasts.length, 3);
  } finally {
    restore();
  }
});

test('the throttle is bounded and per-conversation', () => {
  let clock = 0;
  const throttle = createTypingThrottle({ now: () => clock });

  // Two conversations are independent.
  assert.equal(throttle.allowStart('room-a'), true);
  assert.equal(throttle.allowStart('room-a'), false);
  assert.equal(throttle.allowStart('room-b'), true, 'a second room is not collateral damage');

  // The frame ceiling counts both directions and is a hard stop.
  const framed = createTypingThrottle({ now: () => clock });

  let allowed = 0;

  for (let index = 0; index < CHAT_TYPING_FRAME_MAX + 5; index += 1) {
    if (framed.allowFrame()) allowed += 1;
  }

  assert.equal(allowed, CHAT_TYPING_FRAME_MAX, 'the ceiling is exact, never unlimited');

  // ...and it reopens with the next window.
  clock += 10_000;
  assert.equal(framed.allowFrame(), true);

  // The conversation map is bounded: eviction drops the oldest room, not the
  // newest, so an active conversation is never the one that gets forgotten.
  const bounded = createTypingThrottle({ now: () => clock });

  for (let index = 0; index < CHAT_TYPING_MAX_CONVERSATIONS + 10; index += 1) {
    bounded.allowStart(`room-${index}`);
  }

  assert.equal(bounded.allowStart('room-999'), true);
  assert.equal(bounded.allowStart('room-0'), true, 'the oldest room was evicted, so it is free again');
});

test('exceeding the frame ceiling is ignored, not refused', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }] });

  const restore = installConversationFake({ conversations: [conversation], onWrite: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    const { broadcasts, ioBroadcasts } = mount(socket);

    const payload = { conversationId: String(conversation._id) };

    // Burn the whole frame window with stops (stops are never start-throttled,
    // so this is the cheapest way to reach the ceiling).
    for (let index = 0; index < CHAT_TYPING_FRAME_MAX; index += 1) {
      await socket.trigger('chat:typing:stop', payload);
    }

    const overflow = await socket.trigger('chat:typing:stop', payload);

    assert.equal(overflow.ok, true, 'an ignored frame is still an OK ack');
    assert.equal(overflow.data.relayed, false);
    assert.equal(
      broadcasts.length,
      CHAT_TYPING_FRAME_MAX,
      'the room saw exactly the ceiling, never more',
    );
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. NO STORAGE, NO LOGGING, NO NEW VOCABULARY (source pins)
// ═══════════════════════════════════════════════════════════════════════════

// Both pins below read CODE, not prose: these files EXPLAIN the decisions
// ("no Redis on this path"), and a scan that counted comments would punish the
// documentation (the trap 34.3 hit with a banned API name).
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/[^\n'"]*$/gm, '');

test('the typing path stores nothing: no writes, no cache, no Redis', () => {
  const raw = readSource('Backend/src/socket/chatSocketHandlers.js');
  const service = stripComments(readSource('Backend/src/services/chat/chatTypingService.js'));

  // The relay block only, sliced on CODE (not on a comment marker) so the other
  // chat writes in this file — which legitimately persist — cannot mask a
  // typing-path write.
  const start = raw.indexOf('const typingThrottle = createTypingThrottle();');
  const end = raw.indexOf("guard(socket, log, 'chat:message:send'");

  assert.ok(start > 0 && end > start, 'the typing block is locatable');

  const block = stripComments(raw.slice(start, end));

  for (const forbidden of [
    'ChatMessage',
    'ChatConversation',
    '.create(',
    'findOneAndUpdate',
    'updateOne(',
    'save(',
    'redis',
    'Redis',
    'setex',
    'hset',
    'publish(',
  ]) {
    assert.ok(!block.includes(forbidden), `the typing block must not contain ${forbidden}`);
  }

  // ...and the service the block depends on has NO import at all: a module that
  // cannot reach a database or a cache cannot accidentally store a keystroke.
  assert.ok(!/\bimport\b/.test(service), 'chatTypingService imports nothing');
  assert.ok(!/\brequire\(/.test(service), 'and is pure ESM, like the rest of the repo');
});

test('nothing logs a typing frame', () => {
  const handler = readSource('Backend/src/socket/chatSocketHandlers.js');

  const block = handler.slice(
    handler.indexOf('const typingThrottle = createTypingThrottle();'),
    handler.indexOf("guard(socket, log, 'chat:message:send'"),
  );

  // No console, no logger call — a keystroke firehose must not become a log
  // stream (which is also how "we know when people are typing" would start).
  // The `guard(...)` wrapper's own error path is outside this slice by design:
  // it logs an error NAME only, never a frame.
  assert.ok(!/console\./.test(block), 'no console on the typing path');
  assert.ok(!/log\.(info|warn|error|debug)/.test(block), 'no log call on the typing path');
});

test('the two ends of the wire agree on the event names', () => {
  const handler = readSource('Backend/src/socket/chatSocketHandlers.js');
  const client = readSource('Frontend/src/services/realtime/chatSocketClient.js');

  const names = ['chat:typing:start', 'chat:typing:stop', 'chat:typing'];

  for (const name of names) {
    assert.ok(handler.includes(`'${name}'`), `the handler registers ${name} as a literal`);
    assert.ok(client.includes(`'${name}'`), `the client speaks ${name} as a literal`);
  }

  // The relay payload is three keys on the server; the client must not expect
  // a fourth (a name, a timestamp) that the server never sends.
  const payload = handler.slice(
    handler.indexOf("emit('chat:typing'"),
    handler.indexOf('return ack(cb, { ok: true, data: { relayed: true } });'),
  );

  assert.ok(payload.includes('conversationId'));
  assert.ok(payload.includes('userId'));
  assert.ok(payload.includes('isTyping'));
  assert.ok(
    !/senderName|displayName|userName|timestamp|createdAt|typingAt/i.test(payload),
    'no extra field rides along',
  );
});

test('the client stops typing on send, on conversation change and after idle', () => {
  const page = readSource('Frontend/src/pages/chat/ChatPage.jsx');
  const client = readSource('Frontend/src/services/realtime/chatSocketClient.js');

  assert.ok(client.includes('typingStart:'), 'the client exposes start');
  assert.ok(client.includes('typingStop:'), 'the client exposes stop');

  // The page owns the timers: an idle stop, a heartbeat (so a long session
  // does not expire under the receiver's TTL) and a stop on conversation
  // change/unmount.
  assert.match(page, /TYPING_IDLE_MS/);
  assert.match(page, /TYPING_HEARTBEAT_MS/);
  assert.ok(page.includes('stopTyping'), 'the page can end its own indicator');

  // The composer reports activity: the page cannot hook a keystroke it never
  // hears about.
  const composer = readSource('Frontend/src/components/chat/MessageComposer.jsx');

  assert.ok(composer.includes('onTypingChange'), 'the composer reports input activity');
});

test('the indicator is plain text plus dots: no emoji, no icon, no console', () => {
  const indicator = readSource('Frontend/src/components/chat/TypingIndicator.jsx');

  // 34.4 allowed real emoji glyphs on the REACTION surface only. The typing
  // indicator is new UI, and new UI still ships no emoji.
  assert.deepEqual(
    indicator.match(/\p{Extended_Pictographic}/gu) ?? [],
    [],
    'no emoji glyph may appear in the typing indicator',
  );

  assert.ok(!/console\./.test(indicator), 'the chat surface never logs');
  assert.ok(indicator.includes('is typing'), 'the indicator says what it means in words');

  // The indicator renders at the top level of the render tree (a component),
  // not as a modal/overlay that could follow the user into another room.
  assert.ok(!/fixed|z-50/.test(indicator), 'the indicator is not an overlay');
});

test('typing is never a schema field, and the socket layer still forbids surveillance', () => {
  const models = ['Backend/src/models/ChatMessage.js', 'Backend/src/models/ChatConversation.js'];

  for (const file of models) {
    const source = readSource(file);

    // 34.5 adds NO field: an isTyping column would turn an ephemeral signal
    // into stored state about a person.
    assert.ok(!/isTyping\s*:/.test(source), `${file} must not declare an isTyping field`);
    assert.ok(!/typingAt\s*:/.test(source), `${file} must not declare a typingAt field`);
  }

  // The 33-era prohibition on presence, last-seen and receipts is UNCHANGED by
  // this unit; only typing left the forbidden list.
  const socketDir = path.join(repo, 'Backend', 'src', 'socket');
  const combined = fs
    .readdirSync(socketDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(socketDir, name), 'utf8'))
    .join('\n');

  for (const forbidden of ['lastSeen', 'isOnline', 'isIdle', 'presenceState', 'activityAt']) {
    assert.ok(!combined.includes(forbidden), `${forbidden} stays forbidden — no surveillance`);
  }
});
