// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.8 — PRIVATE FILE DELIVERY RESOLVER
//
// The authorized-download endpoint pattern for employee file flows
// (documents / expense receipts / task attachments). The DOMAIN controller
// enforces its own authorization FIRST (owner / HR / task visibility —
// a storage key or URL alone is never authorization); only then does it
// call `resolvePrivateFileDelivery`, which returns HOW the bytes reach the
// authorized caller:
//
//   NEW private rows      → { kind: 'SIGNED_URL' }  — bounded (≤ 5 min)
//                           provider URL generated HERE, after authz.
//   LEGACY public rows    → { kind: 'REDIRECT' }    — 302 to the stored URL,
//                           but now reachable ONLY through this gated
//                           endpoint (residual until the approved
//                           one-time migration; documented in §32.8).
//   DEV inline rows       → { kind: 'INLINE' }      — base64 data: URI rows
//                           (dev fallback) decoded and streamed; no URL
//                           exists at all.
//   anything else         → 404 ApiError (provider mismatch / unknown).
//
// Pure and injectable — no network calls of its own.
// ─────────────────────────────────────────────────────────────────────────────
import ApiError from '../utils/ApiError.js';

export const resolvePrivateFileDelivery = ({
  storageProvider,
  storageKey,
  legacyUrl,
  dataUri,
  resourceType = 'raw',
  signedUrlResolver,
} = {}) => {
  if (storageProvider === 'CLOUDINARY_AUTHENTICATED') {
    if (!storageKey) throw ApiError.notFound('File not found');
    if (typeof signedUrlResolver !== 'function') {
      throw new ApiError(503, 'File storage is temporarily unavailable');
    }
    const { url, expiresAt } = signedUrlResolver({ storageKey, resourceType });
    return { kind: 'SIGNED_URL', url, expiresAt, storageKey };
  }

  if (storageProvider === 'LEGACY_PUBLIC_URL') {
    if (!legacyUrl) throw ApiError.notFound('File not found');
    return { kind: 'REDIRECT', url: legacyUrl };
  }

  if (storageProvider === 'INLINE_DEV_FALLBACK') {
    if (!dataUri || typeof dataUri !== 'string' || !dataUri.startsWith('data:')) {
      throw ApiError.notFound('File not found');
    }
    const commaIndex = dataUri.indexOf(',');
    if (commaIndex < 0) throw ApiError.notFound('File not found');
    const meta = dataUri.slice(5, commaIndex); // e.g. "image/png;base64"
    const contentType = meta.split(';')[0] || 'application/octet-stream';
    const bytes = Buffer.from(dataUri.slice(commaIndex + 1), 'base64');
    return { kind: 'INLINE', bytes, contentType };
  }

  throw ApiError.notFound('File not found');
};

/**
 * Classify what an upload produced so the model can store the right
 * reference shape. Mirrors the established dev-fallback semantics of the
 * legacy controllers (cloud failure in DEV → inline base64, never a 500);
 * in PRODUCTION a provider failure must fail loud — the caller checks
 * `allowInlineFallback` only outside production.
 */
export const classifyUploadedAsset = ({ cloudResult, file, allowInlineFallback }) => {
  if (cloudResult) {
    return {
      storageProvider: 'CLOUDINARY_AUTHENTICATED',
      storageKey: cloudResult.storageKey,
      legacyUrl: '',
      dataUri: '',
    };
  }

  if (!allowInlineFallback) {
    throw new ApiError(503, 'Secure file storage is unavailable');
  }

  return {
    storageProvider: 'INLINE_DEV_FALLBACK',
    storageKey: '',
    legacyUrl: '',
    dataUri: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
  };
};

/**
 * For rows written BEFORE 32.8 (public-URL era): adapt their stored shape
 * to the delivery resolver's input without touching the database.
 */
export const legacyRowDeliveryInput = (
  row,
  { legacyUrlField = 'fileUrl', providerField = 'storageProvider', keyField = 'storageKey' } = {}
) => {
  if (row && row[providerField] && row[keyField]) {
    return {
      storageProvider: row[providerField],
      storageKey: row[keyField],
      legacyUrl: '',
      dataUri: '',
    };
  }

  if (row && row.dataUri) {
    return { storageProvider: 'INLINE_DEV_FALLBACK', storageKey: '', legacyUrl: '', dataUri: row.dataUri };
  }

  const legacyUrl = row ? row[legacyUrlField] || row.url || '' : '';

  if (legacyUrl && legacyUrl.startsWith('data:')) {
    return { storageProvider: 'INLINE_DEV_FALLBACK', storageKey: '', legacyUrl: '', dataUri: legacyUrl };
  }

  return { storageProvider: 'LEGACY_PUBLIC_URL', storageKey: '', legacyUrl, dataUri: '' };
};
