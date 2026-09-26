// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.1 — CHAT MESSAGE REACTION (persistence layer)
//
//  WHAT THIS IS
//    One row per (message, user, reaction type). A reaction is a small
//    social annotation on a message that already exists — it is NOT a
//    message, it has no body, and it can never be edited into one.
//
//  WHY A SEPARATE COLLECTION (and not an array on ChatMessage)
//    ChatMessage is the hottest document in the chat system: every history
//    page reads it, every send writes it. Embedding reactions would (a) grow
//    it with every reactor in a group, (b) drag every reactor through every
//    history read, and (c) make the per-user cap an array surgery inside a
//    document that other writers are concurrently updating. A separate
//    collection keeps a message small, makes the cap an indexable count, and
//    -- the important one -- makes "one reaction per user per message" a
//    UNIQUE INDEX guarantee instead of a read-modify-write race.
//
//  INVARIANTS (all schema-declared)
//   - (companyId, messageId, userId, reactionType) is UNIQUE. Reacting twice
//     is therefore a duplicate-key no-op, not a second row, no matter how
//     many tabs or replicas race. Idempotency is a database property here.
//   - companyId, messageId, userId and reactionType are IMMUTABLE. A reaction
//     row that could be repointed would be a way to forge a reaction onto
//     another tenant's message.
//   - reactionType is a FIXED enum (CHAT_REACTION_TYPES). There is no free
//     entry: the product shows four icons, and the database accepts exactly
//     those four strings. That also means the summary of one message can
//     never exceed a handful of groups.
//
//  BOUNDED BY DESIGN (two independent ceilings)
//   1. per user, per message  — CHAT_REACTION_MAX_PER_USER_PER_MESSAGE (1).
//      A new type REPLACES the previous one, so the number of rows a single
//      user can add to a single message is fixed and small. The service
//      enforces it; the unique index is what makes it safe under races.
//   2. per message            — CHAT_REACTION_MAX_PER_MESSAGE (200). A guard,
//      not a transaction: the service counts after writing and rolls its own
//      row back if the ceiling is crossed, so a room can never be turned into
//      an unbounded reaction sink. In practice a conversation is capped at
//      CHAT_GROUP_MAX_MEMBERS (50) members, so the real ceiling is membership.
//
//  TENANCY
//    companyId leads the only index, so every read and every write is
//    tenant-scoped by construction. conversationId is stored too, so a
//    moderation cleanup or an audit can be answered without joining
//    ChatMessage — but it never replaces the companyId filter.
//
//  PRIVACY
//    A row says "user X reacted with type T to message M". That is the whole
//    payload: no text, no timestamps beyond the write itself, nothing about
//    where the user is or whether they are online. This is NOT presence —
//    there is still no presence, typing or last-seen anywhere in Phase 34.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * The complete, closed set of reactions the product supports. Deliberately
 * small and positively-toned (no negative-sentiment icon): the UI renders
 * these four as inline icons — never as free-typed emoji, which is both a
 * product decision ("no emojis in new UI") and a storage one (an open set
 * would make the per-message summary unbounded).
 */
export const CHAT_REACTION_TYPES = ['LIKE', 'HEART', 'LAUGH', 'THANKS'];

/** Rows one user may hold on one message. A new type replaces the old one. */
export const CHAT_REACTION_MAX_PER_USER_PER_MESSAGE = 1;

/** Safety valve: the hard ceiling of rows on a single message. */
export const CHAT_REACTION_MAX_PER_MESSAGE = 200;

/**
 * The largest number of reaction rows a single history page will read when
 * building summaries. A page is at most CHAT_LIST_LIMIT_MAX (50) messages; at
 * the per-message ceiling that would be 10,000 rows, so the read is bounded
 * explicitly. Anything beyond the bound is not silently dropped from the UI —
 * it simply cannot exist for a legal page under the caps above.
 */
export const CHAT_REACTION_SUMMARY_ROW_LIMIT = 5000;

const chatMessageReactionSchema = new Schema(
  {
    // No standalone companyId index: it leads the compound below.
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
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    reactionType: {
      type: String,
      required: true,
      enum: CHAT_REACTION_TYPES,
      immutable: true,
    },
  },
  { timestamps: true, versionKey: false }
);

// ONE index, three jobs: tenant+message reads (its prefix), the per-user
// lookup, and the idempotency guarantee itself. The unique constraint is what
// makes "react twice" a no-op instead of a duplicate row.
chatMessageReactionSchema.index(
  { companyId: 1, messageId: 1, userId: 1, reactionType: 1 },
  { unique: true }
);

export default mongoose.model('ChatMessageReaction', chatMessageReactionSchema);
