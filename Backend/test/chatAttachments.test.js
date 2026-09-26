// ============================================================
//  PHASE 33.10 — CHAT PRIVATE ATTACHMENTS (HERMETIC).
//
//  No Redis, no Mongo, no Cloudinary, no HTTP server: the real services
//  (chatAttachmentService, chatAttachmentStorage, chatMessageService,
//  chatEditService) and the real socket handler run against in-memory fakes
//  and an INJECTED storage seam (the `_store` / `_signer` / `_readLocal`
//  parameters the prompt requires), so nothing here can reach a provider.
//
//  Pinned behaviour:
//    · upload: non-member refused (404, no leak); cross-tenant refused;
//      member succeeds with a SERVER-BUILT key and no key/checksum in the
//      returned shape; scanState is NOT_CONFIGURED (never a fake CLEAN)
//    · upload caps: oversize refused, disallowed type refused, MIME lie on a
//      .pdf name refused (extension↔MIME cross-check)
//    · upload refused on a locked conversation (33.9 lock contract)
//    · download: non-member refused, cross-tenant refused, withdrawn
//      (removedAt) refused, traversal-shaped keys refused
//    · delivery: signed URL for Cloudinary rows, streamed bytes for the dev
//      local provider, and the controller emits Cache-Control
//      private,no-store,max-age=0 with a sanitized Content-Disposition
//    · FILE send: ids revalidated against tenant + conversation + unused;
//      an id from another conversation cannot be attached; the stored
//      message carries ONLY the metadata the service returned
//    · delete-for-everyone withdraws the attachments
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_attachments';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatAttachment from '../src/models/ChatAttachment.js';
import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import {
  authorizeAttachmentDownload,
  linkAttachmentsToMessage,
  uploadAttachment,
  withdrawMessageAttachments,
} from '../src/services/chat/chatAttachmentService.js';
import { resolveChatAttachmentDelivery } from '../src/services/chat/chatAttachmentStorage.js';
import { sendFileMessage } from '../src/services/chat/chatMessageService.js';
import { registerChatSocketHandlers } from '../src/socket/chatSocketHandlers.js';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  assertSafeStorageKey,
  buildAttachmentStorageKey,
  safeChatFileName,
} from '../src/utils/chatFileRules.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();

const COMPANY_A = id();
const COMPANY_B = id();
const MEMBER = id();
const OUTSIDER = id();

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');

// ── in-memory fakes ───────────────────────────────────────────────────────

const same = (a, b) => String(a) === String(b);

const installFakes = ({ conversations = [], attachments = [], messages = [] }) => {
  const original = {
    convFindOne: ChatConversation.findOne,
    convFindOneAndUpdate: ChatConversation.findOneAndUpdate,
    attCreate: ChatAttachment.create,
    attFindOne: ChatAttachment.findOne,
    attFind: ChatAttachment.find,
    attUpdateMany: ChatAttachment.updateMany,
    msgFindOne: ChatMessage.findOne,
    msgFind: ChatMessage.find,
    msgCreate: ChatMessage.create,
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

  ChatConversation.findOneAndUpdate = (_filter, update) => ({
    lean: async () => {
      const doc = conversations[0] ?? null;
      if (!doc) return null;

      if (update?.$inc?.lastMessageSeq) {
        doc.lastMessageSeq = (doc.lastMessageSeq ?? 0) + update.$inc.lastMessageSeq;
      }

      if (update?.$set) {
        for (const [key, value] of Object.entries(update.$set)) doc[key] = value;
      }

      return doc;
    },
  });

  ChatAttachment.create = async (payload) => {
    const row = {
      _id: id(),
      createdAt: new Date(),
      removedAt: null,
      scanCheckedAt: null,
      ...payload,
    };
    attachments.push(row);
    return row;
  };

  ChatAttachment.find = (filter) => ({
    lean: async () => {
      const quoted = (filter._id?.$in ?? []).map(String);

      return attachments.filter(
        (doc) =>
          quoted.includes(String(doc._id)) &&
          same(doc.companyId, filter.companyId) &&
          same(doc.conversationId, filter.conversationId) &&
          (!('removedAt' in filter) || !doc.removedAt)
      );
    },
  });

  ChatAttachment.findOne = (filter) => ({
    select: () => ({
      lean: async () =>
        attachments.find(
          (doc) =>
            (!filter._id || same(doc._id, filter._id)) &&
            same(doc.companyId, filter.companyId)
        ) ?? null,
    }),
  });

  ChatAttachment.updateMany = async (filter, update) => {
    const wanted = (filter._id?.$in ?? []).map(String);
    let modifiedCount = 0;

    for (const row of attachments) {
      if (!wanted.includes(String(row._id))) continue;
      if (!same(row.companyId, filter.companyId)) continue;
      if (filter.conversationId && !same(row.conversationId, filter.conversationId)) continue;
      if (filter.removedAt === null && row.removedAt) continue;
      row.removedAt = update.$set.removedAt;
      modifiedCount += 1;
    }

    return { modifiedCount };
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

  ChatMessage.find = (filter) => ({
    select: () => ({
      lean: async () => {
        const quoted = filter['attachments.attachmentId']?.$in ?? [];

        return messages.filter(
          (doc) =>
            same(doc.companyId, filter.companyId) &&
            same(doc.conversationId, filter.conversationId) &&
            (doc.attachments ?? []).some((row) =>
              quoted.some((wanted) => same(wanted, row.attachmentId))
            )
        );
      },
    }),
    lean: async () =>
      messages.filter(
        (doc) =>
          same(doc.companyId, filter.companyId) &&
          same(doc.conversationId, filter.conversationId)
      ),
  });

  ChatMessage.create = async (payload) => {
    const row = { _id: id(), createdAt: new Date(), editVersion: 0, ...payload };
    messages.push(row);
    return { toObject: () => row };
  };

  return {
    attachments,
    messages,
    restore: () => {
      ChatConversation.findOne = original.convFindOne;
      ChatConversation.findOneAndUpdate = original.convFindOneAndUpdate;
      ChatAttachment.create = original.attCreate;
      ChatAttachment.findOne = original.attFindOne;
      ChatAttachment.find = original.attFind;
      ChatAttachment.updateMany = original.attUpdateMany;
      ChatMessage.findOne = original.msgFindOne;
      ChatMessage.find = original.msgFind;
      ChatMessage.create = original.msgCreate;
    },
  };
};

const memberOf = (userId, role = 'MEMBER') => ({
  userId,
  role,
  joinedAt: new Date(),
  joinedAtSeq: 0,
  lastReadSeq: 0,
});

const seedConversation = ({ companyId = COMPANY_A, isDisabled = false } = {}) => ({
  _id: id(),
  companyId,
  type: 'GROUP',
  title: 'Design',
  members: [memberOf(MEMBER), memberOf(OUTSIDER)],
  lastMessageSeq: 0,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastMessageSenderUserId: null,
  isDisabled,
});

// The injected storage seam: records what would have been stored.
const fakeStore = (calls) => async ({ buffer, companyId, conversationId }) => {
  const storageKey = buildAttachmentStorageKey({ companyId, conversationId });
  calls.push({ buffer, storageKey });
  return { storageProvider: 'CLOUDINARY_AUTHENTICATED', storageKey };
};

const upload = ({ conversation, file, store, overrides = {} }) => {
  const fakes = installFakes({ conversations: [conversation] });

  return uploadAttachment({
    companyId: overrides.companyId ?? COMPANY_A,
    userId: overrides.userId ?? MEMBER,
    conversationId: conversation._id,
    file,
    _store: store ?? fakeStore([]),
    _model: ChatAttachment,
    _conversationModel: ChatConversation,
  }).finally(() => fakes.restore());
};

// ── 1. upload authorization + shape ───────────────────────────────────────

test('a non-member cannot upload (404, and nothing is stored)', async () => {
  const conversation = seedConversation();
  const stored = [];

  await assert.rejects(
    () =>
      upload({
        conversation,
        file: { originalname: 'note.pdf', mimetype: 'application/pdf', buffer: PDF },
        store: fakeStore(stored),
        overrides: { userId: id() },
      }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.message, 'Conversation not found.');
      return true;
    }
  );

  assert.equal(stored.length, 0, 'no bytes may be stored for a refused upload');
});

test('a cross-tenant upload is refused with the same 404 shape', async () => {
  const conversation = seedConversation({ companyId: COMPANY_B });
  const stored = [];

  await assert.rejects(
    () =>
      upload({
        conversation,
        file: { originalname: 'note.pdf', mimetype: 'application/pdf', buffer: PDF },
        store: fakeStore(stored),
      }),
    (error) => error.statusCode === 404
  );

  assert.equal(stored.length, 0);
});

test('a member upload returns display metadata only — never a key or checksum', async () => {
  const conversation = seedConversation();
  const fakes = installFakes({ conversations: [conversation] });
  const stored = [];

  try {
    const attachment = await uploadAttachment({
      companyId: COMPANY_A,
      userId: MEMBER,
      conversationId: conversation._id,
      file: { originalname: 'Quarterly Report.pdf', mimetype: 'application/pdf', buffer: PDF },
      _store: fakeStore(stored),
      _model: ChatAttachment,
      _conversationModel: ChatConversation,
    });

    // The row (with the key) exists...
    assert.equal(fakes.attachments.length, 1);
    const row = fakes.attachments[0];

    assert.equal(row.storageProvider, 'CLOUDINARY_AUTHENTICATED');
    assert.ok(row.storageKey.startsWith('crewly-private-chat-attachments/'));
    assert.ok(
      row.storageKey.includes(String(COMPANY_A)),
      'the key must be tenant-scoped'
    );
    assert.equal(row.originalFileName, 'Quarterly Report.pdf');
    assert.equal(row.sizeBytes, PDF.length);
    assert.equal(row.checksumSha256.length, 64);
    assert.equal(row.scanStatus, 'NOT_CONFIGURED');
    assert.equal(row.scanCheckedAt, null);

    // ...but the RESPONSE never carries it.
    const serialized = JSON.stringify(attachment);

    assert.ok(!serialized.includes(row.storageKey), 'the key must not be returned');
    assert.ok(!serialized.includes(row.checksumSha256), 'the checksum must not be returned');
    assert.ok(!serialized.toLowerCase().includes('url'), 'no URL of any kind');
    assert.deepEqual(Object.keys(attachment).sort(), [
      '_id',
      'conversationId',
      'createdAt',
      'fileName',
      'mimeType',
      'scanState',
      'sizeBytes',
    ]);
    assert.equal(attachment.scanState, 'NOT_CONFIGURED', 'never a fake CLEAN');
    assert.equal(attachment.fileName, 'Quarterly Report.pdf');
  } finally {
    fakes.restore();
  }
});

test('the server builds the key: caller input cannot reach it', async () => {
  const conversation = seedConversation();
  const key = buildAttachmentStorageKey({
    companyId: COMPANY_A,
    conversationId: conversation._id,
  });

  assert.ok(key.includes(`/${String(COMPANY_A)}/${String(conversation._id)}/`));
  assert.ok(!key.includes('..'));
  assert.match(key.split('/').pop(), /^[0-9a-f-]{36}$/);
});

// ── 2. upload caps ────────────────────────────────────────────────────────

test('an oversize file is refused before any storage call', async () => {
  const conversation = seedConversation();
  const stored = [];

  await assert.rejects(
    () =>
      upload({
        conversation,
        file: {
          originalname: 'big.pdf',
          mimetype: 'application/pdf',
          buffer: Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES + 1),
        },
        store: fakeStore(stored),
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /10 MB or smaller/);
      return true;
    }
  );

  assert.equal(stored.length, 0);
});

test('a disallowed type is refused, and a MIME lie on a .pdf name is refused too', async () => {
  const conversation = seedConversation();

  await assert.rejects(
    () =>
      upload({
        conversation,
        file: { originalname: 'script.js', mimetype: 'application/javascript', buffer: PDF },
      }),
    (error) => error.statusCode === 400
  );

  // The cross-check: an executable named .pdf with a non-PDF MIME.
  await assert.rejects(
    () =>
      upload({
        conversation,
        file: {
          originalname: 'invoice.pdf',
          mimetype: 'application/x-msdownload',
          buffer: Buffer.from('MZ'),
        },
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /PDF, JPG, JPEG, PNG, or WEBP/);
      return true;
    }
  );
});

test('a locked conversation refuses uploads (the 33.9 lock covers files)', async () => {
  const conversation = seedConversation({ isDisabled: true });
  const stored = [];

  await assert.rejects(
    () =>
      upload({
        conversation,
        file: { originalname: 'note.pdf', mimetype: 'application/pdf', buffer: PDF },
        store: fakeStore(stored),
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /disabled/i);
      return true;
    }
  );

  assert.equal(stored.length, 0);
});

test('safeChatFileName neutralizes path and header characters', () => {
  assert.equal(safeChatFileName('../../etc/passwd.pdf', '.pdf'), 'passwd.pdf');
  // Control characters are stripped; quote-class characters become '_'.
  assert.equal(safeChatFileName('re"port\n.pdf', '.pdf'), 're_port.pdf');
  assert.equal(safeChatFileName('', '.pdf'), 'attachment.pdf');
});

// ── 3. download authorization + delivery ──────────────────────────────────

const seedAttachment = ({ conversation, companyId = COMPANY_A, provider = 'CLOUDINARY_AUTHENTICATED' }) => ({
  _id: id(),
  companyId,
  conversationId: conversation._id,
  uploadedByUserId: MEMBER,
  storageProvider: provider,
  storageKey:
    provider === 'CLOUDINARY_AUTHENTICATED'
      ? `crewly-private-chat-attachments/${companyId}/${conversation._id}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`
      : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  checksumSha256: 'a'.repeat(64),
  originalFileName: 'Quarterly Report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  scanStatus: 'NOT_CONFIGURED',
  removedAt: null,
});

test('download authorization: member yes; non-member, cross-tenant and withdrawn no', async () => {
  const conversation = seedConversation();
  const attachment = seedAttachment({ conversation });
  const fakes = installFakes({ conversations: [conversation], attachments: [attachment] });

  try {
    const allowed = await authorizeAttachmentDownload({
      companyId: COMPANY_A,
      userId: MEMBER,
      attachmentId: attachment._id,
      _model: ChatAttachment,
      _conversationModel: ChatConversation,
    });

    assert.equal(String(allowed._id), String(attachment._id));
    assert.ok(allowed.storageKey, 'the key is read back only here (select:+storageKey)');

    // Non-member (a real user, not in this conversation).
    await assert.rejects(
      () =>
        authorizeAttachmentDownload({
          companyId: COMPANY_A,
          userId: id(),
          attachmentId: attachment._id,
          _model: ChatAttachment,
          _conversationModel: ChatConversation,
        }),
      (error) => error.statusCode === 404
    );

    // Cross-tenant: the row is not even visible.
    await assert.rejects(
      () =>
        authorizeAttachmentDownload({
          companyId: COMPANY_B,
          userId: MEMBER,
          attachmentId: attachment._id,
          _model: ChatAttachment,
          _conversationModel: ChatConversation,
        }),
      (error) => error.statusCode === 404
    );

    // Withdrawn (delete-for-everyone).
    attachment.removedAt = new Date();

    await assert.rejects(
      () =>
        authorizeAttachmentDownload({
          companyId: COMPANY_A,
          userId: MEMBER,
          attachmentId: attachment._id,
          _model: ChatAttachment,
          _conversationModel: ChatConversation,
        }),
      (error) => error.statusCode === 404
    );
  } finally {
    fakes.restore();
  }
});

test('traversal-shaped storage keys are refused on the read path', () => {
  for (const bad of [
    '../secrets',
    'crewly-private-chat-attachments/../../etc/passwd',
    'crewly-private-chat-attachments%2F..%2Fetc',
    '/absolute/path',
    'crewly-private\\chat',
    '',
  ]) {
    assert.throws(() => assertSafeStorageKey(bad), /File not found/, `must refuse: ${bad}`);
  }

  assert.equal(
    assertSafeStorageKey('crewly-private-chat-attachments/abc/def/file.png'),
    'crewly-private-chat-attachments/abc/def/file.png'
  );
});

test('delivery streams through the backend for both providers', async () => {
  const conversation = seedConversation();

  // Cloudinary rows: a signed URL is minted internally, followed immediately,
  // and the bytes come back — the client never sees a provider URL.
  const signerCalls = [];
  let fetchedUrl = null;

  const remote = await resolveChatAttachmentDelivery({
    attachment: seedAttachment({ conversation }),
    _signer: ({ storageKey }) => {
      signerCalls.push(storageKey);
      return { url: 'https://res.cloudinary.test/signed-internal', expiresAt: 1 };
    },
    _fetch: async (url) => {
      fetchedUrl = url;
      return {
        ok: true,
        headers: { get: () => '11' },
        body: (async function* stream() {
          yield Buffer.from('hello');
          yield Buffer.from('-bytes');
        })(),
      };
    },
  });

  assert.equal(remote.kind, 'INLINE', 'the client receives bytes, not a URL');
  assert.equal(remote.bytes.toString(), 'hello-bytes');
  assert.equal(remote.contentType, 'application/pdf');
  assert.equal(signerCalls.length, 1, 'the signer runs only after authorization');
  assert.equal(fetchedUrl, 'https://res.cloudinary.test/signed-internal');
  assert.ok(!JSON.stringify(remote).includes('res.cloudinary.test'), 'no provider URL leaves the module');

  // Dev-local rows: read straight off disk.
  const local = await resolveChatAttachmentDelivery({
    attachment: seedAttachment({ conversation, provider: 'LOCAL_PRIVATE' }),
    _readLocal: async () => Buffer.from('bytes'),
  });

  assert.equal(local.kind, 'INLINE');
  assert.equal(local.bytes.toString(), 'bytes');

  // A row whose provider is unknown is indistinguishable from missing.
  await assert.rejects(
    () =>
      resolveChatAttachmentDelivery({
        attachment: { ...seedAttachment({ conversation }), storageProvider: 'LEGACY_PUBLIC_URL' },
      }),
    (error) => error.statusCode === 404
  );
});

test('a provider failure or oversize remote body degrades to 503/413, never a crash', async () => {
  const conversation = seedConversation();
  const attachment = seedAttachment({ conversation });

  // No credentials / signer unavailable.
  await assert.rejects(
    () =>
      resolveChatAttachmentDelivery({
        attachment,
        _signer: () => {
          throw new Error('storage not configured');
        },
      }),
    (error) => error.statusCode === 503
  );

  // Provider answered but the body is beyond the cap.
  await assert.rejects(
    () =>
      resolveChatAttachmentDelivery({
        attachment,
        _signer: () => ({ url: 'https://res.cloudinary.test/signed-internal', expiresAt: 1 }),
        _fetch: async () => ({
          ok: true,
          headers: { get: () => String(CHAT_ATTACHMENT_MAX_BYTES + 1) },
          body: (async function* stream() {})(),
        }),
      }),
    (error) => error.statusCode === 413
  );

  // Network failure.
  await assert.rejects(
    () =>
      resolveChatAttachmentDelivery({
        attachment,
        _signer: () => ({ url: 'https://res.cloudinary.test/signed-internal', expiresAt: 1 }),
        _fetch: async () => {
          throw new Error('ECONNRESET');
        },
      }),
    (error) => error.statusCode === 503
  );
});

test('a dev-local read failure surfaces as 404, never as a 500', async () => {
  const conversation = seedConversation();

  await assert.rejects(
    () =>
      resolveChatAttachmentDelivery({
        attachment: seedAttachment({ conversation, provider: 'LOCAL_PRIVATE' }),
        _readLocal: async () => {
          throw new Error('ENOENT');
        },
      }),
    (error) => error.statusCode === 404
  );
});

// ── 4. FILE message send (linking rules) ──────────────────────────────────

test('linking revalidates tenant + conversation + unused', async () => {
  const conversation = seedConversation();
  const otherConversation = seedConversation();
  const attachment = seedAttachment({ conversation, provider: 'LOCAL_PRIVATE' });

  const fakes = installFakes({
    conversations: [conversation, otherConversation],
    attachments: [attachment],
  });

  try {
    const linked = await linkAttachmentsToMessage({
      companyId: COMPANY_A,
      conversationId: conversation._id,
      attachmentIds: [String(attachment._id)],
      _model: ChatAttachment,
      _messageModel: ChatMessage,
    });

    assert.equal(linked.length, 1);
    assert.deepEqual(Object.keys(linked[0]).sort(), [
      'attachmentId',
      'fileName',
      'mimeType',
      'sizeBytes',
    ]);
    assert.ok(
      !JSON.stringify(linked).includes(attachment.storageKey),
      'a message reference must never carry the storage key'
    );

    // Another conversation cannot claim it.
    await assert.rejects(
      () =>
        linkAttachmentsToMessage({
          companyId: COMPANY_A,
          conversationId: otherConversation._id,
          attachmentIds: [String(attachment._id)],
          _model: ChatAttachment,
          _messageModel: ChatMessage,
        }),
      (error) => error.statusCode === 400
    );

    // Another tenant cannot claim it.
    await assert.rejects(
      () =>
        linkAttachmentsToMessage({
          companyId: COMPANY_B,
          conversationId: conversation._id,
          attachmentIds: [String(attachment._id)],
          _model: ChatAttachment,
          _messageModel: ChatMessage,
        }),
      (error) => error.statusCode === 400
    );

    // Once a message references it, the id is spent.
    fakes.messages.push({
      _id: id(),
      companyId: COMPANY_A,
      conversationId: conversation._id,
      attachments: [{ attachmentId: attachment._id }],
    });

    await assert.rejects(
      () =>
        linkAttachmentsToMessage({
          companyId: COMPANY_A,
          conversationId: conversation._id,
          attachmentIds: [String(attachment._id)],
          _model: ChatAttachment,
          _messageModel: ChatMessage,
        }),
      (error) => {
        assert.match(error.message, /already sent/);
        return true;
      }
    );
  } finally {
    fakes.restore();
  }
});

test('sendFileMessage stores references and a generic preview, never a filename', async () => {
  const conversation = seedConversation();
  const fakes = installFakes({ conversations: [conversation] });

  try {
    const result = await sendFileMessage({
      companyId: COMPANY_A,
      senderUserId: MEMBER,
      conversationId: conversation._id,
      clientMessageId: 'c-file-1',
      attachments: [
        { attachmentId: id(), fileName: 'Quarterly Report.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.message.type, 'FILE');
    assert.equal(result.message.text, null, 'a FILE message carries no body text');
    assert.equal(result.message.attachments.length, 1);
    assert.equal(conversation.lastMessagePreview, 'Attachment');
  } finally {
    fakes.restore();
  }
});

test('withdrawMessageAttachments marks the rows removed (delete-for-everyone)', async () => {
  const conversation = seedConversation();
  const attachment = seedAttachment({ conversation });
  const fakes = installFakes({ conversations: [conversation], attachments: [attachment] });

  try {
    const result = await withdrawMessageAttachments({
      companyId: COMPANY_A,
      conversationId: conversation._id,
      attachments: [{ attachmentId: attachment._id }],
      _model: ChatAttachment,
    });

    assert.equal(result.removed, 1);
    assert.ok(attachment.removedAt instanceof Date);

    // Idempotent: a second call finds nothing left to withdraw.
    const again = await withdrawMessageAttachments({
      companyId: COMPANY_A,
      conversationId: conversation._id,
      attachments: [{ attachmentId: attachment._id }],
      _model: ChatAttachment,
    });

    assert.equal(again.removed, 0);
  } finally {
    fakes.restore();
  }
});

// ── 5. socket path ────────────────────────────────────────────────────────

const makeSocket = () => {
  const handlers = {};

  return {
    id: 'sock-attachments',
    data: { companyId: COMPANY_A, userId: MEMBER },
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

test('socket sendFile: invalid ids are a VALIDATION_ERROR, and no send happens', async () => {
  const broadcasts = [];
  const socket = makeSocket();
  let sendCalls = 0;

  registerChatSocketHandlers({
    io: makeIo(broadcasts),
    socket,
    log: { warn: () => {} },
    sendFile: async () => {
      sendCalls += 1;
      return { ok: true, message: {}, created: true };
    },
  });

  const ack = await socket.trigger('chat:message:sendFile', {
    conversationId: id(),
    clientMessageId: 'c-1',
    attachmentIds: ['not-an-object-id'],
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'VALIDATION_ERROR');
  assert.equal(sendCalls, 0, 'a malformed frame must never reach the send path');
  assert.equal(broadcasts.length, 0);
});

test('socket sendFile: a rejected link is refused and nothing is broadcast', async () => {
  const broadcasts = [];
  const socket = makeSocket();
  let sendCalls = 0;

  registerChatSocketHandlers({
    io: makeIo(broadcasts),
    socket,
    log: { warn: () => {} },
    linkAttachments: async () => {
      throw new Error('One or more attachments are not available in this conversation.');
    },
    sendFile: async () => {
      sendCalls += 1;
      return { ok: true, message: {}, created: true };
    },
  });

  const ack = await socket.trigger('chat:message:sendFile', {
    conversationId: id(),
    clientMessageId: 'c-1',
    attachmentIds: [String(id())],
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'VALIDATION_ERROR');
  assert.match(ack.message, /not available/);
  assert.equal(sendCalls, 0);
  assert.equal(broadcasts.length, 0);
});

test('socket sendFile: success broadcasts the reference-only message', async () => {
  const broadcasts = [];
  const socket = makeSocket();
  const conversationId = id();
  const attachmentId = id();

  registerChatSocketHandlers({
    io: makeIo(broadcasts),
    socket,
    log: { warn: () => {} },
    linkAttachments: async ({ attachmentIds }) => [
      {
        attachmentId: attachmentIds[0],
        fileName: 'Quarterly Report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      },
    ],
    sendFile: async ({ attachments }) => ({
      ok: true,
      created: true,
      message: {
        _id: id(),
        seq: 1,
        senderUserId: MEMBER,
        type: 'FILE',
        text: null,
        attachments,
        clientMessageId: 'c-1',
        editVersion: 0,
        deletedAt: null,
        createdAt: new Date(),
      },
    }),
  });

  const ack = await socket.trigger('chat:message:sendFile', {
    conversationId,
    clientMessageId: 'c-1',
    attachmentIds: [String(attachmentId)],
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.data.message.type, 'FILE');
  assert.equal(ack.data.message.attachments.length, 1);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event, 'chat:message:created');
  assert.equal(String(broadcasts[0].payload.message.attachments[0].attachmentId), String(attachmentId));

  const serialized = JSON.stringify(broadcasts[0].payload);

  assert.ok(!serialized.includes('storageKey'));
  assert.ok(!serialized.toLowerCase().includes('http'), 'no URL may be broadcast');
});

// ── 6. download HTTP headers (controller, real local-provider branch) ─────

// asyncHandler() does NOT return the handler's promise
// (`Promise.resolve(fn(...)).catch(next)`), so a controller must be awaited
// by SETTLEMENT — resolved on send/redirect, rejected on next(error) — not by
// its return value. This helper is the honest way to test a thin controller.
const runController = (handler, req, res) =>
  new Promise((resolve, reject) => {
    const settle = () => resolve();

    res.send = (body) => {
      res.sentBody = body;
      settle();
      return res;
    };
    res.redirect = (status, url) => {
      res.redirectedTo = { status, url };
      settle();
      return res;
    };

    handler(req, res, (error) => (error ? reject(error) : settle()));
  });


// This exercises the ACTUAL delivery path for the dev-local provider: a real
// file in the (gitignored) private_storage directory is streamed through the
// controller, and the HTTP contract is asserted on the way out. No Cloudinary
// account, no network — but also no stubbed delivery, so the headers under
// test are the ones production sends.
test('the download controller streams privately: private,no-store + sanitized name', async () => {
  const { readFile, writeFile, rm, mkdir } = await import('node:fs/promises');
  const path = await import('node:path');

  const { downloadAttachment } = await import('../src/controllers/chat/chatController.js');
  const storage = await import('../src/services/chat/chatAttachmentStorage.js');

  const conversation = seedConversation();
  const fileName = 'Quarterly Report.pdf';
  const localKey = `${id()}-stream-test`;

  await mkdir(storage.LOCAL_DIRECTORY, { recursive: true });
  const filePath = path.join(storage.LOCAL_DIRECTORY, localKey);
  const payload = Buffer.from('%PDF-1.7 staged bytes %%EOF');
  await writeFile(filePath, payload);

  const row = {
    ...seedAttachment({ conversation, provider: 'LOCAL_PRIVATE' }),
    storageKey: localKey,
    originalFileName: fileName,
  };

  const originalFindOne = ChatAttachment.findOne;
  const originalConvFindOne = ChatConversation.findOne;

  ChatAttachment.findOne = () => ({ select: () => ({ lean: async () => row }) });
  ChatConversation.findOne = () => ({ lean: async () => conversation });

  const headers = {};
  const res = {
    set: (key, value) => {
      headers[key] = value;
      return res;
    },
    setHeader: (key, value) => {
      headers[key] = value;
    },
    status: (code) => {
      headers.statusCode = code;
      return res;
    },
  };

  try {
    await runController(
      downloadAttachment,
      { params: { attachmentId: String(row._id) }, companyId: COMPANY_A, user: { _id: MEMBER } },
      res
    );
  } finally {
    ChatAttachment.findOne = originalFindOne;
    ChatConversation.findOne = originalConvFindOne;
    await rm(filePath, { force: true });
  }

  assert.equal(headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Content-Type'], 'application/pdf');
  assert.match(headers['Content-Disposition'], /^attachment; filename="Quarterly Report\.pdf"$/);
  assert.equal(headers.statusCode, 200);
  assert.equal(Buffer.compare(res.sentBody, payload), 0, 'the exact stored bytes are streamed');

  await assert.rejects(() => readFile(filePath), /ENOENT/, 'the test cleaned up after itself');
});

test('the download controller refuses a non-member before any storage read', async () => {
  const { downloadAttachment } = await import('../src/controllers/chat/chatController.js');

  const conversation = seedConversation();
  const row = seedAttachment({ conversation, provider: 'LOCAL_PRIVATE' });

  const originalFindOne = ChatAttachment.findOne;
  const originalConvFindOne = ChatConversation.findOne;

  ChatAttachment.findOne = () => ({ select: () => ({ lean: async () => row }) });
  // A non-member sees no conversation at all (the endpoint's only yes/no).
  ChatConversation.findOne = () => ({ lean: async () => null });

  const headers = {};
  const res = {
    set: (key, value) => {
      headers[key] = value;
      return res;
    },
    setHeader: (key, value) => {
      headers[key] = value;
    },
    status: (code) => {
      headers.statusCode = code;
      return res;
    },
  };

  let failure = null;

  try {
    await runController(
      downloadAttachment,
      { params: { attachmentId: String(row._id) }, companyId: COMPANY_A, user: { _id: id() } },
      res
    );
  } catch (error) {
    failure = error;
  } finally {
    ChatAttachment.findOne = originalFindOne;
    ChatConversation.findOne = originalConvFindOne;
  }

  assert.ok(failure, 'the download must refuse');
  assert.equal(failure.statusCode, 404);
  assert.equal(res.sentBody, undefined, 'no bytes may be sent to a non-member');
  assert.equal(headers['Content-Disposition'], undefined, 'and no filename either');
});
