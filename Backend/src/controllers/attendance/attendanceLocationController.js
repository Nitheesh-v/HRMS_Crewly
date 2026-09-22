// ─────────────────────────────────────────────────────────────
// Phase 31.3 — Attendance Location controllers (thin).
// Location rules live in services/attendance/attendanceLocationRules.js;
// orchestration in services/attendance/attendanceLocationService.js.
// ─────────────────────────────────────────────────────────────
import ApiResponse from '../../utils/ApiResponse.js';
import asyncHandler from '../../utils/asyncHandler.js';
import {
  createLocation,
  getLocation,
  listEligibleLocations,
  listLocations,
  setLocationActive,
  updateLocation,
} from '../../services/attendance/attendanceLocationService.js';

export const getAttendanceLocations = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const locations = await listLocations({ companyId: req.companyId });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Attendance locations fetched', data: locations });
});

export const getEligibleAttendanceLocations = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const locations = await listEligibleLocations({ companyId: req.companyId });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Eligible attendance locations fetched', data: locations });
});

export const getAttendanceLocation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { locationId } = req.params;
  // DB Logic - DB logics
  const location = await getLocation({ companyId: req.companyId, locationId });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Attendance location fetched', data: location });
});

export const createAttendanceLocation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const input = req.body || {};
  // DB Logic - DB logics
  const location = await createLocation({
    companyId: req.companyId,
    input,
    actor: req.user,
    req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: 'Attendance location created', data: location });
});

export const updateAttendanceLocation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { locationId } = req.params;
  const input = req.body || {};
  // DB Logic - DB logics
  const location = await updateLocation({
    companyId: req.companyId,
    locationId,
    input,
    actor: req.user,
    req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Attendance location updated', data: location });
});

export const activateAttendanceLocation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { locationId } = req.params;
  // DB Logic - DB logics
  const location = await setLocationActive({
    companyId: req.companyId,
    locationId,
    isActive: true,
    actor: req.user,
    req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Attendance location activated', data: location });
});

export const deactivateAttendanceLocation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { locationId } = req.params;
  // DB Logic - DB logics
  const location = await setLocationActive({
    companyId: req.companyId,
    locationId,
    isActive: false,
    actor: req.user,
    req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Attendance location deactivated', data: location });
});
