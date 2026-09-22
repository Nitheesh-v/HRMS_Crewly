// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.8 — PRIVATE CLOUDINARY ASSET ADAPTER (infrastructure/storage)
//
// ONE place for the provider mechanics of PRIVATE Cloudinary objects:
// upload (authenticated, never public), bounded signed delivery URLs,
// destroy. This is the same semantics the hardened domain storage
// services (resume / offer / pre-onboarding / BGV evidence) already use —
// those services stay untouched; this adapter exists so the remaining
// employee-file flows (documents, expense receipts, task attachments)
// stop maintaining their own copies of provider options.
//
// LAWS PINNED HERE:
//   · type: 'authenticated'  — the object has NO permanent public URL.
//   · overwrite: false        — a new object never silently replaces an
//                               existing key; callers generate fresh uuid keys.
//   · Signed URLs are issued ONLY after Crewly authorization (the domain
//     controller decides who may call this) and are BOUNDED (≤ 5 minutes).
//   · destroy is best-effort and never throws (established semantics).
//   · Credentials never leave this process; nothing here logs values,
//     URLs, or keys.
//
// Provider-injectable for hermetic tests (`_cloudinary` / `_ready`).
// ─────────────────────────────────────────────────────────────────────────────
import cloudinary, { cloudinaryReady } from '../../config/cloudinary.js';
import ApiError from '../../utils/ApiError.js';

export const PRIVATE_SIGNED_URL_TTL_SECONDS = 5 * 60; // same bound as resume delivery

const clampTtl = (ttlSeconds) => {
  const parsed = Number(ttlSeconds);
  if (!Number.isFinite(parsed)) return PRIVATE_SIGNED_URL_TTL_SECONDS;
  return Math.min(PRIVATE_SIGNED_URL_TTL_SECONDS, Math.max(30, Math.floor(parsed)));
};

const assertResourceType = (resourceType) => {
  if (resourceType !== 'raw' && resourceType !== 'image') {
    throw new ApiError(500, 'Unsupported private asset resource type');
  }
};

export const uploadPrivateAsset = async ({
  buffer,
  storageKey,
  resourceType = 'raw',
  _cloudinary = cloudinary,
  _ready = cloudinaryReady,
} = {}) => {
  assertResourceType(resourceType);

  if (!_ready) throw new ApiError(503, 'Secure file storage is unavailable');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(500, 'Private asset upload had no content');
  }

  const result = await new Promise((resolve, reject) => {
    const stream = _cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        type: 'authenticated',
        public_id: storageKey,
        overwrite: false,
        use_filename: false,
        unique_filename: false,
      },
      (error, res) => (error ? reject(error) : resolve(res))
    );
    stream.end(buffer);
  }).catch((error) => {
    // Provider failures normalize to a LOUD, provider-detail-free 503 —
    // the DB must never be told a durable file exists when it does not
    // (§40), and provider internals never reach logs/responses (§55).
    throw new ApiError(503, 'Secure file storage is temporarily unavailable');
  });

  return {
    storageProvider: 'CLOUDINARY_AUTHENTICATED',
    storageKey: result.public_id,
  };
};

export const getPrivateAssetSignedUrl = ({
  storageKey,
  resourceType = 'raw',
  attachment = false,
  ttlSeconds = PRIVATE_SIGNED_URL_TTL_SECONDS,
  _cloudinary = cloudinary,
  _ready = cloudinaryReady,
} = {}) => {
  assertResourceType(resourceType);

  if (!_ready) throw new ApiError(503, 'File storage is temporarily unavailable');

  const expiresAt = Math.floor(Date.now() / 1000) + clampTtl(ttlSeconds);
  const url = _cloudinary.utils.private_download_url(storageKey, '', {
    resource_type: resourceType,
    type: 'authenticated',
    attachment,
    expires_at: expiresAt,
  });

  return { url, expiresAt };
};

export const destroyPrivateAsset = async ({
  storageKey,
  resourceType = 'raw',
  _cloudinary = cloudinary,
  _ready = cloudinaryReady,
} = {}) => {
  if (!storageKey) return;
  if (!_ready) return;

  try {
    await _cloudinary.uploader.destroy(storageKey, {
      resource_type: resourceType,
      type: 'authenticated',
      invalidate: true,
    });
  } catch {
    // Best-effort, like every established storage delete in Crewly.
  }
};
