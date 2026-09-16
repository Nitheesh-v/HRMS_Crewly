import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { validateKioskClaims } from '../services/attendance/attendanceSourceRules.js';
import AttendanceKiosk from '../models/AttendanceKiosk.js';

// Phase 31.14 — kiosk session authentication (least privilege).
//
// Kiosk JWTs ({typ:'kiosk', stationId, companyId, sv}) authenticate
// the SHARED DEVICE, never an employee. This middleware:
//   - verifies signature + expiry (existing JWT_SECRET);
//   - validates claim shape (pure rules);
//   - re-checks the station is ACTIVE and the secret version still
//     matches (rotation/deactivation kill sessions immediately);
//   - sets req.kiosk + req.companyId (tenant authority comes from
//     the trusted session, never from client input).
//
// It mounts ONLY on the kiosk punch router. Normal `protect`
// rejects kiosk tokens (no user id), and kiosk tokens can never
// reach HR/employee APIs — the routers simply don't mount this
// middleware anywhere else.
export const kioskAuth = asyncHandler(async (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Kiosk session required');
  }

  let decoded;
  try {
    decoded = jwt.verify(authorization.slice(7), env.JWT_SECRET);
  } catch {
    throw ApiError.unauthorized('Invalid or expired kiosk session');
  }

  const errors = validateKioskClaims(decoded);
  if (errors.length) {
    throw ApiError.unauthorized('Invalid kiosk session');
  }

  const station = await AttendanceKiosk.findOne({
    _id: decoded.stationId,
    companyId: decoded.companyId,
    status: 'ACTIVE',
  })
    .select('_id companyId name location status secretVersion')
    .lean();

  if (!station || station.secretVersion !== decoded.sv) {
    throw ApiError.unauthorized('Kiosk station unavailable — please sign in again');
  }

  req.kiosk = {
    stationId: String(station._id),
    stationName: station.name,
    companyId: String(station.companyId),
    locationId: station.location ? String(station.location) : null,
  };
  req.companyId = req.kiosk.companyId;
  next();
});

export default kioskAuth;
