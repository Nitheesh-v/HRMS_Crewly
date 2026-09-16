// ─────────────────────────────────────────────────────────────
// Phase 31.14 — QR challenge issuance, resolution, and redemption.
//
// A challenge binds an AUTHENTICATED employee session to a PLACE
// (location, optionally a station) for five minutes. Token →
// sha256 at rest; single-use atomic claim; GET never punches;
// the punch path converges on recordEvent with server-decided
// ingest { source: QR, provenance }.
//
// Identity ALWAYS comes from the employee's own JWT session
// (companyId + userId) — never from the token, the URL, or the
// request body. Cross-tenant tokens resolve as NOT_FOUND.
// ─────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  QR_TOKEN_BYTES,
  QR_CHALLENGE_TTL_MS,
  QR_PURPOSE,
  QR_PUNCH_PATH,
  hashQrToken,
  validateChallengeForUse,
} from './attendanceQrRules.js';
import { EVENT_TYPE, EVENT_SOURCE } from './attendancePolicyRules.js';
import { recordEvent, getLiveAttendance } from './attendanceEventService.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import { monthOfInstantInZone } from './attendanceImportRules.js';
import { assertIngestMonthOpen } from './attendanceIngestSupport.js';
import AttendanceQrChallenge from '../../models/AttendanceQrChallenge.js';
import AttendanceKiosk from '../../models/AttendanceKiosk.js';
import AttendanceLocation from '../../models/AttendanceLocation.js';
import User from '../../models/User.js';

const runAudit = (deps, args) =>
  Promise.resolve()
    .then(() => (deps.audit || recordAudit)(args))
    .catch(() => {});

export const generateQrToken = (bytes = QR_TOKEN_BYTES) =>
  crypto.randomBytes(bytes).toString('base64url');

const safeChallenge = (doc) => {
  if (!doc) return null;
  const location = doc.location && typeof doc.location === 'object' ? doc.location : null;
  const station = doc.station && typeof doc.station === 'object' ? doc.station : null;
  return {
    id: String(doc._id),
    companyId: String(doc.companyId),
    purpose: doc.purpose,
    locationId: location ? String(location._id || doc.location) : doc.location ? String(doc.location) : null,
    locationName: location?.name || null,
    stationId: station ? String(station._id || doc.station) : doc.station ? String(doc.station) : null,
    stationName: station?.name || null,
    expiresAt: doc.expiresAt instanceof Date ? doc.expiresAt.toISOString() : new Date(doc.expiresAt).toISOString(),
    usedAt: doc.usedAt ? new Date(doc.usedAt).toISOString() : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  };
};

// ── Issuance (HR/admin) ──────────────────────────────────────

export const createChallenge = async ({
  companyId,
  locationId = null,
  stationId = null,
  actor = null,
  req = null,
  deps = {},
} = {}) => {
  if (!mongoose.isValidObjectId(companyId)) throw ApiError.badRequest('Company context is required');
  if (!locationId && !stationId) {
    throw ApiError.badRequest('A challenge must bind to a location or a station');
  }
  const LocationModel = deps.LocationModel || AttendanceLocation;
  const StationModel = deps.StationModel || AttendanceKiosk;
  let location = null;
  let station = null;
  if (locationId) {
    if (!mongoose.isValidObjectId(locationId)) throw ApiError.badRequest('locationId must be an ObjectId string');
    location = await LocationModel.findOne({ _id: locationId, companyId, isActive: true })
      .select('_id name')
      .lean();
    if (!location) throw ApiError.badRequest('Attendance location not found or inactive');
  }
  if (stationId) {
    if (!mongoose.isValidObjectId(stationId)) throw ApiError.badRequest('stationId must be an ObjectId string');
    station = await StationModel.findOne({ _id: stationId, companyId, status: 'ACTIVE' })
      .select('_id name')
      .lean();
    if (!station) throw ApiError.badRequest('Kiosk station not found or inactive');
  }

  const generate = deps.generateQrToken || generateQrToken;
  const now = deps.now ? deps.now() : Date.now();
  const token = await generate();
  const ChallengeModel = deps.ChallengeModel || AttendanceQrChallenge;
  const challenge = await ChallengeModel.create({
    companyId,
    purpose: QR_PURPOSE,
    location: location?._id || null,
    station: station?._id || null,
    tokenHash: hashQrToken(token),
    expiresAt: new Date(now + QR_CHALLENGE_TTL_MS),
    createdBy: actor?._id || null,
  });
  await runAudit(deps, {
    req,
    action: 'ATTENDANCE_QR_CHALLENGE_CREATED',
    companyId,
    actorId: actor?._id || null,
    resource: 'AttendanceQrChallenge',
    resourceId: challenge._id,
    // Challenge id only — the token itself is never logged.
    newValue: {
      challengeId: String(challenge._id),
      locationId: location?._id || null,
      stationId: station?._id || null,
      expiresAt: challenge.expiresAt,
    },
  }).catch(() => {});
  const safe = safeChallenge(challenge.toObject ? challenge.toObject() : challenge);
  safe.locationName = location?.name || null;
  safe.stationName = station?.name || null;
  return {
    challenge: safe,
    // Shown ONCE — the only moment the raw token exists outside
    // the QR pixels.
    token,
    punchPath: `${QR_PUNCH_PATH}/${token}`,
    expiresAt: safe.expiresAt,
  };
};

// ── Resolution (authenticated employee, POST only) ───────────
// Read-only preview for the confirm screen. Never consumes.

const challengeFailure = (reason) => {
  switch (reason) {
    case 'EXPIRED':
      throw ApiError.gone('This QR code has expired — please scan a fresh one');
    case 'ALREADY_USED':
      throw ApiError.gone('This QR code has already been used');
    case 'WRONG_TENANT':
      throw ApiError.notFound('QR code not recognized');
    default:
      throw ApiError.badRequest('QR code not recognized');
  }
};

const loadActiveEmployee = async ({ companyId, userId, deps }) => {
  const UserModel = deps.UserModel || User;
  const user = await UserModel.findOne({ _id: userId, companyId, status: 'ACTIVE' })
    .select('_id companyId name employeeCode status')
    .lean();
  if (!user) throw ApiError.unauthorized('Employee session is no longer active');
  return user;
};

export const resolveChallenge = async ({ companyId, token, userId, deps = {} } = {}) => {
  const digest = hashQrToken(token);
  if (!digest) throw ApiError.badRequest('QR code not recognized');
  const ChallengeModel = deps.ChallengeModel || AttendanceQrChallenge;
  const challenge = await ChallengeModel.findOne({ tokenHash: digest })
    .populate('location', 'name')
    .populate('station', 'name')
    .lean();
  const now = deps.now ? deps.now() : Date.now();
  const check = validateChallengeForUse({ challenge, companyId, nowMs: now });
  if (!check.valid) challengeFailure(check.reason);
  const user = await loadActiveEmployee({ companyId, userId, deps });
  const live = deps.getLiveAttendance || getLiveAttendance;
  const snapshot = await live({ companyId, userId: user._id });
  return {
    ...safeChallenge(challenge),
    employeeCode: user.employeeCode,
    liveState: snapshot?.liveState || 'NOT_IN',
    allowedActions: snapshot?.allowedActions || [],
  };
};

// ── Redemption (authenticated employee, POST only) ───────────
// Atomic single-use claim, then the standard engine.

export const redeemChallenge = async ({
  companyId,
  userId,
  token,
  action,
  idempotencyKey = null,
  deps = {},
} = {}) => {
  if (!Object.values(EVENT_TYPE).includes(action)) {
    throw ApiError.badRequest('Unknown attendance action');
  }
  const digest = hashQrToken(token);
  if (!digest) throw ApiError.badRequest('QR code not recognized');
  const nowMs = deps.now ? deps.now() : Date.now();
  const now = new Date(nowMs);
  const ChallengeModel = deps.ChallengeModel || AttendanceQrChallenge;

  // Atomic single-use claim: exactly one redemption wins.
  const claimed = await ChallengeModel.findOneAndUpdate(
    {
      tokenHash: digest,
      companyId,
      purpose: QR_PURPOSE,
      expiresAt: { $gt: now },
      usedAt: null,
    },
    { $set: { usedAt: now }, $inc: { useCount: 1 } },
    { returnDocument: 'after' }
  ).lean();
  if (!claimed) {
    // Failure-path read only (accurate errors, no oracle: tenant
    // mismatches stay NOT_FOUND).
    const existing = await ChallengeModel.findOne({ tokenHash: digest }).select('companyId expiresAt usedAt purpose').lean();
    const check = validateChallengeForUse({ challenge: existing, companyId, nowMs });
    challengeFailure(check.valid ? 'UNKNOWN' : check.reason);
  }

  const user = await loadActiveEmployee({ companyId, userId, deps });

  const getPolicy = deps.getCurrentPolicy || getCurrentPolicy;
  let timeZone = 'Asia/Kolkata';
  try {
    const current = await getPolicy({ companyId });
    timeZone = current?.policy?.timezone || timeZone;
  } catch {
    // Policy unreadable → UTC-fallback month; recordEvent still
    // enforces its own rules for the punch itself.
  }
  await assertIngestMonthOpen({ companyId, month: monthOfInstantInZone(nowMs, timeZone), deps });

  const full = await ChallengeModel.findById(claimed._id)
    .populate('location', 'name')
    .populate('station', 'name')
    .lean();
  const location = full?.location && typeof full.location === 'object' ? full.location : null;
  const station = full?.station && typeof full.station === 'object' ? full.station : null;

  const record = deps.recordEvent || recordEvent;
  return record({
    companyId,
    userId: user._id,
    action,
    // QR punches happen at the workplace the code hangs in:
    // OFFICE by definition, server-decided.
    workMode: action === EVENT_TYPE.CLOCK_IN ? 'OFFICE' : null,
    idempotencyKey: idempotencyKey || null,
    ingest: {
      source: EVENT_SOURCE.QR,
      provenance: {
        challengeId: String(claimed._id),
        ...(location || claimed.location
          ? { locationId: String(location?._id || claimed.location), ...(location ? { locationName: location.name } : {}) }
          : {}),
        ...(station || claimed.station
          ? { stationId: String(station?._id || claimed.station), ...(station ? { stationName: station.name } : {}) }
          : {}),
      },
    },
  });
};
