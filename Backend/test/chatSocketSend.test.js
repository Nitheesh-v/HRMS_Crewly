// ============================================================
//  PHASE 33.5 — CHAT SOCKET JOIN + SEND (HERMETIC).
//
//  No Redis, no HTTP, no socket.io-client. The real handlers
//  (chatSocketHandlers.js) and the real send service
//  (chatMessageService.js) are exercised against in-memory fakes of
//  ChatConversation / ChatMessage statics (repo pattern), with a mock
//  socket + mock io capturing room joins and broadcasts.
//
//  Pinned behaviour:
//    · join refused for non-member / other tenant, allowed for member
//    · send refused for non-member
//    · send persists with seq increment + lastMessage* update
//    · idempotency: same clientMessageId twice -> same message, one
//      broadcast
//    · deleted/disabled conversation refused
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_send';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';
import { conversationRoom } from '../src/utils/chatKeys.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();

const COMPANY_A = id();
const COMPANY_B = id();
const ALICE = id();
const BOB = id();
const MALLORY = id(); // company B

// ── in-memory fakes ───────────────────────────────────────────────────────

const installFakes = ({ conversations, messages }) => {
  const same = (a, b) => String(a) === String(b);

  const original = {
    convFindOne: ChatConversation.findOne,
    convFindOneAndUpdate: ChatConversation.findOneAndUpdate,
    msgFindOne: ChatMessage.findOne,
    msgCreate: ChatMessage.create,
  };

  ChatConversation.findOne = (filter) => ({
    lean: async () =>
      conversations.find((doc) => {
        if (filter._id && !same(doc._id, filter._id)) return false;
        if (filter.companyId && !same(doc.companyId, filter.companyId)) return false;
        const member = filter['members.userId'];
        if (member && !doc.members.some((m) => same(m.userId, member))) return false;
        return true;
      }) ?? null,
  });

  ChatConversation.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const doc = conversations.find(
        (entry) => same(entry._id, filter._id) && same(entry.companyId, filter.companyId)
      );

      if (!doc) return null;

      if (update.$inc?.lastMessageSeq) doc.lastMessageSeq += update.$inc.lastMessageSeq;
      if (update.$set) Object.assign(doc, update.$set);

      return doc;
    },
  });

  ChatMessage.findOne = (filter) => ({
    lean: async () =>
      messages.find(
        (doc) =>
          same(doc.companyId, filter.companyId) &&
          same(doc.conversationId, filter.conversationId) &&
          same(doc.senderUserId, filter.senderUserId) &&
          doc.clientMessageId === filter.clientMessageId
      ) ?? null,
  });

  ChatMessage.create = async (payload) => {
    const dup = messages.find(
      (doc) =>
        same(doc.companyId, payload.companyId) &&
        same(doc.conversationId, payload.conversationId) &&
        same(doc.senderUserId, payload.senderUserId) &&
        doc.clientMessageId === payload.clientMessageId
    );

    if (dup) {
      const error = new Error('E11000 duplicate key');
      error.code = 11000;
      throw error;
    }

    const doc = { _id: id(), editVersion: 0, deletedAt: null, createdAt: new Date(), ...payload };
    messages.push(doc);
    return { toObject: () => doc };
  };

  return () => {
    ChatConversation.findOne = original.convFindOne;
    ChatConversation.findOneAndUpdate = original.convFindOneAndUpdate;
    ChatMessage.findOne = original.msgFindOne;
    ChatMessage.create = original.msgCreate;
  };
};

// ── mock socket + io ──────────────────────────────────────────────────────

const makeSocket = ({ companyId, userId }) => {
  const handlers = {};
  const rooms = new Set();

  return {
    id: `sock-${Math.random().toString(36).slice(2, 8)}`,
    data: { companyId, userId },
    rooms,
    on: (event, fn) => { handlers[event] = fn; },
    join: async (room) => { rooms.add(room); },
    leave: (room) => { rooms.delete(room); },
    trigger: (event, payload) =>
      new Promise((resolve) => { handlers[event](payload, resolve); }),
  };
};

const makeIo = (broadcasts) => ({
  to: (room) => ({
    emit: (event, payload) => { broadcasts.push({ room, event, payload }); },
  }),
});

const seedConversation = ({ companyId = COMPANY_A, members, isDisabled = false }) => ({
  _id: id(),
  companyId,
  type: 'GROUP',
  title: 'Design',
  members,
  lastMessageSeq: 0,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastMessageSenderUserId: null,
  isDisabled,
});

// ── join ──────────────────────────────────────────────────────────────────

test('chat:join allowed for member, refused for non-member and other tenant', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] })];
  const restore = installFakes({ conversations, messages: [] });

  try {
    const member = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo([]), socket: member, log: { error: () => {} } });

    const ok = await member.trigger('chat:join', { conversationId: conversations[0]._id });
    assert.equal(ok.ok, true);
    assert.ok(member.rooms.has(conversationRoom(conversations[0]._id)));

    const stranger = makeSocket({ companyId: COMPANY_A, userId: MALLORY });
    registerChatSocketHandlers({ io: makeIo([]), socket: stranger, log: { error: () => {} } });
    const denied = await stranger.trigger('chat:join', { conversationId: conversations[0]._id });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'NOT_FOUND_OR_FORBIDDEN');

    const crossTenant = makeSocket({ companyId: COMPANY_B, userId: MALLORY });
    registerChatSocketHandlers({ io: makeIo([]), socket: crossTenant, log: { error: () => {} } });
    const cross = await crossTenant.trigger('chat:join', { conversationId: conversations[0]._id });
    assert.equal(cross.ok, false);
    assert.equal(cross.code, 'NOT_FOUND_OR_FORBIDDEN');
  } finally {
    restore();
  }
});

test('chat:join refused for a disabled conversation', async () => {
  const conversations = [
    seedConversation({ members: [{ userId: ALICE }], isDisabled: true }),
  ];
  const restore = installFakes({ conversations, messages: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo([]), socket, log: { error: () => {} } });

    const result = await socket.trigger('chat:join', { conversationId: conversations[0]._id });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONVERSATION_DISABLED');
  } finally {
    restore();
  }
});

// ── send ──────────────────────────────────────────────────────────────────

test('chat:message:send persists with seq increment + lastMessage* update and broadcasts once', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] })];
  const messages = [];
  const broadcasts = [];
  const restore = installFakes({ conversations, messages });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo(broadcasts), socket, log: { error: () => {} } });

    const result = await socket.trigger('chat:message:send', {
      conversationId: conversations[0]._id,
      clientMessageId: 'client-1',
      text: 'hello world',
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.message.seq, 1, 'first message gets seq 1');
    assert.equal(messages.length, 1);
    assert.equal(conversations[0].lastMessageSeq, 1);
    assert.ok(conversations[0].lastMessageAt, 'lastMessageAt bumped');
    assert.equal(conversations[0].lastMessagePreview, 'hello world');
    assert.equal(broadcasts.length, 1, 'exactly one broadcast for a new message');
    assert.equal(broadcasts[0].room, conversationRoom(conversations[0]._id));
    assert.equal(broadcasts[0].event, 'chat:message:created');
  } finally {
    restore();
  }
});

test('idempotency: same clientMessageId twice returns same message, one broadcast', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }] })];
  const messages = [];
  const broadcasts = [];
  const restore = installFakes({ conversations, messages });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo(broadcasts), socket, log: { error: () => {} } });

    const first = await socket.trigger('chat:message:send', {
      conversationId: conversations[0]._id, clientMessageId: 'dup-1', text: 'once',
    });
    const second = await socket.trigger('chat:message:send', {
      conversationId: conversations[0]._id, clientMessageId: 'dup-1', text: 'once',
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(String(second.data.message._id), String(first.data.message._id));
    assert.equal(messages.length, 1, 'no duplicate document');
    assert.equal(broadcasts.length, 1, 'retry must not re-broadcast');
  } finally {
    restore();
  }
});

test('chat:message:send refused for non-member', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }] })];
  const restore = installFakes({ conversations, messages: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: BOB }); // not a member
    registerChatSocketHandlers({ io: makeIo([]), socket, log: { error: () => {} } });

    const result = await socket.trigger('chat:message:send', {
      conversationId: conversations[0]._id, clientMessageId: 'x-1', text: 'sneak',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND_OR_FORBIDDEN');
  } finally {
    restore();
  }
});

test('send payload validation rejects empty/oversized text', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }] })];
  const restore = installFakes({ conversations, messages: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo([]), socket, log: { error: () => {} } });

    const empty = await socket.trigger('chat:message:send', {
      conversationId: conversations[0]._id, clientMessageId: 'v-1', text: '   ',
    });
    const huge = await socket.trigger('chat:message:send', {
      conversationId: conversations[0]._id, clientMessageId: 'v-2', text: 'x'.repeat(4001),
    });

    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'VALIDATION_ERROR');
    assert.equal(huge.ok, false);
    assert.equal(huge.code, 'VALIDATION_ERROR');
  } finally {
    restore();
  }
});
