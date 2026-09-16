// ============================================================
// 📤 UPLOAD MIDDLEWARE — multer (memory storage)
// avatarUpload → images 2MB · documentUpload → images/PDF 5MB
// Errors become clean 400s, never 500s.
// ============================================================
import multer from 'multer';

const memory = multer.memoryStorage();

const imageFilter = (req, file, cb) => {
  if (/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype)) return cb(null, true);
  cb(new Error('Only PNG, JPG, WEBP or GIF images are allowed'));
};

const docFilter = (req, file, cb) => {
  if (/^(image\/(png|jpe?g|webp)|application\/pdf)$/i.test(file.mimetype)) return cb(null, true);
  cb(new Error('Only PDF, PNG, JPG or WEBP files are allowed'));
};

const wrap = (uploader) => (req, res, next) => {
  uploader(req, res, (err) => {
    if (err) {
      err.statusCode = 400;
      if (err.code === 'LIMIT_FILE_SIZE') err.message = 'File too large';
    }
    next(err);
  });
};

export const avatarUpload = wrap(
  multer({ storage: memory, limits: { fileSize: 2 * 1024 * 1024 }, fileFilter: imageFilter }).single('avatar')
);

export const documentUpload = wrap(
  multer({ storage: memory, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: docFilter }).single('document')
);

// Phase 31.14 — attendance CSV import (memory only; the raw file
// is never persisted — only its fingerprint + outcomes). 2MB
// comfortably holds the 5000-row cap; the parser enforces rows.
const csvFilter = (req, file, cb) => {
  if (/^(text\/csv|application\/vnd\.ms-excel|application\/csv|text\/plain)$/i.test(file.mimetype || '')) {
    return cb(null, true);
  }
  // Browsers often sniff CSV as octet-stream — accept by extension.
  if (/\.csv$/i.test(file.originalname || '')) return cb(null, true);
  cb(new Error('Only CSV files are allowed'));
};

export const csvUpload = wrap(
  multer({ storage: memory, limits: { fileSize: 2 * 1024 * 1024 }, fileFilter: csvFilter }).single('file')
);