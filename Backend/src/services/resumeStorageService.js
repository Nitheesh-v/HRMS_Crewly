import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import cloudinary, { cloudinaryReady } from '../config/cloudinary.js';
import ApiError from '../utils/ApiError.js';

const LOCAL_STORAGE_DIRECTORY = path.resolve(
  process.env.PRIVATE_RESUME_STORAGE_DIR || 'private_storage/resumes'
);
const DOWNLOAD_TTL_SECONDS = 5 * 60;

const uploadToCloudinary = ({ buffer, storageKey }) =>
  new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        type: 'authenticated',
        public_id: storageKey,
        overwrite: false,
        use_filename: false,
        unique_filename: false,
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      }
    );

    upload.end(buffer);
  });

const localFilePath = (storageKey) => {
  const safeKey = path.basename(String(storageKey || ''));

  if (!safeKey || safeKey !== storageKey) {
    throw ApiError.notFound('Resume not found');
  }

  return path.join(LOCAL_STORAGE_DIRECTORY, safeKey);
};

export const storeResume = async ({ file, companyId }) => {
  const randomId = crypto.randomUUID();

  if (cloudinaryReady) {
    const storageKey = `crewly-private-resumes/${companyId}/${randomId}`;
    const result = await uploadToCloudinary({
      buffer: file.buffer,
      storageKey,
    });

    return {
      storageProvider: 'CLOUDINARY_AUTHENTICATED',
      storageKey: result.public_id,
    };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new ApiError(503, 'Secure resume storage is unavailable');
  }

  await fs.mkdir(LOCAL_STORAGE_DIRECTORY, {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(localFilePath(randomId), file.buffer, {
    flag: 'wx',
    mode: 0o600,
  });

  return {
    storageProvider: 'LOCAL_PRIVATE',
    storageKey: randomId,
  };
};

export const deleteStoredResume = async ({ storageProvider, storageKey }) => {
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
    await fs.rm(localFilePath(storageKey), { force: true });
  }
};

export const getStoredResumeAccess = async ({
  storageProvider,
  storageKey,
}) => {
  if (storageProvider === 'CLOUDINARY_AUTHENTICATED') {
    if (!cloudinaryReady) {
      throw new ApiError(503, 'Resume storage is temporarily unavailable');
    }

    const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
    const url = cloudinary.utils.private_download_url(storageKey, '', {
      resource_type: 'raw',
      type: 'authenticated',
      attachment: true,
      expires_at: expiresAt,
    });

    return { type: 'SIGNED_URL', url, expiresAt };
  }

  if (storageProvider === 'LOCAL_PRIVATE') {
    const filePath = localFilePath(storageKey);

    try {
      await fs.access(filePath);
    } catch {
      throw ApiError.notFound('Resume not found');
    }

    return { type: 'LOCAL_FILE', filePath };
  }

  throw ApiError.notFound('Resume not found');
};
