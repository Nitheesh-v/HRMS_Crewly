// Phase 30.2 — BGV SERVICE CATALOGUE service (platform-scoped).
//
// Backend is the ONLY price authority:
//  - the UI displays what getCatalogueView() returns;
//  - mutations are validated against the allowlisted five types and integer
//    minor-unit money rules (bgvCatalogueRules.js);
//  - Phase 30.3 orders will call resolveActivePrice() and SNAPSHOT the result
//    (priceMinorUnits/currency/version) — they must never treat this document
//    as their historical amount.
//
// No seeding: an absent record means "unconfigured / not purchasable".
// No queue, no Redis cache in 30.2 (read volume is tiny; Mongo is the source
// of truth — cache deferred deliberately).
//
// All Mongo/audit collaborators are injectable (deps) for hermetic tests.

import BgvServiceCatalogue from '../../models/BgvServiceCatalogue.js';
import SystemEvent from '../../models/SystemEvent.js';
import ApiError from '../../utils/ApiError.js';
import {
  BGV_CATALOGUE_CURRENCY,
  BGV_CATALOGUE_DEFINITIONS,
  BGV_CATALOGUE_TYPES,
  formatMinorUnits,
  validateCataloguePayload,
} from './bgvCatalogueRules.js';

const catalogueDto = (record) => ({
  id: record._id,
  type: record.type,
  name: record.displayName || BGV_CATALOGUE_DEFINITIONS[record.type]?.name || record.type,
  description:
    record.description || BGV_CATALOGUE_DEFINITIONS[record.type]?.description || '',
  configured: true,
  active: record.active !== false,
  priceMinorUnits: record.priceMinorUnits,
  priceDisplay: formatMinorUnits(record.priceMinorUnits),
  currency: record.currency || BGV_CATALOGUE_CURRENCY,
  version: record.version,
  updatedBy: record.updatedBy || null,
  updatedAt: record.updatedAt || null,
  createdAt: record.createdAt || null,
});

const unconfiguredDto = (type) => ({
  id: null,
  type,
  name: BGV_CATALOGUE_DEFINITIONS[type]?.name || type,
  description: BGV_CATALOGUE_DEFINITIONS[type]?.description || '',
  configured: false,
  active: false,
  priceMinorUnits: null,
  priceDisplay: '',
  currency: BGV_CATALOGUE_CURRENCY,
  version: 0,
  updatedBy: null,
  updatedAt: null,
  createdAt: null,
});

// ── default (Mongo) collaborators ────────────────────────────────
const defaultFindAll = () => BgvServiceCatalogue.find({}).sort({ type: 1 }).lean();

const defaultUpsert = ({ type, set, actorId }) =>
  BgvServiceCatalogue.findOneAndUpdate(
    { type },
    [
      {
        $set: {
          ...set,
          updatedBy: actorId ?? null,
          updatedAt: '$$NOW',
          // Bump the version on every mutation (also on first insert: 0→1).
          version: { $add: [{ $ifNull: ['$version', 0] }, 1] },
        },
      },
    ],
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

const defaultAudit = (entry) => SystemEvent.create(entry);

// ── read: merged fixed definitions + stored configuration ────────
export const getCatalogueView = async (deps = {}) => {
  const findAll = deps.findAll || defaultFindAll;
  const records = await findAll();
  const byType = new Map((records || []).map((record) => [record.type, record]));
  // Always exactly the five backend-known products, in stable order.
  const services = BGV_CATALOGUE_TYPES.map((type) =>
    byType.has(type) ? catalogueDto(byType.get(type)) : unconfiguredDto(type)
  );
  return {
    currency: BGV_CATALOGUE_CURRENCY,
    configuredCount: services.filter((service) => service.configured).length,
    services,
  };
};

// ── write: configure / update / activate / deactivate ────────────
export const configureBgvService = async ({ type, payload = {}, actorId, deps = {} }) => {
  const validation = validateCataloguePayload({ ...payload, type });
  if (!validation.ok) {
    throw ApiError.badRequest(validation.errors.join('; '));
  }
  const { priceMinorUnits, description, active } = validation.value;

  const upsert = deps.upsert || defaultUpsert;
  const audit = deps.audit || defaultAudit;

  const set = {};
  if (priceMinorUnits !== null) set.priceMinorUnits = priceMinorUnits;
  if (description !== undefined) set.description = description;
  if (active !== undefined) set.active = active;
  if (payload.displayName !== undefined) {
    const displayName = String(payload.displayName ?? '').trim().slice(0, 120);
    if (displayName) set.displayName = displayName;
  }
  if (!Object.keys(set).length) {
    throw ApiError.badRequest('Nothing to update');
  }

  // Previous state (safe commercial metadata only) for the audit trail.
  const findAll = deps.findAll || defaultFindAll;
  const previous = (await findAll()).find((record) => record.type === type) || null;

  // First-time configuration must establish a price; later mutations may
  // touch only activation/description.
  if (!previous && priceMinorUnits === null) {
    throw ApiError.badRequest('Price is required for first-time configuration');
  }

  // Atomic upsert with unique type index: concurrent duplicate creates for
  // the same product cannot produce a second row.
  const record = await upsert({ type, set, actorId });

  // Rows created before an explicit active flag count as active (schema
  // default), so absence is never treated as "was deactivated".
  const wasActive = previous ? previous.active !== false : false;
  const action =
    previous == null
      ? 'BGV_CATALOGUE_CONFIGURED'
      : active === true && !wasActive
        ? 'BGV_CATALOGUE_ACTIVATED'
        : active === false && wasActive
          ? 'BGV_CATALOGUE_DEACTIVATED'
          : 'BGV_CATALOGUE_UPDATED';

  await audit({
    type: 'BGV_CATALOGUE_UPDATED',
    level: 'INFO',
    title: `BGV catalogue ${action.toLowerCase().replace('bgv_catalogue_', '')}: ${type}`,
    message: `${type} ${formatMinorUnits(previous?.priceMinorUnits ?? 0)} → ${formatMinorUnits(record.priceMinorUnits)} (active: ${previous?.active ?? 'n/a'} → ${record.active})`,
    targetType: 'BgvServiceCatalogue',
    targetId: record._id,
    metadata: {
      action,
      serviceType: type,
      actorId: actorId ?? null,
      previous: previous
        ? {
            priceMinorUnits: previous.priceMinorUnits,
            active: previous.active,
            version: previous.version,
          }
        : null,
      next: {
        priceMinorUnits: record.priceMinorUnits,
        active: record.active,
        version: record.version,
      },
    },
  }).catch(() => {});

  return { ...catalogueDto(record), action };
};

// ── future 30.3 consumption: authoritative active price ──────────
// Returns a snapshot-ready value object or null. Never reads client input;
// an unconfigured or deactivated service is simply not purchasable.
export const resolveActivePrice = async (type, deps = {}) => {
  if (!BGV_CATALOGUE_TYPES.includes(type)) return null;
  const findAll = deps.findAll || defaultFindAll;
  const record = (await findAll()).find(
    (candidate) => candidate.type === type && candidate.active !== false
  );
  if (!record) return null;
  return {
    type: record.type,
    priceMinorUnits: record.priceMinorUnits,
    currency: record.currency || BGV_CATALOGUE_CURRENCY,
    version: record.version,
  };
};
