// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.10 — CHAT ATTACHMENT (private, reference-only)
//
//  WHAT THIS IS
//    One row per uploaded chat file. The BYTES live in the repo's existing
//    private storage (32.8: Cloudinary `authenticated`, or the LOCAL_PRIVATE
//    dev fallback) — this document stores only the server-generated key and
//    the metadata a bubble needs to render before the download happens.
//
//  NON-NEGOTIABLE PROPERTIES
//    · storageKey is `select: false` — it never rides along on a normal read,
//      so no API response, log line or frontend payload can leak it.
//    · NO URL of any kind is persisted. Signed URLs are minted per download,
//      AFTER authorization, and are bounded (≤ 5 min) by the 32.8 adapter.
//    · scanStatus speaks the repo's EXISTING vocabulary
//      (DOCUMENT_SCAN_STATUSES) and stays NOT_CONFIGURED — there is no
//      scanner in this repository, so a fake CLEAN is impossible by design.
//    · checksumSha256 is `select: false` too: durable integrity proof for
//      operators, never part of a customer payload.
//    · removedAt is the "delete for everyone" half of the story: tombstoning
//      a FILE message marks its attachments removed, and the download path
//      refuses them. (Purging the stored bytes is a later, deliberate unit —
//      see the docs limitation.)
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import {
  DOCUMENT_SCAN_STATUSES,
  DOCUMENT_STORAGE_PROVIDERS,
} from './CandidateDocument.js';

const { Schema } = mongoose;

const chatAttachmentSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
      index: true,
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'ChatConversation',
      required: true,
      immutable: true,
      index: true,
    },
    uploadedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
      index: true,
    },

    // NEVER returned by a normal query (33.2/32.8 convention).
    storageProvider: {
      type: String,
      enum: DOCUMENT_STORAGE_PROVIDERS,
      required: true,
    },
    storageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
      select: false,
    },
    checksumSha256: {
      type: String,
      required: true,
      lowercase: true,
      maxlength: 64,
      select: false,
    },

    // Sanitized at upload (repo's safeDocumentFileName) — never a raw
    // browser-supplied path.
    originalFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 220,
    },
    mimeType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
    },

    // Honest posture: without a configured scanner this stays
    // NOT_CONFIGURED forever. It is never promoted to a fake CLEAN.
    scanStatus: {
      type: String,
      enum: DOCUMENT_SCAN_STATUSES,
      default: 'NOT_CONFIGURED',
    },
    scanCheckedAt: { type: Date, default: null },

    // Set when the referencing message is tombstoned (delete for everyone)
    // or the attachment is otherwise withdrawn. Downloads refuse after this.
    removedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

// The read path: "attachments of this conversation, newest first", always
// tenant-first (repo index convention).
chatAttachmentSchema.index({ companyId: 1, conversationId: 1, createdAt: -1 });

export default mongoose.model('ChatAttachment', chatAttachmentSchema);
