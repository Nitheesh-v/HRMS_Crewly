// ─────────────────────────────────────────────────────────────
// Phase 31.14 — kiosk stations, sessions, and punches.
//
// Trust model: the station secret authenticates the SHARED DEVICE
// (a trusted workplace terminal); the employee code identifies the
// employee PER PUNCH. Secrets are shown once and stored sha256;
// sessions are short kiosk-scoped JWTs (see kioskAuth).
//
// Honest limitation (no PIN in 31.14): a code alone cannot
// strongly prove physical identity. Forgery requires physical
// access to a trusted ACTIVE station plus the victim's code, and
// every punch is station-attributed in immutable provenance.
// The QR path (authenticated session + challenge) is the strong
// alternative for high-assurance workplaces.
//
// All punches converge on recordEvent with server-decided
// ingest { source: KIOSK, provenance }. Kiosk punches are OFFICE
// by definition (the station IS the workplace) and always use
// server time. No browser GPS is collected or claimed.
// ─────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  KIOSK_SESSION_TTL_MS,
  maskEmployeeName,
} from './attendanceSourceRules.js';
import { EVENT_TYPE, EVENT_SOURCE } from './attendancePolicyRules.js';
import { recordEvent, getLiveAttendance } from './attendanceEventService.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import { monthOfInstantInZone } from './attendanceImportRules.js';
import {
  resolveEmployeeByCode,
  assertIngestMonthOpen,
} from './attendanceIngestSupport.js';
import AttendanceKiosk from '../../models/AttendanceKiosk.js';
import AttendanceLocation from '../../models/AttendanceLocation.js';

export const KIOSK_SECRET_BYTES = 32;

export const hashStationSecret = (secret) => {
  if (typeof secret !== 'string' || !secret) return '';
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
};

const safeStation = (doc) => {
  if (!doc) return null;
  const location = doc.location && typeof doc.location === 'object' ? doc.location : null;
  return {
    id: String(doc._id),
    companyId: String(doc.companyId),
    name: doc.name,
    locationId: location ? String(location._id || doc.location) : doc.location ? String(doc.location) : null,
    locationName: location?.name || null,
    status: doc.status,
    secretVersion: doc.secretVersion,
    lastUsedAt: doc.lastUsedAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
};

const runAudit = (deps, args) =>
  Promise.resolve()
    .then(() => (deps.audit || recordAudit)(args))
    .catch(() => {});

// ── Station lifecycle (HR/admin) ─────────────────────────────

const loadLocation = async ({ companyId, locationId, deps }) => {
  if (!locationId) return null;
  if (!mongoose.isValidObjectId(locationId)) {
    throw ApiError.badRequest('locationId must be an ObjectId string');
  }
  const LocationModel = deps.LocationModel || AttendanceLocation;
  const location = await LocationModel.findOne({ _id: locationId, companyId, isActive: true })
    .select('_id name')
    .lean();
  if (!location) throw ApiError.badRequest('Attendance location not found or inactive');
  return location;
};

export const createStation = async ({ companyId, name, locationId = null, actor = null, req = null, deps = {} } = {}) => {
  if (!mongoose.isValidObjectId(companyId)) throw ApiError.badRequest('Company context is required');
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 60) {
    throw ApiError.badRequest('Station name is required (max 60 characters)');
  }
  const location = await loadLocation({ companyId, locationId, deps });
  const secret = crypto.randomBytes(KIOSK_SECRET_BYTES).toString('base64url');
  const StationModel = deps.StationModel || AttendanceKiosk;
  let station;
  try {
    station = await StationModel.create({
      companyId,
      name: cleanName,
      location: location?._id || null,
      status: 'ACTIVE',
      secretHash: hashStationSecret(secret),
      secretVersion: 1,
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });
  } catch (error) {
    if (error?.code === 11000) throw ApiError.conflict('A station with this name already exists');
    throw error;
  }
  await runAudit(deps, {
    req,
    action: 'ATTENDANCE_KIOSK_CREATED',
    companyId,
    actorId: actor?._id || null,
    resource: 'AttendanceKiosk',
    resourceId: station._id,
    newValue: { name: cleanName, locationId: location?._id || null },
  });
  const safe = safeStation(station.toObject ? station.toObject() : station);
  if (location) {
    safe.locationId = String(location._id);
    safe.locationName = location.name;
  }
  return { station: safe, secret };
};

export const listStations = async ({ companyId, deps = {} } = {}) => {
  if (!mongoose.isValidObjectId(companyId)) return [];
  const StationModel = deps.StationModel || AttendanceKiosk;
  const rows = await StationModel.find({ companyId })
    .populate('location', 'name')
    .sort({ name: 1 })
    .limit(200)
    .lean();
  return (rows || []).map(safeStation);
};

export const updateStation = async ({ companyId, stationId, patch = {}, actor = null, req = null, deps = {} } = {}) => {
  if (!mongoose.isValidObjectId(companyId) || !mongoose.isValidObjectId(stationId)) {
    throw ApiError.badRequest('Station not found');
  }
  const updates = {};
  if (patch.name !== undefined) {
    const cleanName = String(patch.name || '').trim();
    if (!cleanName || cleanName.length > 60) throw ApiError.badRequest('Station name is required (max 60 characters)');
    updates.name = cleanName;
  }
  if (patch.locationId !== undefined) {
    if (patch.locationId === null || patch.locationId === '') {
      updates.location = null;
    } else {
      const location = await loadLocation({ companyId, locationId: patch.locationId, deps });
      updates.location = location._id;
    }
  }
  if (patch.status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(patch.status)) throw ApiError.badRequest('status must be ACTIVE or INACTIVE');
    updates.status = patch.status;
  }
  if (!Object.keys(updates).length) throw ApiError.badRequest('Nothing to update');
  updates.updatedBy = actor?._id || null;

  const StationModel = deps.StationModel || AttendanceKiosk;
  const before = await StationModel.findOne({ _id: stationId, companyId }).select('status name').lean();
  if (!before) throw ApiError.notFound('Station not found');
  let station;
  try {
    station = await StationModel.findOneAndUpdate(
      { _id: stationId, companyId },
      { $set: updates },
      { returnDocument: 'after' }
    )
      .populate('location', 'name')
      .lean();
  } catch (error) {
    if (error?.code === 11000) throw ApiError.conflict('A station with this name already exists');
    throw error;
  }
  const statusFlipped = updates.status && updates.status !== before.status;
  await runAudit(deps, {
    req,
    action: statusFlipped
      ? updates.status === 'INACTIVE' ? 'ATTENDANCE_KIOSK_DEACTIVATED' : 'ATTENDANCE_KIOSK_REACTIVATED'
      : 'ATTENDANCE_KIOSK_UPDATED',
    companyId,
    actorId: actor?._id || null,
    resource: 'AttendanceKiosk',
    resourceId: stationId,
    previousValue: { status: before.status },
    newValue: updates,
  });
  return safeStation(station);
};

export const rotateStationSecret = async ({ companyId, stationId, actor = null, req = null, deps = {} } = {}) => {
  if (!mongoose.isValidObjectId(companyId) || !mongoose.isValidObjectId(stationId)) {
    throw ApiError.badRequest('Station not found');
  }
  const secret = crypto.randomBytes(KIOSK_SECRET_BYTES).toString('base64url');
  const StationModel = deps.StationModel || AttendanceKiosk;
  const station = await StationModel.findOneAndUpdate(
    { _id: stationId, companyId },
    { $set: { secretHash: hashStationSecret(secret), updatedBy: actor?._id || null }, $inc: { secretVersion: 1 } },
    { returnDocument: 'after' }
  ).lean();
  if (!station) throw ApiError.notFound('Station not found');
  await runAudit(deps, {
    req,
    action: 'ATTENDANCE_KIOSK_SECRET_ROTATED',
    companyId,
    actorId: actor?._id || null,
    resource: 'AttendanceKiosk',
    resourceId: stationId,
    newValue: { secretVersion: station.secretVersion },
  });
  return { secret, secretVersion: station.secretVersion };
};

// ── Kiosk session (shared device sign-in) ────────────────────
// Generic failures everywhere: no station enumeration, no status
// oracle — a disabled station looks identical to a wrong secret.

const GENERIC_SESSION_ERROR = 'Invalid station credentials';

export const openSession = async ({ stationId, secret, deps = {} } = {}) => {
  const deny = () => {
    throw ApiError.unauthorized(GENERIC_SESSION_ERROR);
  };
  if (!mongoose.isValidObjectId(stationId) || typeof secret !== 'string' || !secret) deny();
  const StationModel = deps.StationModel || AttendanceKiosk;
  const station = await StationModel.findOne({ _id: stationId })
    .select('+secretHash')
    .populate('location', 'name')
    .lean();
  if (!station || station.status !== 'ACTIVE') deny();
  const candidate = hashStationSecret(secret);
  const expected = Buffer.from(String(station.secretHash || ''), 'utf8');
  const actual = Buffer.from(candidate, 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) deny();

  // Lazy env: hermetic callers stub the signer and never touch
  // process config; production signs with the shared JWT secret.
  const sign = deps.signKioskToken || (async (claims) => {
    const { default: env } = await import('../../config/env.js');
    return jwt.sign(claims, env.JWT_SECRET, { expiresIn: KIOSK_SESSION_TTL_MS / 1000 });
  });
  const token = await sign({
    typ: 'kiosk',
    stationId: String(station._id),
    companyId: String(station.companyId),
    sv: station.secretVersion,
  });
  const location = station.location && typeof station.location === 'object' ? station.location : null;
  return {
    token,
    expiresAt: new Date(Date.now() + KIOSK_SESSION_TTL_MS).toISOString(),
    station: {
      id: String(station._id),
      name: station.name,
      locationName: location?.name || null,
    },
  };
};

// ── Employee identification + punch (kiosk session) ──────────

const loadActiveStation = async ({ companyId, stationId, deps }) => {
  const StationModel = deps.StationModel || AttendanceKiosk;
  const station = await StationModel.findOne({ _id: stationId, companyId, status: 'ACTIVE' })
    .populate('location', 'name')
    .lean();
  if (!station) throw ApiError.unauthorized('Kiosk station unavailable — please sign in again');
  return station;
};

export const identifyEmployee = async ({ companyId, stationId, employeeCode, deps = {} } = {}) => {
  await loadActiveStation({ companyId, stationId, deps });
  const user = await resolveEmployeeByCode({ companyId, employeeCode, deps });
  // Generic: the rate-limited kiosk must not become a code oracle.
  if (!user) throw ApiError.notFound('Employee not found or inactive');
  const live = deps.getLiveAttendance || getLiveAttendance;
  const snapshot = await live({ companyId, userId: user._id });
  return {
    employeeCode: user.employeeCode,
    maskedName: maskEmployeeName(user.name),
    liveState: snapshot?.liveState || 'NOT_IN',
    allowedActions: snapshot?.allowedActions || [],
  };
};

export const punchEmployee = async ({
  companyId,
  stationId,
  employeeCode,
  action,
  idempotencyKey = null,
  deps = {},
} = {}) => {
  if (!Object.values(EVENT_TYPE).includes(action)) {
    throw ApiError.badRequest('Unknown attendance action');
  }
  const station = await loadActiveStation({ companyId, stationId, deps });
  const user = await resolveEmployeeByCode({ companyId, employeeCode, deps });
  if (!user) throw ApiError.notFound('Employee not found or inactive');

  // Finalized-month protection (kiosk punches are current-day, but
  // the guard is uniform and cheap).
  const getPolicy = deps.getCurrentPolicy || getCurrentPolicy;
  let timeZone = 'Asia/Kolkata';
  try {
    const current = await getPolicy({ companyId });
    timeZone = current?.policy?.timezone || timeZone;
  } catch {
    // Policy unreadable → UTC-fallback month; recordEvent still
    // enforces its own policy rules for the punch itself.
  }
  await assertIngestMonthOpen({ companyId, month: monthOfInstantInZone(Date.now(), timeZone), deps });

  const location = station.location && typeof station.location === 'object' ? station.location : null;
  const record = deps.recordEvent || recordEvent;
  const result = await record({
    companyId,
    userId: user._id,
    action,
    // Kiosk = physical workplace presence: OFFICE by definition,
    // server-decided (never from the shared screen).
    workMode: action === EVENT_TYPE.CLOCK_IN ? 'OFFICE' : null,
    idempotencyKey: idempotencyKey || null,
    ingest: {
      source: EVENT_SOURCE.KIOSK,
      provenance: {
        stationId: String(station._id),
        stationName: station.name,
        ...(location ? { locationId: String(location._id), locationName: location.name } : {}),
      },
    },
  });

  // Best-effort usage stamp (must never fail the punch).
  try {
    const StationModel = deps.StationModel || AttendanceKiosk;
    await StationModel.updateOne({ _id: station._id }, { $set: { lastUsedAt: new Date() } });
  } catch {
    // Punch already committed — usage telemetry stays lossy.
  }
  return result;
};
