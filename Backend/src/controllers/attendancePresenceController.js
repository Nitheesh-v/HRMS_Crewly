import { getTeamPresence } from "../services/attendance/attendancePresenceService.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

// ============================================================
// PHASE 31.9 — WHO'S WORKING / TEAM PRESENCE
// Live attendance-presence board (read-only). Scope, derivation
// and serialization all live in the presence service; this
// controller only moves the allowlisted query across.
// ============================================================

export const getPresence = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { search, departmentId, workMode, presence, page, pageSize } =
    req.query || {};

  // DB Logic - DB logics
  const board = await getTeamPresence({
    companyId: req.companyId,

    actor: req.user,

    query: {
      search,
      departmentId,
      workMode,
      presence,
      page,
      pageSize,
    },
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Team presence",

    data: board,
  });
});
