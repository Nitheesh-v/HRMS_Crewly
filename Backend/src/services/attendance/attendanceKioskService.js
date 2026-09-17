// ─────────────────────────────────────────────────────────────
// Phase 31.14 — kiosk stations, sessions, and punches.
//
// Trust model: the station secret authenticates the SHARED DEVICE
// (a trusted workplace terminal); employeeCode + Kiosk PIN verify
// the employee PER VISIT (31.14 completion — the original code-only
// identification is closed). Secrets are shown once and stored
// sha256; device sessions are 8-hour kiosk JWTs (see kioskAuth);
// verified visits mint a 3-minute employee context the punch
// trusts INSTEAD of any client-supplied employee identity.
//
// All punches converge on recordEvent with server-decided
// ingest { source: KIOSK, provenance }. Kiosk punches are OFFICE
// by definition (the station IS the workplace) and always use
// server time. No browser GPS is collected or claimed.
// ─────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  KIOSK_EMPLOYEE_CONTEXT_PURPOSE,
  KIOSK_EMPLOYEE_CONTEXT_TTL_MS,
  KIOSK_SESSION_TTL_MS,
  maskEmployeeName,
  validateKioskEmployeeClaims,
  validateKioskPinShape,
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
import User from '../../models/User.js';

export const KIOSK_SECRET_BYTES = 32;
// bcrypt cost mirrors the login-password precedent (User model).
export const KIOSK_PIN_BCRYPT_COST = 10;

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

// ── Kiosk PIN (self-service terminal credential) ─────────────
// Dedicated attendance-terminal secret: hash-only (bcrypt,
// select:false on the model), never logged / audited / returned.
// Set + change run in the employee's OWN authenticated session
// (identity = req.user — nobody sets another person's PIN). HR can
// only CLEAR (force a fresh setup), never view. Every set/change/
// clear bumps kioskPinVersion, which kills outstanding employee
// contexts minted under the previous credential.

const loadPinIdentity = async ({ companyId, userId, deps }) => {
  if (!mongoose.isValidObjectId(companyId) || !mongoose.isValidObjectId(userId)) return null;
  const UserModel = deps.UserModel || User;
  return UserModel.findOne({ _id: userId, companyId })
    .select('_id companyId status kioskPinHash kioskPinVersion kioskPinSetAt')
    .lean();
};

export const getKioskPinStatus = async ({ companyId, userId, deps = {} } = {}) => {
  const identity = await loadPinIdentity({ companyId, userId, deps });
  if (!identity) throw ApiError.notFound('Employee not found');
  return { configured: Boolean(identity.kioskPinHash) };
};

export const setKioskPin = async ({
  companyId,
  userId,
  pin,
  currentPin = null,
  actor = null,
  req = null,
  deps = {},
} = {}) => {
  const shapeError = validateKioskPinShape(pin);
  if (shapeError) throw ApiError.badRequest(shapeError);
  const identity = await loadPinIdentity({ companyId, userId, deps });
  if (!identity) throw ApiError.notFound('Employee not found');
  if (identity.status !== 'ACTIVE') throw ApiError.forbidden('Only active employees can set a Kiosk PIN');
  const compare = deps.comparePin || bcrypt.compare;
  if (identity.kioskPinHash) {
    if (validateKioskPinShape(currentPin)) {
      throw ApiError.badRequest('Current Kiosk PIN is required to change it');
    }
    if (!(await compare(String(currentPin), identity.kioskPinHash))) {
      throw ApiError.unauthorized('Current Kiosk PIN is incorrect');
    }
  }
  const hash = deps.hashPin || ((value) => bcrypt.hash(value, KIOSK_PIN_BCRYPT_COST));
  const UserModel = deps.UserModel || User;
  const now = deps.now ? new Date(deps.now()) : new Date();
  const updated = await UserModel.findOneAndUpdate(
    { _id: identity._id, companyId },
    { $set: { kioskPinHash: await hash(String(pin)), kioskPinSetAt: now }, $inc: { kioskPinVersion: 1 } },
    { returnDocument: 'after' }
  ).lean();
  await runAudit(deps, {
    req,
    action: 'ATTENDANCE_KIOSK_PIN_SET',
    companyId,
    actorId: actor?._id || userId,
    resource: 'User',
    resourceId: String(identity._id),
    newValue: { kioskPinVersion: updated?.kioskPinVersion ?? null },
  });
  return { configured: true };
};

export const clearKioskPin = async ({ companyId, targetUserId, actor = null, req = null, deps = {} } = {}) => {
  if (!mongoose.isValidObjectId(targetUserId)) throw ApiError.badRequest('targetUserId must be an ObjectId string');
  const UserModel = deps.UserModel || User;
  const updated = await UserModel.findOneAndUpdate(
    { _id: targetUserId, companyId },
    { $set: { kioskPinHash: null, kioskPinSetAt: null }, $inc: { kioskPinVersion: 1 } },
    { returnDocument: 'after' }
  ).lean();
  if (!updated) throw ApiError.notFound('Employee not found');
  await runAudit(deps, {
    req,
    action: 'ATTENDANCE_KIOSK_PIN_CLEARED',
    companyId,
    actorId: actor?._id || null,
    resource: 'User',
    resourceId: String(updated._id),
    targetUserId: String(updated._id),
    newValue: { kioskPinVersion: updated.kioskPinVersion },
  });
  return { configured: false };
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

// 31.14 completion — one generic denial for EVERY identify
// failure (unknown code, inactive employee, unset PIN, wrong PIN):
// the rate-limited kiosk must not become an enumeration oracle.
const GENERIC_IDENTIFY_ERROR = 'Employee code or PIN is incorrect';
// Real bcrypt hash of a random secret: unknown-code / unset-PIN
// failures still pay one comparison so failure timing reveals
// nothing about which half was wrong.
const DUMMY_PIN_HASH = '$2b$10$68ZlzjIEcWJ2flvNClReOOdUT9YOayBiwPfZIqDSRfud2Wj4HYIke';

export const identifyEmployee = async ({ companyId, stationId, employeeCode, pin, deps = {} } = {}) => {
  const deny = () => {
    throw ApiError.unauthorized(GENERIC_IDENTIFY_ERROR);
  };
  if (validateKioskPinShape(pin)) deny();
  await loadActiveStation({ companyId, stationId, deps });
  const compare = deps.comparePin || bcrypt.compare;
  const user = await resolveEmployeeByCode({ companyId, employeeCode, deps });
  const UserModel = deps.UserModel || User;
  const credential = user
    ? await UserModel.findOne({ _id: user._id, companyId }).select('kioskPinHash kioskPinVersion').lean()
    : null;
  const ok = await compare(String(pin), credential?.kioskPinHash || DUMMY_PIN_HASH);
  if (!user || !credential?.kioskPinHash || !ok) deny();
  // Verified visit: mint the short-lived employee context the
  // punch trusts INSTEAD of any client-supplied identity.
  const sign = deps.signEmployeeToken || (async (claims) => {
    const { default: env } = await import('../../config/env.js');
    return jwt.sign(claims, env.JWT_SECRET, { expiresIn: KIOSK_EMPLOYEE_CONTEXT_TTL_MS / 1000 });
  });
  const employeeToken = await sign({
    typ: 'kiosk-employee',
    companyId: String(companyId),
    stationId: String(stationId),
    userId: String(user._id),
    pv: credential.kioskPinVersion || 0,
    purpose: KIOSK_EMPLOYEE_CONTEXT_PURPOSE,
  });
  const live = deps.getLiveAttendance || getLiveAttendance;
  const snapshot = await live({ companyId, userId: user._id });
  return {
    employeeCode: user.employeeCode,
    maskedName: maskEmployeeName(user.name),
    liveState: snapshot?.liveState || 'NOT_IN',
    allowedActions: snapshot?.allowedActions || [],
    employeeToken,
    expiresAt: new Date((deps.now ? deps.now() : Date.now()) + KIOSK_EMPLOYEE_CONTEXT_TTL_MS).toISOString(),
  };
};

// One generic denial for EVERY context failure (bad signature,
// expiry, wrong station/tenant, deactivated employee, rotated
// PIN): failure detail would only aid token juggling.
const GENERIC_CONTEXT_ERROR = 'Employee verification is invalid or expired';

export const punchEmployee = async ({
  companyId,
  stationId,
  employeeToken,
  action,
  idempotencyKey = null,
  // One-shot terminal GPS { latitude, longitude, accuracy? }, sent
  // ONLY when the geofence gate demands verification (strict
  // policy). The locationId half is ALWAYS server-decided from the
  // station binding — the terminal never chooses its own fence.
  position = null,
  deps = {},
} = {}) => {
  const deny = () => {
    throw ApiError.unauthorized(GENERIC_CONTEXT_ERROR);
  };
  if (!Object.values(EVENT_TYPE).includes(action)) {
    throw ApiError.badRequest('Unknown attendance action');
  }
  if (typeof employeeToken !== 'string' || !employeeToken) deny();
  const verify = deps.verifyEmployeeToken || (async (token) => {
    const { default: env } = await import('../../config/env.js');
    return jwt.verify(token, env.JWT_SECRET);
  });
  let claims = null;
  try {
    claims = await verify(employeeToken);
  } catch {
    deny();
  }
  if (validateKioskEmployeeClaims(claims).length) deny();
  // The context is bound to THIS terminal + tenant: a token
  // carried from another station (or tenant) is worthless here.
  if (String(claims.companyId) !== String(companyId) || String(claims.stationId) !== String(stationId)) deny();
  const station = await loadActiveStation({ companyId, stationId, deps });
  const UserModel = deps.UserModel || User;
  const user = await UserModel.findOne({ _id: claims.userId, companyId, status: 'ACTIVE' })
    .select('_id kioskPinVersion')
    .lean();
  // PIN set/change/clear bumps the version: outstanding contexts
  // die with the credential that minted them.
  if (!user || (user.kioskPinVersion || 0) !== claims.pv) deny();

  // The fence is the page the terminal stands on: the station
  // binding supplies locationId, the terminal supplies GPS only
  // when the gate demands it. recordEvent consumes location for
  // CLOCK_IN only, so break/out punches pass it through untouched.
  const stationPlace = station.location && typeof station.location === 'object' ? station.location : null;
  const boundLocationId = stationPlace
    ? String(stationPlace._id)
    : (station.location ? String(station.location) : null);
  if (position && !boundLocationId) {
    throw ApiError.badRequest('This station is not bound to a verifiable location');
  }
  const gateLocation = boundLocationId || position ? { locationId: boundLocationId, position } : null;

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
    location: gateLocation,
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
