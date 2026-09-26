// ============================================================
//  PHASE 33.10-fix2 — MESSAGE BODY RULES (HERMETIC).
//
//  WHY THIS SUITE EXISTS
//    Localhost acceptance showed a chat bubble carrying nothing but a
//    timestamp (2026-09-26, 10:57) in BOTH members' views. The stored body was
//    invisible: a zero-width space — the class of character that pastes in
//    from other apps. `String(text).trim()` removes only WhiteSpace and line
//    terminators, so an all-invisible body passed every "is it empty?" check:
//
//      validateSendPayload({ text: '\u200B' })  ->  { ok: true, text: '\u200B' }
//
//    That message was stored, broadcast and rendered as a hollow bubble.
//
//  THE LAW PINNED HERE
//    · a body must contain at least one VISIBLE character (backend authority:
//      utils/chatTextRules.js)
//    · the frontend mirror (Frontend/src/utils/chatText.js) agrees with the
//      backend on the same sample table — drift fails this suite
//    · send and edit refuse invisible-only bodies with their EXISTING messages
//    · the model's own validator refuses one at the schema level
//    · the ONE create path (persistMessage) refuses a mutation that would
//      render nothing: no visible body AND no attachment reference
//      (code EMPTY_BODY), before any DB work
//    · the socket answers EMPTY_BODY as a VALIDATION_ERROR with the rule, not
//      as a retryable server fault
//    · the UI cannot render a hollow bubble: the composer gate and the bubble
//      fallback are pinned
//
//  No Redis, no Mongo, no HTTP: pure rules, in-memory fakes.
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_body_rules';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import { hasVisibleText } from '../src/utils/chatTextRules.js';
import frontendTextRules from '../../Frontend/src/utils/chatText.js';
import {
  validateEditPayload,
  validateSendPayload,
  validateSendFilePayload,
} from '../src/socket/chatSocketValidators.js';
import {
  EMPTY_BODY_MESSAGE,
  sendFileMessage,
  sendTextMessage,
} from '../src/services/chat/chatMessageService.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';

const { ObjectId } = mongoose.Types;
const id = () => new ObjectId();

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendSrc = (rel) =>
  fs.readFileSync(path.join(here, '..', '..', 'Frontend', 'src', rel), 'utf8');

// ── the sample table (one table, three implementations) ───────────────────
const SAMPLES = [
  ['', false, 'empty string'],
  ['   ', false, 'spaces only'],
  ['\n\t ', false, 'whitespace only'],
  ['\u200B', false, 'zero-width space (the 2026-09-26 bubble)'],
  ['\u200B\u200B\u200B', false, 'several zero-width spaces'],
  ['\u200C', false, 'zero-width non-joiner'],
  ['\u200D', false, 'zero-width joiner'],
  ['\uFEFF', false, 'BOM / zero-width no-break space'],
  ['\uFE0F', false, 'orphan variation selector'],
  ['\u2060', false, 'word joiner'],
  ['\u00AD', false, 'soft hyphen'],
  ['\u3164', false, 'Hangul filler'],
  ['\uFFA0', false, 'halfwidth Hangul filler'],
  ['\u200B \uFE0F', false, 'invisibles plus a space'],
  ['\u0007', false, 'bell control character'],
  ['hello', true, 'plain text'],
  ['  hello  ', true, 'text with surrounding spaces'],
  ['\u200Bhello', true, 'invisible prefix, visible body'],
  ['\u0BB5\u0BA3\u0B95\u0BCD\u0B95\u0BAE\u0BCD', true, 'Tamil text'],
  ['\u{1F600}', true, 'emoji (no variation selector)'],
  ['\u2764\uFE0F', true, 'emoji plus variation selector'],
  ['a', true, 'single letter'],
  ['42', true, 'digits'],
];

test('hasVisibleText: an invisible-only body is not a body', () => {
  for (const [value, expected, why] of SAMPLES) {
    assert.equal(hasVisibleText(value), expected, `${why}: ${JSON.stringify(value)}`);
  }

  // Never throws, never guesses for non-strings.
  assert.equal(hasVisibleText(null), false);
  assert.equal(hasVisibleText(undefined), false);
  assert.equal(hasVisibleText(42), false);
  assert.equal(hasVisibleText({ text: 'hi' }), false);
});

test('the frontend mirror agrees with the backend on every sample', () => {
  assert.equal(typeof frontendTextRules, 'function', 'the mirror exports a function');

  for (const [value, expected, why] of SAMPLES) {
    assert.equal(
      frontendTextRules(value),
      expected,
      `frontend mirror disagrees on ${why}: ${JSON.stringify(value)}`,
    );
    assert.equal(
      frontendTextRules(value),
      hasVisibleText(value),
      `frontend/backend drift on ${why}`,
    );
  }
});

test('send refuses an invisible-only body with the existing message', () => {
  const conversationId = String(id());

  for (const [value, expected, why] of SAMPLES) {
    if (expected) continue;

    const parsed = validateSendPayload({
      conversationId,
      clientMessageId: 'c1',
      text: value,
    });

    assert.equal(parsed.ok, false, `${why} must be refused`);
    assert.equal(parsed.code, 'VALIDATION_ERROR');
    assert.equal(parsed.message, 'A message must not be empty.');
  }

  const ok = validateSendPayload({
    conversationId,
    clientMessageId: 'c2',
    text: '  \u200Bhello  ',
  });

  assert.equal(ok.ok, true);
  assert.equal(ok.text, '\u200Bhello'.replace('\u200B', '\u200B'), 'trimmed, still visible');
});

test('edit refuses an invisible-only body too', () => {
  const conversationId = String(id());
  const messageId = String(id());

  const refused = validateEditPayload({
    conversationId,
    messageId,
    expectedEditVersion: 0,
    newText: '\u200B\u200B',
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.message, 'The edited text must not be empty.');

  const accepted = validateEditPayload({
    conversationId,
    messageId,
    expectedEditVersion: 0,
    newText: 'fixed',
  });

  assert.equal(accepted.ok, true);
});

test('the model itself refuses an invisible TEXT body', () => {
  const base = {
    companyId: id(),
    conversationId: id(),
    senderUserId: id(),
    seq: 1,
    clientMessageId: 'm1',
    type: 'TEXT',
  };

  const invisible = new ChatMessage({ ...base, text: '\u200B' });
  const failure = invisible.validateSync();

  assert.ok(failure, 'an invisible body must fail validation');
  assert.match(String(failure.message), /non-empty text/);

  assert.equal(new ChatMessage({ ...base, text: 'hi' }).validateSync(), undefined);
  // A FILE message is legitimately body-less: its references are the content.
  assert.equal(
    new ChatMessage({
      ...base,
      type: 'FILE',
      text: null,
      attachments: [
        { attachmentId: id(), fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
      ],
    }).validateSync(),
    undefined,
  );
});

// ── the create-path invariant ─────────────────────────────────────────────

const installFakes = () => {
  const original = {
    convFindOne: ChatConversation.findOne,
    convFindOneAndUpdate: ChatConversation.findOneAndUpdate,
    msgFindOne: ChatMessage.findOne,
    msgCreate: ChatMessage.create,
  };

  const conversation = {
    _id: id(),
    companyId: id(),
    isDisabled: false,
    lastMessageSeq: 3,
    members: [{ userId: null }],
  };
  const senderUserId = id();
  conversation.members = [{ userId: senderUserId }];

  const created = [];

  ChatConversation.findOne = (filter) => ({
    lean: async () =>
      filter['members.userId'] && String(filter['members.userId']) !== String(senderUserId)
        ? null
        : conversation,
  });

  ChatConversation.findOneAndUpdate = () => ({
    lean: async () => {
      conversation.lastMessageSeq += 1;
      return conversation;
    },
  });

  ChatMessage.findOne = () => ({ lean: async () => null });

  ChatMessage.create = async (payload) => {
    created.push(payload);
    return { toObject: () => ({ _id: id(), createdAt: new Date(), ...payload }) };
  };

  const restore = () => {
    ChatConversation.findOne = original.convFindOne;
    ChatConversation.findOneAndUpdate = original.convFindOneAndUpdate;
    ChatMessage.findOne = original.msgFindOne;
    ChatMessage.create = original.msgCreate;
  };

  return { conversation, senderUserId, created, restore };
};

const reference = () => ({
  attachmentId: id(),
  fileName: 'quarterly.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
});

test('the create path refuses a mutation that would render nothing', async () => {
  const fakes = installFakes();

  try {
    const args = {
      companyId: fakes.conversation.companyId,
      senderUserId: fakes.senderUserId,
      conversationId: fakes.conversation._id,
      clientMessageId: 'c-empty',
    };

    // (a) an invisible body
    const invisible = await sendTextMessage({ ...args, text: '\u200B' });

    assert.equal(invisible.ok, false);
    assert.equal(invisible.code, 'EMPTY_BODY');
    assert.equal(invisible.message, EMPTY_BODY_MESSAGE);

    // (b) a FILE message with no references — a FILE message's content IS its
    //     attachments, so an empty list is the same hollow bubble.
    const noFiles = await sendFileMessage({ ...args, clientMessageId: 'c-files', attachments: [] });

    assert.equal(noFiles.ok, false);
    assert.equal(noFiles.code, 'EMPTY_BODY');

    // (c) and a missing list is not an empty one either
    const missing = await sendFileMessage({ ...args, clientMessageId: 'c-missing' });

    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'EMPTY_BODY');

    assert.equal(fakes.created.length, 0, 'nothing may be written for an unrenderable message');
  } finally {
    fakes.restore();
  }
});

test('the create path still writes renderable messages (text and file)', async () => {
  const fakes = installFakes();

  try {
    const args = {
      companyId: fakes.conversation.companyId,
      senderUserId: fakes.senderUserId,
      conversationId: fakes.conversation._id,
    };

    const text = await sendTextMessage({ ...args, clientMessageId: 't1', text: '  hello  ' });

    assert.equal(text.ok, true);
    assert.equal(text.created, true);

    const file = await sendFileMessage({
      ...args,
      clientMessageId: 'f1',
      attachments: [reference()],
    });

    assert.equal(file.ok, true);
    assert.equal(file.created, true);

    assert.equal(fakes.created.length, 2);
    assert.equal(fakes.created[0].type, 'TEXT');
    assert.equal(fakes.created[1].type, 'FILE');
    assert.equal(fakes.created[1].attachments.length, 1);
  } finally {
    fakes.restore();
  }
});

// ── the socket surface ────────────────────────────────────────────────────

const makeSocket = () => {
  const handlers = new Map();

  return {
    data: { companyId: String(id()), userId: String(id()) },
    on: (event, handler) => handlers.set(event, handler),
    join: () => {},
    leave: () => {},
    emit: () => {},
    handlers,
  };
};

test('the socket answers EMPTY_BODY as a VALIDATION_ERROR, never as retryable', async () => {
  const socket = makeSocket();
  const acks = [];

  registerChatSocketHandlers({
    io: { to: () => ({ emit: () => {} }) },
    socket,
    log: { warn: () => {}, error: () => {}, info: () => {} },
    loadConversation: async () => ({ _id: id(), isDisabled: false }),
    // Both senders report the invariant's verdict.
    sendMessage: async () => ({ ok: false, code: 'EMPTY_BODY', message: EMPTY_BODY_MESSAGE }),
    sendFile: async () => ({ ok: false, code: 'EMPTY_BODY', message: EMPTY_BODY_MESSAGE }),
    linkAttachments: async () => [reference()],
  });

  const handler = socket.handlers.get('chat:message:send');

  assert.ok(handler, 'the send handler is registered');

  await handler(
    { conversationId: String(id()), clientMessageId: 'c1', text: '\u200B' },
    (ack) => acks.push(ack),
  );

  assert.equal(acks.length, 1);
  assert.equal(acks[0].ok, false);
  assert.equal(acks[0].code, 'VALIDATION_ERROR');
  assert.equal(acks[0].message, EMPTY_BODY_MESSAGE);

  const fileHandler = socket.handlers.get('chat:message:sendFile');

  assert.ok(fileHandler, 'the FILE handler is registered');

  const fileAcks = [];

  await fileHandler(
    { conversationId: String(id()), clientMessageId: 'c2', attachmentIds: [String(id())] },
    (ack) => fileAcks.push(ack),
  );

  assert.equal(fileAcks[0].code, 'VALIDATION_ERROR');
  assert.equal(fileAcks[0].message, EMPTY_BODY_MESSAGE);
});

test('a FILE send still needs a non-empty id list at the validator', () => {
  const conversationId = String(id());

  const empty = validateSendFilePayload({ conversationId, clientMessageId: 'c1', attachmentIds: [] });

  assert.equal(empty.ok, false);
  assert.equal(empty.message, 'At least one file is required.');
});

// ── the UI cannot render a hollow bubble ─────────────────────────────────

test('the composer gate and the bubble fallback use the shared rule', () => {
  const composer = frontendSrc('components/chat/MessageComposer.jsx');

  assert.match(composer, /import \{ hasVisibleText \} from '\.\.\/\.\.\/utils\/chatText\.js'/);
  assert.match(composer, /hasVisibleText\(trimmed\)/, 'the send gate reads the rule');

  const bubble = frontendSrc('components/chat/MessageBubble.jsx');

  assert.match(bubble, /hasVisibleText\(message\.text\)/);
  assert.match(bubble, /This message could not be displayed/, 'a hollow row says so');

  const page = frontendSrc('pages/chat/ChatPage.jsx');

  assert.match(page, /hasVisibleText\(text\) \? text : 'Attachment'/, 'the optimistic row too');
});
