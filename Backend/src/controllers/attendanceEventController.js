import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import Leave from '../models/Leave.js';
import {
  getLiveAttendance,
  recordEvent,
} from '../services/attendance/attendanceEventService.js';

// POST /api/attendance/events — record one self-service punch action.
// Identity comes from req.user / req.companyId only (see validator).
export const postEvent = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { action, workMode = null, date = null, idempotencyKey = null } = req.body || {};
  // Phase 31.3 — geofence inputs assembled server-side (the client sends
  // locationId + position; the service consumes them for CLOCK_IN only).
  const { locationId = null, position = null } = req.body || {};
  const location = locationId || position ? { locationId, position } : null;

  // DB Logic - DB logics
  // Phase 31.7 — the live service resolves leave itself when the
  // model is injected (hermetic callers without one skip fast).
  const result = await recordEvent({
    companyId: req.companyId,
    userId: req.user._id,
    action,
    workMode,
    date,
    idempotencyKey,
    location,
    deps: { LeaveModel: Leave },
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
  // Phase 31.7 — Leave injection (see postEvent).
  const snapshot = await getLiveAttendance({ companyId, userId, deps: { LeaveModel: Leave } });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: "Today's live attendance", data: snapshot });
});
