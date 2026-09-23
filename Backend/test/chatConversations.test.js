// ============================================================
//  PHASE 33.3 — CHAT CONVERSATION REST SERVICE (HERMETIC).
//
//  No Mongo, no Redis, no HTTP. The ChatConversation / User model
//  statics are swapped for in-memory fakes (the repo's established
//  pattern — see test/offerManagement.test.js), then the service is
//  exercised for tenancy, membership, DIRECT idempotency (including
//  the E11000 race), GROUP rules, member management authorization
//  and pagination bounds.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_conv';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import User from '../src/models/User.js';
import * as chatService from '../src/services/chatService.js';
import {
  buildDirectKey,
  buildPageFilter,
  clampChatLimit,
  decodeChatCursor,
  encodeChatCursor,
} from '../src/services/chatService.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();

const COMPANY_A = id();
const COMPANY_B = id();

const ALICE = id(); // company A
const BOB = id(); // company A
const CAROL = id(); // company A
const MALLORY = id(); // company B

// ── in-memory ChatConversation fake ───────────────────────────────────────

const installChatFake = () => {
  const docs = [];

  const sameId = (a, b) => String(a) === String(b);

  const isMember = (doc, userId) =>
    doc.members.some((member) => sameId(member.userId, userId));

  const matches = (doc, filter) => {
    if (filter.companyId && !sameId(doc.companyId, filter.companyId)) return false;

    if (filter.directKey && doc.directKey !== filter.directKey) return false;

    if (filter._id && !sameId(doc._id, filter._id)) return false;

    const memberFilter = filter['members.userId'];

    if (memberFilter && !isMember(doc, memberFilter)) return false;

    return true;
  };

  const findOne = (filter) => ({
    lean: async () => docs.find((doc) => matches(doc, filter)) ?? null,
  });

  const create = async (payload) => {
    if (payload.type === 'DIRECT') {
      const clash = docs.find(
        (doc) => doc.type === 'DIRECT' && doc.directKey === payload.directKey &&
          sameId(doc.companyId, payload.companyId)
      );

      if (clash) {
        const error = new Error('E11000 duplicate key');
        error.code = 11000;

        throw error;
      }
    }

    const doc = { _id: id(), ...payload };

    docs.push(doc);

    return { toObject: () => doc };
  };

  const updateOne = async (filter, update) => {
    const doc = docs.find((entry) => matches(entry, filter));

    if (!doc) return { modifiedCount: 0 };

    if (update.$push?.members?.$each) {
      doc.members.push(...update.$push.members.$each);
    }

    if (update.$pull?.members?.userId) {
      doc.members = doc.members.filter(
        (member) => !sameId(member.userId, update.$pull.members.userId)
      );
    }

    return { modifiedCount: 1 };
  };

  const find = (rowsRef, capture) => (filter) => {
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
      lean: async () => rowsRef.rows,
    };

    return query;
  };

  const original = {
    findOne: ChatConversation.findOne,
    create: ChatConversation.create,
    updateOne: ChatConversation.updateOne,
    find: ChatConversation.find,
  };

  ChatConversation.findOne = findOne;
  ChatConversation.create = create;
  ChatConversation.updateOne = updateOne;

  return {
    docs,
    setFind: (rowsRef, capture) => {
      ChatConversation.find = find(rowsRef, capture);
    },
    restore: () => {
      ChatConversation.findOne = original.findOne;
      ChatConversation.create = original.create;
      ChatConversation.updateOne = original.updateOne;
      ChatConversation.find = original.find;
    },
  };
};

const installUserFake = (activeByCompany) => {
  const original = User.find;

  User.find = (filter) => ({
    select: () => ({
      lean: async () =>
        (filter._id?.$in ?? [])
          .filter((userId) =>
            activeByCompany.some(
              (entry) => entry.companyId === String(filter.companyId) &&
                entry.ids.includes(String(userId))
            )
          )
          .map((userId) => ({ _id: userId })),
    }),
  });

  return () => {
    User.find = original;
  };
};

// ── pure helpers ──────────────────────────────────────────────────────────

test('clampChatLimit clamps to 1..50 with default 20', () => {
  assert.equal(clampChatLimit(undefined), 20);
  assert.equal(clampChatLimit('abc'), 20);
  assert.equal(clampChatLimit(0), 20);
  assert.equal(clampChatLimit(-5), 20);
  assert.equal(clampChatLimit(1), 1);
  assert.equal(clampChatLimit(50), 50);
  assert.equal(clampChatLimit(51), 50);
  assert.equal(clampChatLimit(1000), 50);
});

test('buildDirectKey is order-independent', () => {
  assert.equal(buildDirectKey('a', 'b'), buildDirectKey('b', 'a'));
  assert.equal(buildDirectKey(ALICE, BOB), [String(ALICE), String(BOB)].sort().join(':'));
});

test('cursor round-trips and rejects garbage', () => {
  const at = new Date('2026-01-02T03:04:05Z');
  const cursor = encodeChatCursor({ at, id: ALICE });

  const decoded = decodeChatCursor(cursor);

  assert.equal(decoded.at.getTime(), at.getTime());
  assert.equal(String(decoded.id), String(ALICE));

  assert.equal(decodeChatCursor('not-a-cursor'), null);
  assert.equal(decodeChatCursor(Buffer.from('{"a":1}').toString('base64url')), null);
});

test('buildPageFilter always scopes tenant + membership, cursor adds $or', () => {
  const base = buildPageFilter({ companyId: COMPANY_A, userId: ALICE, cursor: null });

  assert.equal(String(base.companyId), String(COMPANY_A));
  assert.equal(String(base['members.userId']), String(ALICE));
  assert.equal(base.$or, undefined);

  const cursor = decodeChatCursor(encodeChatCursor({ at: new Date(), id: ALICE }));
  const paged = buildPageFilter({ companyId: COMPANY_A, userId: ALICE, cursor });

  assert.ok(Array.isArray(paged.$or), 'cursor must add a keyset $or');
});

// ── create: DIRECT idempotency + tenancy ──────────────────────────────────

test('DIRECT create is idempotent and tenant-scoped', async () => {
  const fake = installChatFake();
  const restoreUser = installUserFake([
    { companyId: String(COMPANY_A), ids: [String(ALICE), String(BOB)] },
  ]);

  try {
    const first = await chatService.createDirectConversation({
      companyId: COMPANY_A,
      requesterId: ALICE,
      targetUserId: BOB,
    });

    const second = await chatService.createDirectConversation({
      companyId: COMPANY_A,
      requesterId: BOB,
      targetUserId: ALICE,
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false, 'reverse order must hit the same conversation');
    assert.equal(String(second.conversation._id), String(first.conversation._id));
    assert.equal(fake.docs.length, 1, 'only one DIRECT conversation may exist');
  } finally {
    fake.restore();
    restoreUser();
  }
});

test('DIRECT create resolves an E11000 race to the winner', async () => {
  const fake = installChatFake();
  const restoreUser = installUserFake([
    { companyId: String(COMPANY_A), ids: [String(ALICE), String(BOB)] },
  ]);

  try {
    // Seed the winner directly so create() will collide.
    const key = buildDirectKey(ALICE, BOB);

    fake.docs.push({
      _id: id(),
      companyId: COMPANY_A,
      type: 'DIRECT',
      directKey: key,
      members: [{ userId: ALICE }, { userId: BOB }],
    });

    const result = await chatService.createDirectConversation({
      companyId: COMPANY_A,
      requesterId: ALICE,
      targetUserId: BOB,
    });

    assert.equal(result.created, false);
    assert.equal(fake.docs.length, 1);
  } finally {
    fake.restore();
    restoreUser();
  }
});

test('DIRECT create rejects self-chat and cross-company targets', async () => {
  const fake = installChatFake();
  const restoreUser = installUserFake([
    { companyId: String(COMPANY_A), ids: [String(ALICE), String(BOB)] },
  ]);

  try {
    await assert.rejects(
      chatService.createDirectConversation({
        companyId: COMPANY_A,
        requesterId: ALICE,
        targetUserId: ALICE,
      }),
      /yourself/i
    );

    await assert.rejects(
      chatService.createDirectConversation({
        companyId: COMPANY_A,
        requesterId: ALICE,
        targetUserId: MALLORY, // company B, not in A's active set
      }),
      /not found/i
    );
  } finally {
    fake.restore();
    restoreUser();
  }
});

// ── create: GROUP rules ───────────────────────────────────────────────────

test('GROUP create enforces min members, cap and same-company ACTIVE users', async () => {
  const fake = installChatFake();
  const restoreUser = installUserFake([
    { companyId: String(COMPANY_A), ids: [String(ALICE), String(BOB), String(CAROL)] },
  ]);

  try {
    await assert.rejects(
      chatService.createGroupConversation({
        companyId: COMPANY_A,
        requesterId: ALICE,
        name: 'Solo',
        memberUserIds: [],
      }),
      /at least one other member/i
    );

    await assert.rejects(
      chatService.createGroupConversation({
        companyId: COMPANY_A,
        requesterId: ALICE,
        name: 'Too big',
        memberUserIds: Array.from({ length: 60 }, () => id()),
      }),
      /at most/i
    );

    await assert.rejects(
      chatService.createGroupConversation({
        companyId: COMPANY_A,
        requesterId: ALICE,
        name: 'Cross-company',
        memberUserIds: [MALLORY],
      }),
      /not active users/i
    );

    const ok = await chatService.createGroupConversation({
      companyId: COMPANY_A,
      requesterId: ALICE,
      name: 'Design',
      memberUserIds: [BOB, CAROL],
    });

    const creator = ok.conversation.members.find((m) => String(m.userId) === String(ALICE));

    assert.equal(ok.created, true);
    assert.equal(creator.role, 'ADMIN', 'creator must be the group admin');
    assert.equal(ok.conversation.members.length, 3);
  } finally {
    fake.restore();
    restoreUser();
  }
});

// ── read: tenancy + membership ────────────────────────────────────────────

test('getConversation 404s for other tenants and non-members', async () => {
  const fake = installChatFake();
  const restoreUser = installUserFake([
    { companyId: String(COMPANY_A), ids: [String(ALICE), String(BOB)] },
  ]);

  try {
    const { conversation } = await chatService.createGroupConversation({
      companyId: COMPANY_A,
      requesterId: ALICE,
      name: 'Design',
      memberUserIds: [BOB],
    });

    // Same company, member — works.
    const asMember = await chatService.getConversation({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
    });

    assert.equal(String(asMember.conversation._id), String(conversation._id));

    // Other tenant — 404.
    await assert.rejects(
      chatService.getConversation({
        companyId: COMPANY_B,
        userId: MALLORY,
        conversationId: conversation._id,
      }),
      /not found/i
    );

    // Same tenant, non-member — 404.
    await assert.rejects(
      chatService.getConversation({
        companyId: COMPANY_A,
        userId: CAROL,
        conversationId: conversation._id,
      }),
      /not found/i
    );
  } finally {
    fake.restore();
    restoreUser();
  }
});

// ── list: pagination bounds + scoping ─────────────────────────────────────

test('listMyConversations scopes by tenant + membership and clamps limit', async () => {
  const fake = installChatFake();
  const capture = {};
  const rows = [{ _id: id(), lastMessageAt: new Date() }];

  try {
    fake.setFind({ rows }, capture);

    const result = await chatService.listMyConversations({
      companyId: COMPANY_A,
      userId: ALICE,
      cursor: null,
      limit: 999,
    });

    assert.equal(result.limit, 50, 'limit must be clamped to 50');
    assert.equal(capture.limit, 51, 'service must request limit+1 for hasMore');
    assert.equal(String(capture.filter.companyId), String(COMPANY_A));
    assert.equal(String(capture.filter['members.userId']), String(ALICE));
  } finally {
    fake.restore();
  }
});

// ── member management authorization ───────────────────────────────────────

test('addMembers is admin-only and same-company', async () => {
  const fake = installChatFake();
  const restoreUser = installUserFake([
    { companyId: String(COMPANY_A), ids: [String(ALICE), String(BOB), String(CAROL)] },
  ]);

  try {
    const { conversation } = await chatService.createGroupConversation({
      companyId: COMPANY_A,
      requesterId: ALICE, // admin
      name: 'Design',
      memberUserIds: [BOB],
    });

    // Non-admin member cannot add.
    await assert.rejects(
      chatService.addMembers({
        companyId: COMPANY_A,
        actorId: BOB,
        conversationId: conversation._id,
        memberUserIds: [CAROL],
      }),
      /admin/i
    );

    // Admin cannot add a cross-company user.
    await assert.rejects(
      chatService.addMembers({
        companyId: COMPANY_A,
        actorId: ALICE,
        conversationId: conversation._id,
        memberUserIds: [MALLORY],
      }),
      /not active users/i
    );

    // Admin adds a valid same-company user.
    const added = await chatService.addMembers({
      companyId: COMPANY_A,
      actorId: ALICE,
      conversationId: conversation._id,
      memberUserIds: [CAROL],
    });

    assert.equal(added.conversation.members.length, 3);
  } finally {
    fake.restore();
    restoreUser();
  }
});

test('removeMember guards last member and last admin', async () => {
  const fake = installChatFake();
  const restoreUser = installUserFake([
    { companyId: String(COMPANY_A), ids: [String(ALICE), String(BOB), String(CAROL)] },
  ]);

  try {
    const { conversation } = await chatService.createGroupConversation({
      companyId: COMPANY_A,
      requesterId: ALICE, // the only admin
      name: 'Design',
      memberUserIds: [BOB],
    });

    // Bring the group to three members so the "keep two members" guard does
    // not mask the "keep one admin" guard we are asserting next.
    await chatService.addMembers({
      companyId: COMPANY_A,
      actorId: ALICE,
      conversationId: conversation._id,
      memberUserIds: [CAROL],
    });

    // Cannot remove the last admin.
    await assert.rejects(
      chatService.removeMember({
        companyId: COMPANY_A,
        actorId: ALICE,
        conversationId: conversation._id,
        targetUserId: ALICE,
      }),
      /at least one admin/i
    );

    // Removing a normal member works.
    const removed = await chatService.removeMember({
      companyId: COMPANY_A,
      actorId: ALICE,
      conversationId: conversation._id,
      targetUserId: BOB,
    });

    assert.equal(removed.conversation.members.length, 2);
  } finally {
    fake.restore();
    restoreUser();
  }
});

test('non-member cannot manage a group', async () => {
  const fake = installChatFake();
  const restoreUser = installUserFake([
    { companyId: String(COMPANY_A), ids: [String(ALICE), String(BOB), String(CAROL)] },
  ]);

  try {
    const { conversation } = await chatService.createGroupConversation({
      companyId: COMPANY_A,
      requesterId: ALICE,
      name: 'Design',
      memberUserIds: [BOB],
    });

    await assert.rejects(
      chatService.addMembers({
        companyId: COMPANY_A,
        actorId: CAROL, // not a member
        conversationId: conversation._id,
        memberUserIds: [CAROL],
      }),
      /must be a member/i
    );
  } finally {
    fake.restore();
    restoreUser();
  }
});
