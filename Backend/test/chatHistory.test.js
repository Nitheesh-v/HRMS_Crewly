// ============================================================
//  PHASE 33.4 — CHAT MESSAGE HISTORY (HERMETIC).
//
//  No Mongo, no Redis, no HTTP. ChatConversation.findOne (membership)
//  and ChatMessage.find (the paginated read) are swapped for in-memory
//  fakes, then the service is exercised for tenancy, membership,
//  pagination bounds, cursor keyset behaviour and tombstone safety.
//
//  33.10-fix3 — the projection must also carry ATTACHMENT REFERENCES.
//  33.10 added them to the socket broadcast but not to this whitelist, so a
//  FILE message rendered correctly while it was the live socket copy and as
//  an empty bubble the moment the transcript came from history. The pins
//  below compare this projection against the socket's own view of the same
//  row, so the two surfaces cannot drift again.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_history';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import User from '../src/models/User.js';
import * as chatService from '../src/services/chat/chatService.js';
import { sanitizeMessageForHistory } from '../src/services/chat/chatService.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();

const COMPANY_A = id();
const COMPANY_B = id();
const ALICE = id();
const BOB = id();
const MALLORY = id(); // company B

const makeConversation = (overrides = {}) => ({
  _id: id(),
  companyId: COMPANY_A,
  type: 'GROUP',
  title: 'Design',
  members: [{ userId: ALICE }, { userId: BOB }],
  lastMessageSeq: 0,
  ...overrides,
});

const installFakes = ({ conversation, messages }) => {
  const original = {
    convFindOne: ChatConversation.findOne,
    msgFind: ChatMessage.find,
    // 33.8-fix: listMessages verifies membership through getConversation,
    // which now builds a member directory — hermetic runs need a sealed
    // User stub (empty directory).
    userFind: User.find,
  };

  User.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });

  ChatConversation.findOne = (filter) => ({
    lean: async () => {
      if (!conversation) return null;
      if (filter.companyId && String(filter.companyId) !== String(conversation.companyId)) return null;
      if (filter._id && String(filter._id) !== String(conversation._id)) return null;
      const member = filter['members.userId'];
      if (member && !conversation.members.some((m) => String(m.userId) === String(member))) return null;
      return conversation;
    },
  });

  const capture = {};

  ChatMessage.find = (filter) => {
    capture.filter = filter;

    const query = {
      sort: (sort) => {
        capture.sort = sort;
        return query;
      },
      limit: (limit) => {
        capture.limit = limit;
        return query;
      },
      lean: async () => {
        let rows = [...messages];

        if (filter.seq?.$lt !== undefined) {
          rows = rows.filter((row) => row.seq < filter.seq.$lt);
        }

        // emulate seq desc
        rows.sort((a, b) => b.seq - a.seq);

        const limited = rows.slice(0, capture.limit);

        return limited;
      },
    };

    return query;
  };

  return {
    capture,
    restore: () => {
      ChatConversation.findOne = original.convFindOne;
      ChatMessage.find = original.msgFind;
      User.find = original.userFind;
    },
  };
};

const seedMessages = (count, extras = {}) =>
  Array.from({ length: count }, (_, index) => ({
    _id: id(),
    companyId: COMPANY_A,
    conversationId: id(),
    senderUserId: index % 2 === 0 ? ALICE : BOB,
    seq: index + 1,
    clientMessageId: `client-${index + 1}`,
    type: 'TEXT',
    text: `message ${index + 1}`,
    editVersion: 0,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    ...extras,
  }));

// ── sanitizer ─────────────────────────────────────────────────────────────

test('sanitizeMessageForHistory never leaks a tombstone body', () => {
  const live = sanitizeMessageForHistory({
    _id: id(), seq: 1, senderUserId: ALICE, type: 'TEXT', text: 'hello',
    editVersion: 0, deletedAt: null, createdAt: new Date(),
  });

  const dead = sanitizeMessageForHistory({
    _id: id(), seq: 2, senderUserId: ALICE, type: 'TEXT', text: 'should not leak',
    editVersion: 0, deletedAt: new Date(), createdAt: new Date(),
  });

  assert.equal(live.text, 'hello');
  assert.equal(dead.text, null, 'deleted message body must be nulled');
  assert.ok(dead.deletedAt, 'deletedAt is surfaced so the UI can render a tombstone');
});

// ── membership + tenancy ──────────────────────────────────────────────────

test('non-member and cross-tenant callers get 404 before any message read', async () => {
  const conversation = makeConversation();
  const fake = installFakes({ conversation, messages: seedMessages(3) });

  try {
    await assert.rejects(
      chatService.listMessages({
        companyId: COMPANY_A, userId: MALLORY, conversationId: conversation._id,
      }),
      /not found/i,
      'same tenant, non-member must 404'
    );

    await assert.rejects(
      chatService.listMessages({
        companyId: COMPANY_B, userId: MALLORY, conversationId: conversation._id,
      }),
      /not found/i,
      'other tenant must 404'
    );
  } finally {
    fake.restore();
  }
});

// ── pagination ────────────────────────────────────────────────────────────

test('limit is clamped to 1..50 and service requests limit+1', async () => {
  const conversation = makeConversation();
  const fake = installFakes({ conversation, messages: seedMessages(5) });

  try {
    const result = await chatService.listMessages({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, limit: 999,
    });

    assert.equal(result.limit, 50);
    assert.equal(fake.capture.limit, 51, 'must fetch limit+1 for hasMore');
    assert.equal(String(fake.capture.filter.companyId), String(COMPANY_A));
    assert.equal(String(fake.capture.filter.conversationId), String(conversation._id));
    assert.equal(fake.capture.sort.seq, -1, 'newest-first by seq');
  } finally {
    fake.restore();
  }
});

test('cursor returns the strictly-older page and a correct nextCursor', async () => {
  const conversation = makeConversation();
  const messages = seedMessages(10); // seq 1..10
  const fake = installFakes({ conversation, messages });

  try {
    const page1 = await chatService.listMessages({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, limit: 4,
    });

    // newest-first: seq 10,9,8,7
    assert.deepEqual(page1.items.map((item) => item.seq), [10, 9, 8, 7]);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextCursor, 7);

    const page2 = await chatService.listMessages({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id,
      limit: 4, cursor: page1.nextCursor,
    });

    assert.equal(fake.capture.filter.seq.$lt, 7, 'cursor must translate to seq < cursor');
    assert.deepEqual(page2.items.map((item) => item.seq), [6, 5, 4, 3]);
    assert.equal(page2.nextCursor, 3);

    const page3 = await chatService.listMessages({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id,
      limit: 50, cursor: 3,
    });

    assert.deepEqual(page3.items.map((item) => item.seq), [2, 1]);
    assert.equal(page3.hasMore, false);
    assert.equal(page3.nextCursor, null);
  } finally {
    fake.restore();
  }
});

test('deleted messages come back tombstone-safe in a real page', async () => {
  const conversation = makeConversation();
  const messages = seedMessages(3);
  messages[1].deletedAt = new Date();
  messages[1].text = 'secret body';

  const fake = installFakes({ conversation, messages });

  try {
    const result = await chatService.listMessages({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, limit: 10,
    });

    const deleted = result.items.find((item) => item.seq === 2);

    assert.equal(deleted.text, null, 'tombstone body must not leak through the page');
    assert.ok(deleted.deletedAt);
  } finally {
    fake.restore();
  }
});

// ── attachment references (33.10-fix3) ────────────────────────────────────

const attachmentRow = (overrides = {}) => ({
  attachmentId: id(),
  fileName: 'BGVRPT-00001-v1.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  // Server-only fields the projection must never forward.
  storageKey: 'crewly-private-chat-attachments/company/conversation/uuid',
  checksumSha256: 'deadbeef',
  ...overrides,
});

test('history carries attachment references — id + display metadata only', () => {
  const row = attachmentRow();

  const item = sanitizeMessageForHistory({
    _id: id(), seq: 7, senderUserId: ALICE, type: 'FILE', text: null,
    attachments: [row], editVersion: 0, deletedAt: null, createdAt: new Date(),
  });

  assert.deepEqual(item.attachments, [
    {
      attachmentId: row.attachmentId,
      fileName: 'BGVRPT-00001-v1.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    },
  ]);

  // The private parts stay private.
  const serialized = JSON.stringify(item);

  assert.ok(!serialized.includes('storageKey'), 'no storage key');
  assert.ok(!serialized.includes('checksum'), 'no checksum');
  assert.ok(!serialized.includes('crewly-private'), 'no key namespace');
  assert.ok(!/https?:\/\//.test(serialized), 'no URL of any kind');

  // A text message has no references, and a missing field is an empty list
  // (never undefined: the client renders `attachments.length`).
  assert.deepEqual(
    sanitizeMessageForHistory({ _id: id(), seq: 8, senderUserId: ALICE, type: 'TEXT', text: 'hi' }).attachments,
    [],
  );
});

test('a tombstoned message keeps its references (the bubble shows the tombstone)', () => {
  const item = sanitizeMessageForHistory({
    _id: id(), seq: 9, senderUserId: ALICE, type: 'FILE', text: null,
    attachments: [attachmentRow()], deletedAt: new Date(), createdAt: new Date(),
  });

  assert.equal(item.text, null);
  assert.ok(item.deletedAt);
  assert.equal(item.attachments.length, 1);
});

test('listMessages returns FILE messages with their files attached', async () => {
  const conversation = makeConversation();
  const messages = [
    ...seedMessages(2),
    {
      ...seedMessages(1, { type: 'FILE', text: null })[0],
      seq: 3,
      attachments: [attachmentRow()],
    },
  ];
  const fake = installFakes({ conversation, messages });

  try {
    const page = await chatService.listMessages({
      companyId: COMPANY_A, userId: ALICE, conversationId: conversation._id, limit: 10,
    });

    const file = page.items.find((item) => item.type === 'FILE');

    assert.ok(file, 'the FILE message is in the page');
    assert.equal(file.attachments.length, 1);
    assert.equal(file.attachments[0].fileName, 'BGVRPT-00001-v1.pdf');
    assert.equal(String(file.attachments[0].attachmentId), String(messages[2].attachments[0].attachmentId));
  } finally {
    fake.restore();
  }
});

test('the history view and the socket broadcast agree on the same row', async () => {
  // The socket's own projection, captured from the real handler.
  const handlers = new Map();
  const emitted = [];
  const socket = {
    data: { companyId: String(COMPANY_A), userId: String(ALICE) },
    on: (event, handler) => handlers.set(event, handler),
    join: () => {}, leave: () => {}, emit: () => {},
  };

  const row = attachmentRow();
  const stored = {
    _id: id(), seq: 4, senderUserId: ALICE, type: 'FILE', text: null,
    attachments: [row], clientMessageId: 'client-4', editVersion: 0,
    deletedAt: null, createdAt: new Date(),
  };

  registerChatSocketHandlers({
    io: { to: () => ({ emit: (event, payload) => emitted.push([event, payload]) }) },
    socket,
    log: { warn: () => {}, error: () => {}, info: () => {} },
    loadConversation: async () => ({ _id: id(), isDisabled: false }),
    linkAttachments: async () => [row],
    sendFile: async () => ({ ok: true, created: true, message: stored }),
  });

  await new Promise((resolve) => {
    handlers.get('chat:message:sendFile')(
      { conversationId: String(id()), clientMessageId: 'client-4', attachmentIds: [String(row.attachmentId)] },
      () => resolve(),
    );
  });

  const broadcast = emitted.find(([event]) => event === 'chat:message:created')?.[1]?.message;

  assert.ok(broadcast, 'the socket broadcast the created message');

  const history = sanitizeMessageForHistory(stored);

  assert.deepEqual(
    history.attachments,
    broadcast.attachments,
    'the two surfaces must describe the same file identically',
  );
});
