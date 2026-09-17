// ============================================================
// 🖼️ BRANDING UPLOAD MIDDLEWARE — multer (memory storage)
// Company logo: PNG/JPEG only, 2MB. MIME here is a pre-check only —
// the branding service validates magic bytes and structure.
// Errors become clean 400s, never 500s.
// ============================================================
import multer from 'multer';

import { LOGO_MAX_BYTES } from '../services/companyBrandingRules.js';

const memory = multer.memoryStorage();

const logoFilter = (req, file, cb) => {
  if (/^image\/(png|jpe?g)$/i.test(file.mimetype || '')) return cb(null, true);
  cb(new Error('Only PNG or JPG logo images are allowed'));
};

const wrap = (uploader) => (req, res, next) => {
  uploader(req, res, (err) => {
    if (err) {
      err.statusCode = 400;
      if (err.code === 'LIMIT_FILE_SIZE') {
        err.message = `Logo must be ${Math.floor(LOGO_MAX_BYTES / (1024 * 1024))} MB or smaller`;
      }
    }
    next(err);
  });
};

export const brandingLogoUpload = wrap(
  multer({ storage: memory, limits: { fileSize: LOGO_MAX_BYTES }, fileFilter: logoFilter }).single(
    'logo'
  )
);
