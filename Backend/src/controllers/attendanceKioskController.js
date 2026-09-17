import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  createStation,
  listStations,
  updateStation,
  rotateStationSecret,
  openSession,
  identifyEmployee,
  punchEmployee,
  getKioskPinStatus,
  setKioskPin,
  clearKioskPin,
} from '../services/attendance/attendanceKioskService.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.14 — kiosk stations, sessions, and punches.
// Station management is HR/admin (permission router); sessions
// and punches ride the kiosk router (kioskAuth, rate-limited).
// The station secret is shown ONCE at create/rotate — the API
// never returns it again.
// ─────────────────────────────────────────────────────────────

// POST /api/attendance/kiosks — register a station (HR).
export const postStation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { name, locationId = null } = req.body || {};

  // DB Logic - DB logics
  const result = await createStation({
    companyId: req.companyId,
    name,
    locationId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'Kiosk station registered. Store the secret now — it cannot be shown again.',
    data: result,
  });
});

// GET /api/attendance/kiosks — list stations (HR).
export const getStations = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;

  // DB Logic - DB logics
  const stations = await listStations({ companyId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Kiosk stations fetched',
    data: { stations },
  });
});

// PATCH /api/attendance/kiosks/:id — rename / relocate / toggle (HR).
export const patchStation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id } = req.params;
  const { name, locationId, status } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (locationId !== undefined) patch.locationId = locationId;
  if (status !== undefined) patch.status = status;

  // DB Logic - DB logics
  const station = await updateStation({
    companyId: req.companyId,
    stationId: id,
    patch,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Kiosk station updated',
    data: { station },
  });
});

// POST /api/attendance/kiosks/:id/rotate-secret (HR).
export const postStationRotate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { id } = req.params;

  // DB Logic - DB logics
  const result = await rotateStationSecret({
    companyId: req.companyId,
    stationId: id,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Station secret rotated. All kiosk sessions for this station are now invalid — store the new secret.',
    data: result,
  });
});

// POST /api/kiosk/session — shared-device sign-in (public + rate-limited).
export const postKioskSession = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { stationId, secret } = req.body || {};

  // DB Logic - DB logics
  const session = await openSession({ stationId, secret });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Kiosk session opened',
    data: session,
  });
});

// POST /api/kiosk/identify — code + PIN verification for the
// shared screen. Returns the short-lived employee context the
// punch trusts; failures are one generic 401 (never which half).
export const postKioskIdentify = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeCode, pin } = req.body || {};

  // DB Logic - DB logics
  const result = await identifyEmployee({
    companyId: req.kiosk.companyId,
    stationId: req.kiosk.stationId,
    employeeCode,
    pin,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Employee identified',
    data: result,
  });
});

// POST /api/kiosk/punch — one punch for the VERIFIED employee.
// Identity comes only from the employee context (bound to this
// station + tenant); the terminal supplies no employee identity.
export const postKioskPunch = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { employeeToken, action, idempotencyKey = null } = req.body || {};

  // DB Logic - DB logics
  const result = await punchEmployee({
    companyId: req.kiosk.companyId,
    stationId: req.kiosk.stationId,
    employeeToken,
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

// ── Kiosk PIN self-service (employee session) ────────────────
// Identity is ALWAYS req.user (own PIN only). The hash is never
// selected, never returned — only { configured }.

// GET /api/attendance/kiosk-pin — is my PIN configured?
export const getKioskPin = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const userId = req.user._id;

  // DB Logic - DB logics
  const result = await getKioskPinStatus({ companyId: req.companyId, userId });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Kiosk PIN status',
    data: result,
  });
});

// POST /api/attendance/kiosk-pin — set (first time) or change
// (current PIN required) my Kiosk PIN.
export const postKioskPin = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { pin, currentPin = null } = req.body || {};

  // DB Logic - DB logics
  const result = await setKioskPin({
    companyId: req.companyId,
    userId: req.user._id,
    pin,
    currentPin,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Kiosk PIN saved',
    data: result,
  });
});

// POST /api/attendance/kiosk-pin/clear — HR clears an
// employee's PIN (forces a fresh setup; plaintext never visible).
export const postKioskPinClear = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { targetUserId } = req.body || {};

  // DB Logic - DB logics
  const result = await clearKioskPin({
    companyId: req.companyId,
    targetUserId,
    actor: req.user,
    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Kiosk PIN cleared. The employee can set a fresh PIN.',
    data: result,
  });
});
