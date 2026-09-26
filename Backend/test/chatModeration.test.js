// ============================================================
//  PHASE 33.9 — CHAT MODERATION + ADMIN CONTROLS (HERMETIC).
//
//  No Redis, no HTTP, no socket.io-client, no Mongo. The real services
//  (chatModerationService.js, chatEditService.js, chatService.js), the real
//  socket handlers (chatSocketHandlers.js) and the real permission registry
//  run against in-memory fakes of the User / ChatConversation /
//  ChatMessage / AuditLog statics (repo pattern: chatEditDelete.test.js).
//
//  Pinned behaviour:
//    · catalogue: CHAT resource + MODERATE / GROUP_MANAGE actions, version 37
//    · role matrix: COMPANY_ADMIN and HR_MANAGER hold both; MANAGER holds
//      CHAT_MODERATE only; EMPLOYEE holds neither
//    · non-moderator cannot disable / enable / moderate-delete (403)
//    · moderator can disable (audit CHAT_CONVERSATION_DISABLED), enable
//      (CHAT_CONVERSATION_ENABLED); idempotent repeat writes NO audit row
//    · cross-tenant conversation is a 404, never a leak
//    · reason is bounded to 200 chars; audit carries no message text
//    · moderator tombstone-delete of ANOTHER member's message succeeds and
//      is audited once (CHAT_MESSAGE_MODERATED_DELETE); idempotent retry
//      reports changed:false and audits nothing new
//    · socket delete fallback: sender-only refusal is overturned ONLY for a
//      CHAT_MODERATE socket, and the broadcast still goes out; a
//      non-moderator keeps the refusal
//    · disabled conversation refuses send, EDIT and DELETE for a member
//      (CONVERSATION_DISABLED); a CHAT_MODERATE socket may still delete inside
//      it (the lock is aimed at members, not at moderation)
//    · membership invariants: last admin cannot be removed, a 2-member group
//      cannot be emptied; CHAT_GROUP_MANAGE widens (never narrows) the
//      in-group ADMIN rule
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_moderation';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import AuditLog from '../src/models/AuditLog.js';
import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import User from '../src/models/User.js';
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLE_MATRIX,
  ACTIONS,
  RESOURCES,
} from '../src/utils/permissionRegistry.js';
import { getSystemPermissionVersion } from '../src/utils/permissionService.js';
import {
  CHAT_MODERATION_REASON_MAX,
  boundModerationReason,
  disableConversation,
  enableConversation,
  moderateDeleteMessage,
} from '../src/services/chat/chatModerationService.js';
import { addMembers, removeMember } from '../src/services/chat/chatService.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';
import { conversationRoom } from '../src/utils/chatKeys.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();

const COMPANY_A = id();
const COMPANY_B = id();
const ADMIN = id(); // moderator in company A
const MEMBER = id();
const OTHER = id();

// ── in-memory fakes ───────────────────────────────────────────────────────

const same = (a, b) => String(a) === String(b);

const installFakes = ({ conversations = [], messages = [], users = [] }) => {
  const audits = [];
  const updates = [];

  const original = {
    convFindOne: ChatConversation.findOne,
    convFindOneAndUpdate: ChatConversation.findOneAndUpdate,
    convUpdateOne: ChatConversation.updateOne,
    msgFindOne: ChatMessage.findOne,
    msgFindOneAndUpdate: ChatMessage.findOneAndUpdate,
    userFindOne: User.findOne,
    userFind: User.find,
    auditCreate: AuditLog.create,
  };

  const convMatches = (doc, filter) => {
    if (filter._id && !same(doc._id, filter._id)) return false;
    if (filter.companyId && !same(doc.companyId, filter.companyId)) return false;
    const member = filter['members.userId'];
    if (member && !doc.members.some((m) => same(m.userId, member))) return false;
    return true;
  };

  ChatConversation.findOne = (filter) => ({
    lean: async () => conversations.find((doc) => convMatches(doc, filter)) ?? null,
  });

  ChatConversation.findOneAndUpdate = (filter, update) => {
    updates.push({ filter, update });

    return {
      lean: async () => {
        const doc = conversations.find((entry) => convMatches(entry, filter));
        if (!doc) return null;
        if (update.$set) {
          for (const [key, value] of Object.entries(update.$set)) doc[key] = value;
        }
        return doc;
      },
    };
  };

  ChatConversation.updateOne = async (filter, update) => {
    updates.push({ filter, update });

    const doc = conversations.find((entry) => convMatches(entry, filter));
    if (!doc) return { modifiedCount: 0 };

    if (update.$pull?.members) {
      const target = update.$pull.members.userId;
      doc.members = doc.members.filter((m) => !same(m.userId, target));
    }

    if (update.$push?.members?.$each) {
      doc.members.push(...update.$push.members.$each);
    }

    return { modifiedCount: 1 };
  };

  ChatMessage.findOne = (filter) => ({
    lean: async () =>
      messages.find(
        (doc) =>
          (!filter._id || same(doc._id, filter._id)) &&
          same(doc.companyId, filter.companyId) &&
          same(doc.conversationId, filter.conversationId)
      ) ?? null,
  });

  ChatMessage.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const doc = messages.find(
        (entry) =>
          same(entry._id, filter._id) &&
          same(entry.companyId, filter.companyId) &&
          same(entry.conversationId, filter.conversationId)
      );

      if (!doc) return null;
      if (filter.deletedAt === null && doc.deletedAt) return null;

      if (update.$set) {
        for (const [key, value] of Object.entries(update.$set)) doc[key] = value;
      }

      return doc;
    },
  });

  // resolveActor() reads one tenant-scoped actor: .select(...).lean()
  User.findOne = (filter) => ({
    select: () => ({
      lean: async () =>
        users.find(
          (doc) => same(doc._id, filter._id) && same(doc.companyId, filter.companyId)
        ) ?? null,
    }),
  });

  User.find = (filter) => ({
    select: () => ({
      lean: async () =>
        users.filter((doc) => same(doc.companyId, filter.companyId)),
    }),
  });

  AuditLog.create = async (payload) => {
    const row = { _id: id(), ...payload };
    audits.push(row);
    return row;
  };

  return {
    audits,
    updates,
    restore: () => {
      ChatConversation.findOne = original.convFindOne;
      ChatConversation.findOneAndUpdate = original.convFindOneAndUpdate;
      ChatConversation.updateOne = original.convUpdateOne;
      ChatMessage.findOne = original.msgFindOne;
      ChatMessage.findOneAndUpdate = original.msgFindOneAndUpdate;
      User.findOne = original.userFindOne;
      User.find = original.userFind;
      AuditLog.create = original.auditCreate;
    },
  };
};

const seedConversation = ({
  companyId = COMPANY_A,
  members,
  isDisabled = false,
  lastMessageSeq = 0,
}) => ({
  _id: id(),
  companyId,
  type: 'GROUP',
  title: 'Design',
  members,
  lastMessageSeq,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastMessageSenderUserId: null,
  isDisabled,
  disabledAt: null,
  disabledByUserId: null,
});

const seedMessage = ({ conversation, sender, text = 'hello' }) => ({
  _id: id(),
  companyId: conversation.companyId,
  conversationId: conversation._id,
  senderUserId: sender,
  seq: 1,
  clientMessageId: 'seed-1',
  type: 'TEXT',
  text,
  editVersion: 0,
  editedAt: null,
  editedByUserId: null,
  deletedAt: null,
  deletedByUserId: null,
  createdAt: new Date(),
});

const seedUser = ({ companyId = COMPANY_A, userId, name = 'Moderator', role = 'HR_MANAGER' }) => ({
  _id: userId,
  companyId,
  name,
  email: `${String(userId).slice(-6)}@crewly.test`,
  role,
});

const memberOf = (userId, role = 'MEMBER') => ({
  userId,
  role,
  joinedAt: new Date(),
  joinedAtSeq: 0,
  lastReadSeq: 0,
});

// A moderator checker that never touches the permission engine.
const allow = async () => true;
const deny = async () => false;

// ── 1. catalogue + role matrix pins ───────────────────────────────────────

test('33.9 catalogue: CHAT resource with MODERATE + GROUP_MANAGE actions', () => {
  assert.ok(RESOURCES.includes('CHAT'), 'CHAT must be a registered resource');
  assert.ok(ACTIONS.includes('MODERATE'), 'MODERATE must be a registered action');
  assert.ok(ACTIONS.includes('GROUP_MANAGE'), 'GROUP_MANAGE must be a registered action');

  const names = DEFAULT_PERMISSIONS.map((permission) => permission.name);

  assert.ok(names.includes('CHAT_MODERATE'));
  assert.ok(names.includes('CHAT_GROUP_MANAGE'));

  for (const permission of DEFAULT_PERMISSIONS.filter((p) => p.resource === 'CHAT')) {
    assert.equal(permission.scope, 'ALL', `${permission.name} must be a company-wide permission`);
    assert.equal(permission.group, 'CHAT');
  }

  // No CHAT_READ was invented: chat reads stay membership-gated (33.3).
  assert.ok(!names.some((name) => name.startsWith('CHAT_READ')));
});

test('33.9 role matrix: moderation is granted deliberately, never to employees', () => {
  const admin = DEFAULT_ROLE_MATRIX.COMPANY_ADMIN;
  const hr = DEFAULT_ROLE_MATRIX.HR_MANAGER;
  const manager = DEFAULT_ROLE_MATRIX.MANAGER;
  const employee = DEFAULT_ROLE_MATRIX.EMPLOYEE;

  assert.ok(admin.includes('CHAT_MODERATE'));
  assert.ok(admin.includes('CHAT_GROUP_MANAGE'));

  assert.ok(hr.includes('CHAT_MODERATE'));
  assert.ok(hr.includes('CHAT_GROUP_MANAGE'));

  // A manager moderates content but does not administer group membership.
  assert.ok(manager.includes('CHAT_MODERATE'));
  assert.ok(!manager.includes('CHAT_GROUP_MANAGE'));

  assert.ok(!employee.includes('CHAT_MODERATE'));
  assert.ok(!employee.includes('CHAT_GROUP_MANAGE'));
});

test('33.9 bumps the permission version to 37 (one-shot role migration)', () => {
  assert.equal(getSystemPermissionVersion(), 37);
});

// ── 2. conversation lock ──────────────────────────────────────────────────

test('non-moderator cannot disable a conversation (403, no write)', async () => {
  const conversation = seedConversation({ members: [memberOf(MEMBER), memberOf(ADMIN, 'ADMIN')] });
  const fakes = installFakes({
    conversations: [conversation],
    users: [seedUser({ userId: MEMBER, role: 'EMPLOYEE' })],
  });

  try {
    await assert.rejects(
      () =>
        disableConversation({
          companyId: COMPANY_A,
          actorId: MEMBER,
          conversationId: conversation._id,
          checkPermission: deny,
          audit: AuditLog.create,
        }),
      (error) => {
        assert.equal(error.statusCode, 403);
        return true;
      }
    );

    assert.equal(conversation.isDisabled, false, 'the lock must not be applied');
    assert.equal(fakes.audits.length, 0, 'a refused attempt is not a moderation event');
    assert.equal(fakes.updates.length, 0, 'no write may be issued');
  } finally {
    fakes.restore();
  }
});

test('an actor with no membership at all still cannot disable (no actor, no power)', async () => {
  const conversation = seedConversation({ members: [memberOf(MEMBER), memberOf(ADMIN, 'ADMIN')] });
  const fakes = installFakes({ conversations: [conversation], users: [] });

  try {
    await assert.rejects(
      () =>
        disableConversation({
          companyId: COMPANY_A,
          actorId: id(),
          conversationId: conversation._id,
          checkPermission: allow,
          audit: AuditLog.create,
        }),
      (error) => error.statusCode === 403
    );

    assert.equal(conversation.isDisabled, false);
    assert.equal(fakes.audits.length, 0);
  } finally {
    fakes.restore();
  }
});

test('moderator disables a conversation: lock set, audit written, reason bounded', async () => {
  const conversation = seedConversation({ members: [memberOf(MEMBER), memberOf(ADMIN, 'ADMIN')] });
  // The moderator does NOT have to be a member.
  const fakes = installFakes({
    conversations: [conversation],
    users: [seedUser({ userId: ADMIN, name: 'Manikandan', role: 'HR_MANAGER' })],
  });

  const longReason = 'x'.repeat(500);

  try {
    const result = await disableConversation({
      companyId: COMPANY_A,
      actorId: ADMIN,
      conversationId: conversation._id,
      reason: longReason,
      checkPermission: allow,
      audit: AuditLog.create,
      reqMeta: { method: 'PATCH', path: `/api/chat/conversations/${conversation._id}/disable`, ip: '127.0.0.1' },
    });

    assert.equal(result.changed, true);
    assert.equal(result.conversation.isDisabled, true);
    assert.equal(String(result.conversation.disabledByUserId), String(ADMIN));
    assert.ok(result.conversation.disabledAt instanceof Date);

    assert.equal(fakes.audits.length, 1);

    const entry = fakes.audits[0];

    assert.equal(entry.action, 'CHAT_CONVERSATION_DISABLED');
    assert.equal(entry.companyId, COMPANY_A);
    assert.equal(String(entry.actor), String(ADMIN));
    assert.equal(entry.targetType, 'ChatConversation');
    assert.equal(String(entry.targetId), String(conversation._id));
    assert.equal(entry.method, 'PATCH');
    assert.equal(entry.previousValue.isDisabled, false);
    assert.equal(entry.newValue.isDisabled, true);
    assert.equal(entry.newValue.reason.length, CHAT_MODERATION_REASON_MAX);

    // Privacy: no message content and no member cursors anywhere in the row.
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes('hello'), 'audit must never carry message text');
    assert.ok(!serialized.includes('lastReadSeq'), 'audit must never carry read state');
    assert.ok(entry.newValue.reason.length < longReason.length);
  } finally {
    fakes.restore();
  }
});

test('re-disabling an already disabled conversation is a no-op (no second audit)', async () => {
  const conversation = seedConversation({
    members: [memberOf(MEMBER), memberOf(ADMIN, 'ADMIN')],
    isDisabled: true,
  });
  const fakes = installFakes({
    conversations: [conversation],
    users: [seedUser({ userId: ADMIN })],
  });

  try {
    const result = await disableConversation({
      companyId: COMPANY_A,
      actorId: ADMIN,
      conversationId: conversation._id,
      reason: 'again',
      checkPermission: allow,
      audit: AuditLog.create,
    });

    assert.equal(result.changed, false);
    assert.equal(fakes.audits.length, 0);
    assert.equal(fakes.updates.length, 0);
  } finally {
    fakes.restore();
  }
});

test('moderator re-enables a disabled conversation and the audit says so', async () => {
  const conversation = seedConversation({
    members: [memberOf(MEMBER), memberOf(ADMIN, 'ADMIN')],
    isDisabled: true,
  });
  conversation.disabledByUserId = ADMIN;
  conversation.disabledAt = new Date();

  const fakes = installFakes({
    conversations: [conversation],
    users: [seedUser({ userId: ADMIN })],
  });

  try {
    const result = await enableConversation({
      companyId: COMPANY_A,
      actorId: ADMIN,
      conversationId: conversation._id,
      checkPermission: allow,
      audit: AuditLog.create,
    });

    assert.equal(result.changed, true);
    assert.equal(result.conversation.isDisabled, false);
    assert.equal(result.conversation.disabledByUserId, null);
    assert.equal(result.conversation.disabledAt, null);

    assert.equal(fakes.audits.length, 1);
    assert.equal(fakes.audits[0].action, 'CHAT_CONVERSATION_ENABLED');
  } finally {
    fakes.restore();
  }
});

test('moderation never crosses the tenant boundary (404, no existence leak)', async () => {
  const foreign = seedConversation({
    companyId: COMPANY_B,
    members: [memberOf(MEMBER), memberOf(ADMIN, 'ADMIN')],
  });
  const fakes = installFakes({
    conversations: [foreign],
    users: [seedUser({ userId: ADMIN })],
  });

  try {
    await assert.rejects(
      () =>
        disableConversation({
          companyId: COMPANY_A,
          actorId: ADMIN,
          conversationId: foreign._id,
          checkPermission: allow,
          audit: AuditLog.create,
        }),
      (error) => {
        assert.equal(error.statusCode, 404);
        assert.equal(error.message, 'Conversation not found.');
        return true;
      }
    );

    assert.equal(foreign.isDisabled, false);
    assert.equal(fakes.audits.length, 0);
  } finally {
    fakes.restore();
  }
});

test('boundModerationReason trims, bounds and nulls empty input', () => {
  assert.equal(boundModerationReason(undefined), null);
  assert.equal(boundModerationReason('   '), null);
  assert.equal(boundModerationReason('  spam  '), 'spam');
  assert.equal(boundModerationReason('y'.repeat(400)).length, CHAT_MODERATION_REASON_MAX);
});

// ── 3. moderator message removal ──────────────────────────────────────────

test('non-moderator cannot moderate-delete a message (403, message untouched)', async () => {
  const conversation = seedConversation({ members: [memberOf(MEMBER), memberOf(OTHER)] });
  const message = seedMessage({ conversation, sender: OTHER, text: 'secret' });
  const fakes = installFakes({
    conversations: [conversation],
    messages: [message],
    users: [seedUser({ userId: MEMBER, role: 'EMPLOYEE' })],
  });

  try {
    await assert.rejects(
      () =>
        moderateDeleteMessage({
          companyId: COMPANY_A,
          actorId: MEMBER,
          conversationId: conversation._id,
          messageId: message._id,
          checkPermission: deny,
          audit: AuditLog.create,
        }),
      (error) => error.statusCode === 403
    );

    assert.equal(message.deletedAt, null);
    assert.equal(message.text, 'secret');
    assert.equal(fakes.audits.length, 0);
  } finally {
    fakes.restore();
  }
});

test('moderator tombstones ANOTHER member message: text nulled, audited once, no content stored', async () => {
  const conversation = seedConversation({ members: [memberOf(MEMBER), memberOf(OTHER), memberOf(ADMIN, 'ADMIN')] });
  const message = seedMessage({ conversation, sender: MEMBER, text: 'offending text' });
  const fakes = installFakes({
    conversations: [conversation],
    messages: [message],
    users: [seedUser({ userId: ADMIN })],
  });

  try {
    const result = await moderateDeleteMessage({
      companyId: COMPANY_A,
      actorId: ADMIN,
      conversationId: conversation._id,
      messageId: message._id,
      reason: 'off-topic',
      checkPermission: allow,
      audit: AuditLog.create,
      reqMeta: { method: 'POST', path: '/api/chat/conversations/x/messages/y/moderate-delete' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(message.text, null, 'the tombstone nulls the text');
    assert.equal(String(message.deletedByUserId), String(ADMIN));
    assert.ok(message.deletedAt instanceof Date);

    assert.equal(fakes.audits.length, 1);

    const entry = fakes.audits[0];

    assert.equal(entry.action, 'CHAT_MESSAGE_MODERATED_DELETE');
    assert.equal(entry.targetType, 'ChatMessage');
    assert.equal(String(entry.targetId), String(message._id));
    assert.equal(String(entry.newValue.conversationId), String(conversation._id));
    assert.equal(entry.newValue.reason, 'off-topic');

    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes('offending text'), 'audit must never carry the moderated text');
  } finally {
    fakes.restore();
  }
});

test('moderate-delete is idempotent: retry reports changed:false and writes no new audit', async () => {
  const conversation = seedConversation({ members: [memberOf(MEMBER), memberOf(OTHER), memberOf(ADMIN, 'ADMIN')] });
  const message = seedMessage({ conversation, sender: MEMBER });
  const fakes = installFakes({
    conversations: [conversation],
    messages: [message],
    users: [seedUser({ userId: ADMIN })],
  });

  try {
    const first = await moderateDeleteMessage({
      companyId: COMPANY_A,
      actorId: ADMIN,
      conversationId: conversation._id,
      messageId: message._id,
      checkPermission: allow,
      audit: AuditLog.create,
    });

    const second = await moderateDeleteMessage({
      companyId: COMPANY_A,
      actorId: ADMIN,
      conversationId: conversation._id,
      messageId: message._id,
      checkPermission: allow,
      audit: AuditLog.create,
    });

    assert.equal(first.changed, true);
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(String(second.deletedAt), String(first.deletedAt));
    assert.equal(fakes.audits.length, 1, 'a retry is not a second moderation event');
  } finally {
    fakes.restore();
  }
});

test('moderate-delete cannot reach a message in another tenant', async () => {
  const foreign = seedConversation({ companyId: COMPANY_B, members: [memberOf(MEMBER), memberOf(ADMIN, 'ADMIN')] });
  const message = seedMessage({ conversation: foreign, sender: MEMBER });
  const fakes = installFakes({
    conversations: [foreign],
    messages: [message],
    users: [seedUser({ userId: ADMIN })],
  });

  try {
    const result = await moderateDeleteMessage({
      companyId: COMPANY_A,
      actorId: ADMIN,
      conversationId: foreign._id,
      messageId: message._id,
      checkPermission: allow,
      audit: AuditLog.create,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND_OR_FORBIDDEN');
    assert.equal(message.deletedAt, null);
    assert.equal(fakes.audits.length, 0);
  } finally {
    fakes.restore();
  }
});

// ── 4. socket enforcement ─────────────────────────────────────────────────

const makeSocket = ({ companyId, userId }) => {
  const handlers = {};

  return {
    id: 'sock-moderation',
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

const makeIo = (broadcasts) => ({
  to: (room) => ({
    emit: (event, payload) => {
      broadcasts.push({ room, event, payload });
    },
  }),
});

test('socket delete: a CHAT_MODERATE socket overturns the sender-only refusal', async () => {
  const broadcasts = [];
  const socket = makeSocket({ companyId: COMPANY_A, userId: ADMIN });

  const calls = { moderator: 0 };

  registerChatSocketHandlers({
    io: makeIo(broadcasts),
    socket,
    log: { warn: () => {} },
    deleteMessage: async () => ({ ok: false, code: 'MESSAGE_NOT_EDITABLE' }),
    resolveModerator: async () => true,
    moderateDelete: async ({ messageId }) => {
      calls.moderator += 1;
      return { ok: true, messageId, deletedAt: new Date('2026-01-01T00:00:00.000Z'), changed: true };
    },
  });

  const messageId = id();
  const conversationId = id();

  const ack = await socket.trigger('chat:message:delete', { conversationId, messageId });

  assert.equal(ack.ok, true);
  assert.equal(calls.moderator, 1);

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event, 'chat:message:deleted');
  assert.equal(broadcasts[0].room, conversationRoom(String(conversationId)));
  assert.equal(String(broadcasts[0].payload.messageId), String(messageId));
  assert.equal(String(broadcasts[0].payload.deletedByUserId), String(ADMIN));
});

test('socket delete: a plain member keeps the sender-only refusal (moderator check denied)', async () => {
  const broadcasts = [];
  const socket = makeSocket({ companyId: COMPANY_A, userId: MEMBER });

  let moderatorCalls = 0;

  registerChatSocketHandlers({
    io: makeIo(broadcasts),
    socket,
    log: { warn: () => {} },
    deleteMessage: async () => ({ ok: false, code: 'MESSAGE_NOT_EDITABLE' }),
    resolveModerator: async () => false,
    moderateDelete: async () => {
      moderatorCalls += 1;
      return { ok: true, changed: true };
    },
  });

  const ack = await socket.trigger('chat:message:delete', {
    conversationId: id(),
    messageId: id(),
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'MESSAGE_NOT_EDITABLE');
  assert.equal(moderatorCalls, 0, 'the moderation path must never run for a non-moderator');
  assert.equal(broadcasts.length, 0);
});

test('socket delete: an unmoderated success never consults the moderation path', async () => {
  const broadcasts = [];
  const socket = makeSocket({ companyId: COMPANY_A, userId: MEMBER });
  let moderatorCalls = 0;

  registerChatSocketHandlers({
    io: makeIo(broadcasts),
    socket,
    log: { warn: () => {} },
    deleteMessage: async ({ messageId }) => ({
      ok: true,
      messageId,
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      changed: true,
    }),
    resolveModerator: async () => {
      moderatorCalls += 1;
      return false;
    },
  });

  const ack = await socket.trigger('chat:message:delete', {
    conversationId: id(),
    messageId: id(),
  });

  assert.equal(ack.ok, true);
  assert.equal(moderatorCalls, 0, 'the happy path stays a single Mongo round-trip');
  assert.equal(broadcasts.length, 1);
});

test('socket send in a disabled conversation is refused for a member (CONVERSATION_DISABLED)', async () => {
  const broadcasts = [];
  const conversation = seedConversation({
    members: [memberOf(MEMBER), memberOf(OTHER)],
    isDisabled: true,
  });

  const fakes = installFakes({ conversations: [conversation] });
  const socket = makeSocket({ companyId: COMPANY_A, userId: MEMBER });

  try {
    registerChatSocketHandlers({
      io: makeIo(broadcasts),
      socket,
      log: { warn: () => {} },
    });

    const ack = await socket.trigger('chat:message:send', {
      conversationId: conversation._id,
      clientMessageId: 'c-1',
      text: 'anyone there?',
    });

    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'CONVERSATION_DISABLED');
    assert.equal(broadcasts.length, 0);
  } finally {
    fakes.restore();
  }
});

test('socket edit in a disabled conversation is refused for a member (CONVERSATION_DISABLED)', async () => {
  const broadcasts = [];
  const conversation = seedConversation({
    members: [memberOf(MEMBER), memberOf(OTHER)],
    isDisabled: true,
  });

  const fakes = installFakes({ conversations: [conversation] });
  const socket = makeSocket({ companyId: COMPANY_A, userId: MEMBER });

  try {
    registerChatSocketHandlers({
      io: makeIo(broadcasts),
      socket,
      log: { warn: () => {} },
    });

    const ack = await socket.trigger('chat:message:edit', {
      conversationId: conversation._id,
      messageId: id(),
      expectedEditVersion: 1,
      newText: 'edited inside a locked room',
    });

    // 33.9 pinned send; the lock is a property of the CONVERSATION, so the same
    // refusal must cover edit — the service gate fires before the message load.
    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'CONVERSATION_DISABLED');
    assert.equal(broadcasts.length, 0);
  } finally {
    fakes.restore();
  }
});

test('socket delete in a disabled conversation is refused for a member, and overturned for a CHAT_MODERATE socket', async () => {
  const broadcasts = [];
  const conversation = seedConversation({
    members: [memberOf(ADMIN, 'ADMIN'), memberOf(MEMBER), memberOf(OTHER)],
    isDisabled: true,
  });

  const fakes = installFakes({ conversations: [conversation] });

  try {
    // Half 1 — a plain member: the lock holds, and the moderator path is denied.
    const memberChecks = { moderator: 0 };

    const memberSocket = makeSocket({ companyId: COMPANY_A, userId: MEMBER });

    registerChatSocketHandlers({
      io: makeIo(broadcasts),
      socket: memberSocket,
      log: { warn: () => {} },
      resolveModerator: async () => {
        memberChecks.moderator += 1;

        return false;
      },
    });

    const refused = await memberSocket.trigger('chat:message:delete', {
      conversationId: conversation._id,
      messageId: id(),
    });

    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'CONVERSATION_DISABLED');
    assert.equal(memberChecks.moderator, 1, 'the fallback is consulted and denies');
    assert.equal(broadcasts.length, 0);

    // Half 2 — a CHAT_MODERATE holder: the lock is aimed at members, not at
    // moderation. The REAL delete service still refuses (it runs as the member),
    // and the moderator fallback is what overturns it.
    const moderatorCalls = { moderate: 0 };
    const messageId = id();
    const moderatorSocket = makeSocket({ companyId: COMPANY_A, userId: ADMIN });

    registerChatSocketHandlers({
      io: makeIo(broadcasts),
      socket: moderatorSocket,
      log: { warn: () => {} },
      resolveModerator: async () => true,
      moderateDelete: async ({ messageId: targetId }) => {
        moderatorCalls.moderate += 1;

        return {
          ok: true,
          messageId: targetId,
          deletedAt: new Date('2026-01-01T00:00:00.000Z'),
          changed: true,
        };
      },
    });

    const allowed = await moderatorSocket.trigger('chat:message:delete', {
      conversationId: conversation._id,
      messageId,
    });

    assert.equal(allowed.ok, true);
    assert.equal(moderatorCalls.moderate, 1);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].event, 'chat:message:deleted');
  } finally {
    fakes.restore();
  }
});

// ── 5. membership invariants + the group-manage widening ──────────────────

test('the last group admin cannot be removed (orphan rule preserved)', async () => {
  const conversation = seedConversation({
    members: [memberOf(ADMIN, 'ADMIN'), memberOf(MEMBER), memberOf(OTHER)],
  });

  const fakes = installFakes({ conversations: [conversation] });

  try {
    await assert.rejects(
      () =>
        removeMember({
          companyId: COMPANY_A,
          actorId: ADMIN,
          conversationId: conversation._id,
          targetUserId: ADMIN,
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /at least one admin/);
        return true;
      }
    );

    assert.equal(conversation.members.length, 3);
  } finally {
    fakes.restore();
  }
});

test('a two-member group cannot be emptied', async () => {
  const conversation = seedConversation({
    members: [memberOf(ADMIN, 'ADMIN'), memberOf(MEMBER, 'ADMIN')],
  });

  const fakes = installFakes({ conversations: [conversation] });

  try {
    await assert.rejects(
      () =>
        removeMember({
          companyId: COMPANY_A,
          actorId: ADMIN,
          conversationId: conversation._id,
          targetUserId: MEMBER,
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /two members/);
        return true;
      }
    );

    assert.equal(conversation.members.length, 2);
  } finally {
    fakes.restore();
  }
});

test('CHAT_GROUP_MANAGE widens membership management to a non-member (never narrows 33.2)', async () => {
  const conversation = seedConversation({
    members: [memberOf(ADMIN, 'ADMIN'), memberOf(MEMBER), memberOf(OTHER)],
  });

  const fakes = installFakes({ conversations: [conversation] });

  try {
    // Without the permission a non-member is still refused...
    await assert.rejects(
      () =>
        removeMember({
          companyId: COMPANY_A,
          actorId: id(),
          conversationId: conversation._id,
          targetUserId: OTHER,
        }),
      (error) => error.statusCode === 403
    );

    assert.equal(conversation.members.length, 3);

    // ...with it, the same call succeeds (and audits are the caller's job).
    const result = await removeMember({
      companyId: COMPANY_A,
      actorId: id(),
      conversationId: conversation._id,
      targetUserId: OTHER,
      moderatorManage: true,
    });

    assert.equal(String(result.removed), String(OTHER));
    assert.equal(conversation.members.length, 2);
  } finally {
    fakes.restore();
  }
});

test('addMembers: a non-admin member is still refused; CHAT_GROUP_MANAGE passes', async () => {
  const conversation = seedConversation({
    members: [memberOf(MEMBER), memberOf(OTHER)],
    lastMessageSeq: 4,
  });

  const newcomer = id();

  const fakes = installFakes({
    conversations: [conversation],
    users: [seedUser({ userId: newcomer, role: 'EMPLOYEE' })],
  });

  try {
    await assert.rejects(
      () =>
        addMembers({
          companyId: COMPANY_A,
          actorId: MEMBER,
          conversationId: conversation._id,
          memberUserIds: [String(newcomer)],
        }),
      (error) => error.statusCode === 403
    );

    assert.equal(conversation.members.length, 2);

    const result = await addMembers({
      companyId: COMPANY_A,
      actorId: MEMBER,
      conversationId: conversation._id,
      memberUserIds: [String(newcomer)],
      moderatorManage: true,
    });

    assert.equal(result.added, 1);
    assert.equal(conversation.members.length, 3);

    // A late joiner starts unread-free: the baseline is the current seq.
    const joined = conversation.members.find((m) => same(m.userId, newcomer));
    assert.equal(joined.joinedAtSeq, 4);
    assert.equal(joined.lastReadSeq, 4);
  } finally {
    fakes.restore();
  }
});

test('membership management stays tenant-scoped', async () => {
  const foreign = seedConversation({
    companyId: COMPANY_B,
    members: [memberOf(ADMIN, 'ADMIN'), memberOf(MEMBER)],
  });

  const fakes = installFakes({ conversations: [foreign] });

  try {
    await assert.rejects(
      () =>
        removeMember({
          companyId: COMPANY_A,
          actorId: ADMIN,
          conversationId: foreign._id,
          targetUserId: MEMBER,
          moderatorManage: true,
        }),
      (error) => error.statusCode === 404
    );

    assert.equal(foreign.members.length, 2);
  } finally {
    fakes.restore();
  }
});
