import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { boundedText, uniqueStrings } from './resumeNormalizationService.js';

const PDF_MIME = 'application/pdf';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_RAW_TEXT_CHARACTERS = Math.min(
  250000,
  Math.max(20000, Number(process.env.RESUME_PARSE_MAX_RAW_TEXT_CHARS) || 250000)
);
const MAX_DOCX_EXPANDED_BYTES = Math.min(
  100 * 1024 * 1024,
  Math.max(
    5 * 1024 * 1024,
    Number(process.env.RESUME_PARSE_MAX_DOCX_EXPANDED_BYTES) || 50 * 1024 * 1024
  )
);
const MAX_PDF_PAGES = Math.min(
  200,
  Math.max(1, Number(process.env.RESUME_PARSE_MAX_PDF_PAGES) || 100)
);
const EXTRACTION_TIMEOUT_MS = Math.min(
  120000,
  Math.max(5000, Number(process.env.RESUME_PARSE_TIMEOUT_MS) || 30000)
);
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const BLOCKED_DOCX_PARTS = [
  'vbaproject.bin',
  'word/embeddings/',
  'word/activex/',
  '/macrosheets/',
  '/externallinks/',
  '.exe',
  '.com',
  '.cmd',
  '.bat',
  '.js',
  '.html',
];

export class ResumeExtractionError extends Error {
  constructor(category, safeMessage, options = {}) {
    super(safeMessage, options);
    this.name = 'ResumeExtractionError';
    this.category = category;
    this.safeMessage = safeMessage;
  }
}

const extractionError = (category, safeMessage, cause = null) =>
  new ResumeExtractionError(category, safeMessage, cause ? { cause } : {});

const withTimeout = async (promise, timeoutMs) => {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              extractionError(
                'RESOURCE_LIMIT',
                'Resume extraction exceeded the processing time limit.'
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const findEndOfCentralDirectory = (buffer) => {
  const minimum = Math.max(0, buffer.length - 65557);

  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }

  return -1;
};

const inspectDocxArchive = (buffer) => {
  const endOffset = findEndOfCentralDirectory(buffer);

  if (endOffset < 0 || endOffset + 22 > buffer.length) {
    throw extractionError('CORRUPT_FILE', 'The DOCX file could not be read.');
  }

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);

  if (
    entryCount > 5000 ||
    centralDirectoryOffset + centralDirectorySize > buffer.length ||
    [entryCount, centralDirectorySize, centralDirectoryOffset].includes(0xffff) ||
    [centralDirectorySize, centralDirectoryOffset].includes(0xffffffff)
  ) {
    throw extractionError(
      'RESOURCE_LIMIT',
      'The DOCX archive exceeds the supported safety limits.'
    );
  }

  let offset = centralDirectoryOffset;
  let expandedBytes = 0;
  const names = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw extractionError('CORRUPT_FILE', 'The DOCX file could not be read.');
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nextOffset =
      offset + 46 + fileNameLength + extraLength + commentLength;

    if (
      nextOffset > buffer.length ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      throw extractionError(
        'RESOURCE_LIMIT',
        'The DOCX archive uses an unsupported archive format.'
      );
    }

    if (flags & 0x1) {
      throw extractionError(
        'PASSWORD_PROTECTED',
        'Password-protected resumes cannot be processed.'
      );
    }

    if (![0, 8].includes(compressionMethod)) {
      throw extractionError(
        'UNSUPPORTED_FORMAT',
        'The DOCX compression format is not supported.'
      );
    }

    const fileName = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString('utf8')
      .replace(/\\/g, '/')
      .toLowerCase();

    if (
      fileName.startsWith('/') ||
      fileName.split('/').includes('..') ||
      BLOCKED_DOCX_PARTS.some((part) => fileName.includes(part))
    ) {
      throw extractionError(
        'UNSUPPORTED_FORMAT',
        'The DOCX file contains unsupported active or embedded content.'
      );
    }

    names.push(fileName);
    expandedBytes += uncompressedSize;

    if (expandedBytes > MAX_DOCX_EXPANDED_BYTES) {
      throw extractionError(
        'RESOURCE_LIMIT',
        'The DOCX expanded content exceeds the supported safety limit.'
      );
    }

    offset = nextOffset;
  }

  if (
    !names.includes('[content_types].xml') ||
    !names.includes('_rels/.rels') ||
    !names.includes('word/document.xml')
  ) {
    throw extractionError('CORRUPT_FILE', 'The DOCX file could not be read.');
  }

  return { expandedBytes, entryCount };
};

const qualityResult = (rawValue, metadata = {}) => {
  const cleaned = boundedText(rawValue, MAX_RAW_TEXT_CHARACTERS);
  const alphabeticCharacters = (cleaned.match(/[\p{L}]/gu) || []).length;
  const truncated = String(rawValue || '').length > cleaned.length || metadata.truncated;
  const reviewRequired = cleaned.length < 80 || alphabeticCharacters < 30;
  const density = Math.min(1, alphabeticCharacters / Math.max(1, cleaned.length * 0.45));
  const confidence = reviewRequired
    ? Math.min(0.25, density * 0.25)
    : Math.max(0.5, Math.min(1, density));

  return {
    rawText: cleaned,
    reviewRequired,
    truncated: Boolean(truncated),
    confidence: Number(confidence.toFixed(2)),
    warnings: reviewRequired
      ? [
          'Little or no machine-readable text was found. The resume may be scanned or image-only.',
        ]
      : [],
    ...metadata,
  };
};

const extractPdfText = async (buffer) => {
  const parser = new PDFParse({
    data: buffer,
    stopAtErrors: true,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });

  try {
    const result = await withTimeout(
      parser.getText({
        first: MAX_PDF_PAGES,
        parseHyperlinks: false,
        includeMarkedContent: false,
        pageJoiner: '\n',
      }),
      EXTRACTION_TIMEOUT_MS
    );
    const processedPageCount = result.pages?.length || 0;
    const pageCount = Number(result.total) || processedPageCount;

    return qualityResult(result.text, {
      pageCount,
      processedPageCount,
      truncated: pageCount > processedPageCount,
      extractorVersion: 'pdf-parse-2.4.5',
    });
  } catch (error) {
    if (error instanceof ResumeExtractionError) throw error;

    const errorName = String(error?.name || '').toLowerCase();
    const errorMessage = String(error?.message || '').toLowerCase();

    if (errorName.includes('password') || errorMessage.includes('password')) {
      throw extractionError(
        'PASSWORD_PROTECTED',
        'Password-protected resumes cannot be processed.',
        error
      );
    }

    if (
      errorName.includes('invalidpdf') ||
      errorMessage.includes('invalid pdf') ||
      errorMessage.includes('xref') ||
      errorMessage.includes('corrupt')
    ) {
      throw extractionError('CORRUPT_FILE', 'The PDF file could not be read.', error);
    }

    throw extractionError(
      'EXTRACTION_FAILED',
      'Text could not be extracted from the PDF resume.',
      error
    );
  } finally {
    await parser.destroy().catch(() => {});
  }
};

const extractDocxText = async (buffer) => {
  const archive = inspectDocxArchive(buffer);

  try {
    const result = await withTimeout(
      mammoth.extractRawText({ buffer }),
      EXTRACTION_TIMEOUT_MS
    );
    const warnings = (result.messages || []).length
      ? ['The DOCX extractor reported recoverable document formatting issues.']
      : [];

    return {
      ...qualityResult(result.value, {
        pageCount: 0,
        processedPageCount: 0,
        truncated: false,
        extractorVersion: 'mammoth-1.12.1',
      }),
      warnings: uniqueStrings(
        [...qualityResult(result.value).warnings, ...warnings],
        50,
        300
      ),
      expandedBytes: archive.expandedBytes,
    };
  } catch (error) {
    if (error instanceof ResumeExtractionError) throw error;

    const errorMessage = String(error?.message || '').toLowerCase();

    if (errorMessage.includes('password') || errorMessage.includes('encrypted')) {
      throw extractionError(
        'PASSWORD_PROTECTED',
        'Password-protected resumes cannot be processed.',
        error
      );
    }

    throw extractionError('CORRUPT_FILE', 'The DOCX file could not be read.', error);
  }
};

export const extractResumeText = async ({ buffer, mimeType }) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw extractionError('CORRUPT_FILE', 'The resume file is empty.');
  }

  if (mimeType === PDF_MIME) return extractPdfText(buffer);
  if (mimeType === DOCX_MIME) return extractDocxText(buffer);

  throw extractionError(
    'UNSUPPORTED_FORMAT',
    'This resume format is not supported for text extraction.'
  );
};
