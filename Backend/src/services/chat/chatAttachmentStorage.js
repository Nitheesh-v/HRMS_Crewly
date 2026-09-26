// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.10 — CHAT ATTACHMENT STORAGE (thin wrapper, repo patterns)
//
//  Mirrors the proven pre-onboarding / offer storage services so every
//  private file family in Crewly behaves identically:
//
//    Cloudinary ready  → `type: 'authenticated'` object (NO public URL),
//                        key = crewly-private-chat-attachments/<company>/<conv>/<uuid>
//    Dev, not ready    → LOCAL_PRIVATE file under private_storage/chat-attachments,
//                        mode 0700 dir / 0600 file, traversal-guarded path.
//    Production        → NO local fallback: refuse (a private attachment must
//                        never silently land on a local disk in production).
//
//  Downloads STREAM THROUGH THE BACKEND (the same shape the BGV evidence
//  download uses): the caller passes tenant + membership authorization
//  first, then the bytes are fetched from the provider with a bounded,
//  time-limited read and sent on the authenticated response. A signed URL is
//  minted only as an internal hop (≤ 5 min), is never returned to the client
//  and is never persisted — so there is exactly ONE auth model for the
//  browser (the Bearer token) and no cross-origin fetch of a provider URL.
//
//  Provider mechanics are injectable (`_upload`, `_signer`, `_destroy`) so
//  tests need no Cloudinary account — the hermetic seam the prompt requires.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs/promises';
import path from 'node:path';

import ApiError from '../../utils/ApiError.js';
import { cloudinaryReady } from '../../config/cloudinary.js';
import {
  destroyPrivateAsset,
  getPrivateAssetSignedUrl,
  uploadPrivateAsset,
} from '../../infrastructure/storage/privateCloudinaryAsset.js';
import {
  assertSafeStorageKey,
  buildAttachmentStorageKey,
  CHAT_ATTACHMENT_MAX_BYTES,
} from '../../utils/chatFileRules.js';

// Code default, no new env var (repo asks for names only when unavoidable;
// this one is not). Absolute so the process CWD cannot move the folder.
const LOCAL_DIRECTORY = path.resolve(
  process.env.PRIVATE_CHAT_ATTACHMENT_STORAGE_DIR ||
    'private_storage/chat-attachments'
);

// Traversal guard: the key must be a bare uuid-shaped basename here (local
// files are stored flat). Anything else is refused as "not found".
const localPath = (storageKey) => {
  const key = assertSafeStorageKey(storageKey);
  const safeName = path.basename(key);

  if (!safeName || safeName !== key) throw ApiError.notFound('File not found');

  return path.join(LOCAL_DIRECTORY, safeName);
};

export const CHAT_ATTACHMENT_RESOURCE_TYPE = 'raw';

// ── upload ────────────────────────────────────────────────────────────────

export const storeChatAttachment = async ({
  buffer,
  companyId,
  conversationId,
  _upload = uploadPrivateAsset,
  _ready = cloudinaryReady,
} = {}) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw ApiError.badRequest('A file is required.');
  }

  const storageKey = buildAttachmentStorageKey({ companyId, conversationId });

  if (_ready) {
    const stored = await _upload({
      buffer,
      storageKey,
      resourceType: CHAT_ATTACHMENT_RESOURCE_TYPE,
    });

    return {
      storageProvider: stored?.storageProvider ?? 'CLOUDINARY_AUTHENTICATED',
      storageKey: stored?.storageKey ?? storageKey,
    };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new ApiError(503, 'Secure file storage is unavailable');
  }

  await fs.mkdir(LOCAL_DIRECTORY, { recursive: true, mode: 0o700 });

  // The local key is ONLY the uuid — a flat directory, so no caller-derived
  // segment exists to traverse with.
  const localKey = path.basename(storageKey);

  await fs.writeFile(localPath(localKey), buffer, { flag: 'wx', mode: 0o600 });

  return { storageProvider: 'LOCAL_PRIVATE', storageKey: localKey };
};

// ── download resolution (AFTER authorization) ─────────────────────────────

// Bounded remote read, mirroring services/bgv/bgvEvidenceStorageService: a
// declared or observed size beyond the cap is a 413, a slow provider is a
// 503. The provider URL is minted HERE, used immediately, and never stored
// or logged.
const boundedRemoteBuffer = async (response) => {
  const declared = Number(response.headers.get('content-length')) || 0;

  if (declared > CHAT_ATTACHMENT_MAX_BYTES) {
    throw new ApiError(413, 'File is too large');
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;

    if (total > CHAT_ATTACHMENT_MAX_BYTES) throw new ApiError(413, 'File is too large');

    chunks.push(bytes);
  }

  return Buffer.concat(chunks, total);
};

const fetchRemoteAttachment = async ({ storageKey, _signer, _fetch }) => {
  let signed;

  try {
    signed = _signer({ storageKey, resourceType: CHAT_ATTACHMENT_RESOURCE_TYPE, attachment: false });
  } catch {
    // No credentials / provider down: never claim the file exists.
    throw new ApiError(503, 'File storage is temporarily unavailable');
  }

  const response = await _fetch(signed.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  }).catch(() => {
    throw new ApiError(503, 'File storage is temporarily unavailable');
  });

  if (!response.ok || !response.body) {
    throw new ApiError(503, 'File storage is temporarily unavailable');
  }

  return boundedRemoteBuffer(response);
};

// Streaming-first by design (the prompt's option b, and the pattern the BGV
// evidence download already uses): bytes travel through the API, so the
// browser never needs a cross-origin fetch of a provider URL, and there is
// exactly ONE auth model — the same Bearer token as every other endpoint.
// Signed URLs still exist (bounded ≤ 5 min) but only as an internal hop
// between this process and the provider.
export const resolveChatAttachmentDelivery = async ({
  attachment,
  _signer = getPrivateAssetSignedUrl,
  _fetch = fetch,
  _readLocal = (key) => fs.readFile(localPath(key)),
} = {}) => {
  const storageKey = assertSafeStorageKey(attachment?.storageKey);

  if (attachment.storageProvider === 'CLOUDINARY_AUTHENTICATED') {
    const bytes = await fetchRemoteAttachment({ storageKey, _signer, _fetch });

    return {
      kind: 'INLINE',
      bytes,
      contentType: attachment.mimeType || 'application/octet-stream',
    };
  }

  if (attachment.storageProvider === 'LOCAL_PRIVATE') {
    const bytes = await _readLocal(storageKey).catch(() => {
      throw ApiError.notFound('File not found');
    });

    return {
      kind: 'INLINE',
      bytes,
      contentType: attachment.mimeType || 'application/octet-stream',
    };
  }

  // Unknown / provider-mismatched rows are indistinguishable from missing.
  throw ApiError.notFound('File not found');
};

// ── delete (best-effort, never throws) ────────────────────────────────────

export const destroyChatAttachment = async ({
  attachment,
  _destroy = destroyPrivateAsset,
  _removeLocal = (key) => fs.rm(localPath(key), { force: true }),
} = {}) => {
  try {
    const storageKey = assertSafeStorageKey(attachment?.storageKey);

    if (attachment.storageProvider === 'CLOUDINARY_AUTHENTICATED') {
      await _destroy({ storageKey, resourceType: CHAT_ATTACHMENT_RESOURCE_TYPE });
      return;
    }

    if (attachment.storageProvider === 'LOCAL_PRIVATE') {
      await _removeLocal(storageKey);
    }
  } catch {
    // Established Crewly semantics: storage cleanup is best-effort and never
    // fails a business operation (the row, not the bytes, is the truth).
  }
};

export { LOCAL_DIRECTORY };
