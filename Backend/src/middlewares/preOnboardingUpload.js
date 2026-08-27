import path from 'node:path';
import multer from 'multer';

const configuredSizeMb = Number(process.env.MAX_PRE_ONBOARDING_DOC_SIZE_MB || 5);
export const MAX_PRE_ONBOARDING_DOC_SIZE_MB = Number.isFinite(configuredSizeMb)
  ? Math.min(10, Math.max(1, configuredSizeMb))
  : 5;
export const MAX_PRE_ONBOARDING_DOC_FILE_SIZE =
  MAX_PRE_ONBOARDING_DOC_SIZE_MB * 1024 * 1024;

const ALLOWED = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

const fileFilter = (_req, file, callback) => {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const expectedMime = ALLOWED.get(extension);

  if (!expectedMime || file.mimetype !== expectedMime) {
    return callback(
      new Error('Document must be a PDF, JPG, PNG, or WEBP file with a valid type')
    );
  }

  return callback(null, true);
};

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PRE_ONBOARDING_DOC_FILE_SIZE,
    files: 1,
    fields: 20,
    parts: 25,
    fieldNameSize: 80,
    fieldSize: 8 * 1024,
  },
  fileFilter,
}).single('document');

export const preOnboardingUpload = (req, res, next) => {
  uploader(req, res, (error) => {
    if (!error) return next();

    error.statusCode = 400;

    if (error.code === 'LIMIT_FILE_SIZE') {
      error.message = `Document must be ${MAX_PRE_ONBOARDING_DOC_SIZE_MB} MB or smaller`;
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      error.message = 'Only one document can be uploaded';
    } else if (error.code?.startsWith('LIMIT_')) {
      error.message = 'Upload form is too large or malformed';
    }

    return next(error);
  });
};
