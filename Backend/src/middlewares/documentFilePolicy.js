// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.8 — DOCUMENT FILE UPLOAD POLICY (middleware)
//
// ONE shared multer policy for the employee-file flows that 32.8 moved to
// private storage (My Documents / HR file cabinet / expense receipts /
// task attachments). Mirrors the repo's established sensitive-document
// policy (`preOnboardingUpload`): memory storage, a hard size cap, and an
// extension+MIME CROSS-CHECK so a `.pdf`-named executable or a browser
//_mime lie cannot slip through as "any type".
//
// Previously `selfServiceRoutes.anyDocUpload` accepted ANY file type up to
// 10 MB and `taskRoutes.taskUpload` any type up to 5 MB — documented gap,
// now closed with the same allowlist the product already uses for
// candidate documents. Size caps are UNCHANGED (§18: no arbitrary limit
// changes without evidence).
// ─────────────────────────────────────────────────────────────────────────────
import multer from 'multer';
import path from 'node:path';

export const DOCUMENT_FILE_ALLOWLIST = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

export const DOCUMENT_FILE_POLICY_MESSAGE =
  'File must be a PDF, JPG, JPEG, PNG, or WEBP with a valid type';

export const documentFileFilter = (_req, file, callback) => {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const expectedMime = DOCUMENT_FILE_ALLOWLIST.get(extension);

  if (!expectedMime || file.mimetype !== expectedMime) {
    return callback(new Error(DOCUMENT_FILE_POLICY_MESSAGE));
  }

  return callback(null, true);
};

// Factory keeps each route's OWN cap (no universal tiny limit): documents
// stay at 10 MB, task attachments at 5 MB — exactly as before 32.8.
export const createDocumentFileUpload = (maxBytes) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes },
    fileFilter: documentFileFilter,
  });
