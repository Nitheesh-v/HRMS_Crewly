// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.10 — CHAT FILE RULES (limits, allowlist, safe keys/names)
//
//  Pure functions + constants only — no I/O, no models. Both the upload
//  service and the socket send path import from here so a file that passes
//  the multipart check can never be rejected later for a size/type reason
//  (mirrors the 33.5 validator/schema mirroring rule).
//
//  THE ALLOWLIST IS THE REPO'S OWN
//    DOCUMENT_FILE_ALLOWLIST (middlewares/documentFilePolicy.js) already
//    defines what Crewly treats as a safe document — PDF / JPG / JPEG / PNG /
//    WEBP, with an extension↔MIME cross-check. Chat reuses that list rather
//    than inventing a second policy that could drift.
//
//  KEYS ARE SERVER-BUILT
//    buildAttachmentStorageKey() is the ONLY way a key comes into existence:
//    a uuid under a fixed, tenant-scoped prefix. Caller input never reaches
//    the key, so '..', '\\', '%2e%2e' and friends have nothing to traverse.
//    assertSafeStorageKey() re-checks on the READ side (defense in depth) —
//    a key that is not a plain relative segment set is refused outright.
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import path from 'node:path';

import ApiError from './ApiError.js';
import {
  DOCUMENT_FILE_ALLOWLIST,
  DOCUMENT_FILE_POLICY_MESSAGE,
} from '../middlewares/documentFilePolicy.js';

// Per-file cap. Deliberately the repo's document cap (10 MB) rather than a
// new number: chat attachments are the same class of object as the documents
// the product already stores privately.
export const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

// A message may reference a bounded set of files (bubble stays readable,
// payload stays small).
export const CHAT_ATTACHMENT_MAX_PER_MESSAGE = 5;

// The multipart field name. ONE constant, because a mismatch between what the
// client appends and what multer reads is invisible until runtime: multer
// simply finds no file and the request fails as "a file is required"
// (observed in localhost acceptance on 2026-09-26 — the client was sending a
// JSON body, see the NOT_MULTIPART guard below).
export const CHAT_ATTACHMENT_FIELD = 'file';

export const CHAT_ATTACHMENT_MESSAGES = Object.freeze({
  EMPTY: 'A file is required.',
  TOO_LARGE: `File must be ${Math.floor(CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB or smaller.`,
  TYPE: DOCUMENT_FILE_POLICY_MESSAGE,
  TOO_MANY: `A message can carry at most ${CHAT_ATTACHMENT_MAX_PER_MESSAGE} files.`,
  NO_FILES: 'At least one file is required.',
  NOT_MULTIPART:
    `Attachments must be sent as multipart/form-data (file field "${CHAT_ATTACHMENT_FIELD}").`,
});

// Fail-closed request-shape guard for the upload route. The shared axios
// instance defaults to `Content-Type: application/json`, and axios serializes
// a FormData body to JSON when that header survives — the bytes then arrive
// as a JSON document, multer finds no file, and the failure looks like a
// missing file instead of a missing multipart header. Rejecting a
// non-multipart body up front names the real problem.
export const isMultipartRequest = (req = {}) =>
  String(req.headers?.['content-type'] || '')
    .toLowerCase()
    .startsWith('multipart/form-data');

export const CHAT_FILE_ALLOWLIST = DOCUMENT_FILE_ALLOWLIST;

// Storage key namespace. Mirrors the established
// `crewly-private-pre-onboarding/...` / `crewly-private-offers/...` shape so
// operator tooling sees ONE convention across every private file family.
export const CHAT_ATTACHMENT_KEY_PREFIX = 'crewly-private-chat-attachments';

// ── extension / mime cross-check ──────────────────────────────────────────

// Returns the normalized extension, or throws the repo's standard refusal.
// The cross-check matters: a browser MIME lie on a '.pdf' name must not slip
// through as "any type".
export const assertAllowedChatFile = ({ originalName, mimeType, sizeBytes }) => {
  const size = Number(sizeBytes);

  if (!Number.isFinite(size) || size <= 0) {
    throw ApiError.badRequest(CHAT_ATTACHMENT_MESSAGES.EMPTY);
  }

  if (size > CHAT_ATTACHMENT_MAX_BYTES) {
    throw ApiError.badRequest(CHAT_ATTACHMENT_MESSAGES.TOO_LARGE);
  }

  const extension = path.extname(String(originalName || '')).toLowerCase();
  const expectedMime = CHAT_FILE_ALLOWLIST.get(extension);
  const mime = String(mimeType || '').toLowerCase();

  if (!expectedMime || mime !== expectedMime) {
    throw ApiError.badRequest(CHAT_ATTACHMENT_MESSAGES.TYPE);
  }

  return extension;
};

// ── safe names ────────────────────────────────────────────────────────────

// Same character discipline as the repo's safeDocumentFileName (path.basename
// first, control characters stripped, executable-ish punctuation replaced):
// the stored name is for humans, never for the filesystem.
export const safeChatFileName = (rawName, extension = '.bin') => {
  const base = path
    .basename(String(rawName || `attachment${extension}`))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-zA-Z0-9._() -]/g, '_')
    .slice(0, 220)
    .trim();

  return base || `attachment${extension}`;
};

// ── keys ──────────────────────────────────────────────────────────────────

export const buildAttachmentStorageKey = ({ companyId, conversationId }) => {
  if (!companyId || !conversationId) {
    throw new ApiError(500, 'Attachment storage key requires a tenant and conversation');
  }

  // Fixed segments + a uuid. Nothing caller-controlled is interpolated.
  return `${CHAT_ATTACHMENT_KEY_PREFIX}/${String(companyId)}/${String(conversationId)}/${crypto.randomUUID()}`;
};

// Read-side traversal guard. Accepts only relative segment sets of the safe
// alphabet; refuses absolute paths, backslashes, dot-segments, URL-encoded
// traversal and empty/oversized keys.
export const assertSafeStorageKey = (storageKey) => {
  const key = String(storageKey || '');

  if (!key || key.length > 500) throw ApiError.notFound('File not found');

  const decoded = (() => {
    try {
      return decodeURIComponent(key);
    } catch {
      return key;
    }
  })();

  const unsafe =
    key !== decoded ||
    key.startsWith('/') ||
    key.includes('\\') ||
    /(^|\/)\.\.?(\/|$)/.test(decoded) ||
    !/^[a-zA-Z0-9._/-]+$/.test(key);

  if (unsafe) throw ApiError.notFound('File not found');

  return key;
};

export const assertAttachmentCount = (count) => {
  const total = Number(count);

  if (!Number.isFinite(total) || total < 1) {
    throw ApiError.badRequest(CHAT_ATTACHMENT_MESSAGES.NO_FILES);
  }

  if (total > CHAT_ATTACHMENT_MAX_PER_MESSAGE) {
    throw ApiError.badRequest(CHAT_ATTACHMENT_MESSAGES.TOO_MANY);
  }

  return total;
};

// Preview text for the conversation list when a FILE message arrives — the
// list must say something useful without carrying the filename of a private
// document into a denormalized field. Deliberately generic.
export const CHAT_FILE_PREVIEW_TEXT = 'Attachment';
