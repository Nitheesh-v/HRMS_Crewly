import crypto from 'node:crypto';
import path from 'node:path';
import ApiError from '../utils/ApiError.js';

const PDF_MIME = 'application/pdf';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const validatePdf = (buffer) => {
  const header = buffer.subarray(0, 5).toString('ascii');
  const tail = buffer
    .subarray(Math.max(0, buffer.length - 4096))
    .toString('latin1');

  if (header !== '%PDF-' || !tail.includes('%%EOF')) {
    throw ApiError.badRequest('Resume file is not a valid PDF');
  }

  const lowerContent = buffer.toString('latin1').toLowerCase();
  const activeMarkers = [
    '/javascript',
    '/launch',
    '/embeddedfile',
    '/richmedia',
  ];

  if (activeMarkers.some((marker) => lowerContent.includes(marker))) {
    throw ApiError.badRequest('PDF resumes cannot contain active content');
  }
};

const validateDocx = (buffer) => {
  const hasZipHeader =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04;
  const archiveIndex = buffer.toString('latin1').toLowerCase();

  const requiredParts = [
    '[content_types].xml',
    '_rels/.rels',
    'word/document.xml',
  ];
  const blockedParts = [
    'vbaproject.bin',
    'word/embeddings/',
    'word/activex/',
    '.exe',
    '.com',
    '.cmd',
    '.bat',
    '.js',
    '.html',
  ];

  if (
    !hasZipHeader ||
    !requiredParts.every((part) => archiveIndex.includes(part))
  ) {
    throw ApiError.badRequest('Resume file is not a valid DOCX document');
  }

  if (blockedParts.some((part) => archiveIndex.includes(part))) {
    throw ApiError.badRequest('DOCX resumes cannot contain active content');
  }
};

export const safeOriginalFileName = (value, mimeType) => {
  const expectedExtension = mimeType === PDF_MIME ? '.pdf' : '.docx';
  const baseName = path
    .basename(String(value || `resume${expectedExtension}`))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-zA-Z0-9._() -]/g, '_')
    .slice(0, 220)
    .trim();
  const withoutExtension = baseName
    .replace(/\.(pdf|docx)$/i, '')
    .slice(0, 200)
    .trim();

  return `${withoutExtension || 'resume'}${expectedExtension}`;
};

export const scanResumeForMalware = async (_file) => ({
  status: 'NOT_CONFIGURED',
  provider: 'NONE',
  checkedAt: null,
});

export const inspectResumeFile = async (file) => {
  if (!file?.buffer?.length) {
    throw ApiError.badRequest('A resume file is required');
  }

  const extension = path.extname(file.originalname || '').toLowerCase();

  if (file.mimetype === PDF_MIME && extension === '.pdf') {
    validatePdf(file.buffer);
  } else if (file.mimetype === DOCX_MIME && extension === '.docx') {
    validateDocx(file.buffer);
  } else {
    throw ApiError.badRequest('Resume must be a PDF or DOCX file');
  }

  const scan = await scanResumeForMalware(file);

  if (scan.status === 'REJECTED') {
    throw ApiError.badRequest('Resume file did not pass security validation');
  }

  return {
    mimeType: file.mimetype,
    fileSize: file.buffer.length,
    originalFileName: safeOriginalFileName(
      file.originalname,
      file.mimetype
    ),
    checksumSha256: crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex'),
    scanStatus: scan.status,
    scanCheckedAt: scan.checkedAt,
  };
};
