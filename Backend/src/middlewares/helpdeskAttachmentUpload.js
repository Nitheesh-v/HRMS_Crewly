import multer from 'multer';

import { documentFileFilter } from './documentFilePolicy.js';
import ApiError from '../utils/ApiError.js';
import {
  HELPDESK_ATTACHMENT_FIELD,
  HELPDESK_ATTACHMENT_MAX_BYTES,
} from '../services/helpdesk/helpdeskFileRules.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: HELPDESK_ATTACHMENT_MAX_BYTES,
    files: 1,
    fields: 2,
    parts: 3,
    fieldSize: 16 * 1024,
    fieldNameSize: 64,
  },
  fileFilter: documentFileFilter,
}).single(HELPDESK_ATTACHMENT_FIELD);

export const helpdeskAttachmentUpload = (req, res, next) => {
  const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) {
    return next(ApiError.badRequest(
      `Attachments must use multipart/form-data (file field "${HELPDESK_ATTACHMENT_FIELD}").`,
    ));
  }

  return upload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(413, 'File must be 10 MB or smaller.'));
    }
    return next(ApiError.badRequest('File must be a PDF, JPG, JPEG, PNG, or WEBP with a matching type.'));
  });
};

export default helpdeskAttachmentUpload;
