import {
  exportTeamTimesheets,
  getEmployeeTimesheet,
  getMyTimesheet,
  getTeamTimesheets,
} from "../services/attendance/attendanceTimesheetService.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

// ============================================================
// PHASE 31.10 — ATTENDANCE CALENDAR & TIMESHEETS
// Read-only monthly timesheets (self + scoped team) and the
// scoped CSV export. Scope, derivation and serialization all
// live in the timesheet service; this controller only moves the
// allowlisted query across (export streams a file download).
// ============================================================

export const getMyTimesheetMonth = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.query || {};

  // DB Logic - DB logics
  const sheet = await getMyTimesheet({
    companyId: req.companyId,

    actor: req.user,

    month,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "My timesheet",

    data: sheet,
  });
});

export const getTeamTimesheetTable = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, search, departmentId, hasExceptions, page, pageSize } =
    req.query || {};

  // DB Logic - DB logics
  const table = await getTeamTimesheets({
    companyId: req.companyId,

    actor: req.user,

    query: {
      month,
      search,
      departmentId,
      hasExceptions,
      page,
      pageSize,
    },
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Team timesheets",

    data: table,
  });
});

export const getScopedEmployeeTimesheet = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeId } = req.params || {};
  const { month } = req.query || {};

  // DB Logic - DB logics
  const sheet = await getEmployeeTimesheet({
    companyId: req.companyId,

    actor: req.user,

    employeeId,

    month,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Employee timesheet",

    data: sheet,
  });
});

// Sync CSV download (statutory fileResponse precedent: headers +
// res.end). Export is audited once inside the service.
const fileResponse = (res, { filename, contentType, content }) => {
  res.setHeader("Content-Type", contentType || "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // 31.16 D-09 — Content-Length is BYTES: CSV strings carry a BOM +
  // multibyte data, so char .length under-declares and poisons the
  // keep-alive socket for the next response. Buffers pass through.
  const bodyLength = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content ?? '', 'utf8');
  res.setHeader("Content-Length", String(bodyLength));
  return res.end(content);
};

export const downloadTeamTimesheets = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month, search, departmentId, hasExceptions } = req.query || {};

  // DB Logic - DB logics
  const file = await exportTeamTimesheets({
    companyId: req.companyId,

    actor: req.user,

    query: {
      month,
      search,
      departmentId,
      hasExceptions,
    },
  });

  // Data to frontend - response to frontend
  return fileResponse(res, {
    filename: file.filename,
    contentType: file.contentType,
    content: file.content,
  });
});
