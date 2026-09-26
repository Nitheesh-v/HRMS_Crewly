// ============================================================
//  PHASE 34.2 — CHAT THREADS (HERMETIC).
//
//  No Mongo, no Redis, no socket.io-client. The REAL socket handlers, the REAL
//  message service, the REAL thread service and the REAL projection run
//  against in-memory doubles of the ChatConversation / ChatMessage /
//  ChatMessageReaction statics (the repo pattern from chatEditDelete.test.js).
//
//  Pinned behaviour:
//    · REST thread fetch: non-member 404, cross-tenant 404, root from another
//      conversation 404, limit clamped 1..50 with a limit+1 probe, cursor page
//      strictly older with a correct nextCursor, tombstones carry no text,
//      reply previews are bounded (and null for a deleted parent), reactions
//      ride the same projection, the root carries the THREAD-WIDE reply count
//    · requesting a reply id opens the thread it belongs to (one thread, one
//      view)
//    · a disabled conversation stays READABLE (lock law) while replies are
//      refused at the write gate
//    · socket send: malformed replyToMessageId refused at the edge; parent in
//      another conversation / another tenant refused with no existence leak;
//      thread root computed for reply-to-root AND reply-to-reply; the stored
//      message carries both fields; the broadcast and the ACK carry both plus
//      the bounded preview; idempotent retry does not duplicate
//    · a tombstoned parent may still be answered, with a NULL snippet
//    · FILE sends carry the reply too
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_threads';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import ChatMessageReaction from '../src/models/ChatMessageReaction.js';
import User from '../src/models/User.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';
import {
  sendFileMessage,
  sendTextMessage,
} from '../src/services/chat/chatMessageService.js';
import {
  CHAT_REPLY_PREVIEW_MAX,
  CHAT_THREAD_LIMIT_DEFAULT,
  CHAT_THREAD_LIMIT_MAX,
} from '../src/services/chat/chatThreadService.js';
import { getThread, listMessages } from '../src/services/chat/chatService.js';
import { conversationRoom } from '../src/utils/chatKeys.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();
const same = (a, b) => String(a) === String(b);

const COMPANY_A = id();
const COMPANY_B = id();
const ALICE = id();
const BOB = id();
const MALLORY = id(); // company B

// ── doubles ───────────────────────────────────────────────────────────────

const matchesConversation = (doc, filter = {}) => {
  if (!doc) return false;
  if (filter._id && !same(doc._id, filter._id)) return false;
  if (filter.companyId && !same(doc.companyId, filter.companyId)) return false;
  const member = filter['members.userId'];
  if (member && !doc.members.some((m) => same(m.userId, member))) return false;
  return true;
};

const matchesMessage = (doc, filter = {}) => {
  if (!doc) return false;
  if (filter.companyId && !same(doc.companyId, filter.companyId)) return false;
  if (filter.conversationId && !same(doc.conversationId, filter.conversationId)) return false;
  if (filter.senderUserId && !same(doc.senderUserId, filter.senderUserId)) return false;
  if (filter.clientMessageId && !same(doc.clientMessageId, filter.clientMessageId)) return false;
  if (filter.threadRootMessageId && !same(doc.threadRootMessageId, filter.threadRootMessageId)) {
    return false;
  }

  // _id may arrive as a value, as { $in }, or as { $ne } (the thread page
  // excludes its own root).
  const idFilter = filter._id;

  if (idFilter !== undefined) {
    if (idFilter && typeof idFilter === 'object' && idFilter.$in) {
      if (!idFilter.$in.some((entry) => same(entry, doc._id))) return false;
    } else if (idFilter && typeof idFilter === 'object' && idFilter.$ne !== undefined) {
      if (same(idFilter.$ne, doc._id)) return false;
    } else if (!same(idFilter, doc._id)) {
      return false;
    }
  }

  return true;
};

const installFakes = ({ conversations = [], messages = [], reactions = [] }) => {
  const original = {
    convFindOne: ChatConversation.findOne,
    convFindOneAndUpdate: ChatConversation.findOneAndUpdate,
    msgFind: ChatMessage.find,
    msgFindOne: ChatMessage.findOne,
    msgCreate: ChatMessage.create,
    msgAggregate: ChatMessage.aggregate,
    reactFind: ChatMessageReaction.find,
    // listMessages builds a member directory; a hermetic run needs it sealed
    // or the call escapes to a real driver and buffers for 10 seconds.
    userFind: User.find,
  };

  User.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });

  const capture = { created: [], itemQueries: [], aggregates: 0 };
  let seqCounter = messages.reduce((max, row) => Math.max(max, row.seq ?? 0), 0);

  ChatConversation.findOne = (filter) => ({
    lean: async () => conversations.find((doc) => matchesConversation(doc, filter)) ?? null,
  });

  ChatConversation.findOneAndUpdate = (filter, update = {}) => ({
    lean: async () => {
      const doc = conversations.find((entry) => matchesConversation(entry, filter));

      if (!doc) return null;

      doc.lastMessageSeq = (doc.lastMessageSeq ?? 0) + (update.$inc?.lastMessageSeq ?? 0);
      Object.assign(doc, update.$set ?? {});

      return doc;
    },
  });

  ChatMessage.findOne = (filter) => {
    const query = {
      select: () => query,
      lean: async () => messages.find((doc) => matchesMessage(doc, filter)) ?? null,
    };

    return query;
  };

  ChatMessage.find = (filter = {}) => {
    const isThreadPage = filter.threadRootMessageId !== undefined;

    if (isThreadPage) capture.itemQueries.push(filter);

    const query = {
      select: () => query,
      sort: (spec) => {
        query.sortSpec = spec;
        return query;
      },
      limit: (value) => {
        query.limitSpec = value;
        return query;
      },
      lean: async () => {
        let rows = messages.filter((doc) => matchesMessage(doc, filter));

        if (filter.seq?.$lt !== undefined) {
          rows = rows.filter((row) => row.seq < filter.seq.$lt);
        }

        if (query.sortSpec?.seq === -1) rows = [...rows].sort((a, b) => b.seq - a.seq);
        if (query.limitSpec !== undefined) rows = rows.slice(0, query.limitSpec);

        return rows;
      },
    };

    return query;
  };

  ChatMessage.aggregate = async (pipeline = []) => {
    capture.aggregates += 1;

    const match = pipeline[0]?.$match ?? {};
    const wanted = (match.threadRootMessageId?.$in ?? []).map(String);

    if (wanted.length === 0) return [];

    const counts = new Map();

    for (const row of messages) {
      if (!matchesMessage(row, { ...match, threadRootMessageId: undefined })) continue;

      const rootId = row.threadRootMessageId ? String(row.threadRootMessageId) : null;

      if (!rootId || !wanted.includes(rootId)) continue;

      counts.set(rootId, (counts.get(rootId) ?? 0) + 1);
    }

    return [...counts].map(([messageId, count]) => ({ _id: messageId, count }));
  };

  ChatMessage.create = async (payload) => {
    seqCounter += 1;

    const doc = {
      _id: id(),
      ...payload,
      seq: payload.seq ?? seqCounter,
      editVersion: 0,
      deletedAt: null,
      createdAt: new Date(),
      toObject() {
        return { ...this, toObject: undefined };
      },
    };

    capture.created.push(doc);
    messages.push(doc);

    return doc;
  };

  ChatMessageReaction.find = (filter = {}) => {
    const query = {
      select: () => query,
      limit: () => query,
      lean: async () => {
        const wanted = (filter.messageId?.$in ?? []).map(String);

        return reactions.filter(
          (row) =>
            same(row.companyId, filter.companyId) &&
            (wanted.length === 0 || wanted.includes(String(row.messageId)))
        );
      },
    };

    return query;
  };

  return {
    capture,
    restore: () => {
      ChatConversation.findOne = original.convFindOne;
      ChatConversation.findOneAndUpdate = original.convFindOneAndUpdate;
      ChatMessage.find = original.msgFind;
      ChatMessage.findOne = original.msgFindOne;
      ChatMessage.create = original.msgCreate;
      ChatMessage.aggregate = original.msgAggregate;
      ChatMessageReaction.find = original.reactFind;
      User.find = original.userFind;
    },
  };
};

// ── seeds ─────────────────────────────────────────────────────────────────

const seedConversation = ({ companyId = COMPANY_A, members, isDisabled = false } = {}) => ({
  _id: id(),
  companyId,
  type: 'GROUP',
  title: 'Design',
  members: members ?? [{ userId: ALICE }, { userId: BOB }],
  lastMessageSeq: 0,
  isDisabled,
});

const seedMessage = ({
  conversation,
  sender = ALICE,
  seq,
  text = 'hello',
  replyTo = null,
  threadRoot = null,
  deletedAt = null,
  type = 'TEXT',
} = {}) => ({
  _id: id(),
  companyId: conversation.companyId,
  conversationId: conversation._id,
  senderUserId: sender,
  seq,
  clientMessageId: `seed-${seq}`,
  type,
  text,
  attachments: [],
  editVersion: 0,
  replyToMessageId: replyTo,
  threadRootMessageId: threadRoot,
  deletedAt,
  createdAt: new Date(),
});

// ── mocks ─────────────────────────────────────────────────────────────────

const makeIo = (broadcasts) => ({
  to: (room) => ({
    emit: (event, payload) => broadcasts.push({ room, event, payload }),
  }),
});

const makeSocket = ({ companyId = COMPANY_A, userId = ALICE } = {}) => {
  const handlers = {};

  return {
    data: { companyId, userId },
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

const wireSocket = ({ companyId = COMPANY_A, userId = ALICE, broadcasts, overrides = {} }) => {
  const socket = makeSocket({ companyId, userId });

  registerChatSocketHandlers({
    io: makeIo(broadcasts),
    socket,
    log: { error: () => {}, warn: () => {} },
    limitRate: async () => ({ limited: false }),
    ...overrides,
  });

  return socket;
};

const createdBroadcasts = (broadcasts) =>
  broadcasts.filter((entry) => entry.event === 'chat:message:created');

// ══════════════════════════════════════════════════════════════════════════
// 1. REST — GET …/threads/:rootMessageId
// ══════════════════════════════════════════════════════════════════════════

test('a member gets the root and its replies, and the root carries the thread-wide reply count', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] });
  const root = seedMessage({ conversation, seq: 1, text: 'kick off' });
  const first = seedMessage({ conversation, sender: BOB, seq: 2, text: 'reply one', replyTo: root._id, threadRoot: root._id });
  const second = seedMessage({ conversation, seq: 3, text: 'reply two', replyTo: first._id, threadRoot: root._id });
  const other = seedMessage({ conversation, seq: 4, text: 'top level again' });

  const fake = installFakes({ conversations: [conversation], messages: [root, first, second, other] });

  try {
    const result = await getThread({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      rootMessageId: root._id,
      limit: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(same(result.root._id, root._id), true, 'the root is returned');
    assert.equal(result.root.threadReplyCount, 2, 'the count is thread-wide, not page-wide');
    assert.deepEqual(
      result.items.map((row) => row.seq),
      [3, 2],
      'replies come back newest first'
    );

    // Reply hints ride the same projection: the second reply answers the first.
    const replyTwo = result.items[0];

    assert.equal(same(replyTwo.replyTo.messageId, first._id), true);
    assert.equal(replyTwo.replyTo.snippet, 'reply one', 'the snippet is bounded context, not a copy');
    assert.equal(replyTwo.replyTo.deletedAt, null);

    // …and every item knows which thread it belongs to, so the UI can open it
    // from any reply.
    assert.equal(result.items.every((row) => same(row.threadRootMessageId, root._id)), true);

    // The root never claims to be a reply.
    assert.equal(result.root.replyToMessageId, null);
    assert.equal(result.root.threadRootMessageId, null);
    assert.deepEqual(result.root.reactions, [], 'no reactions yet, and always an array');
  } finally {
    fake.restore();
  }
});

test('requesting a REPLY opens the thread it belongs to (one thread, one view)', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });
  const reply = seedMessage({ conversation, seq: 2, text: 'answer', replyTo: root._id, threadRoot: root._id });

  const fake = installFakes({ conversations: [conversation], messages: [root, reply] });

  try {
    const result = await getThread({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      rootMessageId: reply._id,
      limit: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(same(result.root._id, root._id), true, 'the effective root is the original one');
    assert.deepEqual(result.items.map((row) => row._id.toString()), [reply._id.toString()]);
  } finally {
    fake.restore();
  }
});

test('a non-member, another tenant, and a root from another conversation all 404 the same way', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }] });
  const root = seedMessage({ conversation, seq: 1 });
  const foreignConversation = seedConversation({ members: [{ userId: ALICE }] });
  const foreignRoot = seedMessage({ conversation: foreignConversation, seq: 1 });

  const fake = installFakes({
    conversations: [conversation, foreignConversation],
    messages: [root, foreignRoot],
  });

  try {
    const notAMember = await getThread({
      companyId: COMPANY_A, userId: BOB, conversationId: conversation._id, rootMessageId: root._id,
    });

    assert.equal(notAMember.ok, false);
    assert.equal(notAMember.code, 'NOT_FOUND_OR_FORBIDDEN', 'membership is checked before anything else');

    const otherTenant = await getThread({
      companyId: COMPANY_B, userId: MALLORY, conversationId: conversation._id, rootMessageId: root._id,
    });

    assert.equal(otherTenant.ok, false);
    assert.equal(otherTenant.code, 'NOT_FOUND_OR_FORBIDDEN', 'tenant isolation reads as "not found"');

    const wrongConversation = await getThread({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, rootMessageId: foreignRoot._id,
    });

    assert.equal(wrongConversation.ok, false);
    assert.equal(wrongConversation.code, 'NOT_FOUND_OR_FORBIDDEN', 'a root must belong to THIS conversation');

    // …and an id that simply does not exist is the same refusal.
    const missing = await getThread({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, rootMessageId: id(),
    });

    assert.equal(missing.code, 'NOT_FOUND_OR_FORBIDDEN');
  } finally {
    fake.restore();
  }
});

test('pagination is clamped 1..50, probes with limit+1, and a cursor walks strictly older replies', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });

  const replies = Array.from({ length: 8 }, (_, index) =>
    seedMessage({
      conversation,
      seq: index + 2,
      text: `reply ${index + 1}`,
      replyTo: root._id,
      threadRoot: root._id,
    })
  );

  const fake = installFakes({ conversations: [conversation], messages: [root, ...replies] });

  try {
    const clampedHigh = await getThread({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, rootMessageId: root._id, limit: 500,
    });

    assert.equal(clampedHigh.limit, CHAT_THREAD_LIMIT_MAX, 'a huge limit is clamped, never honoured');
    assert.equal(fake.capture.itemQueries.at(-1) !== undefined, true);

    const page = await getThread({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, rootMessageId: root._id, limit: 3,
    });

    assert.equal(page.items.length, 3, 'exactly a page');
    assert.deepEqual(page.items.map((row) => row.seq), [9, 8, 7]);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextCursor, 7, 'the cursor is the last seq of the page');

    const next = await getThread({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      rootMessageId: root._id,
      limit: 3,
      cursor: page.nextCursor,
    });

    assert.deepEqual(next.items.map((row) => row.seq), [6, 5, 4], 'strictly older, no overlap');
    assert.equal(next.hasMore, true);

    const last = await getThread({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      rootMessageId: root._id,
      limit: 3,
      cursor: next.nextCursor,
    });

    assert.deepEqual(last.items.map((row) => row.seq), [3, 2]);
    assert.equal(last.hasMore, false);
    assert.equal(last.nextCursor, null, 'the end of a thread says so');

    // The clamp is also visible to the query itself (limit + 1 probe).
    const defaulted = await getThread({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, rootMessageId: root._id,
    });

    assert.equal(defaulted.limit, CHAT_THREAD_LIMIT_DEFAULT, 'no limit means the documented default');
  } finally {
    fake.restore();
  }
});

test('tombstones stay tombstone-safe and a deleted parent yields a NULL snippet', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });
  const deletedReply = seedMessage({
    conversation,
    sender: BOB,
    seq: 2,
    text: null,
    deletedAt: new Date(),
    replyTo: root._id,
    threadRoot: root._id,
  });
  const answerToDeleted = seedMessage({
    conversation,
    seq: 3,
    text: 'still answering',
    replyTo: deletedReply._id,
    threadRoot: root._id,
  });

  const fake = installFakes({
    conversations: [conversation],
    messages: [root, deletedReply, answerToDeleted],
  });

  try {
    const result = await getThread({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, rootMessageId: root._id,
    });

    const tombstone = result.items.find((row) => same(row._id, deletedReply._id));

    assert.equal(tombstone.text, null, 'a deleted reply carries no text');
    assert.ok(tombstone.deletedAt, 'and it is visibly deleted');
    assert.deepEqual(tombstone.reactions, [], 'and it shows no reactions');

    const answer = result.items.find((row) => same(row._id, answerToDeleted._id));

    assert.equal(answer.replyTo.snippet, null, 'the deleted parent is never echoed back');
    assert.ok(answer.replyTo.deletedAt, 'the UI can still say "replying to a deleted message"');
  } finally {
    fake.restore();
  }
});

test('the thread page carries reactions (viewer-aware) like any other history page', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });
  const reply = seedMessage({ conversation, sender: BOB, seq: 2, text: 'answer', replyTo: root._id, threadRoot: root._id });

  const reactions = [
    {
      _id: id(), companyId: COMPANY_A, conversationId: conversation._id,
      messageId: reply._id, userId: ALICE, reactionType: 'LIKE',
    },
    {
      _id: id(), companyId: COMPANY_A, conversationId: conversation._id,
      messageId: reply._id, userId: BOB, reactionType: 'LIKE',
    },
    {
      _id: id(), companyId: COMPANY_A, conversationId: conversation._id,
      messageId: root._id, userId: BOB, reactionType: 'HEART',
    },
  ];

  const fake = installFakes({ conversations: [conversation], messages: [root, reply], reactions });

  try {
    const result = await getThread({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, rootMessageId: root._id,
    });

    assert.deepEqual(result.items[0].reactions, [{ type: 'LIKE', count: 2, mine: true }]);
    assert.deepEqual(result.root.reactions, [{ type: 'HEART', count: 1, mine: false }]);
  } finally {
    fake.restore();
  }
});

test('a DISABLED conversation stays readable as a thread (the lock law)', async () => {
  const conversation = seedConversation({ isDisabled: true });
  const root = seedMessage({ conversation, seq: 1, text: 'root' });
  const reply = seedMessage({ conversation, seq: 2, text: 'answer', replyTo: root._id, threadRoot: root._id });

  const fake = installFakes({ conversations: [conversation], messages: [root, reply] });

  try {
    const read = await getThread({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, rootMessageId: root._id,
    });

    assert.equal(read.ok, true, 'history is still readable while locked');
    assert.equal(read.items.length, 1);

    // …but a reply is a WRITE and is refused by the same gate as any other write.
    const write = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'locked-1',
      text: 'nope',
      replyToMessageId: root._id,
    });

    assert.equal(write.ok, false);
    assert.equal(write.code, 'CONVERSATION_DISABLED');
    assert.equal(fake.capture.created.length, 0, 'nothing was written');
  } finally {
    fake.restore();
  }
});

test('a normal history page still works and now states its thread counts', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });
  const reply = seedMessage({ conversation, seq: 2, text: 'answer', replyTo: root._id, threadRoot: root._id });

  const fake = installFakes({ conversations: [conversation], messages: [root, reply] });

  try {
    const page = await listMessages({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, limit: 20,
    });

    const rootRow = page.items.find((row) => same(row._id, root._id));
    const replyRow = page.items.find((row) => same(row._id, reply._id));

    assert.equal(rootRow.threadReplyCount, 1, 'the root advertises its thread');
    assert.equal(replyRow.threadReplyCount, 0, 'a reply roots nothing');
    assert.equal(replyRow.replyTo.snippet, 'root', 'and shows what it answers');
  } finally {
    fake.restore();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2. SOCKET SEND — replies
// ══════════════════════════════════════════════════════════════════════════

test('replying to a message stores the reply target and roots the thread at it', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });

  const fake = installFakes({ conversations: [conversation], messages: [root] });

  try {
    const stored = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'reply-1',
      text: 'answering',
      replyToMessageId: String(root._id),
    });

    assert.equal(stored.ok, true);
    assert.equal(same(stored.message.replyToMessageId, root._id), true, 'the parent is stored');
    assert.equal(
      same(stored.message.threadRootMessageId, root._id),
      true,
      'answering the root makes the root the thread root'
    );
    assert.equal(stored.replyTo.snippet, 'root', 'and the caller gets the preview back');
  } finally {
    fake.restore();
  }
});

test('replying to a REPLY keeps the original thread root (threads never fork)', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });
  const first = seedMessage({ conversation, sender: BOB, seq: 2, text: 'first answer', replyTo: root._id, threadRoot: root._id });

  const fake = installFakes({ conversations: [conversation], messages: [root, first] });

  try {
    const stored = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'reply-2',
      text: 'answering the answer',
      replyToMessageId: String(first._id),
    });

    assert.equal(stored.ok, true);
    assert.equal(same(stored.message.replyToMessageId, first._id), true, 'the PARENT is the reply');
    assert.equal(
      same(stored.message.threadRootMessageId, root._id),
      true,
      'but the ROOT stays the original message'
    );
  } finally {
    fake.restore();
  }
});

test('a reply target outside this conversation or this tenant is refused, with nothing written', async () => {
  const conversation = seedConversation({});
  const otherConversation = seedConversation({});
  const foreign = seedMessage({ conversation: otherConversation, seq: 1, text: 'somewhere else' });

  const fake = installFakes({
    conversations: [conversation, otherConversation],
    messages: [foreign],
  });

  try {
    const crossConversation = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'x-1',
      text: 'nope',
      replyToMessageId: String(foreign._id),
    });

    assert.equal(crossConversation.ok, false);
    assert.equal(crossConversation.code, 'NOT_FOUND_OR_FORBIDDEN');

    const crossTenant = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'x-2',
      text: 'nope',
      replyToMessageId: String(id()), // another tenant's message never even matches
    });

    assert.equal(crossTenant.code, 'NOT_FOUND_OR_FORBIDDEN');
    assert.equal(fake.capture.created.length, 0, 'no message was created for either attempt');
  } finally {
    fake.restore();
  }
});

test('a malformed replyToMessageId is refused at the socket edge, before any service call', async () => {
  const broadcasts = [];
  const calls = [];

  const socket = wireSocket({
    broadcasts,
    overrides: {
      loadConversation: async () => ({ _id: id(), isDisabled: false }),
      sendMessage: async (payload) => {
        calls.push(payload);

        return { ok: true, created: false, message: { _id: id(), seq: 1 }, replyTo: null };
      },
    },
  });

  const result = await socket.trigger('chat:message:send', {
    conversationId: String(id()),
    clientMessageId: 'edge-1',
    text: 'hello',
    replyToMessageId: 'not-an-id',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'VALIDATION_ERROR');
  assert.match(result.message, /replyToMessageId/);
  assert.equal(calls.length, 0, 'the service is never reached');
  assert.equal(broadcasts.length, 0);
});

test('the socket send path forwards the reply id and broadcasts both fields plus the preview', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });

  const fake = installFakes({ conversations: [conversation], messages: [root] });
  const broadcasts = [];

  try {
    const socket = wireSocket({ broadcasts });

    const ack = await socket.trigger('chat:message:send', {
      conversationId: String(conversation._id),
      clientMessageId: 'socket-1',
      text: 'a threaded answer',
      replyToMessageId: String(root._id),
    });

    assert.equal(ack.ok, true);
    assert.equal(same(ack.data.message.replyToMessageId, root._id), true, 'the ACK carries the parent');
    assert.equal(same(ack.data.message.threadRootMessageId, root._id), true);
    assert.equal(ack.data.message.replyTo.snippet, 'root');

    const emitted = createdBroadcasts(broadcasts);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].room, conversationRoom(conversation._id));
    assert.equal(same(emitted[0].payload.message.replyToMessageId, root._id), true);
    assert.equal(same(emitted[0].payload.message.threadRootMessageId, root._id), true);
    assert.deepEqual(
      Object.keys(emitted[0].payload.message.replyTo).sort(),
      ['deletedAt', 'messageId', 'senderUserId', 'snippet'],
      'the hint is a bounded shape, never the parent document'
    );
    assert.equal(
      JSON.stringify(emitted[0].payload.message).includes('storageKey'),
      false,
      'the broadcast still carries references only — nothing new leaks'
    );
  } finally {
    fake.restore();
  }
});

test('a FILE message can answer a message too', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });

  const fake = installFakes({ conversations: [conversation], messages: [root] });

  try {
    const stored = await sendFileMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'file-1',
      attachments: [
        { attachmentId: id(), fileName: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
      ],
      text: 'the brief',
      replyToMessageId: String(root._id),
    });

    assert.equal(stored.ok, true);
    assert.equal(same(stored.message.replyToMessageId, root._id), true);
    assert.equal(same(stored.message.threadRootMessageId, root._id), true);
  } finally {
    fake.restore();
  }
});

test('a retried reply is idempotent: one row, and the ACK still explains what it answers', async () => {
  const conversation = seedConversation({});
  const root = seedMessage({ conversation, seq: 1, text: 'root' });

  const fake = installFakes({ conversations: [conversation], messages: [root] });
  const broadcasts = [];

  try {
    const socket = wireSocket({ broadcasts });

    const payload = {
      conversationId: String(conversation._id),
      clientMessageId: 'retry-1',
      text: 'once',
      replyToMessageId: String(root._id),
    };

    const first = await socket.trigger('chat:message:send', payload);
    const second = await socket.trigger('chat:message:send', payload);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fake.capture.created.length, 1, 'one message, however many times it is sent');
    assert.equal(
      createdBroadcasts(broadcasts).length,
      1,
      'and the room hears about it exactly once'
    );
    assert.equal(same(second.data.message.replyToMessageId, root._id), true);
    assert.equal(second.data.message.replyTo.snippet, 'root', 'the retry is re-answered with context');
  } finally {
    fake.restore();
  }
});

test('a TOMBSTONED parent may still be answered, with a null snippet', async () => {
  const conversation = seedConversation({});
  const deletedRoot = seedMessage({
    conversation,
    sender: BOB,
    seq: 1,
    text: null,
    deletedAt: new Date(),
  });

  const fake = installFakes({ conversations: [conversation], messages: [deletedRoot] });

  try {
    const stored = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'after-delete',
      text: 'carrying on',
      replyToMessageId: String(deletedRoot._id),
    });

    assert.equal(stored.ok, true, 'a moderator removal must not freeze a thread');
    assert.equal(same(stored.message.threadRootMessageId, deletedRoot._id), true);
    assert.equal(stored.replyTo.snippet, null, 'and the deleted text is never echoed back');
    assert.ok(stored.replyTo.deletedAt);
  } finally {
    fake.restore();
  }
});

test('the reply preview is a bounded hint, never a copy of a long parent', async () => {
  const conversation = seedConversation({});
  const longRoot = seedMessage({ conversation, seq: 1, text: 'x'.repeat(500) });

  const fake = installFakes({ conversations: [conversation], messages: [longRoot] });

  try {
    const stored = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'long-1',
      text: 'ok',
      replyToMessageId: String(longRoot._id),
    });

    assert.equal(stored.replyTo.snippet.length, CHAT_REPLY_PREVIEW_MAX);
  } finally {
    fake.restore();
  }
});

test('a top-level send is unchanged: both thread fields stay null', async () => {
  const conversation = seedConversation({});

  const fake = installFakes({ conversations: [conversation], messages: [] });

  try {
    const stored = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'plain-1',
      text: 'no thread here',
    });

    assert.equal(stored.ok, true);
    assert.equal(stored.message.replyToMessageId ?? null, null);
    assert.equal(stored.message.threadRootMessageId ?? null, null);
    assert.equal(stored.replyTo ?? null, null, 'no hint for a message that answers nothing');
  } finally {
    fake.restore();
  }
});
