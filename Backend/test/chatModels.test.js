// ============================================================
//  PHASE 33.2 — CHAT MODELS + INDEXES + INVARIANTS (HERMETIC).
//
//  These tests never connect to Mongo. Mongoose schemas are ground
//  truth: schema.indexes(), schema.path() and document.validate()
//  all work offline, so the persistence contract for the Chat Hub is
//  pinned before any API or socket event can write to it.
//
//  What is pinned here is deliberately structural — field presence,
//  enums, defaults, immutability, index shape, uniqueness, partial
//  filters, tenant-first ordering, and the cross-field invariants
//  that make a malformed conversation or a half-deleted message
//  unwritable. Behaviour (seq allocation, unread maths, edit caps)
//  belongs to 33.5–33.7 and is tested there.
// ============================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_models';
process.env.REDIS_ENABLED ||= 'false';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import ChatMessageEdit from '../src/models/ChatMessageEdit.js';
import {
  CHAT_CONVERSATION_TYPES,
  CHAT_MEMBER_ROLES,
} from '../src/models/ChatConversation.js';
import {
  CHAT_MESSAGE_TYPES,
  CHAT_MESSAGE_TEXT_MAX,
} from '../src/models/ChatMessage.js';

const MODELS = { ChatConversation, ChatMessage, ChatMessageEdit };

const hex = (fill) => fill.repeat(24).slice(0, 24);

const ALICE = hex('a');
const BOB = hex('b');
const CAROL = hex('c');

const tenant = () => new ChatConversation.db.base.Types.ObjectId();

// ── index introspection helpers (same shape as indexCoverage.test.js) ──

const indexesOf = (Model) => Model.schema.indexes();

const keySequences = (Model) => indexesOf(Model).map(([keys]) => Object.keys(keys));

const optionsFor = (Model, expectedKeys) =>
  indexesOf(Model).find(([keys]) => {
    const names = Object.keys(keys);

    return (
      names.length === expectedKeys.length &&
      expectedKeys.every((key, position) => names[position] === key)
    );
  })?.[1];

const directionsFor = (Model, expectedKeys) =>
  indexesOf(Model).find(([keys]) => {
    const names = Object.keys(keys);

    return (
      names.length === expectedKeys.length &&
      expectedKeys.every((key, position) => names[position] === key)
    );
  })?.[0];

const validateOk = async (Model, payload) => {
  try {
    await new Model(payload).validate();

    return true;
  } catch {
    return false;
  }
};

const rejectionPaths = async (Model, payload) => {
  try {
    await new Model(payload).validate();

    return [];
  } catch (error) {
    return Object.keys(error.errors ?? {}).sort();
  }
};

// Strip comments before source-shape assertions, so an explanatory
// comment mentioning a banned API cannot satisfy (or break) a pin.
const stripComments = (source) =>
  source
    .split('\n')
    .map((line) => line.replace(/^\s*(\/\/|\/\*|\*).*/, ''))
    .join('\n');

const readModelSource = (name) =>
  readFile(new URL(`../src/models/${name}.js`, import.meta.url), 'utf8');

// ─────────────────────────────────────────────────────────────
//  1. REGISTRATION
// ─────────────────────────────────────────────────────────────

test('all three chat models register under their exact names', () => {
  assert.equal(ChatConversation.modelName, 'ChatConversation');
  assert.equal(ChatMessage.modelName, 'ChatMessage');
  assert.equal(ChatMessageEdit.modelName, 'ChatMessageEdit');
});

test('chat collections carry no Mongoose __v version key', () => {
  // Chat documents are never written through Mongoose optimistic
  // concurrency; 33.6 uses its own editVersion instead.
  for (const [name, Model] of Object.entries(MODELS)) {
    assert.equal(Model.schema.options.versionKey, false, `${name} must drop __v`);
  }
});

test('timestamps are enabled so createdAt/updatedAt are real fields', () => {
  for (const [name, Model] of Object.entries(MODELS)) {
    assert.ok(Model.schema.path('createdAt'), `${name} needs createdAt`);
    assert.ok(Model.schema.path('updatedAt'), `${name} needs updatedAt`);
  }
});

// ─────────────────────────────────────────────────────────────
//  2. INDEX DESIGN
// ─────────────────────────────────────────────────────────────

test('ChatConversation: one DIRECT conversation per pair per tenant', () => {
  const options = optionsFor(ChatConversation, ['companyId', 'directKey']);

  assert.ok(options, 'the (companyId, directKey) index must exist');
  assert.equal(options.unique, true);
  assert.deepEqual(options.partialFilterExpression, { type: 'DIRECT' });
});

test('ChatConversation: my-conversations list index is tenant + member + recency', () => {
  const keys = directionsFor(ChatConversation, [
    'companyId',
    'members.userId',
    'lastMessageAt',
  ]);

  assert.ok(keys, 'the my-conversations index must exist');
  assert.equal(keys.lastMessageAt, -1, 'newest activity must sort first');
});

test('ChatMessage: history pagination index is tenant + conversation + seq desc', () => {
  const keys = directionsFor(ChatMessage, ['companyId', 'conversationId', 'seq']);

  assert.ok(keys, 'the history index must exist');
  assert.equal(keys.seq, -1, 'history pages newest-first by seq');
});

test('ChatMessage: idempotent-send index is unique over the client key', () => {
  const options = optionsFor(ChatMessage, [
    'companyId',
    'conversationId',
    'senderUserId',
    'clientMessageId',
  ]);

  assert.ok(options, 'the idempotency index must exist');
  assert.equal(options.unique, true);
});

test('ChatMessageEdit: append-only uniqueness per message version', () => {
  const options = optionsFor(ChatMessageEdit, ['companyId', 'messageId', 'version']);

  assert.ok(options, 'the edit uniqueness index must exist');
  assert.equal(options.unique, true);
});

test('ChatMessageEdit: edit-history fetch index is newest revision first', () => {
  const keys = directionsFor(ChatMessageEdit, [
    'companyId',
    'conversationId',
    'messageId',
    'version',
  ]);

  assert.ok(keys, 'the edit-history index must exist');
  assert.equal(keys.version, -1);
});

test('exact index inventory — no index may appear or disappear silently', () => {
  const expected = {
    ChatConversation: [
      ['companyId', 'directKey'],
      ['companyId', 'members.userId', 'lastMessageAt'],
    ],
    ChatMessage: [
      ['companyId', 'conversationId', 'seq'],
      ['companyId', 'conversationId', 'senderUserId', 'clientMessageId'],
      // 33.10 — "is this attachment already referenced by a message?".
      ['companyId', 'conversationId', 'attachments.attachmentId'],
    ],
    ChatMessageEdit: [
      ['companyId', 'messageId', 'version'],
      ['companyId', 'conversationId', 'messageId', 'version'],
    ],
  };

  for (const [name, Model] of Object.entries(MODELS)) {
    const actual = keySequences(Model)
      .map((keys) => keys.join(','))
      .sort();

    assert.deepEqual(
      actual,
      expected[name].map((keys) => keys.join(',')).sort(),
      `${name} index inventory drifted`,
    );
  }
});

// ─────────────────────────────────────────────────────────────
//  3. TENANCY GUARANTEE
// ─────────────────────────────────────────────────────────────

test('tenant-first law: companyId is required and immutable on every chat model', () => {
  for (const [name, Model] of Object.entries(MODELS)) {
    const path = Model.schema.path('companyId');

    assert.ok(path, `${name} must have companyId`);
    assert.equal(path.isRequired, true, `${name}.companyId must be required`);
    assert.equal(path.options.immutable, true, `${name}.companyId must be immutable`);
    assert.equal(path.options.ref, 'Company', `${name}.companyId must ref Company`);
  }
});

test('tenant-first law: every chat index leads with companyId', () => {
  for (const [name, Model] of Object.entries(MODELS)) {
    for (const keys of keySequences(Model)) {
      assert.equal(keys[0], 'companyId', `${name} index [${keys}] must lead with companyId`);
      assert.ok(keys.length > 1, `${name} index [${keys}] must be a compound`);
    }
  }
});

test('write-amplification guard: no redundant single-field companyId index', () => {
  // companyId already leads every compound index above. A standalone
  // { companyId: 1 } would be pure extra write cost on the hottest
  // collections in the system, so it is pinned absent.
  for (const [name, Model] of Object.entries(MODELS)) {
    const standalone = keySequences(Model).some(
      (keys) => keys.length === 1 && keys[0] === 'companyId',
    );

    assert.equal(standalone, false, `${name} must not carry a standalone companyId index`);
  }
});

test('tenant scoping is structural: no chat model exposes a cross-tenant index', () => {
  for (const [name, Model] of Object.entries(MODELS)) {
    for (const [keys] of indexesOf(Model)) {
      assert.ok(
        'companyId' in keys,
        `${name} index ${JSON.stringify(keys)} must include companyId`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────
//  4. FIELDS, ENUMS, DEFAULTS
// ─────────────────────────────────────────────────────────────

test('ChatConversation: required fields exist', () => {
  for (const field of ['companyId', 'type']) {
    assert.equal(
      ChatConversation.schema.path(field).isRequired,
      true,
      `${field} must be required`,
    );
  }
});

test('ChatConversation: type enum is exactly DIRECT | GROUP', () => {
  assert.deepEqual([...ChatConversation.schema.path('type').enumValues], ['DIRECT', 'GROUP']);
  assert.deepEqual([...CHAT_CONVERSATION_TYPES], ['DIRECT', 'GROUP']);
});

test('ChatConversation: member role enum is exactly MEMBER | ADMIN', () => {
  const memberSchema = ChatConversation.schema.path('members').schema;

  assert.deepEqual([...memberSchema.path('role').enumValues], ['MEMBER', 'ADMIN']);
  assert.deepEqual([...CHAT_MEMBER_ROLES], ['MEMBER', 'ADMIN']);
});

test('ChatConversation: defaults are exactly as specified', () => {
  const memberSchema = ChatConversation.schema.path('members').schema;

  assert.equal(ChatConversation.schema.path('lastMessageSeq').defaultValue, 0);
  assert.equal(ChatConversation.schema.path('isDisabled').defaultValue, false);
  assert.equal(ChatConversation.schema.path('directKey').defaultValue, null);
  assert.equal(ChatConversation.schema.path('title').defaultValue, null);
  assert.equal(ChatConversation.schema.path('lastMessageAt').defaultValue, null);
  assert.equal(memberSchema.path('lastReadSeq').defaultValue, 0);
  assert.equal(memberSchema.path('joinedAtSeq').defaultValue, 0);
  assert.equal(memberSchema.path('role').defaultValue, 'MEMBER');
  assert.equal(memberSchema.path('userId').isRequired, true);
});

test('ChatConversation: read-cursor and counter fields are non-negative', () => {
  const memberSchema = ChatConversation.schema.path('members').schema;

  assert.deepEqual(memberSchema.path('lastReadSeq').options.min, 0);
  assert.deepEqual(memberSchema.path('joinedAtSeq').options.min, 0);
  assert.deepEqual(ChatConversation.schema.path('lastMessageSeq').options.min, 0);
});

test('ChatConversation: member subdocuments carry no _id', () => {
  const memberSchema = ChatConversation.schema.path('members').schema;

  assert.equal(memberSchema.options._id, false);
  assert.equal(memberSchema.path('_id'), undefined);
});

test('ChatMessage: required fields exist', () => {
  for (const field of [
    'companyId',
    'conversationId',
    'senderUserId',
    'seq',
    'clientMessageId',
  ]) {
    assert.equal(
      ChatMessage.schema.path(field).isRequired,
      true,
      `${field} must be required`,
    );
  }
});

test('ChatMessage: identity fields are immutable so history cannot be rewritten', () => {
  for (const field of [
    'companyId',
    'conversationId',
    'senderUserId',
    'seq',
    'clientMessageId',
  ]) {
    assert.equal(
      ChatMessage.schema.path(field).options.immutable,
      true,
      `${field} must be immutable`,
    );
  }
});

test('ChatMessage: type enum is exactly TEXT | SYSTEM | FILE', () => {
  assert.deepEqual([...ChatMessage.schema.path('type').enumValues], [
    'TEXT',
    'SYSTEM',
    'FILE',
  ]);
  assert.deepEqual([...CHAT_MESSAGE_TYPES], ['TEXT', 'SYSTEM', 'FILE']);
  assert.equal(ChatMessage.schema.path('type').defaultValue, 'TEXT');
});

test('ChatMessage: edit and tombstone defaults start clean', () => {
  assert.equal(ChatMessage.schema.path('editVersion').defaultValue, 0);
  assert.deepEqual(ChatMessage.schema.path('editVersion').options.min, 0);
  assert.equal(ChatMessage.schema.path('editedAt').defaultValue, null);
  assert.equal(ChatMessage.schema.path('editedByUserId').defaultValue, null);
  assert.equal(ChatMessage.schema.path('deletedAt').defaultValue, null);
  assert.equal(ChatMessage.schema.path('deletedByUserId').defaultValue, null);
  assert.equal(ChatMessage.schema.path('text').defaultValue, null);
});

test('ChatMessage: seq starts at 1 and text is bounded', () => {
  assert.deepEqual(ChatMessage.schema.path('seq').options.min, 1);
  assert.equal(ChatMessage.schema.path('text').options.maxlength, CHAT_MESSAGE_TEXT_MAX);
  assert.equal(CHAT_MESSAGE_TEXT_MAX, 4000);
});

test('ChatMessageEdit: every field is required and bounded', () => {
  for (const field of [
    'companyId',
    'conversationId',
    'messageId',
    'version',
    'previousText',
    'editedAt',
    'editedByUserId',
  ]) {
    assert.equal(
      ChatMessageEdit.schema.path(field).isRequired,
      true,
      `${field} must be required`,
    );
  }

  assert.deepEqual(ChatMessageEdit.schema.path('version').options.min, 1);
  assert.equal(ChatMessageEdit.schema.path('previousText').options.maxlength, 4000);
});

test('ChatMessageEdit: identifying fields are immutable (append-only history)', () => {
  for (const field of [
    'companyId',
    'conversationId',
    'messageId',
    'version',
    'editedByUserId',
  ]) {
    assert.equal(
      ChatMessageEdit.schema.path(field).options.immutable,
      true,
      `${field} must be immutable`,
    );
  }
});

// ─────────────────────────────────────────────────────────────
//  5. CROSS-FIELD INVARIANTS (offline validate)
// ─────────────────────────────────────────────────────────────

test('invariant validators are actually registered', () => {
  assert.ok(ChatConversation.schema.path('directKey').validators.length >= 1);
  assert.ok(ChatConversation.schema.path('members').validators.length >= 1);
  assert.ok(ChatConversation.schema.path('title').validators.length >= 1);
  assert.ok(ChatMessage.schema.path('text').validators.length >= 1);
});

test('DIRECT: directKey is derived from the two member ids and sorted', async () => {
  const forward = new ChatConversation({
    companyId: tenant(),
    type: 'DIRECT',
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  const backward = new ChatConversation({
    companyId: tenant(),
    type: 'DIRECT',
    members: [{ userId: BOB }, { userId: ALICE }],
  });

  await forward.validate();
  await backward.validate();

  const expected = [ALICE, BOB].sort().join(':');

  assert.equal(forward.directKey, expected);
  assert.equal(backward.directKey, expected, 'member order must not change the key');
});

test('DIRECT: a client-supplied directKey is overwritten, never honoured', async () => {
  const document = new ChatConversation({
    companyId: tenant(),
    type: 'DIRECT',
    directKey: `${CAROL}:${ALICE}`,
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  await document.validate();

  assert.equal(document.directKey, [ALICE, BOB].sort().join(':'));
  assert.notEqual(document.directKey, `${CAROL}:${ALICE}`);
});

test('DIRECT: self-chat is rejected', async () => {
  const rejected = await rejectionPaths(ChatConversation, {
    companyId: tenant(),
    type: 'DIRECT',
    members: [{ userId: ALICE }, { userId: ALICE }],
  });

  assert.ok(rejected.includes('directKey'), 'self-chat must fail the directKey invariant');
  assert.ok(rejected.includes('members'), 'self-chat must fail the member invariant');
});

test('DIRECT: exactly two members are required', async () => {
  const tooFew = await rejectionPaths(ChatConversation, {
    companyId: tenant(),
    type: 'DIRECT',
    members: [{ userId: ALICE }],
  });

  const tooMany = await rejectionPaths(ChatConversation, {
    companyId: tenant(),
    type: 'DIRECT',
    members: [{ userId: ALICE }, { userId: BOB }, { userId: CAROL }],
  });

  assert.ok(tooFew.includes('members'));
  assert.ok(tooMany.includes('members'));
});

test('DIRECT: a title must not be set', async () => {
  const rejected = await rejectionPaths(ChatConversation, {
    companyId: tenant(),
    type: 'DIRECT',
    title: 'Not allowed',
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  assert.ok(rejected.includes('title'));
});

test('DIRECT: directKey is forced to null for GROUP', async () => {
  const document = new ChatConversation({
    companyId: tenant(),
    type: 'GROUP',
    directKey: `${ALICE}:${BOB}`,
    title: 'Design team',
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  await document.validate();

  assert.equal(document.directKey, null);
});

test('GROUP: a valid group validates and needs no directKey', async () => {
  const ok = await validateOk(ChatConversation, {
    companyId: tenant(),
    type: 'GROUP',
    title: 'Design team',
    members: [{ userId: ALICE }, { userId: BOB }, { userId: CAROL }],
  });

  assert.equal(ok, true);
});

test('GROUP: a title of at least 2 characters is required', async () => {
  const missing = await rejectionPaths(ChatConversation, {
    companyId: tenant(),
    type: 'GROUP',
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  const tooShort = await rejectionPaths(ChatConversation, {
    companyId: tenant(),
    type: 'GROUP',
    title: 'x',
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  assert.ok(missing.includes('title'));
  assert.ok(tooShort.includes('title'));
});

test('GROUP: membership is bounded 2..200', async () => {
  const one = await rejectionPaths(ChatConversation, {
    companyId: tenant(),
    type: 'GROUP',
    title: 'Solo',
    members: [{ userId: ALICE }],
  });

  const many = await validateOk(ChatConversation, {
    companyId: tenant(),
    type: 'GROUP',
    title: 'Whole company',
    members: Array.from({ length: 200 }, (_, index) => ({
      userId: hex(String(index % 10)),
    })),
  });

  const tooMany = await rejectionPaths(ChatConversation, {
    companyId: tenant(),
    type: 'GROUP',
    title: 'Too big',
    members: Array.from({ length: 201 }, (_, index) => ({
      userId: hex(String(index % 10)),
    })),
  });

  assert.ok(one.includes('members'));
  assert.equal(many, true, '200 members must be allowed');
  assert.ok(tooMany.includes('members'), '201 members must be refused');
});

test('an unknown conversation type is rejected by the enum', async () => {
  const rejected = await rejectionPaths(ChatConversation, {
    companyId: tenant(),
    type: 'CHANNEL',
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  assert.ok(rejected.includes('type'));
});

test('a missing companyId is rejected on every chat model', async () => {
  const conversation = await rejectionPaths(ChatConversation, {
    type: 'DIRECT',
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  const message = await rejectionPaths(ChatMessage, {
    conversationId: tenant(),
    senderUserId: tenant(),
    seq: 1,
    clientMessageId: 'client-1',
    type: 'TEXT',
    text: 'hello',
  });

  const edit = await rejectionPaths(ChatMessageEdit, {
    conversationId: tenant(),
    messageId: tenant(),
    version: 1,
    previousText: 'old',
    editedByUserId: tenant(),
  });

  assert.ok(conversation.includes('companyId'));
  assert.ok(message.includes('companyId'));
  assert.ok(edit.includes('companyId'));
});

test('ChatMessage: TEXT requires a body; SYSTEM and FILE must not carry one', async () => {
  const emptyText = await rejectionPaths(ChatMessage, {
    companyId: tenant(),
    conversationId: tenant(),
    senderUserId: tenant(),
    seq: 1,
    clientMessageId: 'client-1',
    type: 'TEXT',
    text: '   ',
  });

  const systemWithBody = await rejectionPaths(ChatMessage, {
    companyId: tenant(),
    conversationId: tenant(),
    senderUserId: tenant(),
    seq: 2,
    clientMessageId: 'client-2',
    type: 'SYSTEM',
    text: 'smuggled body',
  });

  const validText = await validateOk(ChatMessage, {
    companyId: tenant(),
    conversationId: tenant(),
    senderUserId: tenant(),
    seq: 3,
    clientMessageId: 'client-3',
    type: 'TEXT',
    text: 'hello',
  });

  const validSystem = await validateOk(ChatMessage, {
    companyId: tenant(),
    conversationId: tenant(),
    senderUserId: tenant(),
    seq: 4,
    clientMessageId: 'client-4',
    type: 'SYSTEM',
  });

  assert.ok(emptyText.includes('text'), 'blank TEXT must be refused');
  assert.ok(systemWithBody.includes('text'), 'SYSTEM body must be refused');
  assert.equal(validText, true);
  assert.equal(validSystem, true);
});

// The document path self-heals (see the next test), so the tombstone rule is
// pinned on the validator itself. That is the guard that actually protects
// 33.6: an atomic update opened with { runValidators: true } runs this
// validator and no pre-hook, so it is the only thing standing between a
// half-delete and deleted content staying readable.
const textShapeValidator = ChatMessage.schema.path('text').validators.find(
  (entry) => !('maxlength' in entry)
);

test('ChatMessage: the text validator refuses a tombstone that keeps its body', () => {
  assert.ok(textShapeValidator, 'a cross-field text validator must exist');

  const run = (doc, value) => textShapeValidator.validator.call(doc, value);

  assert.equal(run({ deletedAt: new Date(), type: 'TEXT' }, 'still here'), false);
  assert.equal(run({ deletedAt: new Date(), type: 'TEXT' }, null), true);
  assert.equal(run({ deletedAt: null, type: 'TEXT' }, 'hello'), true);
  assert.equal(run({ deletedAt: null, type: 'TEXT' }, '   '), false);
  assert.equal(run({ deletedAt: null, type: 'SYSTEM' }, 'smuggled'), false);
  assert.equal(run({ deletedAt: null, type: 'SYSTEM' }, null), true);
  assert.equal(run({ deletedAt: null, type: 'FILE' }, 'smuggled'), false);
});

test('ChatMessage: save() self-heals a tombstone instead of failing', async () => {
  const document = new ChatMessage({
    companyId: tenant(),
    conversationId: tenant(),
    senderUserId: tenant(),
    seq: 1,
    clientMessageId: 'client-1',
    type: 'TEXT',
    text: 'delete me',
    editVersion: 2,
    editedAt: new Date(),
    editedByUserId: tenant(),
  });

  document.deletedAt = new Date();
  document.deletedByUserId = tenant();

  await document.validate();

  assert.equal(document.text, null, 'body must be cleared');
  assert.equal(document.editVersion, 0, 'edit state must be cleared');
  assert.equal(document.editedAt, null);
  assert.equal(document.editedByUserId, null);
  assert.equal(document.seq, 1, 'seq must survive — history stays stable');
  assert.equal(document.clientMessageId, 'client-1', 'idempotency key must survive');
});

test('ChatMessageEdit: a valid history row validates', async () => {
  const ok = await validateOk(ChatMessageEdit, {
    companyId: tenant(),
    conversationId: tenant(),
    messageId: tenant(),
    version: 1,
    previousText: 'the text before the edit',
    editedByUserId: tenant(),
  });

  assert.equal(ok, true);
});

test('ChatMessageEdit: an empty previousText proves nothing and is refused', async () => {
  const rejected = await rejectionPaths(ChatMessageEdit, {
    companyId: tenant(),
    conversationId: tenant(),
    messageId: tenant(),
    version: 1,
    previousText: '   ',
    editedByUserId: tenant(),
  });

  assert.ok(rejected.includes('previousText'));
});

test('ChatMessageEdit: version 0 is not a valid revision', async () => {
  const rejected = await rejectionPaths(ChatMessageEdit, {
    companyId: tenant(),
    conversationId: tenant(),
    messageId: tenant(),
    version: 0,
    previousText: 'old',
    editedByUserId: tenant(),
  });

  assert.ok(rejected.includes('version'));
});

// ─────────────────────────────────────────────────────────────
//  6. C1 READ-CURSOR LAW — no embedded receipts
// ─────────────────────────────────────────────────────────────

test('C1: unread state is a per-member cursor, never a per-message receipt array', () => {
  const memberSchema = ChatConversation.schema.path('members').schema;

  assert.ok(memberSchema.path('lastReadSeq'), 'the read cursor must exist');
  assert.equal(
    ChatConversation.schema.path('lastMessageSeq') !== undefined,
    true,
    'the conversation counter must exist',
  );

  const forbidden = ['seenBy', 'readBy', 'receipts', 'readReceipts', 'deliveredTo'];

  for (const field of forbidden) {
    assert.equal(
      ChatMessage.schema.path(field),
      undefined,
      `ChatMessage must not embed ${field}`,
    );
    assert.equal(
      ChatConversation.schema.path(field),
      undefined,
      `ChatConversation must not embed ${field}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────
//  7. NO SURVEILLANCE
// ─────────────────────────────────────────────────────────────

test('no chat model tracks presence, activity or last-seen', () => {
  const forbidden = [
    'lastSeen',
    'lastSeenAt',
    'lastActive',
    'lastActiveAt',
    'isOnline',
    'online',
    'presence',
    'isTyping',
    'typing',
    'typingAt',
    'idleAt',
    'isActive',
    'activityAt',
    'seenAt',
    'readAt',
  ];

  for (const [name, Model] of Object.entries(MODELS)) {
    const paths = Object.keys(Model.schema.paths);

    for (const field of forbidden) {
      assert.equal(
        Model.schema.path(field),
        undefined,
        `${name} must not track ${field}`,
      );
    }

    // joinedAt is membership bookkeeping, not observation — assert the
    // distinction explicitly so a future "lastSeenAt" cannot sneak in
    // beside it under a similar name.
    assert.ok(
      !paths.some((path) => /lastSeen|isOnline|isTyping|idle/i.test(path)),
      `${name} has a presence-shaped field`,
    );
  }
});

// ─────────────────────────────────────────────────────────────
//  8. SOURCE-SHAPE PINS
// ─────────────────────────────────────────────────────────────

test('schema-declared only: no runtime index management anywhere in the chat models', async () => {
  for (const name of ['ChatConversation', 'ChatMessage', 'ChatMessageEdit']) {
    const code = stripComments(await readModelSource(name));

    for (const banned of ['createIndex', 'syncIndexes', 'dropIndex', 'ensureIndex']) {
      assert.equal(
        code.includes(banned),
        false,
        `${name}.js must not call ${banned} at runtime`,
      );
    }
  }
});

test('ESM + modern-syntax law holds in the chat models', async () => {
  for (const name of ['ChatConversation', 'ChatMessage', 'ChatMessageEdit']) {
    const code = stripComments(await readModelSource(name));

    assert.doesNotMatch(code, /\brequire\s*\(/, `${name}.js must not use require()`);
    assert.doesNotMatch(code, /\bmodule\.exports\b/, `${name}.js must not use module.exports`);
    assert.doesNotMatch(code, /\bvar\s+[a-zA-Z]/, `${name}.js must not use var`);
    assert.doesNotMatch(code, /Object\.assign\s*\(/, `${name}.js must not use Object.assign`);
    assert.doesNotMatch(code, /\.indexOf\s*\(/, `${name}.js must not use .indexOf()`);
    assert.doesNotMatch(code, /\.prototype\b/, `${name}.js must not touch .prototype`);
    assert.match(code, /^import mongoose from 'mongoose';/m, `${name}.js must be ESM`);
    assert.match(code, /export default mongoose\.model\(/, `${name}.js must default-export the model`);
  }
});

test('chat models never touch Redis, queues or the network', async () => {
  for (const name of ['ChatConversation', 'ChatMessage', 'ChatMessageEdit']) {
    const code = await readModelSource(name);

    for (const banned of ['redis', 'bullmq', 'ioredis', 'fetch(', 'axios', 'logger']) {
      assert.equal(
        stripComments(code).toLowerCase().includes(banned.toLowerCase()),
        false,
        `${name}.js must not reference ${banned}`,
      );
    }
  }
});

test('Mongoose 9 hook law: validate hooks take no next callback', async () => {
  // Mongoose 9 validate hooks are async-only. Declaring `next` and calling it
  // throws "next is not a function" on EVERY validation, which would break
  // every chat write path at once — so the shape is pinned here by name.
  for (const name of ['ChatConversation', 'ChatMessage', 'ChatMessageEdit']) {
    const code = stripComments(await readModelSource(name));

    assert.doesNotMatch(
      code,
      /pre\(\s*'validate'\s*,\s*function\s+\w+\s*\(\s*next\s*\)/,
      `${name}.js registers a pre('validate') hook that expects next`,
    );
  }
});

test('every registered chat hook runs without throwing (no callback-shape drift)', async () => {
  // Behavioural twin of the pin above: if any pre('validate') hook were
  // written against the Mongoose 8 callback signature, these would reject
  // with a TypeError instead of a ValidationError.
  const conversation = new ChatConversation({
    companyId: tenant(),
    type: 'DIRECT',
    members: [{ userId: ALICE }, { userId: BOB }],
  });

  const message = new ChatMessage({
    companyId: tenant(),
    conversationId: tenant(),
    senderUserId: tenant(),
    seq: 1,
    clientMessageId: 'client-hook',
    type: 'TEXT',
    text: 'hook check',
  });

  await conversation.validate();
  await message.validate();

  assert.equal(conversation.directKey, [ALICE, BOB].sort().join(':'));
  assert.equal(message.text, 'hook check');
});

test('bounded fields: no unbounded string enters the chat schema', async () => {
  const bounded = {
    ChatConversation: ['directKey', 'title', 'lastMessagePreview'],
    ChatMessage: ['clientMessageId', 'text'],
    ChatMessageEdit: ['previousText'],
  };

  for (const [name, fields] of Object.entries(bounded)) {
    for (const field of fields) {
      const path = MODELS[name].schema.path(field);

      assert.ok(path.options.maxlength > 0, `${name}.${field} must be bounded`);
    }
  }
});

test('chat models do not import other chat models (no load-order coupling)', async () => {
  for (const name of ['ChatConversation', 'ChatMessage', 'ChatMessageEdit']) {
    const code = await readModelSource(name);

    assert.doesNotMatch(
      code,
      /from '\.\/Chat(Conversation|Message|MessageEdit)\.js'/,
      `${name}.js must not import a sibling chat model`,
    );
  }
});

// ── 33.9-fix — the `text` validator must work on BOTH write paths ─────────
//
// Mongoose runs UPDATE validators (findOneAndUpdate/updateOne +
// runValidators) with `this` = the QUERY, not the document, and validates
// only the paths present in the update. The 33.6 validator read
// `this.type`/`this.deletedAt` unconditionally, so every atomic TEXT edit
// threw "TEXT messages require non-empty text..." — the throw escaped an
// async socket listener and drained the API (unhandled rejection).
//
// These tests drive the REAL schema validator exactly the way mongoose
// does (schema.path('text').doValidate(value, query, { updateValidator:
// true }), see lib/helpers/updateValidators.js) plus the offline document
// path, so the trap can never come back silently.

const oid = () => new ChatMessage.db.base.Types.ObjectId();

const updateProbe = async (update, value) => {
  const query = ChatMessage.findOneAndUpdate({ _id: oid(), companyId: oid() }, update);

  try {
    await ChatMessage.schema.path('text').doValidate(value, query, { updateValidator: true });
    return null;
  } catch (error) {
    return error.message;
  }
};

const docProbe = async (data) => {
  const doc = new ChatMessage({
    companyId: oid(),
    conversationId: oid(),
    senderUserId: oid(),
    seq: 1,
    clientMessageId: `c-${oid()}`,
    ...data,
  });

  try {
    await doc.validate();
    return { error: null, doc };
  } catch (error) {
    return { error: error.message, doc };
  }
};

test('33.9-fix: a legitimate atomic TEXT edit passes update validation', async () => {
  const failure = await updateProbe(
    { $set: { text: 'hih', editedAt: new Date(), editedByUserId: oid() } },
    'hih'
  );

  assert.equal(failure, null, 'the edit shape that crashed the API must validate');
});

test('33.9-fix: update validation still refuses an empty TEXT body', async () => {
  const failure = await updateProbe({ $set: { text: '   ' } }, '   ');

  assert.match(failure ?? '', /non-empty text/);
});

test('33.9-fix: the tombstone update validates, and carrying a body still fails', async () => {
  assert.equal(
    await updateProbe({ $set: { text: null, deletedAt: new Date() } }, null),
    null,
    'tombstone must stay valid'
  );

  assert.match(
    (await updateProbe({ $set: { text: 'leak', deletedAt: new Date() } }, 'leak')) ?? '',
    /must not carry body text/
  );
});

test('33.9-fix: a SYSTEM body is refused when the update names the type', async () => {
  assert.match(
    (await updateProbe({ $set: { type: 'SYSTEM', text: 'smuggled' } }, 'smuggled')) ?? '',
    /must not carry body text/
  );
});

test('33.9-fix: document validation semantics are unchanged', async () => {
  assert.equal((await docProbe({ type: 'TEXT', text: 'hello' })).error, null);

  assert.match((await docProbe({ type: 'TEXT', text: '' })).error ?? '', /non-empty text/);
  assert.match((await docProbe({ type: 'SYSTEM', text: 'x' })).error ?? '', /must not carry body text/);

  // Tombstoning a whole document self-heals: the pre('validate') hook nulls
  // the body instead of failing the write (33.2 contract).
  const tombstoned = await docProbe({ type: 'TEXT', text: 'x', deletedAt: new Date() });

  assert.equal(tombstoned.error, null);
  assert.equal(tombstoned.doc.text, null, 'the hook must redact the body');
  assert.equal(tombstoned.doc.editVersion, 0);
});

test('33.9-fix: the validator reads cross-field state from the update, not just `this`', async () => {
  const source = await readModelSource('ChatMessage');

  // The scope helper is the fix; without it the update path sees undefined.
  assert.match(source, /updateScopeOf/);
  assert.match(source, /scope\.getUpdate\(\)/);
  assert.match(source, /update\.\$setOnInsert/);
  // And the comment that misled 33.6 is gone.
  assert.doesNotMatch(source, /`this` is the document, which is what makes this cross-field/);
});
