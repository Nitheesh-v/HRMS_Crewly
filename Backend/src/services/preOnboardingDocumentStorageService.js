import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import cloudinary, { cloudinaryReady } from '../config/cloudinary.js';
import ApiError from '../utils/ApiError.js';

const LOCAL_DIRECTORY = path.resolve(
  process.env.PRIVATE_PRE_ONBOARDING_STORAGE_DIR ||
    'private_storage/pre-onboarding'
);
const MAXIMUM_DOCUMENT_BYTES = 10 * 1024 * 1024;

const localPath = (storageKey) => {
  const safeKey = path.basename(String(storageKey || ''));
  if (!safeKey || safeKey !== storageKey) {
    throw ApiError.notFound('Document not found');
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

export const storePreOnboardingDocument = async ({
  buffer,
  companyId,
  documentCode,
}) => {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length === 0 ||
    buffer.length > MAXIMUM_DOCUMENT_BYTES
  ) {
    throw ApiError.badRequest('Document file is empty or too large');
  }

  const randomId = crypto.randomUUID();

  if (cloudinaryReady) {
    const storageKey = `crewly-private-pre-onboarding/${companyId}/${documentCode}/${randomId}`;
    const result = await uploadAuthenticated({ buffer, storageKey });
    return {
      storageProvider: 'CLOUDINARY_AUTHENTICATED',
      storageKey: result.public_id,
    };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new ApiError(503, 'Secure document storage is unavailable');
  }

  await fs.mkdir(LOCAL_DIRECTORY, { recursive: true, mode: 0o700 });
  await fs.writeFile(localPath(randomId), buffer, { flag: 'wx', mode: 0o600 });
  return { storageProvider: 'LOCAL_PRIVATE', storageKey: randomId };
};

export const deleteStoredPreOnboardingDocument = async ({
  storageProvider,
  storageKey,
}) => {
  if (!storageKey) return;

  if (storageProvider === 'CLOUDINARY_AUTHENTICATED') {
    if (!cloudinaryReady) return;
    await cloudinary.uploader.destroy(storageKey, {
      resource_type: 'raw',
      type: 'authenticated',
      invalidate: true,
    });
    return;
  }

  if (storageProvider === 'LOCAL_PRIVATE') {
    await fs.rm(localPath(storageKey), { force: true });
  }
};

const boundedRemoteBuffer = async (response) => {
  const declared = Number(response.headers.get('content-length')) || 0;
  if (declared > MAXIMUM_DOCUMENT_BYTES) {
    throw new ApiError(413, 'Document is too large');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAXIMUM_DOCUMENT_BYTES) {
      throw new ApiError(413, 'Document is too large');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
};

export const getStoredPreOnboardingDocument = async ({
  storageProvider,
  storageKey,
}) => {
  if (storageProvider === 'CLOUDINARY_AUTHENTICATED') {
    if (!cloudinaryReady) {
      throw new ApiError(503, 'Document is temporarily unavailable');
    }

    const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
    const url = cloudinary.utils.private_download_url(storageKey, '', {
      resource_type: 'raw',
      type: 'authenticated',
      expires_at: expiresAt,
    });
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || !response.body) {
      throw new ApiError(503, 'Document is temporarily unavailable');
    }
    return boundedRemoteBuffer(response);
  }

  if (storageProvider === 'LOCAL_PRIVATE') {
    try {
      const file = await fs.stat(localPath(storageKey));
      if (!file.isFile()) throw new Error('Not a file');
      if (file.size > MAXIMUM_DOCUMENT_BYTES) {
        throw new ApiError(413, 'Document is too large');
      }
      return await fs.readFile(localPath(storageKey));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.notFound('Document not found');
    }
  }

  throw ApiError.notFound('Document not found');
};
