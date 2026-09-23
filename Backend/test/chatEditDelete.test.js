// ============================================================
//  PHASE 33.6 — CHAT MESSAGE EDIT + EDIT HISTORY + TOMBSTONE DELETE (HERMETIC).
//
//  No Redis, no HTTP, no socket.io-client. The real handlers
//  (chatSocketHandlers.js) and the real edit/delete service
//  (chatEditService.js) run against in-memory fakes of the
//  ChatConversation / ChatMessage / ChatMessageEdit statics (repo pattern
//  from chatSocketSend.test.js), with a mock socket + mock io capturing
//  broadcasts.
//
//  Pinned behaviour:
//    · sender edits own TEXT message: text updated, editVersion bumps,
//      one ChatMessageEdit row with previousText, one chat:message:updated
//    · expectedEditVersion mismatch -> CONFLICT_EDIT_VERSION, untouched
//    · non-member cannot edit; non-owner member cannot edit (sender-only)
//    · deleted message cannot be edited; SYSTEM message cannot be edited
//    · history cap (20) -> HISTORY_LIMIT_REACHED, refuse (no pruning)
//    · edit payload validation (expectedEditVersion integer, newText bounds)
//    · sender tombstones own message: deletedAt set, text nulled,
//      one chat:message:deleted
//    · delete is idempotent: second delete ok with same deletedAt, no
//      second broadcast
//    · non-member cannot delete; non-owner member cannot delete
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_edit';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import ChatMessageEdit from '../src/models/ChatMessageEdit.js';
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

const installFakes = ({ conversations, messages, edits }) => {
  const same = (a, b) => String(a) === String(b);

  const original = {
    convFindOne: ChatConversation.findOne,
    msgFindOne: ChatMessage.findOne,
    msgFindOneAndUpdate: ChatMessage.findOneAndUpdate,
    editCount: ChatMessageEdit.countDocuments,
    editCreate: ChatMessageEdit.create,
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

  ChatMessage.findOne = (filter) => ({
    lean: async () =>
      messages.find(
        (doc) =>
          (!filter._id || same(doc._id, filter._id)) &&
          same(doc.companyId, filter.companyId) &&
          same(doc.conversationId, filter.conversationId)
      ) ?? null,
  });

  // Honours the two atomic-update shapes the service issues:
  //   edit   : filter carries editVersion + deletedAt:null + type
  //   delete : filter carries deletedAt:null
  ChatMessage.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const doc = messages.find(
        (entry) =>
          same(entry._id, filter._id) &&
          same(entry.companyId, filter.companyId) &&
          same(entry.conversationId, filter.conversationId)
      );

      if (!doc) return null;
      if (filter.editVersion !== undefined && doc.editVersion !== filter.editVersion) return null;
      if (filter.deletedAt === null && doc.deletedAt) return null;
      if (filter.type && doc.type !== filter.type) return null;

      if (update.$inc?.editVersion) doc.editVersion += update.$inc.editVersion;

      if (update.$set) {
        for (const [key, value] of Object.entries(update.$set)) doc[key] = value;
      }

      return doc;
    },
  });

  ChatMessageEdit.countDocuments = async (filter) =>
    edits.filter(
      (row) => same(row.companyId, filter.companyId) && same(row.messageId, filter.messageId)
    ).length;

  ChatMessageEdit.create = async (payload) => {
    const dup = edits.find(
      (row) => same(row.messageId, payload.messageId) && row.version === payload.version
    );

    if (dup) {
      const error = new Error('E11000 duplicate key');
      error.code = 11000;
      throw error;
    }

    const row = { _id: id(), ...payload };
    edits.push(row);
    return row;
  };

  return () => {
    ChatConversation.findOne = original.convFindOne;
    ChatMessage.findOne = original.msgFindOne;
    ChatMessage.findOneAndUpdate = original.msgFindOneAndUpdate;
    ChatMessageEdit.countDocuments = original.editCount;
    ChatMessageEdit.create = original.editCreate;
  };
};

// ── mock socket + io ──────────────────────────────────────────────────────

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

const seedMessage = ({ conversation, sender, text = 'hello', type = 'TEXT', editVersion = 0, deletedAt = null }) => ({
  _id: id(),
  companyId: conversation.companyId,
  conversationId: conversation._id,
  senderUserId: sender,
  seq: 1,
  clientMessageId: 'seed-1',
  type,
  text,
  editVersion,
  editedAt: null,
  editedByUserId: null,
  deletedAt,
  deletedByUserId: null,
  createdAt: new Date(),
});

const quiet = { error: () => {} };

// ── edit ──────────────────────────────────────────────────────────────────

test('chat:message:edit updates text, bumps editVersion, appends history, broadcasts once', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] })];
  const messages = [seedMessage({ conversation: conversations[0], sender: ALICE, text: 'hello' })];
  const edits = [];
  const broadcasts = [];
  const restore = installFakes({ conversations, messages, edits });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo(broadcasts), socket, log: quiet });

    const result = await socket.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
      expectedEditVersion: 0,
      newText: 'hello, edited',
    });

    assert.equal(result.ok, true);
    assert.equal(messages[0].text, 'hello, edited', 'text replaced');
    assert.equal(messages[0].editVersion, 1, 'editVersion incremented atomically');
    assert.equal(String(messages[0].editedByUserId), String(ALICE));
    assert.ok(messages[0].editedAt, 'editedAt set');

    assert.equal(edits.length, 1, 'exactly one history row');
    assert.equal(edits[0].version, 1, 'history version = new editVersion');
    assert.equal(edits[0].previousText, 'hello', 'history keeps the replaced text');
    assert.equal(String(edits[0].editedByUserId), String(ALICE));

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].room, conversationRoom(conversations[0]._id));
    assert.equal(broadcasts[0].event, 'chat:message:updated');
    assert.equal(broadcasts[0].payload.newText, 'hello, edited');
    assert.equal(broadcasts[0].payload.editVersion, 1);
    assert.equal(String(broadcasts[0].payload.messageId), String(messages[0]._id));
    assert.equal(String(broadcasts[0].payload.editedByUserId), String(ALICE));

    assert.equal(result.data.message.editVersion, 1);
  } finally {
    restore();
  }
});

test('chat:message:edit with a stale expectedEditVersion returns CONFLICT_EDIT_VERSION untouched', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }] })];
  const messages = [seedMessage({ conversation: conversations[0], sender: ALICE, text: 'v0' })];
  const edits = [];
  const broadcasts = [];
  const restore = installFakes({ conversations, messages, edits });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo(broadcasts), socket, log: quiet });

    const result = await socket.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
      expectedEditVersion: 5, // message is at 0
      newText: 'nope',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONFLICT_EDIT_VERSION');
    assert.equal(messages[0].text, 'v0', 'message untouched');
    assert.equal(messages[0].editVersion, 0);
    assert.equal(edits.length, 0, 'no history row on conflict');
    assert.equal(broadcasts.length, 0, 'no broadcast on conflict');
  } finally {
    restore();
  }
});

test('chat:message:edit refused for non-member and for other tenant', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }] })];
  const messages = [seedMessage({ conversation: conversations[0], sender: ALICE })];
  const restore = installFakes({ conversations, messages, edits: [] });

  try {
    const stranger = makeSocket({ companyId: COMPANY_A, userId: BOB });
    registerChatSocketHandlers({ io: makeIo([]), socket: stranger, log: quiet });
    const denied = await stranger.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
      expectedEditVersion: 0,
      newText: 'sneak',
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'NOT_FOUND_OR_FORBIDDEN');

    const crossTenant = makeSocket({ companyId: COMPANY_B, userId: MALLORY });
    registerChatSocketHandlers({ io: makeIo([]), socket: crossTenant, log: quiet });
    const cross = await crossTenant.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
      expectedEditVersion: 0,
      newText: 'sneak',
    });
    assert.equal(cross.ok, false);
    assert.equal(cross.code, 'NOT_FOUND_OR_FORBIDDEN');
  } finally {
    restore();
  }
});

test('chat:message:edit refused for a member who is not the sender (sender-only)', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] })];
  const messages = [seedMessage({ conversation: conversations[0], sender: ALICE })];
  const restore = installFakes({ conversations, messages, edits: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: BOB });
    registerChatSocketHandlers({ io: makeIo([]), socket, log: quiet });

    const result = await socket.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
      expectedEditVersion: 0,
      newText: 'not yours',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'MESSAGE_NOT_EDITABLE');
  } finally {
    restore();
  }
});

test('chat:message:edit refused for a tombstoned message and for SYSTEM messages', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }] })];
  const deleted = seedMessage({ conversation: conversations[0], sender: ALICE, deletedAt: new Date(), text: null });
  const system = seedMessage({ conversation: conversations[0], sender: ALICE, type: 'SYSTEM', text: null });
  const restore = installFakes({ conversations, messages: [deleted, system], edits: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo([]), socket, log: quiet });

    const onDeleted = await socket.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: deleted._id,
      expectedEditVersion: 0,
      newText: 'revive',
    });
    assert.equal(onDeleted.ok, false);
    assert.equal(onDeleted.code, 'MESSAGE_DELETED');

    const onSystem = await socket.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: system._id,
      expectedEditVersion: 0,
      newText: 'rewrite',
    });
    assert.equal(onSystem.ok, false);
    assert.equal(onSystem.code, 'MESSAGE_NOT_EDITABLE');
  } finally {
    restore();
  }
});

test('chat:message:edit refuses beyond the history cap (20) with HISTORY_LIMIT_REACHED', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }] })];
  const messages = [seedMessage({ conversation: conversations[0], sender: ALICE, editVersion: 20 })];
  const edits = Array.from({ length: 20 }, (_, index) => ({
    _id: id(),
    companyId: COMPANY_A,
    conversationId: conversations[0]._id,
    messageId: messages[0]._id,
    version: index + 1,
    previousText: `old ${index}`,
    editedAt: new Date(),
    editedByUserId: ALICE,
  }));
  const restore = installFakes({ conversations, messages, edits });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo([]), socket, log: quiet });

    const result = await socket.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
      expectedEditVersion: 20,
      newText: 'one edit too many',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'HISTORY_LIMIT_REACHED');
    assert.equal(messages[0].editVersion, 20, 'refused, not pruned');
    assert.equal(edits.length, 20, 'no row added, none removed');
  } finally {
    restore();
  }
});

test('chat:message:edit payload validation rejects bad expectedEditVersion and empty text', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }] })];
  const messages = [seedMessage({ conversation: conversations[0], sender: ALICE })];
  const restore = installFakes({ conversations, messages, edits: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo([]), socket, log: quiet });

    const missingVersion = await socket.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
      newText: 'x',
    });
    assert.equal(missingVersion.ok, false);
    assert.equal(missingVersion.code, 'VALIDATION_ERROR');

    const negativeVersion = await socket.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
      expectedEditVersion: -1,
      newText: 'x',
    });
    assert.equal(negativeVersion.ok, false);
    assert.equal(negativeVersion.code, 'VALIDATION_ERROR');

    const emptyText = await socket.trigger('chat:message:edit', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
      expectedEditVersion: 0,
      newText: '   ',
    });
    assert.equal(emptyText.ok, false);
    assert.equal(emptyText.code, 'VALIDATION_ERROR');
  } finally {
    restore();
  }
});

// ── delete ────────────────────────────────────────────────────────────────

test('chat:message:delete tombstones own message and broadcasts once', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] })];
  const messages = [seedMessage({ conversation: conversations[0], sender: ALICE, text: 'bye', editVersion: 2 })];
  const broadcasts = [];
  const restore = installFakes({ conversations, messages, edits: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo(broadcasts), socket, log: quiet });

    const result = await socket.trigger('chat:message:delete', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
    });

    assert.equal(result.ok, true);
    assert.equal(String(result.data.messageId), String(messages[0]._id));
    assert.ok(result.data.deletedAt, 'deletedAt acknowledged');

    assert.ok(messages[0].deletedAt, 'tombstone set');
    assert.equal(String(messages[0].deletedByUserId), String(ALICE));
    assert.equal(messages[0].text, null, 'body redacted');
    assert.equal(messages[0].editVersion, 0, 'edit state reset by tombstone');
    assert.equal(messages[0].seq, 1, 'seq preserved for cursor stability');

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].event, 'chat:message:deleted');
    assert.equal(broadcasts[0].room, conversationRoom(conversations[0]._id));
    assert.equal(String(broadcasts[0].payload.messageId), String(messages[0]._id));
    assert.equal(String(broadcasts[0].payload.deletedByUserId), String(ALICE));
  } finally {
    restore();
  }
});

test('chat:message:delete is idempotent: second delete ok with same deletedAt, no re-broadcast', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }] })];
  const messages = [seedMessage({ conversation: conversations[0], sender: ALICE })];
  const broadcasts = [];
  const restore = installFakes({ conversations, messages, edits: [] });

  try {
    const socket = makeSocket({ companyId: COMPANY_A, userId: ALICE });
    registerChatSocketHandlers({ io: makeIo(broadcasts), socket, log: quiet });

    const first = await socket.trigger('chat:message:delete', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
    });
    const second = await socket.trigger('chat:message:delete', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(String(second.data.deletedAt), String(first.data.deletedAt));
    assert.equal(broadcasts.length, 1, 'retry must not re-broadcast');
  } finally {
    restore();
  }
});

test('chat:message:delete refused for non-member and for a member who is not the sender', async () => {
  const conversations = [seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] })];
  const messages = [seedMessage({ conversation: conversations[0], sender: ALICE })];
  const restore = installFakes({ conversations, messages, edits: [] });

  try {
    const stranger = makeSocket({ companyId: COMPANY_A, userId: MALLORY });
    registerChatSocketHandlers({ io: makeIo([]), socket: stranger, log: quiet });
    const denied = await stranger.trigger('chat:message:delete', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'NOT_FOUND_OR_FORBIDDEN');

    const otherMember = makeSocket({ companyId: COMPANY_A, userId: BOB });
    registerChatSocketHandlers({ io: makeIo([]), socket: otherMember, log: quiet });
    const notYours = await otherMember.trigger('chat:message:delete', {
      conversationId: conversations[0]._id,
      messageId: messages[0]._id,
    });
    assert.equal(notYours.ok, false);
    assert.equal(notYours.code, 'MESSAGE_NOT_EDITABLE');
    assert.equal(messages[0].deletedAt, null, 'message untouched');
  } finally {
    restore();
  }
});
