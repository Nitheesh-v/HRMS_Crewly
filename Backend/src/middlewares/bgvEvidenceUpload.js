// ============================================================
//  PHASE 30.1 — BGV EVIDENCE UPLOAD (multipart, memory only)
//
//  Files are received in memory, validated here (MIME + size)
//  and immediately routed through the private storage service.
//  Nothing touches disk in the request path and nothing is
//  logged.
// ============================================================

import multer from 'multer';
import ApiError from '../utils/ApiError.js';
import { BGV_EVIDENCE_MIME_ALLOWLIST } from '../services/bgv/bgvCheckRules.js';
import { bgvEvidenceMaxBytes } from '../services/bgv/bgvEvidenceStorage.js';

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: bgvEvidenceMaxBytes(), files: 1, fieldSize: 4096 },
  fileFilter: (_req, file, cb) => {
    if (!BGV_EVIDENCE_MIME_ALLOWLIST.includes(file.mimetype)) {
      return cb(ApiError.badRequest('Evidence files must be PNG, JPEG, WEBP or PDF'));
    }
    return cb(null, true);
  },
});

export const bgvEvidenceUpload = (req, res, next) => {
  uploader.single('file')(req, res, (error) => {
    if (error) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.badRequest('Evidence file exceeds the allowed size'));
      }
      if (error instanceof ApiError) return next(error);
      return next(ApiError.badRequest('Upload could not be processed'));
    }
    return next();
  });
};
