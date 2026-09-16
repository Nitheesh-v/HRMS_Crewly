// ─────────────────────────────────────────────────────────────
// Phase 31.14 — pure attendance-source rules.
//
// Source describes PROVENANCE, never a second engine. Every
// accepted input converges on recordEvent; these rules decide
// which sources exist, what provenance each must carry, and which
// months refuse ingestion. Deterministic, side-effect-free: no
// Mongo, no req/res, no Redis. Intl + string checks only.
// ─────────────────────────────────────────────────────────────

import { EVENT_SOURCE } from './attendancePolicyRules.js';

// Sources the 31.14 server-side adapters may ingest. WEB is the
// default when no ingest context is passed (existing behavior).
export const INGESTIBLE_SOURCE = Object.freeze({
  KIOSK: EVENT_SOURCE.KIOSK,
  QR: EVENT_SOURCE.QR,
  IMPORT: EVENT_SOURCE.IMPORT,
});

// Vocabulary with NO 31.14 write path. DEVICE is a documented
// future contract (below); MANUAL stays forbidden — 31.5
// regularization is the controlled correction mechanism.
export const RESERVED_SOURCE = Object.freeze({
  DEVICE: EVENT_SOURCE.DEVICE,
  MANUAL: EVENT_SOURCE.MANUAL,
});

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const isObjectIdString = (value) => OBJECT_ID_RE.test(String(value || ''));

const MAX_NAME_CHARS = 120;
const MAX_REFERENCE_CHARS = 120;

const isBoundedString = (value, max) =>
  typeof value === 'string' && value.length <= max;

// ── Ingest context (server-side only) ────────────────────────
// recordEvent accepts `ingest` ONLY from server-side adapter
// calls. Controllers hardcode it per route; req.body.source is
// never read (route-level tests pin this).

export const validateIngestContext = (ingest) => {
  if (ingest === null || ingest === undefined) return []; // WEB default
  if (typeof ingest !== 'object' || Array.isArray(ingest)) {
    return ['ingest must be an object'];
  }
  const errors = [];
  if (!Object.values(INGESTIBLE_SOURCE).includes(ingest.source)) {
    errors.push('ingest.source must be KIOSK, QR, or IMPORT');
    return errors;
  }
  errors.push(...validateProvenance(ingest.source, ingest.provenance));
  return errors;
};

export const validateProvenance = (source, provenance) => {
  const errors = [];
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return ['provenance is required for non-WEB sources'];
  }
  const allowedBySource = {
    [INGESTIBLE_SOURCE.KIOSK]: ['stationId', 'stationName', 'locationId', 'locationName'],
    [INGESTIBLE_SOURCE.QR]: ['challengeId', 'stationId', 'stationName', 'locationId', 'locationName'],
    [INGESTIBLE_SOURCE.IMPORT]: ['importBatchId', 'sourceReference'],
  };
  const allowed = allowedBySource[source] || [];
  for (const key of Object.keys(provenance)) {
    if (!allowed.includes(key)) errors.push(`provenance.${key} is not allowed for source ${source}`);
  }

  const checkId = (key, required) => {
    const value = provenance[key];
    if (value === undefined || value === null || value === '') {
      if (required) errors.push(`provenance.${key} is required for source ${source}`);
      return;
    }
    if (!isObjectIdString(value)) errors.push(`provenance.${key} must be an ObjectId string`);
  };
  const checkName = (key) => {
    const value = provenance[key];
    if (value === undefined || value === null || value === '') return;
    if (!isBoundedString(value, MAX_NAME_CHARS)) {
      errors.push(`provenance.${key} must be a string of at most ${MAX_NAME_CHARS} characters`);
    }
  };

  if (source === INGESTIBLE_SOURCE.KIOSK) {
    checkId('stationId', true);
    checkName('stationName');
    checkId('locationId', false);
    checkName('locationName');
  } else if (source === INGESTIBLE_SOURCE.QR) {
    checkId('challengeId', true);
    checkId('stationId', false);
    checkName('stationName');
    checkId('locationId', false);
    checkName('locationName');
  } else if (source === INGESTIBLE_SOURCE.IMPORT) {
    checkId('importBatchId', true);
    const ref = provenance.sourceReference;
    if (ref !== undefined && ref !== null && ref !== '' && !isBoundedString(ref, MAX_REFERENCE_CHARS)) {
      errors.push(`provenance.sourceReference must be a string of at most ${MAX_REFERENCE_CHARS} characters`);
    }
  }
  return errors;
};

// ── Finalized-month refusal (pure over the period status) ────
// Missing/OPEN/REOPENED months accept ingestion; anything locked
// refuses. Adapters call this per affected month BEFORE invoking
// recordEvent — there is deliberately no skip flag.

export const INGEST_LOCKED_MONTH_STATUS = Object.freeze(['FINALIZING', 'FINALIZED', 'SENT_TO_PAYROLL']);

export const isMonthLockedForIngest = (periodStatus) => {
  if (periodStatus === null || periodStatus === undefined) return false; // missing = OPEN
  return INGEST_LOCKED_MONTH_STATUS.includes(periodStatus);
};

// ── Kiosk session claims (pure shape check) ──────────────────
// Crypto verification lives in the kioskAuth middleware; this only
// validates decoded-claim shape so error paths stay uniform.

export const KIOSK_SESSION_TTL_MS = 8 * 3600 * 1000; // one shift, then re-authenticate

export const validateKioskClaims = (claims) => {
  const errors = [];
  if (!claims || typeof claims !== 'object') return ['kiosk claims must be an object'];
  if (claims.typ !== 'kiosk') errors.push('token is not a kiosk session');
  if (!isObjectIdString(claims.stationId)) errors.push('kiosk stationId must be an ObjectId string');
  if (!isObjectIdString(claims.companyId)) errors.push('kiosk companyId must be an ObjectId string');
  if (!Number.isInteger(claims.sv) || claims.sv < 1) errors.push('kiosk secret version must be a positive integer');
  return errors;
};

// ── Kiosk privacy (pure) ─────────────────────────────────────
// Shared screens show the minimum needed to catch a typo'd code:
// first name + last initial. Nothing else.

export const maskEmployeeName = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 12);
  return `${parts[0].slice(0, 12)} ${parts[parts.length - 1][0].toUpperCase()}.`;
};

// ── DEVICE adapter contract (conceptual boundary only) ───────
// 31.14 defines the NORMALIZED shape a future vendor adapter must
// produce. There is deliberately NO ingest path, NO route, NO
// credential, and NO vendor code behind this contract —
// normalizeDeviceEvent exists so the future design starts from a
// pinned, tested shape instead of folklore.

export const DEVICE_EVENT_CONTRACT_KEYS = Object.freeze([
  'employeeExternalRef',
  'timestamp',
  'eventType',
  'sourceReference',
  'deviceReference',
]);

export const normalizeDeviceEvent = (input) => {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['device event must be an object'], normalized: null };
  }
  for (const key of Object.keys(input)) {
    if (!DEVICE_EVENT_CONTRACT_KEYS.includes(key)) errors.push(`unknown device field: ${key}`);
  }
  for (const key of DEVICE_EVENT_CONTRACT_KEYS) {
    const value = input[key];
    if (value === undefined || value === null || value === '') {
      errors.push(`device field missing: ${key}`);
    } else if (!isBoundedString(String(value), MAX_REFERENCE_CHARS)) {
      errors.push(`device field too long: ${key}`);
    }
  }
  if (errors.length) return { valid: false, errors, normalized: null };
  return {
    valid: true,
    errors: [],
    normalized: {
      employeeExternalRef: String(input.employeeExternalRef),
      timestamp: String(input.timestamp),
      eventType: String(input.eventType),
      sourceReference: String(input.sourceReference),
      deviceReference: String(input.deviceReference),
    },
  };
};
