// Phase 38.4 — Helpdesk private storage adapter. Provider mechanics come from
// the existing authenticated Cloudinary adapter; delivery always stays behind
// the already-authorized Crewly API request.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { cloudinaryReady } from '../../config/cloudinary.js';
import {
  destroyPrivateAsset,
  getPrivateAssetSignedUrl,
  uploadPrivateAsset,
} from '../../infrastructure/storage/privateCloudinaryAsset.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../config/logger.js';
import {
  assertHelpdeskAttachmentStorageKey,
  buildHelpdeskAttachmentStorageKey,
  HELPDESK_ATTACHMENT_MAX_BYTES,
} from './helpdeskFileRules.js';

const LOCAL_DIRECTORY = path.resolve('private_storage/helpdesk-attachments');
const RESOURCE_TYPE = 'raw';
const READ_TIMEOUT_MS = 15_000;

const localPath = (storageKey, directory = LOCAL_DIRECTORY) => {
  const safeKey = assertHelpdeskAttachmentStorageKey({
    storageProvider: 'LOCAL_PRIVATE',
    storageKey,
  });
  return path.join(directory, safeKey);
};

const stopStream = async (stream) => {
  try {
    if (typeof stream?.cancel === 'function') await stream.cancel();
    else stream?.destroy?.();
  } catch {
    // Cancellation is best-effort; the bounded API response remains primary.
  }
};

const readBoundedStream = async (stream, declaredBytes = 0) => {
  if (declaredBytes > HELPDESK_ATTACHMENT_MAX_BYTES) {
    await stopStream(stream);
    throw new ApiError(413, 'File is too large.');
  }

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > HELPDESK_ATTACHMENT_MAX_BYTES) {
        await stopStream(stream);
        throw new ApiError(413, 'File is too large.');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    await stopStream(stream);
    if (error?.statusCode) throw error;
    throw ApiError.unavailable('File storage is temporarily unavailable.');
  }
  return Buffer.concat(chunks, total);
};

const readLocalBounded = async (storageKey, directory = LOCAL_DIRECTORY) => {
  const safePath = localPath(storageKey, directory);
  let stream;
  try {
    const stat = await fs.stat(safePath);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > HELPDESK_ATTACHMENT_MAX_BYTES) {
      throw new ApiError(413, 'File is too large.');
    }
    stream = createReadStream(safePath, { highWaterMark: 64 * 1024 });
    return await readBoundedStream(stream, stat.size);
  } catch (error) {
    stream?.destroy();
    if (error?.statusCode) throw error;
    throw ApiError.notFound('File not found.');
  }
};

export const planHelpdeskAttachmentStorage = ({
  companyId,
  ticketId,
  attachmentId,
  _ready = cloudinaryReady,
  _nodeEnv = process.env.NODE_ENV,
} = {}) => {
  const cloudStorageKey = buildHelpdeskAttachmentStorageKey({ companyId, ticketId, attachmentId });
  if (_ready) {
    return { storageProvider: 'CLOUDINARY_AUTHENTICATED', storageKey: cloudStorageKey };
  }
  if (_nodeEnv === 'production') {
    throw ApiError.unavailable('Secure file storage is unavailable.');
  }
  return {
    storageProvider: 'LOCAL_PRIVATE',
    storageKey: String(attachmentId).toLowerCase(),
  };
};

export const storeHelpdeskAttachment = async ({
  buffer,
  companyId,
  ticketId,
  attachmentId,
  storageProvider,
  storageKey,
  _upload = uploadPrivateAsset,
  _destroy = destroyPrivateAsset,
  _ready = cloudinaryReady,
  _nodeEnv = process.env.NODE_ENV,
  _localDirectory = LOCAL_DIRECTORY,
} = {}) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw ApiError.badRequest('A non-empty file is required.');
  }
  if (buffer.length > HELPDESK_ATTACHMENT_MAX_BYTES) {
    throw ApiError.badRequest('File must be 10 MB or smaller.');
  }

  const planned = storageProvider && storageKey
    ? { storageProvider, storageKey }
    : planHelpdeskAttachmentStorage({ companyId, ticketId, attachmentId, _ready, _nodeEnv });
  const safeKey = assertHelpdeskAttachmentStorageKey({
    ...planned,
    companyId,
    ticketId,
  });

  if (planned.storageProvider === 'CLOUDINARY_AUTHENTICATED') {
    if (!_ready) throw ApiError.unavailable('Secure file storage is unavailable.');
    try {
      const stored = await _upload({
        buffer,
        storageKey: safeKey,
        resourceType: RESOURCE_TYPE,
      });
      if (
        stored?.storageProvider !== 'CLOUDINARY_AUTHENTICATED'
        || stored?.storageKey !== safeKey
      ) {
        throw new Error('unexpected private storage result');
      }
      return { storageProvider: 'CLOUDINARY_AUTHENTICATED', storageKey: safeKey };
    } catch {
      let removed = false;
      try {
        removed = await _destroy({ storageKey: safeKey, resourceType: RESOURCE_TYPE }) === true;
      } catch {
        removed = false;
      }
      if (!removed) {
        logger.warn('helpdesk.attachment.upload_cleanup_pending', {
          companyId: String(companyId),
          ticketId: String(ticketId),
          attachmentId: String(attachmentId),
        });
      }
      // Provider details, hostnames, credentials and raw stacks never escape.
      throw ApiError.unavailable('Secure file storage is temporarily unavailable.');
    }
  }

  if (planned.storageProvider !== 'LOCAL_PRIVATE' || _nodeEnv === 'production') {
    throw ApiError.unavailable('Secure file storage is unavailable.');
  }

  const localKey = safeKey;
  const destination = localPath(localKey, _localDirectory);
  let handle = null;
  let created = false;
  try {
    await fs.mkdir(_localDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(_localDirectory, 0o700);
    handle = await fs.open(destination, 'wx', 0o600);
    created = true;
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    return { storageProvider: 'LOCAL_PRIVATE', storageKey: localKey };
  } catch {
    await handle?.close().catch(() => {});
    if (created) await fs.rm(destination, { force: true }).catch(() => {});
    // Do not remove a pre-existing path on an EEXIST collision.
    throw ApiError.unavailable('Secure local file storage is temporarily unavailable.');
  }
};

const assertStoredIntegrity = (attachment, bytes) => {
  if (
    bytes.length !== Number(attachment?.sizeBytes)
    || !/^[a-f\d]{64}$/i.test(String(attachment?.checksumSha256 || ''))
  ) {
    throw ApiError.unavailable('File storage is temporarily unavailable.');
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== String(attachment.checksumSha256).toLowerCase()) {
    throw ApiError.unavailable('File storage is temporarily unavailable.');
  }
};

const fetchRemoteAttachment = async ({ attachment, signer, fetcher }) => {
  let signed;
  try {
    signed = signer({
      storageKey: attachment.storageKey,
      resourceType: RESOURCE_TYPE,
      attachment: false,
    });
  } catch {
    throw ApiError.unavailable('File storage is temporarily unavailable.');
  }

  let deliveryUrl;
  try {
    deliveryUrl = new URL(String(signed?.url || ''));
  } catch {
    throw ApiError.unavailable('File storage is temporarily unavailable.');
  }
  const host = deliveryUrl.hostname.toLowerCase();
  if (
    deliveryUrl.protocol !== 'https:'
    || deliveryUrl.username
    || deliveryUrl.password
    || !(host === 'cloudinary.com' || host.endsWith('.cloudinary.com'))
  ) {
    throw ApiError.unavailable('File storage is temporarily unavailable.');
  }

  let response;
  try {
    response = await fetcher(deliveryUrl.toString(), {
      redirect: 'error',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    throw ApiError.unavailable('File storage is temporarily unavailable.');
  }
  if (!response?.ok || !response.body) {
    try {
      await response?.body?.cancel?.();
    } catch {
      // Provider error response details are intentionally ignored.
    }
    throw ApiError.unavailable('File storage is temporarily unavailable.');
  }

  const contentLength = Number(response.headers?.get?.('content-length')) || 0;
  const bytes = await readBoundedStream(response.body, contentLength);
  return bytes;
};

export const resolveHelpdeskAttachmentDelivery = async ({
  attachment,
  _signer = getPrivateAssetSignedUrl,
  _fetch = fetch,
  _readLocal = (key) => readLocalBounded(key),
} = {}) => {
  const storageProvider = attachment?.storageProvider;
  const storageKey = assertHelpdeskAttachmentStorageKey({
    storageProvider,
    storageKey: attachment?.storageKey,
    companyId: attachment?.companyId,
    ticketId: attachment?.ticketId,
  });

  let bytes;
  if (storageProvider === 'CLOUDINARY_AUTHENTICATED') {
    bytes = await fetchRemoteAttachment({ attachment: { ...attachment, storageKey }, signer: _signer, fetcher: _fetch });
  } else if (storageProvider === 'LOCAL_PRIVATE') {
    if (process.env.NODE_ENV === 'production') {
      throw ApiError.notFound('File not found.');
    }
    try {
      bytes = await _readLocal(storageKey);
    } catch (error) {
      if (error?.statusCode) throw error;
      throw ApiError.notFound('File not found.');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length > HELPDESK_ATTACHMENT_MAX_BYTES) {
      throw ApiError.unavailable('File storage is temporarily unavailable.');
    }
  } else {
    throw ApiError.notFound('File not found.');
  }

  assertStoredIntegrity(attachment, bytes);
  return {
    bytes,
    contentType: attachment.mimeType,
    fileName: attachment.originalFileName,
  };
};

export const destroyHelpdeskAttachment = async ({
  storageProvider,
  storageKey,
  companyId,
  ticketId,
  _destroy = destroyPrivateAsset,
  _localDirectory = LOCAL_DIRECTORY,
} = {}) => {
  try {
    const safeKey = assertHelpdeskAttachmentStorageKey({
      storageProvider,
      storageKey,
      companyId,
      ticketId,
    });
    if (storageProvider === 'CLOUDINARY_AUTHENTICATED') {
      return await _destroy({ storageKey: safeKey, resourceType: RESOURCE_TYPE }) === true;
    }
    if (storageProvider === 'LOCAL_PRIVATE') {
      await fs.rm(localPath(safeKey, _localDirectory), { force: true });
      return true;
    }
  } catch {
    // Compensation is best-effort; failures are tracked by the metadata row.
  }
  return false;
};

export { LOCAL_DIRECTORY as HELPDESK_ATTACHMENT_LOCAL_DIRECTORY };
