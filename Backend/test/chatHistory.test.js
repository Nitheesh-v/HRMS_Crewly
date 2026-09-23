// ============================================================
//  PHASE 33.4 — CHAT MESSAGE HISTORY (HERMETIC).
//
//  No Mongo, no Redis, no HTTP. ChatConversation.findOne (membership)
//  and ChatMessage.find (the paginated read) are swapped for in-memory
//  fakes, then the service is exercised for tenancy, membership,
//  pagination bounds, cursor keyset behaviour and tombstone safety.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_history';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import * as chatService from '../src/services/chatService.js';
import { sanitizeMessageForHistory } from '../src/services/chatService.js';

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
  };

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
