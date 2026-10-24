import path from 'node:path';

import { DOCUMENT_FILE_ALLOWLIST } from '../../middlewares/documentFilePolicy.js';
import ApiError from '../../utils/ApiError.js';

export const HELPDESK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const HELPDESK_ATTACHMENT_FIELD = 'file';
export const HELPDESK_ATTACHMENT_KEY_PREFIX = 'crewly-private-helpdesk-attachments';
export const HELPDESK_ATTACHMENT_MIME_TYPES = Object.freeze([
  ...new Set(DOCUMENT_FILE_ALLOWLIST.values()),
]);

const OBJECT_ID = /^[a-f\d]{24}$/i;
const LOCAL_KEY = /^[a-f\d]{24}$/i;
const CLOUD_KEY = new RegExp(
  `^${HELPDESK_ATTACHMENT_KEY_PREFIX}/[a-f\\d]{24}/[a-f\\d]{24}/[a-f\\d]{24}$`,
  'i',
);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const normalizedExtension = (originalName) =>
  path.extname(String(originalName || '').replace(/\\/g, '/')).toLowerCase();

const hasActualSignature = (buffer, mimeType) => {
  if (!Buffer.isBuffer(buffer)) return false;

  if (mimeType === 'application/pdf') {
    return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  }
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3
      && buffer[0] === 0xff
      && buffer[1] === 0xd8
      && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= PNG_SIGNATURE.length
      && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
};

export const safeHelpdeskFileName = (rawName, extension = '.bin') => {
  const baseName = String(rawName || `attachment${extension}`)
    .replace(/\\/g, '/')
    .split('/')
    .pop();
  const safe = String(baseName || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[^a-zA-Z0-9._() -]/g, '_')
    .slice(0, 220)
    .trim();

  return safe || `attachment${extension}`;
};

export const assertAllowedHelpdeskAttachment = ({
  originalName,
  mimeType,
  buffer,
} = {}) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw ApiError.badRequest('A non-empty file is required.');
  }
  if (buffer.length > HELPDESK_ATTACHMENT_MAX_BYTES) {
    throw ApiError.badRequest('File must be 10 MB or smaller.');
  }

  const extension = normalizedExtension(originalName);
  const expectedMime = DOCUMENT_FILE_ALLOWLIST.get(extension);
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  if (!expectedMime || normalizedMime !== expectedMime) {
    throw ApiError.badRequest('File must be a PDF, JPG, JPEG, PNG, or WEBP with a matching type.');
  }
  if (!hasActualSignature(buffer, expectedMime)) {
    throw ApiError.badRequest('File content does not match its declared type.');
  }

  return {
    extension,
    mimeType: expectedMime,
    originalFileName: safeHelpdeskFileName(originalName, extension),
    sizeBytes: buffer.length,
  };
};

export const buildHelpdeskAttachmentStorageKey = ({ companyId, ticketId, attachmentId } = {}) => {
  const company = String(companyId || '').toLowerCase();
  const ticket = String(ticketId || '').toLowerCase();
  const attachment = String(attachmentId || '').toLowerCase();
  if (!OBJECT_ID.test(company) || !OBJECT_ID.test(ticket) || !OBJECT_ID.test(attachment)) {
    throw new ApiError(500, 'A Helpdesk attachment key requires server identifiers');
  }
  return `${HELPDESK_ATTACHMENT_KEY_PREFIX}/${company}/${ticket}/${attachment}`;
};

export const assertHelpdeskAttachmentStorageKey = ({
  storageProvider,
  storageKey,
  companyId,
  ticketId,
} = {}) => {
  const key = String(storageKey || '');
  const company = String(companyId || '').toLowerCase();
  const ticket = String(ticketId || '').toLowerCase();

  if (
    storageProvider === 'LOCAL_PRIVATE'
    && LOCAL_KEY.test(key)
  ) {
    return key;
  }

  const expectedPrefix = `${HELPDESK_ATTACHMENT_KEY_PREFIX}/${company}/${ticket}/`;
  if (
    storageProvider === 'CLOUDINARY_AUTHENTICATED'
    && key.toLowerCase().startsWith(expectedPrefix.toLowerCase())
    && CLOUD_KEY.test(key)
  ) {
    return key;
  }

  throw ApiError.notFound('File not found.');
};

export const _helpdeskFileRulesTest = { hasActualSignature, normalizedExtension };
