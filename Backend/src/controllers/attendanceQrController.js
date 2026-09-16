import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  createChallenge,
  resolveChallenge,
  redeemChallenge,
} from '../services/attendance/attendanceQrService.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.14 — QR challenge issuance (HR) and redemption
// (authenticated employees). Resolve + redeem are POST-only:
// no GET ever punches or reveals challenge internals.
// ─────────────────────────────────────────────────────────────

// POST /api/attendance/qr/challenges — issue a 5-minute challenge (HR).
export const postChallenge = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { locationId = null, stationId = null } = req.body || {};

  // DB Logic - DB logics
  const result = await createChallenge({
    companyId: req.companyId,
    locationId,
    stationId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'QR challenge issued. It expires in 5 minutes and can be used once.',
    data: result,
  });
});

// POST /api/attendance/qr/resolve — preview for the confirm screen.
export const postResolve = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { token } = req.body || {};

  // DB Logic - DB logics
  const result = await resolveChallenge({
    companyId: req.companyId,
    token,
    userId: req.user._id,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'QR challenge resolved',
    data: result,
  });
});

// POST /api/attendance/qr/redeem — consume the challenge, punch once.
export const postRedeem = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { token, action, idempotencyKey = null } = req.body || {};

  // DB Logic - DB logics
  const result = await redeemChallenge({
    companyId: req.companyId,
    userId: req.user._id,
    token,
    action,
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
