import { getOperationsDashboard } from "../../services/attendance/attendanceOperationsService.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

// ============================================================
// PHASE 31.12 — HR ATTENDANCE OPERATIONS DASHBOARD
// Read-only operational aggregation over 31.9 presence rows.
// Scope, derivation and serialization all live in the
// operations service; this controller only moves the
// allowlisted query across.
// ============================================================

export const getAttendanceOperations = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const {
    date,
    search,
    departmentId,
    managerId,
    shift,
    location,
    workMode,
    presence,
    category,
    page,
    pageSize,
  } = req.query || {};

  // DB Logic - DB logics
  const dashboard = await getOperationsDashboard({
    companyId: req.companyId,

    actor: req.user,

    query: {
      date,
      search,
      departmentId,
      managerId,
      shift,
      location,
      workMode,
      presence,
      category,
      page,
      pageSize,
    },
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Attendance operations",

    data: dashboard,
  });
});
