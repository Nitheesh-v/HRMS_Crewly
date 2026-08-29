import crypto from 'node:crypto';
import path from 'node:path';
import ApiError from '../utils/ApiError.js';
import { PRE_ONBOARDING_ALLOWED_MIME_TYPES } from '../models/PreOnboardingDocumentRequirement.js';

const EXTENSION_BY_MIME = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const validatePdf = (buffer) => {
  const header = buffer.subarray(0, 5).toString('ascii');
  const tail = buffer
    .subarray(Math.max(0, buffer.length - 4096))
    .toString('latin1');

  if (header !== '%PDF-' || !tail.includes('%%EOF')) {
    throw ApiError.badRequest('File is not a valid PDF');
  }

  const lowerContent = buffer.toString('latin1').toLowerCase();
  const activeMarkers = [
    '/javascript',
    '/launch',
    '/embeddedfile',
    '/richmedia',
    '/js',
  ];

  if (activeMarkers.some((marker) => lowerContent.includes(marker))) {
    throw ApiError.badRequest('PDF documents cannot contain active content');
  }
};

const validateImage = (buffer, mimeType) => {
  if (mimeType === 'image/jpeg') {
    if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) {
      throw ApiError.badRequest('File is not a valid JPEG image');
    }
    return;
  }

  if (mimeType === 'image/png') {
    const signature = buffer.subarray(0, 8);
    const expected = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    if (!signature.equals(expected)) {
      throw ApiError.badRequest('File is not a valid PNG image');
    }
    return;
  }

  if (mimeType === 'image/webp') {
    const riff = buffer.subarray(0, 4).toString('ascii');
    const webp = buffer.subarray(8, 12).toString('ascii');
    if (riff !== 'RIFF' || webp !== 'WEBP') {
      throw ApiError.badRequest('File is not a valid WEBP image');
    }
  }
};

export const safeDocumentFileName = (value, mimeType) => {
  const expectedExtension = EXTENSION_BY_MIME[mimeType] || '.bin';
  const baseName = path
    .basename(String(value || `document${expectedExtension}`))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-zA-Z0-9._() -]/g, '_')
    .slice(0, 220)
    .trim();
  const withoutExtension = baseName
    .replace(/\.(pdf|jpe?g|png|webp)$/i, '')
    .slice(0, 200)
    .trim();

  return `${withoutExtension || 'document'}${expectedExtension}`;
};

export const scanDocumentForMalware = async (_file) => ({
  status: 'NOT_CONFIGURED',
  provider: 'NONE',
  checkedAt: null,
});

// Phase 28.6 — background re-verification of the STORED bytes (the
// worker's source of truth). Reuses the SAME structural validators
// as the upload path (no new rules): throws ApiError(400) on active
// content / invalid structure. The malware abstraction is applied on
// top; without a configured scanner the result stays NOT_CONFIGURED —
// this function never produces a fake CLEAN.
export const verifyStoredDocumentBuffer = async ({ buffer, mimeType }) => {
  if (!buffer?.length) throw ApiError.badRequest('Stored document is empty');
  if (mimeType === 'application/pdf') {
    validatePdf(buffer);
  } else {
    validateImage(buffer, mimeType);
  }
  return scanDocumentForMalware({ buffer, mimetype: mimeType });
};

export const inspectPreOnboardingFile = async ({
  file,
  allowedMimeTypes = PRE_ONBOARDING_ALLOWED_MIME_TYPES,
  maxFileSize = 5 * 1024 * 1024,
}) => {
  if (!file?.buffer?.length) {
    throw ApiError.badRequest('A document file is required');
  }

  if (file.buffer.length > maxFileSize) {
    throw ApiError.badRequest(
      `Document must be ${Math.floor(maxFileSize / (1024 * 1024))} MB or smaller`
    );
  }

  const extension = path.extname(file.originalname || '').toLowerCase();
  const mimeType = String(file.mimetype || '').toLowerCase();

  if (!allowedMimeTypes.includes(mimeType)) {
    throw ApiError.badRequest('This file type is not allowed for the requirement');
  }

  const expectedExtension = EXTENSION_BY_MIME[mimeType];
  const jpegAliases = mimeType === 'image/jpeg' ? ['.jpg', '.jpeg'] : null;
  if (
    !expectedExtension ||
    (jpegAliases
      ? !jpegAliases.includes(extension)
      : extension !== expectedExtension)
  ) {
    throw ApiError.badRequest('File extension does not match the file type');
  }

  if (mimeType === 'application/pdf') {
    validatePdf(file.buffer);
  } else {
    validateImage(file.buffer, mimeType);
  }

  const scan = await scanDocumentForMalware(file);
  if (scan.status === 'REJECTED') {
    throw ApiError.badRequest('Document did not pass security validation');
  }

  return {
    mimeType,
    fileSize: file.buffer.length,
    originalFileName: safeDocumentFileName(file.originalname, mimeType),
    checksumSha256: crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex'),
    scanStatus: scan.status,
    scanCheckedAt: scan.checkedAt,
  };
};
