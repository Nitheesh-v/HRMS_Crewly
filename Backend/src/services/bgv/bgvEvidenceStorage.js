// ============================================================
//  PHASE 30.1 — BGV EVIDENCE STORAGE
//
//  Same security posture as pre-onboarding documents: private
//  Cloudinary "authenticated" resource when configured, local
//  private directory otherwise (dev/test). No public URLs, ever.
//  Env: PRIVATE_BGV_STORAGE_DIR (new, documented in the phase
//  doc) and MAX_BGV_EVIDENCE_SIZE_MB (falls back to
//  MAX_PRE_ONBOARDING_DOC_SIZE_MB, then 10 MB).
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import cloudinary, { cloudinaryReady } from '../../config/cloudinary.js';
import ApiError from '../../utils/ApiError.js';

const LOCAL_DIRECTORY = path.resolve(
  process.env.PRIVATE_BGV_STORAGE_DIR || 'private_storage/bgv'
);

const megabytes = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 50 ? parsed : fallback;
};

export const bgvEvidenceMaxBytes = () =>
  megabytes(process.env.MAX_BGV_EVIDENCE_SIZE_MB, megabytes(process.env.MAX_PRE_ONBOARDING_DOC_SIZE_MB, 10)) *
  1024 *
  1024;

const localPath = (storageKey) => {
  const safeKey = path.basename(String(storageKey || ''));
  if (!safeKey || safeKey !== storageKey) {
    throw ApiError.notFound('Evidence not found');
  }
  return path.join(LOCAL_DIRECTORY, safeKey);
};

const uploadAuthenticated = ({ buffer, storageKey }) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        type: 'authenticated',
        public_id: storageKey,
        overwrite: false,
        use_filename: false,
        unique_filename: false,
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });

export const storeBgvEvidence = async ({ buffer, companyId, maxBytes = bgvEvidenceMaxBytes() }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > maxBytes) {
    throw ApiError.badRequest('Evidence file is empty or too large');
  }

  const randomId = crypto.randomUUID();

  if (cloudinaryReady) {
    const storageKey = `crewly-private-bgv/${companyId}/${randomId}`;
    const result = await uploadAuthenticated({ buffer, storageKey });
    return {
      storageProvider: 'CLOUDINARY_AUTHENTICATED',
      storageKey: result.public_id,
      fileUrl: `bgv-evidence/${companyId}/${result.public_id}`,
    };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new ApiError(503, 'Secure evidence storage is unavailable');
  }

  await fs.mkdir(LOCAL_DIRECTORY, { recursive: true, mode: 0o700 });
  await fs.writeFile(localPath(randomId), buffer, { flag: 'wx', mode: 0o600 });
  return {
    storageProvider: 'LOCAL_PRIVATE',
    storageKey: randomId,
    fileUrl: `bgv-evidence/${companyId}/${randomId}`,
  };
};

const boundedRemoteBuffer = async (response, maxBytes) => {
  const declared = Number(response.headers.get('content-length')) || 0;
  if (declared > maxBytes) throw new ApiError(413, 'Evidence is too large');

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new ApiError(413, 'Evidence is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
};

export const getStoredBgvEvidence = async ({ storageProvider, storageKey, maxBytes = bgvEvidenceMaxBytes() }) => {
  if (storageProvider === 'CLOUDINARY_AUTHENTICATED') {
    if (!cloudinaryReady) throw new ApiError(503, 'Evidence is temporarily unavailable');

    const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
    const url = cloudinary.utils.private_download_url(storageKey, '', {
      resource_type: 'raw',
      type: 'authenticated',
      expires_at: expiresAt,
    });
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.body) {
      throw new ApiError(503, 'Evidence is temporarily unavailable');
    }
    return boundedRemoteBuffer(response, maxBytes);
  }

  if (storageProvider === 'LOCAL_PRIVATE') {
    try {
      const file = await fs.stat(localPath(storageKey));
      if (!file.isFile()) throw new Error('Not a file');
      if (file.size > maxBytes) throw new ApiError(413, 'Evidence is too large');
      return await fs.readFile(localPath(storageKey));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.notFound('Evidence not found');
    }
  }

  throw ApiError.notFound('Evidence not found');
};
