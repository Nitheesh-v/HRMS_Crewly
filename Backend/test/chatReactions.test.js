// ============================================================
//  PHASE 34.1 — MESSAGE REACTIONS (HERMETIC).
//
//  No Mongo, no Redis, no socket.io-client. The REAL socket handlers
//  (chatSocketHandlers.js) and the REAL service (chatReactionService.js) run
//  against in-memory fakes of the ChatConversation / ChatMessage /
//  ChatMessageReaction statics (the repo pattern from chatEditDelete.test.js),
//  with a mock socket + mock io capturing broadcasts.
//
//  Pinned behaviour:
//    · react adds one row, ACKs with the actor's own state, broadcasts once
//      with a VIEWER-NEUTRAL summary ({type,count}) + who changed what
//    · reacting twice with the same type is idempotent: one row, no second
//      broadcast, changed:false, ACK still carries the truth
//    · a different type REPLACES the previous one (per-user cap = 1)
//    · unreact removes, broadcasts REMOVED, and is idempotent when there was
//      nothing to remove
//    · non-members, other tenants, disabled conversations and tombstoned
//      messages are all refused, with nothing written and nothing broadcast
//    · unknown reaction types are refused at the EDGE (validator), before any
//      DB work
//    · the per-message ceiling refuses and rolls its own row back
//    · react AND unreact share one identity budget ('message.react')
//    · history carries [{type,count,mine}] — viewer-aware, empty for tombstones
//    · the UI/slice/client pins that keep the feature wired end to end
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_reactions';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import ChatMessageReaction, {
  CHAT_REACTION_MAX_PER_MESSAGE,
  CHAT_REACTION_TYPES,
} from '../src/models/ChatMessageReaction.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';
import { conversationRoom } from '../src/utils/chatKeys.js';
import { sanitizeMessageForHistory } from '../src/services/chat/chatService.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

const readSource = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');

const COMPANY_A = id();
const COMPANY_B = id();
const ALICE = id();
const BOB = id();
const MALLORY = id(); // company B

const same = (a, b) => String(a) === String(b);

// ── in-memory fakes ───────────────────────────────────────────────────────

const installFakes = ({ conversations, messages, reactions }) => {
  const original = {
    convFindOne: ChatConversation.findOne,
    msgFindOne: ChatMessage.findOne,
    reactFind: ChatMessageReaction.find,
    reactUpdateOne: ChatMessageReaction.updateOne,
    reactDeleteMany: ChatMessageReaction.deleteMany,
    reactDeleteOne: ChatMessageReaction.deleteOne,
    reactCount: ChatMessageReaction.countDocuments,
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

  // The service reads exactly one field: `deletedAt` (via .select(...).lean()).
  ChatMessage.findOne = (filter) => ({
    select: () => ({
      lean: async () =>
        messages.find(
          (doc) =>
            (!filter._id || same(doc._id, filter._id)) &&
            same(doc.companyId, filter.companyId) &&
            same(doc.conversationId, filter.conversationId)
        ) ?? null,
    }),
  });

  // Chainable like mongoose: find(filter).select(...)[.limit(n)].lean()
  ChatMessageReaction.find = (filter = {}) => {
    const query = {
      select: () => query,
      limit: () => query,
      lean: async () => {
        const ids = filter.messageId?.$in;

        return reactions.filter((row) => {
          if (filter.companyId && !same(row.companyId, filter.companyId)) return false;
          if (filter.messageId && !ids && !same(row.messageId, filter.messageId)) return false;
          if (ids && !ids.some((entry) => same(entry, row.messageId))) return false;
          if (filter.userId && !same(row.userId, filter.userId)) return false;
          if (filter.reactionType && !same(row.reactionType, filter.reactionType)) return false;
          return true;
        });
      },
    };

    return query;
  };

  ChatMessageReaction.updateOne = async (filter, update = {}) => {
    const existing = reactions.find(
      (row) =>
        same(row.companyId, filter.companyId) &&
        same(row.messageId, filter.messageId) &&
        same(row.userId, filter.userId) &&
        same(row.reactionType, filter.reactionType)
    );

    if (existing) return { matchedCount: 1, upsertedCount: 0 };

    reactions.push({
      _id: id(),
      companyId: filter.companyId,
      messageId: filter.messageId,
      userId: filter.userId,
      reactionType: filter.reactionType,
      conversationId: update.$setOnInsert?.conversationId ?? null,
    });

    return { matchedCount: 0, upsertedCount: 1 };
  };

  ChatMessageReaction.deleteMany = async (filter) => {
    const keep = reactions.filter((row) => {
      const matches =
        same(row.companyId, filter.companyId) &&
        same(row.messageId, filter.messageId) &&
        same(row.userId, filter.userId);

      if (!matches) return true;
      // $ne support: the service drops the user's OTHER types on a replace.
      if (filter.reactionType?.$ne !== undefined) {
        return same(row.reactionType, filter.reactionType.$ne);
      }
      if (filter.reactionType !== undefined) {
        return !same(row.reactionType, filter.reactionType);
      }

      return false;
    });

    const deletedCount = reactions.length - keep.length;

    reactions.length = 0;
    reactions.push(...keep);

    return { deletedCount };
  };

  ChatMessageReaction.deleteOne = async (filter) => {
    const index = reactions.findIndex(
      (row) =>
        same(row.companyId, filter.companyId) &&
        same(row.messageId, filter.messageId) &&
        same(row.userId, filter.userId) &&
        same(row.reactionType, filter.reactionType)
    );

    if (index < 0) return { deletedCount: 0 };

    reactions.splice(index, 1);

    return { deletedCount: 1 };
  };

  ChatMessageReaction.countDocuments = async (filter) =>
    reactions.filter(
      (row) =>
        same(row.companyId, filter.companyId) && same(row.messageId, filter.messageId)
    ).length;

  return () => {
    ChatConversation.findOne = original.convFindOne;
    ChatMessage.findOne = original.msgFindOne;
    ChatMessageReaction.find = original.reactFind;
    ChatMessageReaction.updateOne = original.reactUpdateOne;
    ChatMessageReaction.deleteMany = original.reactDeleteMany;
    ChatMessageReaction.deleteOne = original.reactDeleteOne;
    ChatMessageReaction.countDocuments = original.reactCount;
  };
};

// ── mocks + seeds ─────────────────────────────────────────────────────────

const makeSocket = ({ companyId, userId }) => {
  const handlers = {};

  return {
    id: `sock-${Math.random().toString(36).slice(2, 8)}`,
    data: companyId === null ? {} : { companyId, userId },
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

const makeIo = (broadcasts) => ({
  to: (room) => ({
    emit: (event, payload) => {
      broadcasts.push({ room, event, payload });
    },
  }),
});

const quiet = { error: () => {}, warn: () => {} };

const seedConversation = ({ companyId = COMPANY_A, members, isDisabled = false } = {}) => ({
  _id: id(),
  companyId,
  type: 'GROUP',
  title: 'Design',
  members: members ?? [{ userId: ALICE }, { userId: BOB }],
  lastMessageSeq: 0,
  isDisabled,
});

const seedMessage = ({ conversation, sender = ALICE, deletedAt = null, text = 'hello' }) => ({
  _id: id(),
  companyId: conversation.companyId,
  conversationId: conversation._id,
  senderUserId: sender,
  seq: 1,
  clientMessageId: 'seed-1',
  type: 'TEXT',
  text,
  editVersion: 0,
  deletedAt,
  createdAt: new Date(),
});

const seedReaction = ({ conversation, message, userId, reactionType = 'LIKE' }) => ({
  _id: id(),
  companyId: conversation.companyId,
  conversationId: conversation._id,
  messageId: message._id,
  userId,
  reactionType,
});

/**
 * Wire one socket with the real handlers. `limited` optionally forces the
 * rate limiter's verdict so the gate itself can be asserted.
 */
const wire = ({ companyId = COMPANY_A, userId = ALICE, broadcasts, limitRate }) => {
  const socket = makeSocket({ companyId, userId });

  registerChatSocketHandlers({
    io: makeIo(broadcasts),
    socket,
    log: quiet,
    limitRate: limitRate ?? (async ({ action }) => ({ limited: false, action })),
  });

  return socket;
};

const reactionBroadcasts = (broadcasts) =>
  broadcasts.filter((entry) => entry.event === 'chat:message:reactionsUpdated');

// ── 1. the happy path ─────────────────────────────────────────────────────

test('reacting adds one row, broadcasts once with a viewer-neutral summary, and ACKs the actor own state', async () => {
  const conversation = seedConversation({});
  const message = seedMessage({ conversation });
  const reactions = [];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ broadcasts });

    const result = await socket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'LIKE',
    });

    assert.equal(result.ok, true, 'the reaction is accepted');
    assert.equal(result.data.myReaction, 'LIKE', 'the actor learns its own state from the ACK');
    assert.equal(result.data.changed, true);
    assert.deepEqual(result.data.reactions, [{ type: 'LIKE', count: 1, mine: true }]);

    assert.equal(reactions.length, 1, 'exactly one row');
    assert.equal(
      same(reactions[0].conversationId, conversation._id),
      true,
      'the row is bound to the conversation'
    );

    const emitted = reactionBroadcasts(broadcasts);

    assert.equal(emitted.length, 1, 'exactly one broadcast');
    assert.equal(emitted[0].room, conversationRoom(conversation._id));
    assert.equal(same(emitted[0].payload.messageId, message._id), true);
    assert.equal(same(emitted[0].payload.actorUserId, ALICE), true);
    assert.equal(emitted[0].payload.action, 'ADDED');
    assert.deepEqual(
      emitted[0].payload.reactions,
      [{ type: 'LIKE', count: 1 }],
      'the room gets counts only — one frame cannot carry a different mine per member'
    );
    assert.equal(
      JSON.stringify(emitted[0].payload).includes('mine'),
      false,
      'mine never rides the room broadcast'
    );
  } finally {
    restore();
  }
});

test('reacting twice with the same type is idempotent — no second row, no second broadcast', async () => {
  const conversation = seedConversation({});
  const message = seedMessage({ conversation });
  const reactions = [];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ broadcasts });

    const payload = { conversationId: conversation._id, messageId: message._id, reactionType: 'LIKE' };

    const first = await socket.trigger('chat:message:react', payload);
    const second = await socket.trigger('chat:message:react', payload);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true, 'a retried reaction is success, not a conflict');
    assert.equal(second.data.changed, false, 'nothing changed the second time');
    assert.equal(second.data.myReaction, 'LIKE');
    assert.equal(reactions.length, 1, 'still one row (the unique index is the guarantee)');
    assert.equal(reactionBroadcasts(broadcasts).length, 1, 'an idempotent retry must not re-emit');
  } finally {
    restore();
  }
});

test('a different type replaces the previous one (per-user cap of one)', async () => {
  const conversation = seedConversation({});
  const message = seedMessage({ conversation });
  const reactions = [];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ broadcasts });

    await socket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'LIKE',
    });

    const replaced = await socket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'HEART',
    });

    assert.equal(replaced.ok, true);
    assert.equal(reactions.length, 1, 'one user never holds two reactions on one message');
    assert.equal(reactions[0].reactionType, 'HEART', 'the new type won');
    assert.deepEqual(replaced.data.reactions, [{ type: 'HEART', count: 1, mine: true }]);

    const emitted = reactionBroadcasts(broadcasts);

    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].payload.action, 'REPLACED', 'the room is told it was a replacement');
    assert.equal(emitted[1].payload.reactionType, 'HEART');
  } finally {
    restore();
  }
});

test('several users group under one type and the summary is ordered by the fixed vocabulary', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] });
  const message = seedMessage({ conversation });
  const reactions = [];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const alice = wire({ userId: ALICE, broadcasts });
    const bob = wire({ userId: BOB, broadcasts });

    await alice.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'HEART',
    });

    const second = await bob.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'LIKE',
    });

    assert.deepEqual(
      second.data.reactions.map((entry) => [entry.type, entry.count]),
      [['LIKE', 1], ['HEART', 1]],
      'ordered LIKE before HEART (vocabulary order), each with its own count'
    );

    assert.deepEqual(
      second.data.reactions.map((entry) => entry.mine),
      [true, false],
      'mine is per-viewer: Bob sees his own LIKE as his, not Alice heart'
    );
  } finally {
    restore();
  }
});

// ── 2. unreact ────────────────────────────────────────────────────────────

test('unreact removes the row, broadcasts REMOVED, and a second unreact is a silent no-op', async () => {
  const conversation = seedConversation({});
  const message = seedMessage({ conversation });
  const reactions = [seedReaction({ conversation, message, userId: ALICE, reactionType: 'LIKE' })];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ broadcasts });

    const payload = { conversationId: conversation._id, messageId: message._id, reactionType: 'LIKE' };

    const removed = await socket.trigger('chat:message:unreact', payload);

    assert.equal(removed.ok, true);
    assert.equal(removed.data.changed, true);
    assert.equal(removed.data.myReaction, null, 'the actor holds nothing afterwards');
    assert.deepEqual(removed.data.reactions, [], 'the count is gone, not zeroed');
    assert.equal(reactions.length, 0);

    const emitted = reactionBroadcasts(broadcasts);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].payload.action, 'REMOVED');
    assert.deepEqual(emitted[0].payload.reactions, []);

    const again = await socket.trigger('chat:message:unreact', payload);

    assert.equal(again.ok, true, 'removing what is not there is still success');
    assert.equal(again.data.changed, false);
    assert.equal(reactionBroadcasts(broadcasts).length, 1, 'and never re-broadcasts');
  } finally {
    restore();
  }
});

// ── 3. refusals (membership, tenant, state, vocabulary) ───────────────────

test('a non-member of the conversation is refused, and nothing is written or broadcast', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }] });
  const message = seedMessage({ conversation });
  const reactions = [];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ userId: BOB, broadcasts });

    const result = await socket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'LIKE',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND_OR_FORBIDDEN', 'never confirm the conversation exists');
    assert.equal(reactions.length, 0);
    assert.equal(broadcasts.length, 0);
  } finally {
    restore();
  }
});

test('a user from another tenant cannot react even with a valid conversation id', async () => {
  const conversation = seedConversation({});
  const message = seedMessage({ conversation });
  const reactions = [];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ companyId: COMPANY_B, userId: MALLORY, broadcasts });

    const result = await socket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'LIKE',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND_OR_FORBIDDEN');
    assert.equal(reactions.length, 0, 'tenant isolation holds — no row, no leak');
  } finally {
    restore();
  }
});

test('a disabled conversation refuses reactions (a reaction is a write)', async () => {
  const conversation = seedConversation({ isDisabled: true });
  const message = seedMessage({ conversation });
  const reactions = [];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ broadcasts });

    const result = await socket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'LIKE',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONVERSATION_DISABLED', 'history stays readable; writes are paused');
    assert.equal(reactions.length, 0);
    assert.equal(broadcasts.length, 0);
  } finally {
    restore();
  }
});

test('a tombstoned message refuses reactions (add and remove alike)', async () => {
  const conversation = seedConversation({});
  const message = seedMessage({ conversation, deletedAt: new Date() });
  const reactions = [];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ broadcasts });

    for (const event of ['chat:message:react', 'chat:message:unreact']) {
      const result = await socket.trigger(event, {
        conversationId: conversation._id,
        messageId: message._id,
        reactionType: 'LIKE',
      });

      assert.equal(result.ok, false, `${event} refused on a deleted message`);
      assert.equal(result.code, 'MESSAGE_DELETED');
    }

    assert.equal(reactions.length, 0);
    assert.equal(broadcasts.length, 0);
  } finally {
    restore();
  }
});

test('an unsupported reaction type is refused at the edge, before any DB work', async () => {
  const conversation = seedConversation({});
  const message = seedMessage({ conversation });
  const reactions = [];
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ broadcasts });

    const result = await socket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'THUMBSDOWN',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'VALIDATION_ERROR');
    assert.match(result.message, /not supported/i);
    assert.equal(reactions.length, 0);
    assert.equal(broadcasts.length, 0);

    // The closed vocabulary is the model's, not the client's.
    assert.deepEqual(CHAT_REACTION_TYPES, ['LIKE', 'HEART', 'LAUGH', 'THANKS']);
  } finally {
    restore();
  }
});

// ── 4. the cap, the budget, and the viewer-aware history ──────────────────

test('the per-message ceiling refuses the write AND rolls its own row back', async () => {
  const conversation = seedConversation({});
  const message = seedMessage({ conversation });
  // The message is already at the ceiling: every slot is taken by another user.
  const reactions = Array.from({ length: CHAT_REACTION_MAX_PER_MESSAGE }, () => ({
    _id: id(),
    companyId: COMPANY_A,
    conversationId: conversation._id,
    messageId: message._id,
    userId: id(),
    reactionType: 'LIKE',
  }));
  const broadcasts = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({ broadcasts });

    const before = reactions.length;

    const result = await socket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'HEART',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'REACTION_LIMIT_REACHED');
    assert.equal(reactions.length, before, 'the refused row was rolled back, not left behind');
    assert.equal(broadcasts.length, 0);
  } finally {
    restore();
  }
});

test('react and unreact share ONE identity budget (message.react)', async () => {
  const conversation = seedConversation({});
  const message = seedMessage({ conversation });
  const reactions = [];
  const broadcasts = [];
  const seen = [];
  const restore = installFakes({ conversations: [conversation], messages: [message], reactions });

  try {
    const socket = wire({
      broadcasts,
      limitRate: async ({ action }) => {
        seen.push(action);

        return { limited: false };
      },
    });

    await socket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'LIKE',
    });

    await socket.trigger('chat:message:unreact', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'LIKE',
    });

    assert.deepEqual(seen, ['message.react', 'message.react']);

    // …and a refused budget stops the write before any service call.
    const limitedSocket = wire({
      broadcasts,
      limitRate: async () => ({ limited: true }),
    });

    const limited = await limitedSocket.trigger('chat:message:react', {
      conversationId: conversation._id,
      messageId: message._id,
      reactionType: 'LIKE',
    });

    assert.equal(limited.ok, false);
    assert.equal(limited.code, 'RATE_LIMITED');
    assert.equal(reactions.length, 0, 'a limited request never reaches Mongo');
  } finally {
    restore();
  }
});

test('history carries viewer-aware reactions, and a tombstone carries none', () => {
  const messageId = id();

  const live = sanitizeMessageForHistory(
    {
      _id: messageId, seq: 4, senderUserId: ALICE, type: 'TEXT', text: 'hi',
      attachments: [], editVersion: 0, deletedAt: null, createdAt: new Date(),
    },
    [{ type: 'LIKE', count: 2, mine: true }]
  );

  assert.deepEqual(live.reactions, [{ type: 'LIKE', count: 2, mine: true }]);

  // Default shape: a message nobody reacted to still carries the field, so the
  // renderer has exactly one shape to handle.
  const untouched = sanitizeMessageForHistory({
    _id: id(), seq: 5, senderUserId: ALICE, type: 'TEXT', text: 'yo',
    attachments: [], editVersion: 0, deletedAt: null, createdAt: new Date(),
  });

  assert.deepEqual(untouched.reactions, []);

  const tombstone = sanitizeMessageForHistory({
    _id: id(), seq: 6, senderUserId: ALICE, type: 'TEXT', text: 'gone',
    attachments: [], editVersion: 0, deletedAt: new Date(), createdAt: new Date(),
  });

  assert.deepEqual(tombstone.reactions, [], 'a deleted message shows no reactions');
});

test('a socket without a server-derived principal can never react', async () => {
  const broadcasts = [];
  const socket = makeSocket({ companyId: null, userId: null });

  registerChatSocketHandlers({ io: makeIo(broadcasts), socket, log: quiet });

  for (const event of ['chat:message:react', 'chat:message:unreact']) {
    const result = await socket.trigger(event, {
      conversationId: id(),
      messageId: id(),
      reactionType: 'LIKE',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'UNAUTHORIZED');
  }

  assert.equal(broadcasts.length, 0);
});

// ── 5. the pins that keep the feature wired end to end ────────────────────

test('the model declares the idempotency guarantee and the two ceilings', () => {
  const model = readSource('Backend/src/models/ChatMessageReaction.js');

  assert.match(model, /unique: true/, 'the per-user uniqueness is a database guarantee');
  assert.match(model, /CHAT_REACTION_MAX_PER_USER_PER_MESSAGE = 1/);
  assert.match(model, /CHAT_REACTION_MAX_PER_MESSAGE = 200/);
  assert.match(model, /immutable: true/, 'a reaction cannot be repointed');
  assert.ok(
    !/presence|typing|lastSeen/i.test(model.split('// ═══')[0] ?? ''),
    'a reaction is not presence'
  );

  const rateLimits = readSource('Backend/src/services/chat/chatRateLimitService.js');

  assert.match(rateLimits, /'message\.react': \{ event: 'chat:message:react'/, 'the budget is in the policy table');

  const errors = readSource('Backend/src/utils/chatErrors.js');

  assert.match(errors, /REACTION_LIMIT_REACHED/, 'the cap has a stable code');
});

test('the client can react, unreact, and apply the broadcast', () => {
  const client = readSource('Frontend/src/services/realtime/chatSocketClient.js');

  assert.match(client, /react: \(payload\) => ackOf\('chat:message:react'/, 'react is callable');
  assert.match(client, /unreact: \(payload\) => ackOf\('chat:message:unreact'/, 'unreact is callable');
  assert.match(client, /'chat:message:reactionsUpdated'/, 'the broadcast is listened to');
  assert.match(client, /reactionsUpdated\(/, 'and dispatched into the store');

  const slice = readSource('Frontend/src/redux/slices/chatSlice.js');

  assert.match(slice, /reactionsUpdated: \(state, action\)/, 'the slice owns the projection');
  assert.match(slice, /myReaction/, 'and applies the per-viewer flag');
});

test('the bubble renders the bar and the picker, with icons and no emoji input', () => {
  const bubble = readSource('Frontend/src/components/chat/MessageBubble.jsx');

  assert.match(bubble, /ReactionBar/, 'the bar is rendered under the bubble');
  assert.match(bubble, /ReactionPicker/, 'and the picker is available on the message');
  assert.match(bubble, /onReact/, 'the page owns the socket call');

  const picker = readSource('Frontend/src/components/chat/ReactionPicker.jsx');
  const icon = readSource('Frontend/src/components/chat/ReactionIcon.jsx');

  assert.match(picker, /CHAT_REACTION_TYPES/, 'the picker offers exactly the fixed vocabulary');
  assert.match(icon, /ThumbsUp|Heart|FaceGrinning|HandHeart/, 'reactions are drawn as icons');
  assert.ok(
    !/\p{Extended_Pictographic}/u.test(picker + icon),
    'no emoji characters anywhere in the reaction UI'
  );

  const page = readSource('Frontend/src/pages/chat/ChatPage.jsx');

  assert.match(page, /handleReact/, 'the page implements the toggle');
  assert.match(page, /chatRealtime\.react|chatRealtime\.unreact/, 'over the socket');
});

test('the phase 34 doc exists and documents this unit', () => {
  const doc = readSource('docs/PHASE_34_CHAT_ENHANCEMENTS.md');

  assert.match(doc, /34\.1/, 'the unit is documented');
  assert.match(doc, /chat:message:react/);
  assert.match(doc, /chat:message:reactionsUpdated/);
  assert.match(doc, /Localhost verification steps/i, 'every unit ships its manual checks');
  assert.match(doc, /Limitations/i);
});
