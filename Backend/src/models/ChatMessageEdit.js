// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.2 — CHAT MESSAGE EDIT HISTORY (persistence layer only)
//
//  WHAT THIS IS
//    One row per edit, holding the text that was REPLACED. Append-only.
//    ChatMessage carries the current text; this collection carries the
//    audit trail of what it used to say.
//
//  WHAT THIS IS NOT
//    No behaviour yet. 33.6 implements the edit flow (with an
//    expectedEditVersion concurrency check so two simultaneous edits cannot
//    both win), the permission gate on who may READ this history, and the
//    retention cap. This model only makes those things possible and makes
//    silent overwriting impossible.
//
//  WHY A SEPARATE COLLECTION
//    Edit history must not live inside ChatMessage. Embedding it would grow
//    the hottest document in the system with every edit, drag the full
//    history through every history-page read, and make the retention cap a
//    per-document array surgery instead of a bounded delete. A separate
//    collection keeps a message small and makes the cap a simple, indexable
//    range operation.
//
//  INVARIANTS (all schema-declared)
//   - (companyId, messageId, version) is UNIQUE. Version numbers are
//     allocated per message, so an edit cannot silently overwrite an
//     existing one — a collision is a lost-update attempt and it fails.
//   - Everything identifying (companyId, conversationId, messageId, version,
//     editedByUserId) is immutable. A history row that could be repointed is
//     not history.
//   - previousText is REQUIRED and bounded. An edit record with no previous
//     text proves nothing.
//
//  PRIVACY NOTE
//    previousText is message content, so it inherits the same handling as
//    ChatMessage.text: tenant-scoped, permission-gated on retrieval (33.6),
//    capped in retention (33.6), and NEVER written to logs, metrics or job
//    data. Its existence is metadata; its body is not.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

const { Schema } = mongoose;

// Kept in step with CHAT_MESSAGE_TEXT_MAX: a previousText longer than the
// field it came from would be impossible, and a shorter cap would silently
// truncate evidence.
const PREVIOUS_TEXT_MAX = 4000;

const chatMessageEditSchema = new Schema(
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
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'ChatMessage',
      required: true,
      immutable: true,
    },
    // 1..n per message. Matches ChatMessage.editVersion after the edit.
    version: { type: Number, required: true, min: 1, immutable: true },
    previousText: {
      type: String,
      required: true,
      trim: true,
      maxlength: PREVIOUS_TEXT_MAX,
    },
    editedAt: { type: Date, required: true, default: Date.now },
    editedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
  },
  { timestamps: true, versionKey: false }
);

// Append-only: one row per version per message.
chatMessageEditSchema.index(
  { companyId: 1, messageId: 1, version: 1 },
  { unique: true }
);

// Edit-history fetch: newest revision first, already tenant- and
// conversation-scoped so the query cannot widen to another tenant.
chatMessageEditSchema.index({
  companyId: 1,
  conversationId: 1,
  messageId: 1,
  version: -1,
});

export default mongoose.model('ChatMessageEdit', chatMessageEditSchema);
