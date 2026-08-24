import path from 'node:path';
import multer from 'multer';

const configuredSizeMb = Number(process.env.MAX_RESUME_SIZE_MB || 5);
export const MAX_RESUME_SIZE_MB = Number.isFinite(configuredSizeMb)
  ? Math.min(10, Math.max(1, configuredSizeMb))
  : 5;
export const MAX_RESUME_FILE_SIZE = MAX_RESUME_SIZE_MB * 1024 * 1024;

const ALLOWED_RESUMES = new Map([
  ['.pdf', 'application/pdf'],
  [
    '.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
]);

const resumeFileFilter = (_req, file, callback) => {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const expectedMime = ALLOWED_RESUMES.get(extension);

  if (!expectedMime || file.mimetype !== expectedMime) {
    return callback(
      new Error('Resume must be a PDF or DOCX file with a valid file type')
    );
  }

  return callback(null, true);
};

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_RESUME_FILE_SIZE,
    files: 1,
    fields: 30,
    parts: 31,
    fieldNameSize: 80,
    fieldSize: 10 * 1024,
  },
  fileFilter: resumeFileFilter,
}).single('resume');

export const publicResumeUpload = (req, res, next) => {
  uploader(req, res, (error) => {
    if (!error) return next();

    error.statusCode = 400;

    if (error.code === 'LIMIT_FILE_SIZE') {
      error.message = `Resume must be ${MAX_RESUME_SIZE_MB} MB or smaller`;
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      error.message = 'Only one resume can be uploaded';
    } else if (error.code?.startsWith('LIMIT_')) {
      error.message = 'Application form is too large or malformed';
    }

    return next(error);
  });
};
