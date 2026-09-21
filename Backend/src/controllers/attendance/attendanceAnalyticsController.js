import ApiResponse from '../../utils/ApiResponse.js';
import asyncHandler from '../../utils/asyncHandler.js';
import {
  exportReport,
  getEmployees,
  getMine,
  getOverview,
  getPayrollReconciliation,
  getTrends,
} from '../../services/attendance/attendanceAnalyticsService.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.15 — historical attendance reporting & analytics.
// Thin controllers: query in, service out. Reads are unaudited
// (no AuditLog spam); exports are audited once inside the service.
// ─────────────────────────────────────────────────────────────

// Sync file download (31.10 fileResponse precedent: headers + res.end).
const fileResponse = (res, { filename, contentType, content }) => {
  res.setHeader('Content-Type', contentType || 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // 31.16 D-09 — Content-Length is BYTES: CSV strings carry a BOM +
  // multibyte data, so char .length under-declares and poisons the
  // keep-alive socket for the next response. Buffers pass through.
  const bodyLength = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content ?? '', 'utf8');
  res.setHeader('Content-Length', String(bodyLength));
  return res.end(content);
};

// GET /api/attendance/analytics/overview — KPIs + distributions.
export const getAnalyticsOverview = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query || {};

  // DB Logic - DB logics
  const data = await getOverview({ companyId: req.companyId, actor: req.user, query });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Attendance analytics overview', data });
});

// GET /api/attendance/analytics/trends — monthly buckets.
export const getAnalyticsTrends = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query || {};

  // DB Logic - DB logics
  const data = await getTrends({ companyId: req.companyId, actor: req.user, query });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Attendance analytics trends', data });
});

// GET /api/attendance/analytics/employees — paginated detail table.
export const getAnalyticsEmployees = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query || {};

  // DB Logic - DB logics
  const data = await getEmployees({ companyId: req.companyId, actor: req.user, query });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Attendance analytics employees', data });
});

// GET /api/attendance/analytics/mine — personal analytics (self).
export const getAnalyticsMine = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query || {};

  // DB Logic - DB logics
  const data = await getMine({ companyId: req.companyId, actor: req.user, query });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'My attendance analytics', data });
});

// GET /api/attendance/analytics/payroll-reconciliation — read-only compare.
export const getAnalyticsRecon = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query || {};

  // DB Logic - DB logics
  const data = await getPayrollReconciliation({ companyId: req.companyId, actor: req.user, query });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Attendance payroll reconciliation', data });
});

// GET /api/attendance/analytics/export — CSV/XLSX download.
export const getAnalyticsExport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query || {};

  // DB Logic - DB logics
  const file = await exportReport({ companyId: req.companyId, actor: req.user, query });

  // Data to frontend - response to frontend
  return fileResponse(res, {
    filename: file.filename,
    contentType: file.contentType,
    content: file.content,
  });
});
