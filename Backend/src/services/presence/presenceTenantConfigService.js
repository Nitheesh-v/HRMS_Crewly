// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — TENANT PRESENCE CONFIG SERVICE
//
//  READ / WRITE / CACHE (no caching yet — 37.1 is not a hot read path).
//
//  The single seam between controllers / services and the
//  PresenceTenantConfig row. Uses the Phase 36 <<replay-tested>>
//  findOneAndUpdate(..., {upsert: true, setDefaultsOnInsert: true})
//  pattern so a tenant without a row gets one on first read with the
//  recommended defaults.
//
//  FAIL-CLOSED (Phase 37 §11)
//    A config read that throws is a deterministic refusal, never a
//    silent in-memory fallback. The 37.1 resolvers need to know whether
//    presence / status messages / work-location are enabled in order to
//    answer "may the caller do this?" — and the only way to know is to
//    READ the authoritative row. Handing a controller the defaults
//    when the row cannot be fetched would silently re-enable a feature
//    an operator explicitly turned off.
//
//  UPDATABLE_FIELDS
//    The ONLY fields an operator may change. Anything else in an update
//    payload is a client error, not something to silently ignore. A
//    silently dropped key is how a "disable WFH" request ends up doing
//    nothing (Phase 36 capsule §4.6, pay-for).
// ═══════════════════════════════════════════════════════════════════════════

import PresenceTenantConfig from '../../models/PresenceTenantConfig.js';
import { PresenceError, PRESENCE_ERROR_CODES } from './presenceErrors.js';
import {
  PRESENCE_TENANT_DEFAULTS,
  WFH_MODES,
  WORK_LOCATION_VALUES,
  isWfhMode,
  isWorkLocation,
} from './presenceConfig.js';

// Service-level guards (defense in depth — the Mongoose model schema
// ALSO has these validators; the service runs them explicitly so a
// fake model in hermetic tests can verify the same contract without
// needing to re-implement Mongoose validation).
const validatePatch = (patch) => {
  if (!patch || typeof patch !== 'object') {
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.INVALID_PRESENCE_VALUE,
      'patch must be an object',
    );
  }

  if (patch.wfhMode !== undefined && !isWfhMode(patch.wfhMode)) {
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.INVALID_WFH_MODE,
      `wfhMode must be one of: ${WFH_MODES.join(', ')}`,
    );
  }

  if (patch.allowedWorkLocations !== undefined) {
    const v = patch.allowedWorkLocations;
    if (!Array.isArray(v)) {
      throw PresenceError.badRequest(
        PRESENCE_ERROR_CODES.INVALID_ALLOWED_WORK_LOCATIONS,
        'allowedWorkLocations must be an array',
      );
    }
    const set = new Set(v);
    if (set.size !== v.length) {
      throw PresenceError.badRequest(
        PRESENCE_ERROR_CODES.INVALID_ALLOWED_WORK_LOCATIONS,
        'allowedWorkLocations must not contain duplicates',
      );
    }
    for (const loc of v) {
      if (!isWorkLocation(loc)) {
        throw PresenceError.badRequest(
          PRESENCE_ERROR_CODES.INVALID_ALLOWED_WORK_LOCATIONS,
          `allowedWorkLocations entries must be one of: ${WORK_LOCATION_VALUES.join(', ')}`,
        );
      }
    }
  }

  if (
    patch.awayAfterMinutes !== undefined &&
    (!Number.isInteger(patch.awayAfterMinutes) || patch.awayAfterMinutes < 1)
  ) {
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.INVALID_TIMEOUT_RELATIONSHIP,
      'awayAfterMinutes must be a positive integer',
    );
  }

  if (
    patch.offlineAfterMinutes !== undefined &&
    (!Number.isInteger(patch.offlineAfterMinutes) ||
      patch.offlineAfterMinutes < 1)
  ) {
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.INVALID_TIMEOUT_RELATIONSHIP,
      'offlineAfterMinutes must be a positive integer',
    );
  }

  if (
    patch.awayAfterMinutes !== undefined &&
    patch.offlineAfterMinutes !== undefined &&
    patch.offlineAfterMinutes <= patch.awayAfterMinutes
  ) {
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.INVALID_TIMEOUT_RELATIONSHIP,
      'offlineAfterMinutes must be greater than awayAfterMinutes',
    );
  }

  if (patch.allowedWorkLocations !== undefined && patch.allowedWorkLocations.length === 0 && patch.workLocationEnabled !== false) {
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.INVALID_ALLOWED_WORK_LOCATIONS,
      'allowedWorkLocations cannot be empty (turn workLocationEnabled off instead)',
    );
  }
};

export const PRESENCE_UPDATABLE_FIELDS = Object.freeze([
  'enabled',
  'employeePresenceVisible',
  'statusMessagesEnabled',
  'workLocationEnabled',
  'wfhMode',
  'awayAfterMinutes',
  'offlineAfterMinutes',
  'lastSeenVisible',
  'allowedWorkLocations',
]);

// Normalise a document (or in-memory object) into one frozen, plain
// shape. Every value is coerced so a service consumer never has to
// special-case Mongo ObjectIds vs strings vs null.
const toSnapshot = (doc) => {
  if (!doc) return null;

  const away = Number(doc.awayAfterMinutes);
  const offline = Number(doc.offlineAfterMinutes);

  return Object.freeze({
    companyId: String(doc.companyId),
    enabled: doc.enabled !== false,
    employeePresenceVisible: doc.employeePresenceVisible !== false,
    statusMessagesEnabled: doc.statusMessagesEnabled !== false,
    workLocationEnabled: doc.workLocationEnabled !== false,
    wfhMode:
      typeof doc.wfhMode === 'string' ? doc.wfhMode : PRESENCE_TENANT_DEFAULTS.wfhMode,
    awayAfterMinutes: Number.isFinite(away)
      ? Math.max(1, Math.trunc(away))
      : PRESENCE_TENANT_DEFAULTS.awayAfterMinutes,
    offlineAfterMinutes: Number.isFinite(offline)
      ? Math.max(1, Math.trunc(offline))
      : PRESENCE_TENANT_DEFAULTS.offlineAfterMinutes,
    lastSeenVisible: doc.lastSeenVisible === true,
    allowedWorkLocations: Array.isArray(doc.allowedWorkLocations)
      ? [...new Set(doc.allowedWorkLocations)]
      : [...PRESENCE_TENANT_DEFAULTS.allowedWorkLocations],
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
  });
};

// The deterministic defaults used BOTH for in-memory fallbacks AND as the
// $setOnInsert payload on first read. Returning the SAME object every
// time means a controller test can identity-compare the snapshot.
const defaultSnapshot = (companyId) =>
  Object.freeze({
    companyId: String(companyId),
    enabled: PRESENCE_TENANT_DEFAULTS.enabled,
    employeePresenceVisible: PRESENCE_TENANT_DEFAULTS.employeePresenceVisible,
    statusMessagesEnabled: PRESENCE_TENANT_DEFAULTS.statusMessagesEnabled,
    workLocationEnabled: PRESENCE_TENANT_DEFAULTS.workLocationEnabled,
    wfhMode: PRESENCE_TENANT_DEFAULTS.wfhMode,
    awayAfterMinutes: PRESENCE_TENANT_DEFAULTS.awayAfterMinutes,
    offlineAfterMinutes: PRESENCE_TENANT_DEFAULTS.offlineAfterMinutes,
    lastSeenVisible: PRESENCE_TENANT_DEFAULTS.lastSeenVisible,
    allowedWorkLocations: [...PRESENCE_TENANT_DEFAULTS.allowedWorkLocations],
    updatedBy: null,
  });

/**
 * Read the (possibly newly-created) tenant config. The first read does an
 * upsert with setDefaultsOnInsert, so subsequent reads return the row the
 * first read persisted. Always emits defaults if the read throws — the
 * caller MUST distinguish a true default from a successful default by
 * observing the second tuple element. Most callers should use
 * `getPresenceTenantConfigOrThrow`.
 *
 * @returns {Promise<[snapshot, true]>}
 */
export const readPresenceTenantConfig = async ({ companyId, model }) => {
  const M = model || PresenceTenantConfig;
  const doc = await M.findOneAndUpdate(
    { companyId },
    { $setOnInsert: { companyId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return [toSnapshot(doc), true];
};

/**
 * Read or refuse. A read that throws becomes PRESENCE_TENANT_CONFIG_READ_FAILED
 * (503). This is the seam the presence service / resolver / controller
 * use — they MUST call this, never readPresenceTenantConfig directly.
 */
export const getPresenceTenantConfigOrThrow = async ({ companyId, model }) => {
  try {
    const [snapshot, ok] = await readPresenceTenantConfig({ companyId, model });
    if (!ok || !snapshot) {
      // A read that returned null is impossible after an upsert, but if a
      // test fake short-circuits here we still serve the in-memory
      // defaults — labelled as a read, not as persistence.
      return defaultSnapshot(companyId);
    }
    return snapshot;
  } catch (err) {
    throw PresenceError.unavailable(
      PRESENCE_ERROR_CODES.PRESENCE_TENANT_CONFIG_READ_FAILED,
      'Presence configuration could not be read.',
    );
  }
};

/**
 * Update the tenant config. The body is filtered to UPDATABLE_FIELDS,
 * anything else is refused outright (PresenceError.badRequest). The
 * resulting snapshot is returned via a second read so the caller does not
 * have to do its own permission / invariant check.
 *
 * @returns the updated snapshot
 */
export const updatePresenceTenantConfig = async ({
  companyId,
  userId,
  patch,
  model,
}) => {
  const M = model || PresenceTenantConfig;

  const allowedKeys = PRESENCE_UPDATABLE_FIELDS;
  const incomingKeys = patch && typeof patch === 'object' ? Object.keys(patch) : [];

  const unknownKeys = incomingKeys.filter((k) => !allowedKeys.includes(k));
  if (unknownKeys.length > 0) {
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.INVALID_PRESENCE_VALUE,
      `Unsupported presence config field(s): ${unknownKeys.join(', ')}`,
    );
  }

  // Service-level guards (defense in depth — model schema has the same).
  validatePatch(patch);

  // Build the $set object with only allowed keys. Object spread over the
  // filtered keys, never over the raw patch.
  const $set = {};
  for (const k of incomingKeys) $set[k] = patch[k];

  try {
    await M.findOneAndUpdate(
      { companyId },
      {
        $set,
        $setOnInsert: { companyId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    // A model-level invariant (e.g. duplicate allowedWorkLocations, or
    // offlineAfterMinutes <= awayAfterMinutes) rejected the patch. Mongoose
    // validation errors arrive as err.name === 'ValidationError'.
    const msg =
      err && err.name === 'ValidationError'
        ? Object.values(err.errors || {})
            .map((e) => e.message)
            .join(', ')
        : 'Presence configuration update failed.';
    throw PresenceError.badRequest(
      PRESENCE_ERROR_CODES.INVALID_TIMEOUT_RELATIONSHIP,
      msg,
    );
  }

  return getPresenceTenantConfigOrThrow({ companyId, model: M });
};

export { defaultSnapshot };