// ─────────────────────────────────────────────────────────────
// Phase 31.3 — pure attendance-location rules.
//
// Deterministic and side-effect-free: no Mongo, no req/res, no Redis,
// no browser APIs. Covers coordinate/radius/accuracy validation, the
// Haversine geofence calculation, the policy×mode requirement matrix
// and verification-snapshot construction.
//
// Privacy: these rules never see raw employee movement — only the
// single position sample submitted for one explicit attendance action,
// which callers must discard after verification (never persisted).
// ─────────────────────────────────────────────────────────────
import { LOCATION_ENFORCEMENT_RULE, WORK_MODE } from './attendancePolicyRules.js';

// ── Bounds ───────────────────────────────────────────────────

export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;

// Allowed attendance radius per location. 10 m keeps desk-level kiosk
// use honest; 100 km caps absurd whole-region geofences.
export const RADIUS_MIN_METERS = 10;
export const RADIUS_MAX_METERS = 100000;

// Browser accuracy beyond 100 km is not a position fix — refuse it.
export const ACCURACY_MAX_METERS = 100000;

export const LOCATION_NAME_MAX = 80;
export const LOCATION_CODE_MAX = 32;
export const LOCATION_ADDRESS_MAX = 300;

const EARTH_RADIUS_METERS = 6371000;

// How the server proved the punch (never a client claim).
export const VERIFICATION_RESULT = Object.freeze({
  VERIFIED: 'VERIFIED',
  OUTSIDE: 'OUTSIDE',
});

// ── Field validators (pure; return an error string or null) ──

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export const validateLatitude = (value) => {
  if (!isFiniteNumber(value)) return 'latitude must be a finite number';
  if (value < LATITUDE_MIN || value > LATITUDE_MAX) {
    return `latitude must be between ${LATITUDE_MIN} and ${LATITUDE_MAX}`;
  }
  return null;
};

export const validateLongitude = (value) => {
  if (!isFiniteNumber(value)) return 'longitude must be a finite number';
  if (value < LONGITUDE_MIN || value > LONGITUDE_MAX) {
    return `longitude must be between ${LONGITUDE_MIN} and ${LONGITUDE_MAX}`;
  }
  return null;
};

export const validateRadiusMeters = (value) => {
  if (!Number.isInteger(value)) return 'radiusMeters must be an integer';
  if (value < RADIUS_MIN_METERS || value > RADIUS_MAX_METERS) {
    return `radiusMeters must be between ${RADIUS_MIN_METERS} and ${RADIUS_MAX_METERS}`;
  }
  return null;
};

// Accuracy is optional metadata. Absent is fine; present must be a
// real non-negative reading. An imprecise-but-real reading (beyond
// the cap) is NOT malformed — 31.16 D-03: desktop browsers routinely
// report IP/WiFi fixes less precise than 100 km, and 400ing the whole
// punch for that is a defect. Callers route over-cap readings through
// isAccuracyUsable into the failed-verification path instead.
export const validateAccuracyMeters = (value) => {
  if (value === undefined || value === null) return null;
  if (!isFiniteNumber(value)) return 'accuracy must be a finite number';
  if (value < 0) return 'accuracy must be 0 or greater';
  return null;
};

// A fix less precise than the cap cannot prove presence — but the
// request itself is well-formed. Absent accuracy (legacy clients)
// keeps the historical distance-only behavior.
export const isAccuracyUsable = (value) =>
  value === undefined || value === null || value <= ACCURACY_MAX_METERS;

// Full location-input validation for create/update (service passes the
// merged document shape; every caller is protected equally).
export const validateLocationInput = (input = {}) => {
  const errors = [];
  const { name, code, displayAddress, latitude, longitude, radiusMeters } = input;

  if (typeof name !== 'string' || !name.trim()) {
    errors.push('name is required');
  } else if (name.trim().length > LOCATION_NAME_MAX) {
    errors.push(`name must be ${LOCATION_NAME_MAX} characters or fewer`);
  }
  if (code !== undefined && code !== null) {
    if (typeof code !== 'string') errors.push('code must be a string');
    else if (code.trim().length > LOCATION_CODE_MAX) {
      errors.push(`code must be ${LOCATION_CODE_MAX} characters or fewer`);
    }
  }
  if (displayAddress !== undefined && displayAddress !== null) {
    if (typeof displayAddress !== 'string') errors.push('displayAddress must be a string');
    else if (displayAddress.trim().length > LOCATION_ADDRESS_MAX) {
      errors.push(`displayAddress must be ${LOCATION_ADDRESS_MAX} characters or fewer`);
    }
  }
  for (const error of [
    validateLatitude(latitude),
    validateLongitude(longitude),
    validateRadiusMeters(radiusMeters),
  ]) {
    if (error) errors.push(error);
  }
  return errors;
};

// ── Geofence maths (pure) ────────────────────────────────────

// Great-circle distance in integer meters (rounded — deterministic,
// no float dust in persisted snapshots).
export const haversineMeters = (fromLat, fromLng, toLat, toLng) => {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a))));
};

// Boundary is inclusive: exactly-on-the-radius counts as inside.
export const isInsideGeofence = (distanceMeters, radiusMeters) =>
  distanceMeters <= radiusMeters;

// ── Requirement matrix (pure) ────────────────────────────────
// Geofencing binds OFFICE punches to company premises. Every other
// work mode is location-independent in 31.3 (31.4 owns remote-work
// approvals) and must never gain a fake office verification.

export const geofenceRequirement = (policy, workMode) => {
  if (workMode !== WORK_MODE.OFFICE) return 'NONE';
  const rule = policy?.locationEnforcement;
  if (rule === LOCATION_ENFORCEMENT_RULE.REQUIRED) return 'REQUIRED';
  if (rule === LOCATION_ENFORCEMENT_RULE.OPTIONAL) return 'OPTIONAL';
  return 'NONE';
};

// ── Verification snapshot (pure) ─────────────────────────────
// Minimal immutable facts answering "what rule accepted this punch".
// Raw employee coordinates are deliberately NOT part of the snapshot.
export const buildVerificationSnapshot = ({
  location,
  distanceMeters,
  result,
  accuracyMeters = null,
  verifiedAt,
}) => ({
  locationId: String(location._id || location.id || ''),
  locationName: location.name,
  radiusMeters: location.radiusMeters,
  distanceMeters,
  result,
  accuracyMeters: accuracyMeters ?? null,
  verifiedAt: verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt),
});
