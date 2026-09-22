// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.2 — CHAT CONVERSATION (persistence layer only)
//
//  WHAT THIS IS
//    The authoritative Mongo record of a Crewly chat conversation: either a
//    DIRECT 1:1 pair or a GROUP. It owns the tenant scope, the membership
//    list, the monotonic message sequence counter, and the per-member read
//    cursor that drives unread counts.
//
//  WHAT THIS IS NOT
//    There is no API, no socket event and no service behind this model yet.
//    Nothing writes these documents until 33.3 (REST) and 33.5 (socket send).
//    Declaring the schema first means the invariants below are already in
//    force the moment the first write path appears.
//
//  SECURITY + CORRECTNESS INVARIANTS (all schema-declared)
//   - Every document is tenant-scoped: companyId is required, immutable, and
//     the LEADING key of every index. A chat query that omits companyId is
//     unindexable and wrong by construction.
//   - ONE DIRECT conversation per pair per tenant: unique (companyId,
//     directKey) with partialFilterExpression { type: 'DIRECT' }. GROUP rows
//     are excluded from that index entirely, so their null directKey can
//     never collide.
//   - directKey is DERIVED, never accepted: a pre('validate') hook recomputes
//     it from the two member ids, sorted, so 'A:B' and 'B:A' collapse to one
//     key. A client cannot choose it, reorder it, or point it elsewhere.
//   - A DIRECT conversation needs exactly 2 DISTINCT members — self-chat is
//     rejected, because a 1:1 conversation with yourself is not a product
//     and its directKey would be degenerate.
//   - lastReadSeq is the C1 read cursor. Unread = lastMessageSeq - lastReadSeq
//     for that member. There are NO per-message receipt arrays anywhere in
//     the chat schema: receipts scale with message count, cursors scale with
//     members.
//
//  NO SURVEILLANCE
//    This model deliberately has no presence, no lastSeen, no online flag,
//    no typing state and no activity timestamps per member. joinedAt is the
//    moment of joining the conversation — membership bookkeeping, not
//    observation of a person. Phase 33 does not track whether anyone is
//    online, idle, or reading.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const CHAT_CONVERSATION_TYPES = ['DIRECT', 'GROUP'];

export const CHAT_MEMBER_ROLES = ['MEMBER', 'ADMIN'];

// 24 hex + ':' + 24 hex
const DIRECT_KEY_MAX_LENGTH = 49;

// GROUP size bounds. Lower bound is 2 so a "group" of one person cannot
// exist — that is a malformed DIRECT, and the validators below say so.
const GROUP_MEMBER_MIN = 2;
const GROUP_MEMBER_MAX = 200;

const chatMemberSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Minimal on purpose. 33.9 (moderation) may widen this; nothing else
    // reads it, and an unread role must never become an authorization check
    // on its own — membership is the gate, role is only a capability hint.
    role: {
      type: String,
      enum: CHAT_MEMBER_ROLES,
      default: 'MEMBER',
    },
    joinedAt: { type: Date, default: Date.now },
    // Baseline for late joiners: seq of the newest message at join time.
    // Unread for a member is computed against max(lastReadSeq, joinedAtSeq)
    // in 33.7 so a newcomer is not shown the entire backlog as unread.
    joinedAtSeq: { type: Number, default: 0, min: 0 },
    // C1 read cursor. Monotonic; never rewound below a previous value.
    lastReadSeq: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const chatConversationSchema = new Schema(
  {
    // NO standalone `index: true` here — deliberately. companyId is the
    // leading key of every compound index below, so a single-field index
    // would be redundant write amplification on a high-volume collection.
    // test/chatModels.test.js pins both halves of that decision.
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
    },
    type: {
      type: String,
      enum: CHAT_CONVERSATION_TYPES,
      required: true,
      uppercase: true,
      trim: true,
      immutable: true,
    },
    // DIRECT only. Derived from the sorted member ids by the pre('validate')
    // hook below; null for GROUP. Immutable because the pair is the identity
    // of the conversation.
    directKey: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
      maxlength: DIRECT_KEY_MAX_LENGTH,
      immutable: true,
    },
    // GROUP only; must stay null for DIRECT.
    title: {
      type: String,
      default: null,
      trim: true,
      maxlength: 80,
    },
    members: {
      type: [chatMemberSchema],
      default: [],
    },

    // ── Denormalized "last message" for list speed ───────────────────────
    // These are a cache of the newest ChatMessage, never its authority.
    // 33.5 updates them in the same atomic $inc that allocates seq. A wrong
    // preview is a display bug; a wrong seq is a correctness bug, which is
    // why seq is the only field here with a uniqueness-bearing role.
    lastMessageSeq: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },
    lastMessageSenderUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── Moderation (behaviour lands in 33.9) ─────────────────────────────
    isDisabled: { type: Boolean, default: false },
    disabledAt: { type: Date, default: null },
    disabledByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

// Derived, never trusted. Recomputed on every validate so the stored key
// always matches the stored members — a client-supplied directKey is
// overwritten, not honoured.
chatConversationSchema.pre('validate', function deriveDirectKey() {
  if (this.type !== 'DIRECT') {
    this.directKey = null;

    return;
  }

  const ids = Array.isArray(this.members)
    ? this.members.map((member) => String(member.userId)).sort()
    : [];

  this.directKey = ids.length === 2 && ids[0] !== ids[1] ? ids.join(':') : null;
});

const isCanonicalDirectKey = (value) =>
  typeof value === 'string' && /^[0-9a-f]{24}:[0-9a-f]{24}$/.test(value);

// `this` is the document — Mongoose binds path validators to it, which is
// what makes these cross-field. A regular function is required here; an
// arrow function would capture module scope and lose the document.
chatConversationSchema.path('directKey').validate(
  function directShape(value) {
    if (this.type !== 'DIRECT') return value === null || value === undefined;

    return isCanonicalDirectKey(value);
  },
  'A DIRECT conversation requires a canonical directKey over two distinct members.'
);

chatConversationSchema.path('members').validate(
  function memberShape(value) {
    if (!Array.isArray(value)) return false;

    if (this.type === 'DIRECT') {
      if (value.length !== 2) return false;

      const [first, second] = value;

      return String(first.userId) !== String(second.userId);
    }

    return value.length >= GROUP_MEMBER_MIN && value.length <= GROUP_MEMBER_MAX;
  },
  'DIRECT conversations need exactly 2 distinct members; GROUP needs 2 to 200.'
);

chatConversationSchema.path('title').validate(
  function titleShape(value) {
    if (this.type !== 'GROUP') return value === null || value === undefined;

    return typeof value === 'string' && value.trim().length >= 2;
  },
  'A GROUP conversation requires a title of at least 2 characters.'
);

// One DIRECT conversation per pair per tenant. The partial filter removes
// GROUP documents from the index entirely, so their null directKey can never
// participate in a uniqueness conflict.
chatConversationSchema.index(
  { companyId: 1, directKey: 1 },
  { unique: true, partialFilterExpression: { type: 'DIRECT' } }
);

// "My conversations" — tenant, then the member, newest activity first.
chatConversationSchema.index({
  companyId: 1,
  'members.userId': 1,
  lastMessageAt: -1,
});

export default mongoose.model('ChatConversation', chatConversationSchema);
