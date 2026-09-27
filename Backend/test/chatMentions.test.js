// ============================================================
//  PHASE 34.3 — CHAT MENTIONS (HERMETIC).
//
//  No Mongo, no Redis, no socket.io-client. The REAL validator, the REAL
//  mention rules, the REAL mention service, the REAL message service and the
//  REAL socket handlers run against in-memory doubles.
//
//  Pinned behaviour:
//    · a validated mention is STORED with the token the server derived, and the
//      broadcast/ACK/history all carry the same rows
//    · an id that is unknown, from ANOTHER TENANT, or not a MEMBER of this
//      conversation refuses the whole send (VALIDATION_ERROR) with nothing
//      written — a mention cannot be an existence probe or a ping to a stranger
//    · the cap (10) is enforced at BOTH the edge and the service
//    · duplicates collapse to one mention
//    · a mention whose visible '@Name' is NOT in the body is dropped while the
//      message still sends — no silent ping is possible
//    · notifying: in-app only, actor excluded, ONE batch, and the payload
//      carries NO message text
//    · an idempotent retry never notifies twice
//    · an ordinary send (no mentions) does no mention work at all — not even a
//      query, which is what keeps every existing hermetic send test hermetic
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_mentions';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import Notification from '../src/models/Notification.js';
import User from '../src/models/User.js';
import {
  CHAT_MENTION_MAX_PER_MESSAGE,
  mentionTokenFor,
  parseMentionIds,
  tokenAppearsInText,
} from '../src/utils/chatMentionRules.js';
import {
  CHAT_MENTION_MESSAGES,
  resolveMentions,
} from '../src/services/chat/chatMentionService.js';
import { sendFileMessage, sendTextMessage } from '../src/services/chat/chatMessageService.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';
import { validateSendPayload } from '../src/socket/chatSocketValidators.js';
import { sanitizeMessageForHistory } from '../src/services/chat/chatService.js';
import { conversationRoom } from '../src/utils/chatKeys.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();
const same = (a, b) => String(a) === String(b);

const COMPANY_A = id();
const COMPANY_B = id();
const ALICE = id();
const BOB = id();
const CAROL = id(); // company A, NOT in the conversation
const MALLORY = id(); // company B

const NAMES = {
  [ALICE]: 'Alice Rao',
  [BOB]: 'Bob Iyer',
  [CAROL]: 'Carol Menon',
  [MALLORY]: 'Mallory Sen',
};

const trackedUserFind = (capture) => (filter = {}) => {
  capture.userQueries.push(filter);

  const wanted = (filter._id?.$in ?? []).map(String);

  const rows = Object.entries(NAMES)
    .filter(([userId]) => {
      if (filter.companyId && !same(COMPANY_B, filter.companyId)) {
        // Users of company A only (the fixture tenant that owns the chat).
        if ([ALICE, BOB, CAROL].every((known) => !same(known, userId))) return false;
      } else if (!same(COMPANY_B, filter.companyId) && same(MALLORY, userId)) {
        return false;
      }

      return wanted.includes(userId);
    })
    .map(([userId, name]) => ({ _id: new ObjectId(userId), name }));

  return {
    select: () => ({ lean: async () => rows }),
    then: (resolve) => resolve(rows),
  };
};

// ── doubles ───────────────────────────────────────────────────────────────

const installFakes = ({ conversation, messages = [], notifications = [] }) => {
  const original = {
    convFindOne: ChatConversation.findOne,
    convFindOneAndUpdate: ChatConversation.findOneAndUpdate,
    msgCreate: ChatMessage.create,
    userFind: User.find,
    notifInsertMany: Notification.insertMany,
  };

  const capture = { userQueries: [], notificationsCreated: [] };

  ChatConversation.findOne = () => ({
    lean: async () => conversation ?? null,
  });

  ChatConversation.findOneAndUpdate = () => ({
    lean: async () => {
      conversation.lastMessageSeq = (conversation.lastMessageSeq ?? 0) + 1;

      return conversation;
    },
  });

  ChatMessage.findOne = () => ({ lean: async () => null });

  ChatMessage.create = async (payload) => {
    const doc = {
      _id: id(),
      editVersion: 0,
      deletedAt: null,
      createdAt: new Date(),
      mentions: [],
      ...payload,
      toObject() {
        const { toObject, ...rest } = this;

        return rest;
      },
    };

    messages.push(doc);

    return doc;
  };

  User.find = trackedUserFind(capture);

  Notification.insertMany = async (rows) => {
    capture.notificationsCreated.push(...rows);
    notifications.push(...rows);

    return rows;
  };

  return {
    capture,
    restore: () => {
      ChatConversation.findOne = original.convFindOne;
      ChatConversation.findOneAndUpdate = original.convFindOneAndUpdate;
      ChatMessage.create = original.msgCreate;
      User.find = original.userFind;
      Notification.insertMany = original.notifInsertMany;
    },
  };
};

const seedConversation = ({ members, title = 'Design team' } = {}) => ({
  _id: id(),
  companyId: COMPANY_A,
  type: 'GROUP',
  title,
  members: members ?? [{ userId: ALICE }, { userId: BOB }],
  lastMessageSeq: 0,
  isDisabled: false,
});

const makeIo = (broadcasts) => ({
  to: (room) => ({ emit: (event, payload) => broadcasts.push({ room, event, payload }) }),
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

// ══════════════════════════════════════════════════════════════════════════
// 1. The pure rules
// ══════════════════════════════════════════════════════════════════════════

test('the mention token is derived from the name, whitespace-collapsed and bounded', () => {
  assert.equal(mentionTokenFor('Alice Rao'), '@Alice Rao');
  assert.equal(mentionTokenFor('  Alice   Rao  '), '@Alice Rao', 'internal runs collapse');
  assert.equal(mentionTokenFor(''), null);
  assert.equal(mentionTokenFor(null), null);
  assert.equal(mentionTokenFor('x'.repeat(400)).length, 120);
});

test('the visibility check is literal and case-sensitive', () => {
  assert.equal(tokenAppearsInText('hi @Alice Rao how are you', '@Alice Rao'), true);
  assert.equal(tokenAppearsInText('hi @alice rao', '@Alice Rao'), false, 'case matters');
  assert.equal(tokenAppearsInText('hi Alice Rao', '@Alice Rao'), false, 'the @ matters');
  assert.equal(tokenAppearsInText('anything', null), false);
});

test('the wire shape is checked before anything else: list of ObjectIds, capped, deduped', () => {
  const a = String(id());
  const b = String(id());

  assert.deepEqual(parseMentionIds(undefined), { ok: true, ids: [] });
  assert.deepEqual(parseMentionIds(null), { ok: true, ids: [] });
  assert.deepEqual(parseMentionIds([a, a, b]), { ok: true, ids: [a, b] }, 'duplicates collapse');

  assert.equal(parseMentionIds('not-a-list').ok, false);
  assert.equal(parseMentionIds([a, 'nope']).ok, false);

  const tooMany = parseMentionIds(Array.from({ length: CHAT_MENTION_MAX_PER_MESSAGE + 1 }, () => String(id())));

  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /at most 10 people/);
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Send path — storing, refusing, dropping
// ══════════════════════════════════════════════════════════════════════════

test('a mention of a member is stored with the server-derived token', async () => {
  const conversation = seedConversation({});
  const fake = installFakes({ conversation });

  try {
    const stored = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'm-1',
      text: 'ping @Bob Iyer please review',
      mentionUserIds: [String(BOB)],
    });

    assert.equal(stored.ok, true);
    assert.equal(stored.message.mentions.length, 1);
    assert.equal(same(stored.message.mentions[0].userId, BOB), true);
    assert.equal(stored.message.mentions[0].token, '@Bob Iyer');
  } finally {
    fake.restore();
  }
});

test('an unknown id, ANOTHER TENANT, and a non-member each refuse the whole send', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] });
  const fake = installFakes({ conversation, messages: [] });

  try {
    const cases = [
      [String(id()), 'unknown id'],
      [String(MALLORY), 'another tenant user'],
      [String(CAROL), 'company colleague who is NOT in this conversation'],
    ];

    for (const [userId, why] of cases) {
      const result = await sendTextMessage({
        companyId: COMPANY_A,
        senderUserId: ALICE,
        conversationId: conversation._id,
        clientMessageId: `refuse-${why}`,
        text: 'hello @someone',
        mentionUserIds: [userId],
      });

      assert.equal(result.ok, false, `${why} must be refused`);
      assert.equal(result.code, 'VALIDATION_ERROR');
    }

    // …and the non-member/other-tenant refusals say which rule was broken
    // without revealing whether the id exists.
    const nonMember = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'refuse-msg',
      text: 'hello @Carol Menon',
      mentionUserIds: [String(CAROL)],
    });

    assert.equal(nonMember.message, CHAT_MENTION_MESSAGES.NOT_A_MEMBER);

    assert.equal(fake.capture.notificationsCreated.length, 0, 'a refused send notifies nobody');
  } finally {
    fake.restore();
  }
});

test('an invisible mention is DROPPED while the message still sends', async () => {
  const conversation = seedConversation({});
  const fake = installFakes({ conversation, messages: [] });

  try {
    const stored = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'invisible-1',
      text: 'no token here at all',
      mentionUserIds: [String(BOB)],
    });

    assert.equal(stored.ok, true, 'the message is not lost because a mention was invisible');
    assert.deepEqual(stored.message.mentions, [], 'and nothing invisible is stored');
    assert.equal(fake.capture.notificationsCreated.length, 0, 'so nobody is silently pinged');
  } finally {
    fake.restore();
  }
});

test('the service re-checks the cap even when the edge was bypassed', async () => {
  const conversation = seedConversation({});
  const fake = installFakes({ conversation });

  try {
    const result = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'cap-1',
      text: 'hello everyone',
      mentionUserIds: Array.from({ length: CHAT_MENTION_MAX_PER_MESSAGE + 1 }, () => String(id())),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'VALIDATION_ERROR');
    assert.match(result.message, /at most 10 people/);
  } finally {
    fake.restore();
  }
});

test('an ordinary send does no mention work at all — not even a query', async () => {
  const conversation = seedConversation({});
  const fake = installFakes({ conversation });

  try {
    const stored = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'plain-1',
      text: 'no mentions here',
    });

    assert.equal(stored.ok, true);
    assert.deepEqual(stored.message.mentions, []);
    assert.equal(
      fake.capture.userQueries.length,
      0,
      'zero extra queries when nobody was mentioned'
    );
    assert.equal(fake.capture.notificationsCreated.length, 0);
  } finally {
    fake.restore();
  }
});

test('a FILE caption can mention people too', async () => {
  const conversation = seedConversation({});
  const fake = installFakes({ conversation });

  try {
    const stored = await sendFileMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'file-1',
      attachments: [
        { attachmentId: id(), fileName: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
      ],
      text: 'for @Bob Iyer',
      mentionUserIds: [String(BOB)],
    });

    assert.equal(stored.ok, true);
    assert.equal(stored.message.mentions[0].token, '@Bob Iyer');
    assert.equal(fake.capture.notificationsCreated.length, 1);
  } finally {
    fake.restore();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Notifications — in-app only, private payload, exactly once
// ══════════════════════════════════════════════════════════════════════════

test('every mentioned member is notified in ONE batch, the actor is excluded, and NO message text is copied', async () => {
  const conversation = seedConversation({
    members: [{ userId: ALICE }, { userId: BOB }],
    title: 'Design team',
  });
  const fake = installFakes({ conversation, messages: [] });

  const body = 'secret-body @Bob Iyer @Alice Rao look';

  try {
    const stored = await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'notify-1',
      text: body,
      // Self-mention included on purpose: it must be stored, but never notify.
      mentionUserIds: [String(BOB), String(ALICE)],
    });

    assert.equal(stored.ok, true);
    assert.equal(stored.message.mentions.length, 2, 'both mentions are stored, including mine');

    const created = fake.capture.notificationsCreated;

    assert.equal(created.length, 1, 'one recipient: the actor is excluded');
    assert.equal(same(created[0].user, BOB), true);
    assert.equal(created[0].companyId.toString(), COMPANY_A.toString(), 'tenant-scoped');
    assert.equal(created[0].type, 'CHAT');
    assert.equal(created[0].title, 'You were mentioned in chat');
    assert.match(created[0].message, /Alice Rao mentioned you in "Design team"/);
    assert.equal(created[0].link, `/app/chat/${conversation._id}`, 'opens the message');

    // THE PRIVACY PIN: no fragment of the body may live in the notification.
    const serialized = JSON.stringify(created);

    assert.equal(serialized.includes('secret-body'), false, 'never the message text');
    assert.equal(serialized.includes('@Bob Iyer'), false, 'not even the mention token');
  } finally {
    fake.restore();
  }
});

test('a DIRECT conversation is named without leaking a title it does not have', async () => {
  const conversation = { ...seedConversation({}), type: 'DIRECT', title: null };
  const fake = installFakes({ conversation });

  try {
    await sendTextMessage({
      companyId: COMPANY_A,
      senderUserId: ALICE,
      conversationId: conversation._id,
      clientMessageId: 'direct-1',
      text: 'hey @Bob Iyer',
      mentionUserIds: [String(BOB)],
    });

    assert.match(fake.capture.notificationsCreated[0].message, /a direct message/);
  } finally {
    fake.restore();
  }
});

test('a retried send notifies ONCE and keeps the stored mentions', async () => {
  const conversation = seedConversation({});
  const messages = [];
  const fake = installFakes({ conversation, messages });

  const payload = {
    companyId: COMPANY_A,
    senderUserId: ALICE,
    conversationId: conversation._id,
    clientMessageId: 'retry-1',
    text: 'ping @Bob Iyer',
    mentionUserIds: [String(BOB)],
  };

  try {
    const first = await sendTextMessage(payload);

    // The retry sees the stored row (the idempotency pre-check), so the second
    // call must return it without writing — and therefore without notifying.
    ChatMessage.findOne = () => ({ lean: async () => messages[0] });

    const second = await sendTextMessage(payload);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(messages.length, 1, 'one stored message');
    assert.equal(
      fake.capture.notificationsCreated.length,
      1,
      'exactly one notification for one logical message'
    );
    assert.equal(second.message.mentions[0].token, '@Bob Iyer', 'the stored mention survives');
  } finally {
    fake.restore();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 4. Socket surface
// ══════════════════════════════════════════════════════════════════════════

test('a malformed mentions field is refused at the edge, before any service call', async () => {
  const calls = [];

  const socket = makeSocket({});

  registerChatSocketHandlers({
    io: makeIo([]),
    socket,
    log: { error: () => {} },
    limitRate: async () => ({ limited: false }),
    sendMessage: async (payload) => {
      calls.push(payload);

      return { ok: true, created: false, message: { _id: id(), seq: 1 }, replyTo: null };
    },
  });

  for (const bad of ['not-a-list', [123], Array.from({ length: 11 }, () => String(id()))]) {
    const result = await socket.trigger('chat:message:send', {
      conversationId: String(id()),
      clientMessageId: 'edge-1',
      text: 'hello',
      mentions: bad,
    });

    assert.equal(result.ok, false, `${JSON.stringify(bad).slice(0, 24)}… must be refused`);
    assert.equal(result.code, 'VALIDATION_ERROR');
  }

  assert.equal(calls.length, 0, 'the service is never reached');
});

test('the socket forwards the ids and the broadcast + ACK carry the stored mentions', async () => {
  const conversation = seedConversation({});
  const messages = [];
  const broadcasts = [];
  const fake = installFakes({ conversation, messages });

  try {
    const socket = makeSocket({});

    registerChatSocketHandlers({
      io: makeIo(broadcasts),
      socket,
      log: { error: () => {} },
      limitRate: async () => ({ limited: false }),
    });

    const ack = await socket.trigger('chat:message:send', {
      conversationId: String(conversation._id),
      clientMessageId: 'sock-1',
      text: 'review please @Bob Iyer',
      mentions: [String(BOB)],
    });

    assert.equal(ack.ok, true);
    assert.equal(same(ack.data.message.mentions[0].userId, BOB), true);
    assert.equal(ack.data.message.mentions[0].token, '@Bob Iyer');

    const created = broadcasts.find((entry) => entry.event === 'chat:message:created');

    assert.ok(created, 'the room hears about it');
    assert.equal(created.room, conversationRoom(conversation._id));
    assert.deepEqual(
      Object.keys(created.payload.message.mentions[0]).sort(),
      ['token', 'userId'],
      'the projection is exactly { userId, token } — no user document, no PII'
    );
    assert.equal(
      JSON.stringify(created.payload.message.mentions).includes('@Bob Iyer'),
      true,
      'the token is the visible fragment the reader already sees in the body'
    );
    assert.equal(
      JSON.stringify(created.payload.message.mentions).includes('Bob Iyer@'),
      false,
      'and nothing else about the user rides along'
    );
  } finally {
    fake.restore();
  }
});

test('a refused mention reaches the sender as the RULE, not as a retry hint', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }] });
  const messages = [];
  const fake = installFakes({ conversation, messages });
  const socket = makeSocket({});

  try {
    registerChatSocketHandlers({
      io: makeIo([]),
      socket,
      log: { error: () => {} },
      limitRate: async () => ({ limited: false }),
    });

    const ack = await socket.trigger('chat:message:send', {
      conversationId: String(conversation._id),
      clientMessageId: 'sock-refuse',
      text: '@Bob Iyer are you there',
      mentions: [String(BOB)],
    });

    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'VALIDATION_ERROR', 'not RETRYABLE — the caller can fix it');
    assert.equal(ack.message, CHAT_MENTION_MESSAGES.NOT_A_MEMBER);
    assert.equal(messages.length, 0, 'nothing was written');
  } finally {
    fake.restore();
  }
});

test('the validator normalizes the payload and the projectors agree on the shape', async () => {
  const parsed = validateSendPayload({
    conversationId: String(id()),
    clientMessageId: 'c1',
    text: 'hi @Bob Iyer',
    mentions: [String(BOB), String(BOB)],
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.mentions, [String(BOB)], 'deduped at the edge');

  const omitted = validateSendPayload({
    conversationId: String(id()),
    clientMessageId: 'c2',
    text: 'no mentions',
  });

  assert.deepEqual(omitted.mentions, [], 'absent means none, never undefined');

  // The history projection mirrors the broadcast projection exactly.
  const projected = sanitizeMessageForHistory({
    _id: id(),
    seq: 3,
    senderUserId: ALICE,
    type: 'TEXT',
    text: 'hi @Bob Iyer',
    attachments: [],
    editVersion: 0,
    deletedAt: null,
    createdAt: new Date(),
    mentions: [{ userId: BOB, token: '@Bob Iyer' }],
  });

  assert.deepEqual(projected.mentions, [{ userId: BOB, token: '@Bob Iyer' }]);

  const tombstone = sanitizeMessageForHistory({
    _id: id(),
    seq: 4,
    senderUserId: ALICE,
    type: 'TEXT',
    text: null,
    attachments: [],
    editVersion: 0,
    deletedAt: new Date(),
    createdAt: new Date(),
  });

  assert.deepEqual(tombstone.mentions, [], 'a deleted message mentions nobody');
});

test('the model keeps the mention rows bounded and refuses surveillance-shaped fields', () => {
  const path = ChatMessage.schema.path('mentions');

  assert.ok(path, 'mentions must exist');
  assert.equal(path.options.default?.length ?? path.options.default, 0, 'defaults to an empty list');

  const inner = path.schema ?? path.casterConstructor?.schema;

  assert.ok(inner, 'mentions is a subdocument array');
  assert.equal(inner.path('userId').isRequired, true, 'a mention always names a user');
  assert.equal(inner.path('userId').options.ref, 'User');
  assert.equal(inner.path('token').options.maxlength, 120, 'the token is bounded');
  assert.equal(inner.options._id, false, 'no per-row id noise');

  for (const forbidden of ['mentionSeenAt', 'mentionReadAt', 'lastMentionedAt']) {
    assert.equal(ChatMessage.schema.path(forbidden), undefined, `${forbidden} must not exist`);
  }
});

test('resolving is one tenant-scoped query, and it never sees another company', async () => {
  const conversation = seedConversation({ members: [{ userId: MALLORY }] });
  const capture = { userQueries: [] };
  const findUsers = trackedUserFind(capture);

  // Mallory is a MEMBER of this (fixture) conversation, but belongs to company
  // B: the tenant filter in the query is what must refuse her.
  const result = await resolveMentions({
    companyId: COMPANY_A,
    conversation,
    text: 'hello @Mallory Sen',
    mentionUserIds: [String(MALLORY)],
    actorUserId: ALICE,
    findUsers,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'VALIDATION_ERROR');
  assert.equal(capture.userQueries.length, 1, 'exactly one lookup');
  assert.equal(String(capture.userQueries[0].companyId), String(COMPANY_A), 'tenant-scoped');
});
