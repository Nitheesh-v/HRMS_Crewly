// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.2 — CHAT MESSAGE (persistence layer only)
//
//  WHAT THIS IS
//    One message inside one conversation. Tenant-scoped, sequence-numbered,
//    idempotent, editable (with a separate append-only history), and
//    deletable only as a tombstone.
//
//  WHAT THIS IS NOT
//    Nothing writes these documents yet. seq is NOT allocated here — 33.5
//    allocates it from an atomic $inc on ChatConversation.lastMessageSeq (or
//    TenantSequence), because two concurrent senders must never receive the
//    same number. This model only demands that seq exists and is immutable
//    once written.
//
//  CORRECTNESS INVARIANTS (all schema-declared)
//   - companyId + conversationId + seq is the ordering key for history. seq
//     is required and immutable: a message that could move would make every
//     read cursor in ChatConversation.members meaningless.
//   - (companyId, conversationId, senderUserId, clientMessageId) is UNIQUE.
//     clientMessageId is the client's idempotency key, so a retried send is
//     an upsert-shaped conflict, not a duplicate message. This is
//     AT-LEAST-ONCE delivery resolved by a unique index — never exactly-once
//     delivery, and nothing in Phase 33 claims otherwise.
//   - Deleting is a TOMBSTONE: deletedAt + deletedByUserId are set and the
//     text is cleared. The document, its seq and its position in history are
//     never removed, so pagination and read cursors stay stable. A tombstone
//     keeps its clientMessageId, which is what stops a re-send of the same
//     deleted message from being accepted as new.
//   - Editing bumps editVersion and writes a ChatMessageEdit row holding the
//     PREVIOUS text. The current text lives here; the history lives there.
//     Nothing is ever overwritten in place without a trace.
//
//  BOUNDED BY DESIGN
//    text is capped at CHAT_MESSAGE_TEXT_MAX. A chat document must stay small
//    enough that a page of history is cheap to read and cheap to hold in the
//    working set. Attachments are references resolved in 33.10 — never inline
//    bytes, never a public URL.
//
//  NO EMBEDDED RECEIPTS
//    There is no seenBy, no readBy, no receipts array. Read state is the
//    per-member lastReadSeq cursor on ChatConversation. An array that grows
//    with readers on every message is the wrong shape for a chat system.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const CHAT_MESSAGE_TYPES = ['TEXT', 'SYSTEM', 'FILE'];

export const CHAT_MESSAGE_TEXT_MAX = 4000;

const chatMessageSchema = new Schema(
  {
    // No standalone companyId index: it leads every compound below.
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'ChatConversation',
      required: true,
      immutable: true,
    },
    senderUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },

    // Monotonic within a conversation, allocated atomically by 33.5.
    seq: { type: Number, required: true, min: 1, immutable: true },

    // Client idempotency key. Required now, on purpose: making it optional
    // would let 33.5 ship a send path with no dedupe and nobody would notice
    // until a flaky network duplicated someone's message.
    clientMessageId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      immutable: true,
    },

    type: {
      type: String,
      enum: CHAT_MESSAGE_TYPES,
      default: 'TEXT',
    },
    // Required and non-empty for TEXT; null for SYSTEM/FILE, which carry
    // their meaning in type (and, for FILE, a reference added in 33.10).
    text: {
      type: String,
      default: null,
      trim: true,
      maxlength: CHAT_MESSAGE_TEXT_MAX,
    },

    // ── FILE references (33.10) ──────────────────────────────────────────
    // Metadata ONLY, copied at send time so the bubble renders without a
    // second query: the id to download with, plus what to show. NEVER a
    // storageKey, NEVER a URL — the bytes are reachable only through the
    // auth-gated download endpoint. The array is bounded by
    // CHAT_ATTACHMENT_MAX_PER_MESSAGE at the service layer.
    attachments: {
      type: [
        new Schema(
          {
            attachmentId: {
              type: Schema.Types.ObjectId,
              ref: 'ChatAttachment',
              required: true,
            },
            fileName: { type: String, required: true, trim: true, maxlength: 220 },
            mimeType: { type: String, required: true, trim: true, maxlength: 120 },
            sizeBytes: { type: Number, required: true, min: 1 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // ── Edits ────────────────────────────────────────────────────────────
    // editVersion 0 means "never edited". Each edit increments it and appends
    // a ChatMessageEdit row. 33.6 enforces the retention cap and the
    // expectedEditVersion concurrency check.
    editVersion: { type: Number, default: 0, min: 0 },
    editedAt: { type: Date, default: null },
    editedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── Tombstone delete ─────────────────────────────────────────────────
    deletedAt: { type: Date, default: null },
    deletedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

// Three body rules, one validator, because they are the same question:
// "may this document carry text right now?"
//   1. a tombstone never carries body text — the delete IS the redaction
//   2. a TEXT message must actually say something
//   3. a SYSTEM/FILE message must not smuggle body text into `text`
//
// THE SCOPE TRAP (33.9-fix — this validator crashed the API once; read on):
// mongoose runs UPDATE validators (findOneAndUpdate/updateOne with
// runValidators) with `this` = the QUERY, not the document — see
// node_modules/mongoose/lib/helpers/updateValidators.js (`const context =
// query`). Only the paths present in the update are validated, and the query
// exposes neither `type` nor `deletedAt` (they live in `this.getUpdate()`).
// The 33.6 version read `this.type`/`this.deletedAt` unconditionally, so
// every atomic TEXT edit saw `type === undefined` and threw
// "TEXT messages require non-empty text...". The throw escaped an async
// socket listener and the process drained (unhandled rejection).
//
// The rule now reads the cross-field state from wherever it actually lives,
// and only enforces what it can see. The service layer still owns the full
// decision (services filter on { type: 'TEXT', deletedAt: null }), so an
// update that does not mention `type`/`deletedAt` is held to its local rule
// — never to a guess.
const updateScopeOf = (scope) => {
  if (!scope || typeof scope.getUpdate !== 'function') return scope ?? null;

  const update = scope.getUpdate() ?? {};

  return { ...update, ...(update.$set ?? {}), ...(update.$setOnInsert ?? {}) };
};

chatMessageSchema.path('text').validate(
  function textShape(value) {
    const empty = value === null || value === undefined || value === '';
    const scope = updateScopeOf(this);

    // A tombstone must never carry a body (checkable on both write paths).
    if (scope?.deletedAt) return empty;

    // A SYSTEM/FILE body is never allowed (checkable when `type` is known).
    if (scope?.type && scope.type !== 'TEXT') return empty;

    // Otherwise the body is a TEXT body: it must say something.
    return typeof value === 'string' && value.trim().length > 0;
  },
  'TEXT messages require non-empty text; SYSTEM, FILE and deleted messages must not carry body text.'
);

// Convenience self-heal: tombstoning a document clears the body instead of
// failing validation.
//
// WHY pre('validate') AND NOT pre('save'):
// a pre('save') hook fires only on save(). It would be skipped by
// document.validate() and by findOneAndUpdate()/updateOne(), so the body
// would survive exactly on the atomic-update paths 33.6 is most likely to
// use — a silent half-delete. pre('validate') runs on every write path that
// validates, including atomic updates opened with { runValidators: true }.
//
// SCOPE LIMIT — read this before writing 33.6. An atomic update that does
// NOT pass runValidators runs neither this hook nor the validator above.
// Such an update must explicitly $set text to null. The validator exists so
// that forgetting to do so fails loudly wherever validation is on, rather
// than quietly leaving deleted content readable.
// NOTE: no `next` parameter. Mongoose 9 validate hooks are async-only and do
// not pass a callback — declaring one and calling it throws
// "next is not a function". (save hooks still receive next; validate hooks
// do not.)
chatMessageSchema.pre('validate', function clearTombstonedText() {
  if (this.deletedAt) {
    this.text = null;
    this.editVersion = 0;
    this.editedAt = null;
    this.editedByUserId = null;
  }
});

// History pagination: tenant, conversation, newest first.
chatMessageSchema.index({ companyId: 1, conversationId: 1, seq: -1 });

// Idempotent send. Duplicate (sender, clientMessageId) inside one
// conversation is a retry of the same intent, never a new message.
chatMessageSchema.index(
  { companyId: 1, conversationId: 1, senderUserId: 1, clientMessageId: 1 },
  { unique: true }
);

// 33.10 — "is this attachment already referenced?" (one attachment belongs to
// exactly one message). Multikey on the embedded array, tenant-first.
chatMessageSchema.index({ companyId: 1, conversationId: 1, 'attachments.attachmentId': 1 });

export default mongoose.model('ChatMessage', chatMessageSchema);
