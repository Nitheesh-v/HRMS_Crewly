// ─────────────────────────────────────────────────────────────
// Phase 31.3 — attendance-location service (injectable model).
//
// Owns tenant location configuration (CRUD + activate/deactivate) and
// the CLOCK_IN geofence gate shared by the event service. The model is
// injectable for hermetic tests; audit is an injected seam that never
// breaks a mutation. No cache: reads are single-doc/list and Mongo is
// authoritative (a cache would add invalidation for zero need).
//
// Privacy: employee positions enter ONLY via verifyClockInLocation,
// are validated + measured, then discarded — they never reach a model,
// a log line, or an audit record.
// ─────────────────────────────────────────────────────────────
import AttendanceLocation from '../../models/AttendanceLocation.js';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  VERIFICATION_RESULT,
  buildVerificationSnapshot,
  geofenceRequirement,
  haversineMeters,
  isAccuracyUsable,
  isInsideGeofence,
  validateAccuracyMeters,
  validateLatitude,
  validateLocationInput,
  validateLongitude,
} from './attendanceLocationRules.js';

const writeAudit = (args) => recordAudit(args);

const serializeLocation = (row) => ({
  id: String(row._id || row.id || ''),
  name: row.name,
  code: row.code || null,
  displayAddress: row.displayAddress || null,
  latitude: row.latitude,
  longitude: row.longitude,
  radiusMeters: row.radiusMeters,
  isActive: row.isActive !== false,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
});

// Self-service shape: enough to pick a location, nothing sensitive.
// Office coordinates stay management-only (least exposure).
const serializeEligible = (row) => ({
  id: String(row._id || row.id || ''),
  name: row.name,
  code: row.code || null,
  displayAddress: row.displayAddress || null,
});

const summarizeLocation = (row) => ({
  name: row?.name || '',
  code: row?.code || null,
  latitude: row?.latitude ?? null,
  longitude: row?.longitude ?? null,
  radiusMeters: row?.radiusMeters ?? null,
  isActive: row?.isActive !== false,
});

const auditMutation = async ({ audit, req, action, companyId, actor, row }) =>
  audit({
    req,
    action,
    companyId,
    actorId: actor?._id || actor?.id || null,
    resource: 'AttendanceLocation',
    resourceId: row._id || row.id,
    newValue: summarizeLocation(row),
  }).catch(() => {});

// ── Management ───────────────────────────────────────────────

export const listLocations = async ({ companyId, AttendanceLocationModel = AttendanceLocation }) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const rows = await AttendanceLocationModel.find({ companyId }).sort({ name: 1 }).lean();
  return rows.map(serializeLocation);
};

export const getLocation = async ({ companyId, locationId, AttendanceLocationModel = AttendanceLocation }) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const row = await AttendanceLocationModel.findOne({ _id: locationId, companyId }).lean();
  if (!row) throw ApiError.notFound('Attendance location not found');
  return serializeLocation(row);
};

export const createLocation = async ({
  companyId,
  input = {},
  actor = null,
  req = null,
  audit = writeAudit,
  AttendanceLocationModel = AttendanceLocation,
}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const errors = validateLocationInput(input);
  if (errors.length > 0) throw ApiError.badRequest(errors[0]);
  const created = await AttendanceLocationModel.create({
    companyId,
    name: input.name.trim(),
    code: input.code?.trim() || null,
    displayAddress: input.displayAddress?.trim() || null,
    latitude: input.latitude,
    longitude: input.longitude,
    radiusMeters: input.radiusMeters,
    isActive: input.isActive !== undefined ? Boolean(input.isActive) : true,
    createdBy: actor?._id || actor?.id || null,
    updatedBy: actor?._id || actor?.id || null,
  });
  const plain = created.toObject ? created.toObject() : created;
  await auditMutation({ audit, req, action: 'ATTENDANCE_LOCATION_CREATED', companyId, actor, row: plain });
  return serializeLocation(plain);
};

export const updateLocation = async ({
  companyId,
  locationId,
  input = {},
  actor = null,
  req = null,
  audit = writeAudit,
  AttendanceLocationModel = AttendanceLocation,
}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const current = await AttendanceLocationModel.findOne({ _id: locationId, companyId }).lean();
  if (!current) throw ApiError.notFound('Attendance location not found');
  const merged = {
    name: input.name !== undefined ? input.name : current.name,
    code: input.code !== undefined ? input.code : current.code,
    displayAddress: input.displayAddress !== undefined ? input.displayAddress : current.displayAddress,
    latitude: input.latitude !== undefined ? input.latitude : current.latitude,
    longitude: input.longitude !== undefined ? input.longitude : current.longitude,
    radiusMeters: input.radiusMeters !== undefined ? input.radiusMeters : current.radiusMeters,
  };
  const errors = validateLocationInput(merged);
  if (errors.length > 0) throw ApiError.badRequest(errors[0]);
  const patch = {
    name: merged.name.trim(),
    code: merged.code?.trim() || null,
    displayAddress: merged.displayAddress?.trim() || null,
    latitude: merged.latitude,
    longitude: merged.longitude,
    radiusMeters: merged.radiusMeters,
  };
  if (input.isActive !== undefined) patch.isActive = Boolean(input.isActive);
  patch.updatedBy = actor?._id || actor?.id || null;
  const updated = await AttendanceLocationModel.findOneAndUpdate(
    { _id: locationId, companyId },
    { $set: patch },
    { new: true },
  );
  const plain = updated.toObject ? updated.toObject() : updated;
  await auditMutation({ audit, req, action: 'ATTENDANCE_LOCATION_UPDATED', companyId, actor, row: plain });
  return serializeLocation(plain);
};

export const setLocationActive = async ({
  companyId,
  locationId,
  isActive,
  actor = null,
  req = null,
  audit = writeAudit,
  AttendanceLocationModel = AttendanceLocation,
}) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const updated = await AttendanceLocationModel.findOneAndUpdate(
    { _id: locationId, companyId },
    { $set: { isActive: Boolean(isActive), updatedBy: actor?._id || actor?.id || null } },
    { new: true },
  );
  if (!updated) throw ApiError.notFound('Attendance location not found');
  const plain = updated.toObject ? updated.toObject() : updated;
  await auditMutation({
    audit,
    req,
    action: isActive ? 'ATTENDANCE_LOCATION_ACTIVATED' : 'ATTENDANCE_LOCATION_DEACTIVATED',
    companyId,
    actor,
    row: plain,
  });
  return serializeLocation(plain);
};

// ── Employee self-service ────────────────────────────────────

export const listEligibleLocations = async ({ companyId, AttendanceLocationModel = AttendanceLocation }) => {
  if (!companyId) throw ApiError.badRequest('Company context is required');
  const rows = await AttendanceLocationModel.find({ companyId, isActive: true }).sort({ name: 1 }).lean();
  return rows.map(serializeEligible);
};

// ── CLOCK_IN geofence gate ───────────────────────────────────
// Shared by the 31.2 event service (real function, injected model —
// tests run this exact code against fakes). Returns { snapshot } where
// snapshot is null when no verification applies. Refusals throw BEFORE
// the event service writes anything: no control, no event.
//
// Enforcement matrix (see rules.geofenceRequirement):
// - NONE (DISABLED or non-OFFICE): everything supplied is discarded.
// - OPTIONAL + OFFICE: verify when both halves arrive, never block.
// - REQUIRED + OFFICE: both halves mandatory, outside is refused.
export const verifyClockInLocation = async ({
  AttendanceLocationModel = AttendanceLocation,
  companyId,
  policy,
  mode,
  location = null,
  now = new Date(),
}) => {
  const requirement = geofenceRequirement(policy, mode);
  if (requirement === 'NONE') return { snapshot: null };

  const locationId = location?.locationId ?? null;
  const position = location?.position ?? null;

  if (!locationId && !position) {
    if (requirement === 'REQUIRED') {
      throw ApiError.badRequest('Attendance location verification is required by company policy');
    }
    return { snapshot: null };
  }
  if (position && !locationId) {
    throw ApiError.badRequest('locationId is required when position is supplied');
  }
  if (locationId && !position) {
    if (requirement === 'REQUIRED') {
      throw ApiError.badRequest('Location verification is required by company policy for this clock-in');
    }
    // OPTIONAL fallback: a location was chosen but the position could
    // not be obtained (denied/unavailable) — proceed unverified.
    return { snapshot: null };
  }

  // Both halves supplied: the referenced location must be real,
  // tenant-owned and active under BOTH enforcement modes — a foreign
  // reference is never silently ignored.
  const place = await AttendanceLocationModel.findOne({ _id: locationId, companyId }).lean();
  if (!place) throw ApiError.notFound('Attendance location not found');
  if (place.isActive === false) {
    throw ApiError.badRequest(`'${place.name}' is no longer active for attendance`);
  }

  // Defense in depth: the validator already checked shapes, but direct
  // service callers are protected equally.
  const positionErrors = [
    validateLatitude(position.latitude),
    validateLongitude(position.longitude),
    validateAccuracyMeters(position.accuracy),
  ].filter(Boolean);
  if (positionErrors.length > 0) throw ApiError.badRequest(positionErrors[0]);

  // Authoritative server-side measurement. No client distance, radius
  // or verdict is trusted — the frontend cannot even send them (the
  // validator refuses those fields outright).
  const distanceMeters = haversineMeters(
    position.latitude,
    position.longitude,
    place.latitude,
    place.longitude,
  );
  // 31.16 D-03 — an imprecise fix can never VERIFY (the center point
  // proves nothing when the error radius dwarfs the geofence), but it
  // is failed verification, not a malformed request: REQUIRED refuses
  // with the standard outside-radius message, OPTIONAL proceeds with
  // OUTSIDE evidence. The raw reported value is preserved below.
  const inside = isAccuracyUsable(position.accuracy)
    && isInsideGeofence(distanceMeters, place.radiusMeters);
  if (!inside && requirement === 'REQUIRED') {
    throw ApiError.forbidden(`You are outside the allowed radius for ${place.name}`);
  }
  return {
    snapshot: buildVerificationSnapshot({
      location: place,
      distanceMeters,
      result: inside ? VERIFICATION_RESULT.VERIFIED : VERIFICATION_RESULT.OUTSIDE,
      accuracyMeters: position.accuracy ?? null,
      verifiedAt: now,
    }),
  };
};
