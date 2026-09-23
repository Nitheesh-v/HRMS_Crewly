// ============================================================
//  PHASE 33.7 — READ MARKERS + UNREAD COUNTS (C1) (HERMETIC).
//
//  No Redis, no HTTP, no socket.io-client. The real service
//  (chatReadService.js), the real list decoration (chatService.js) and the
//  real socket handler (chatSocketHandlers.js) run against in-memory fakes
//  of the ChatConversation statics (repo pattern), with a mock socket +
//  mock io proving read state is never broadcast.
//
//  Pinned behaviour:
//    · member advances the cursor upward; unread = lastMessageSeq - cursor
//    · monotonic: a lower request never rewinds the cursor
//    · clamped: a request past lastMessageSeq stops at lastMessageSeq
//    · non-member / other tenant -> NOT_FOUND_OR_FORBIDDEN
//    · late joiner: unread computed against max(lastReadSeq, joinedAtSeq)
//    · list/detail projection strips every member's cursor, exposes only
//      the caller's myLastReadSeq + unreadCount
//    · chat:readUpTo ACKs { myLastReadSeq, unreadCount } and broadcasts
//      NOTHING
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_read';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import User from '../src/models/User.js';
import {
  computeUnreadCount,
  sanitizeConversationForMember,
  updateReadMarker,
} from '../src/services/chat/chatReadService.js';
import { listMyConversations } from '../src/services/chat/chatService.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();

const COMPANY_A = id();
const COMPANY_B = id();
const ALICE = id();
const BOB = id();
const MALLORY = id(); // company B

// ── in-memory fakes ───────────────────────────────────────────────────────

const installFakes = ({ conversations, findRows = null, capture = null, users = null }) => {
  const same = (a, b) => String(a) === String(b);

  const original = {
    findOne: ChatConversation.findOne,
    updateOne: ChatConversation.updateOne,
    find: ChatConversation.find,
    // 33.8-fix: the list path now builds a member directory, so hermetic
    // runs need a sealed User stub (empty directory unless users given).
    userFind: User.find,
  };

  User.find = () => ({
    select: () => ({
      lean: async () => (users ?? []).map((entry) => ({ ...entry })),
    }),
  });

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

  ChatConversation.updateOne = async (filter, update) => {
    const doc = conversations.find(
      (entry) =>
        same(entry._id, filter._id) &&
        same(entry.companyId, filter.companyId) &&
        entry.members.some((m) => same(m.userId, filter['members.userId']))
    );

    if (!doc) return { matchedCount: 0, modifiedCount: 0 };

    const target = update.$set?.['members.$.lastReadSeq'];

    if (target !== undefined) {
      const member = doc.members.find((m) => same(m.userId, filter['members.userId']));
      if (member) member.lastReadSeq = target;
    }

    return { matchedCount: 1, modifiedCount: 1 };
  };

  ChatConversation.find = (filter) => {
    if (capture) capture.filter = filter;

    return {
      sort: () => ({
        limit: () => ({
          lean: async () => findRows ?? [],
        }),
      }),
    };
  };

  return () => {
    ChatConversation.findOne = original.findOne;
    ChatConversation.updateOne = original.updateOne;
    ChatConversation.find = original.find;
    User.find = original.userFind;
  };
};

const seedConversation = ({
  companyId = COMPANY_A,
  members,
  lastMessageSeq = 0,
}) => ({
  _id: id(),
  companyId,
  type: 'GROUP',
  title: 'Design',
  members,
  lastMessageSeq,
  lastMessageAt: new Date(),
  lastMessagePreview: null,
  lastMessageSenderUserId: null,
  isDisabled: false,
});

const member = (userId, extra = {}) => ({
  userId,
  role: 'MEMBER',
  joinedAt: new Date(),
  joinedAtSeq: 0,
  lastReadSeq: 0,
  ...extra,
});

// ── pure C1 math ──────────────────────────────────────────────────────────

test('computeUnreadCount: zero messages, partial read, fully read, late joiner', () => {
  assert.equal(computeUnreadCount({ lastMessageSeq: 0, lastReadSeq: 0 }), 0, 'empty conversation');
  assert.equal(computeUnreadCount({ lastMessageSeq: 10, lastReadSeq: 4 }), 6, 'partial read');
  assert.equal(computeUnreadCount({ lastMessageSeq: 10, lastReadSeq: 10 }), 0, 'fully read');
  assert.equal(
    computeUnreadCount({ lastMessageSeq: 10, lastReadSeq: 0, joinedAtSeq: 8 }),
    2,
    'late joiner never inherits the backlog',
  );
  assert.equal(
    computeUnreadCount({ lastMessageSeq: undefined, lastReadSeq: undefined }),
    0,
    'missing fields count as zero',
  );
});

// ── updateReadMarker ──────────────────────────────────────────────────────

test('updateReadMarker advances the cursor and reports the C1 count', async () => {
  const conversations = [
    seedConversation({
      members: [member(ALICE), member(BOB)],
      lastMessageSeq: 10,
    }),
  ];
  const restore = installFakes({ conversations });

  try {
    const result = await updateReadMarker({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversations[0]._id,
      lastReadSeq: 5,
    });

    assert.equal(result.ok, true);
    assert.equal(result.myLastReadSeq, 5);
    assert.equal(result.lastMessageSeq, 10);
    assert.equal(result.unreadCount, 5);
  } finally {
    restore();
  }
});

test('updateReadMarker is monotonic: a lower request never rewinds the cursor', async () => {
  const conversations = [
    seedConversation({
      members: [member(ALICE, { lastReadSeq: 7 })],
      lastMessageSeq: 10,
    }),
  ];
  const restore = installFakes({ conversations });

  try {
    const result = await updateReadMarker({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversations[0]._id,
      lastReadSeq: 3,
    });

    assert.equal(result.ok, true);
    assert.equal(result.myLastReadSeq, 7, 'cursor must not move backwards');
    assert.equal(result.unreadCount, 3);
  } finally {
    restore();
  }
});

test('updateReadMarker clamps to lastMessageSeq (cannot read past the end)', async () => {
  const conversations = [
    seedConversation({
      members: [member(ALICE)],
      lastMessageSeq: 10,
    }),
  ];
  const restore = installFakes({ conversations });

  try {
    const result = await updateReadMarker({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversations[0]._id,
      lastReadSeq: 50,
    });

    assert.equal(result.ok, true);
    assert.equal(result.myLastReadSeq, 10, 'clamped to the newest seq');
    assert.equal(result.unreadCount, 0);
  } finally {
    restore();
  }
});

test('updateReadMarker refuses non-members and other tenants identically', async () => {
  const conversations = [
    seedConversation({ members: [member(ALICE)], lastMessageSeq: 4 }),
  ];
  const restore = installFakes({ conversations });

  try {
    const stranger = await updateReadMarker({
      companyId: COMPANY_A,
      userId: BOB,
      conversationId: conversations[0]._id,
      lastReadSeq: 4,
    });
    assert.equal(stranger.ok, false);
    assert.equal(stranger.code, 'NOT_FOUND_OR_FORBIDDEN');

    const crossTenant = await updateReadMarker({
      companyId: COMPANY_B,
      userId: MALLORY,
      conversationId: conversations[0]._id,
      lastReadSeq: 4,
    });
    assert.equal(crossTenant.ok, false);
    assert.equal(crossTenant.code, 'NOT_FOUND_OR_FORBIDDEN');
  } finally {
    restore();
  }
});

// ── privacy projection ────────────────────────────────────────────────────

test('sanitizeConversationForMember hides other members’ cursors, exposes only the caller’s', () => {
  const conversation = seedConversation({
    members: [
      member(ALICE, { lastReadSeq: 2, joinedAtSeq: 1 }),
      member(BOB, { lastReadSeq: 5, joinedAtSeq: 0 }),
    ],
    lastMessageSeq: 5,
  });

  const projected = sanitizeConversationForMember(conversation, ALICE);

  assert.equal(projected.myLastReadSeq, 2);
  assert.equal(projected.lastMessageSeq, 5);
  assert.equal(projected.unreadCount, 3);

  for (const entry of projected.members) {
    assert.equal(entry.lastReadSeq, undefined, 'no member cursor may leak');
    assert.equal(entry.joinedAtSeq, undefined, 'no member cursor may leak');
    assert.ok(entry.userId, 'membership bookkeeping stays');
    assert.ok(entry.role, 'role stays');
    assert.equal(entry.user, null, 'no directory -> user is null, never a crash');
  }
});

// 33.8-fix: names travel with the read projection because the company
// directory endpoint can be scoped narrower than a conversation
// (EMPLOYEE_READ_SELF lists only oneself).
test('sanitizeConversationForMember attaches slim member identities from the directory', () => {
  const conversation = seedConversation({
    members: [member(ALICE), member(BOB)],
    lastMessageSeq: 1,
  });
  const directory = new Map([
    [String(BOB), { name: 'Bob', email: 'bob@x.test', avatarUrl: null }],
  ]);

  const projected = sanitizeConversationForMember(conversation, ALICE, directory);
  const bob = projected.members.find((entry) => String(entry.userId) === String(BOB));
  const alice = projected.members.find((entry) => String(entry.userId) === String(ALICE));

  assert.deepEqual(bob.user, { name: 'Bob', email: 'bob@x.test', avatarUrl: null });
  assert.equal(alice.user, null, 'members missing from the directory stay null');
  assert.equal(bob.lastReadSeq, undefined, 'cursors stay private even with a directory');
});

test('listMyConversations decorates rows with the caller’s C1 count', async () => {
  const rows = [
    seedConversation({
      members: [
        member(ALICE, { lastReadSeq: 2 }),
        member(BOB, { lastReadSeq: 5 }),
      ],
      lastMessageSeq: 5,
    }),
  ];
  const restore = installFakes({ conversations: [], findRows: rows });

  try {
    const result = await listMyConversations({
      companyId: COMPANY_A,
      userId: ALICE,
      cursor: null,
      limit: 20,
    });

    const [item] = result.conversations;

    assert.equal(item.unreadCount, 3, '5 - alice(2), never bob(5)');
    assert.equal(item.myLastReadSeq, 2);
    assert.equal(item.members[1].lastReadSeq, undefined, 'bob’s cursor stays private');
  } finally {
    restore();
  }
});

// ── socket: chat:readUpTo ─────────────────────────────────────────────────

const makeSocket = ({ companyId, userId }) => {
  const handlers = {};

  return {
    id: `sock-${Math.random().toString(36).slice(2, 8)}`,
    data: { companyId, userId },
    on: (event, fn) => { handlers[event] = fn; },
    join: async () => {},
    leave: () => {},
    trigger: (event, payload) =>
      new Promise((resolve) => { handlers[event](payload, resolve); }),
  };
};

const makeIo = (broadcasts) => ({
  to: (room) => ({
    emit: (event, payload) => { broadcasts.push({ room, event, payload }); },
  }),
});

test('chat:readUpTo ACKs the caller with cursor + count and broadcasts nothing', async () => {
  const conversations = [
    seedConversation({ members: [member(ALICE), member(BOB)], lastMessageSeq: 6 }),
  ];
  const broadcasts = [];
  const restore = installFakes({ conversations });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo(broadcasts), socket, log: { error: () => {} } });

    const result = await socket.trigger('chat:readUpTo', {
      conversationId: conversations[0]._id,
      lastReadSeq: 6,
    });

    assert.equal(result.ok, true);
    assert.equal(result.data.myLastReadSeq, 6);
    assert.equal(result.data.unreadCount, 0);
    assert.equal(broadcasts.length, 0, 'read state is private: never broadcast');
  } finally {
    restore();
  }
});

test('chat:readUpTo validates lastReadSeq and refuses non-members', async () => {
  const conversations = [
    seedConversation({ members: [member(ALICE)], lastMessageSeq: 2 }),
  ];
  const restore = installFakes({ conversations });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo([]), socket, log: { error: () => {} } });

    const negative = await socket.trigger('chat:readUpTo', {
      conversationId: conversations[0]._id,
      lastReadSeq: -1,
    });
    assert.equal(negative.ok, false);
    assert.equal(negative.code, 'VALIDATION_ERROR');

    const fractional = await socket.trigger('chat:readUpTo', {
      conversationId: conversations[0]._id,
      lastReadSeq: 1.5,
    });
    assert.equal(fractional.ok, false);
    assert.equal(fractional.code, 'VALIDATION_ERROR');

    const stranger = makeSocket({ companyId: COMPANY_A, userId: BOB });
    registerChatSocketHandlers({ io: makeIo([]), socket: stranger, log: { error: () => {} } });
    const denied = await stranger.trigger('chat:readUpTo', {
      conversationId: conversations[0]._id,
      lastReadSeq: 2,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'NOT_FOUND_OR_FORBIDDEN');
  } finally {
    restore();
  }
});
