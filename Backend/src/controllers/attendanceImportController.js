import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  previewImport,
  confirmImport,
  listImports,
  getImport,
} from '../services/attendance/attendanceImportService.js';
import {
  buildImportTemplate,
  IMPORT_TEMPLATE_FILENAME,
} from '../services/attendance/attendanceImportRules.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.14 — CSV attendance import (HR). Multipart file
// upload (memory only — the raw CSV is never persisted).
// Preview computes without writing; confirm re-validates from
// the uploaded bytes and ingests VALID_ROWS_ONLY.
// ─────────────────────────────────────────────────────────────

const readUpload = (req) => {
  const file = req.file;
  if (!file?.buffer?.length) throw ApiError.badRequest('Upload a CSV file');
  return { content: file.buffer.toString('utf8'), sourceLabel: file.originalname || null };
};

// POST /api/attendance/imports/preview — validate, no writes.
export const postImportPreview = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { content } = readUpload(req);

  // DB Logic - DB logics
  const result = await previewImport({ companyId: req.companyId, content });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Import preview ready — nothing was saved',
    data: result,
  });
});

// POST /api/attendance/imports/confirm — ingest valid rows.
export const postImportConfirm = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { content, sourceLabel } = readUpload(req);

  // DB Logic - DB logics
  const result = await confirmImport({
    companyId: req.companyId,
    content,
    sourceLabel,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.duplicate
      ? 'This file was already imported — showing the stored result'
      : 'Import confirmed',
    data: result,
    meta: result.duplicate ? { idempotentReplay: true } : undefined,
  });
});

// GET /api/attendance/imports — batch history (HR).
export const getImports = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;

  // DB Logic - DB logics
  const imports = await listImports({ companyId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Imports fetched',
    data: { imports },
  });
});

// GET /api/attendance/imports/template.csv — documented starter file.
export const getImportTemplate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  void req.companyId;

  // DB Logic - DB logics
  const csv = buildImportTemplate();

  // Data to frontend - response to frontend
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${IMPORT_TEMPLATE_FILENAME}"`);
  return res.send(csv);
});

// GET /api/attendance/imports/:id — one batch with outcomes (HR).
export const getImportById = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id } = req.params;

  // DB Logic - DB logics
  const batch = await getImport({ companyId: req.companyId, importId: id });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Import fetched',
    data: { import: batch },
  });
});
