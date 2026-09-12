import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  getLiveAttendance,
  recordEvent,
} from '../services/attendance/attendanceEventService.js';

// POST /api/attendance/events — record one self-service punch action.
// Identity comes from req.user / req.companyId only (see validator).
export const postEvent = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { action, workMode = null, date = null, idempotencyKey = null } = req.body || {};

  // DB Logic - DB logics
  const result = await recordEvent({
    companyId: req.companyId,
    userId: req.user._id,
    action,
    workMode,
    date,
    idempotencyKey,
  });

  // Data to frontend - response to frontend
  if (result.replayed) {
    return ApiResponse.success(res, {
      message: 'Attendance action already recorded',
      data: result,
      meta: { idempotentReplay: true },
    });
  }
  return ApiResponse.created(res, {
    message: 'Attendance recorded',
    data: result,
  });
});

// GET /api/attendance/today/live — backend-derived live snapshot:
// state, durations, timeline, allowed next actions. The UI ticks from
// these authoritative timestamps; it never invents state.
export const getTodayLive = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const userId = req.user._id;

  // DB Logic - DB logics
  const snapshot = await getLiveAttendance({ companyId, userId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: "Today's live attendance", data: snapshot });
});
