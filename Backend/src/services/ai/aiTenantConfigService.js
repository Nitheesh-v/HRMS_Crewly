// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.2 — TENANT AI CONFIG SERVICE
//
//  WHAT IT DOES
//    Reads, writes and caches the per-tenant AI configuration, and answers
//    the two questions aiChat asks before it spends a token:
//      · isTenantAIEnabled(companyId)  → the per-tenant kill switch
//      · resolveTenantQuota(companyId) → the effective monthly token cap
//
//  THE SEAM CONTRACT (36.1 → 36.2)
//    aiProvider.aiChat already took an `isTenantEnabled` resolver whose
//    default was `async () => true`. This module is that default now. The
//    resolver still THROWS-TO-REFUSE in the provider: if a config read fails,
//    the call is refused, never allowed — the same fail-closed direction as
//    the quota read in 36.1.
//
//  CACHING
//    Reuses the 28.7 safe cache abstraction (services/redisCacheService.js):
//    bounded, fail-open, tenant-scoped keys, exact DEL only. The raw
//    get/set/delete primitives are used rather than getOrSetCache because
//    getOrSetCache logs at info on every hit and miss — an AI request would
//    then emit a cache line per call, which is log volume for no signal.
//
//  SHAPE DETERMINISM
//    A cache hit returns JSON (plain object); a cache miss returns a Mongoose
//    document. Those are NOT interchangeable — ObjectId vs string, and a
//    lean() vs a full doc — so every read is normalised to the same frozen
//    snapshot before it is cached or returned. Callers cannot tell which
//    path served them, which is what makes the cache testable.
// ═══════════════════════════════════════════════════════════════════════════

import AITenantConfig from '../../models/AITenantConfig.js';

import logger from '../../config/logger.js';

import {
  AI_TENANT_CONFIG_CACHE,
  getAIConfig,

  // 36.7 — the default reply-language set, for the fail-closed fallback.
  AI_TENANT_LANGUAGE_DEFAULT,
} from './aiConfig.js';

import { AIError, AI_ERROR_CODES } from './aiErrors.js';

import {
  buildTenantCacheKey,
  deleteCache as deleteCacheDefault,
  getCache as getCacheDefault,
  setCache as setCacheDefault,
} from '../redisCacheService.js';

// The cache primitives are fail-open and bounded already; wrapping them here
// only adds the `io` injection seam the hermetic tests need. The defaults are
// the real operations, so production behaviour is unchanged.
const cacheIo = (io = {}) => ({
  get: io.get || getCacheDefault,
  set: io.set || setCacheDefault,
  del: io.del || deleteCacheDefault,
});

// The ONLY fields an operator may change. Anything else in an update payload
// is a client error, not something to silently ignore — a silently dropped
// key is how a "disable AI" request ends up doing nothing.
const UPDATABLE_FIELDS = Object.freeze([
  'enabled',
  'monthlyQuotaTokens',
  'allowedCategories',

  // 36.7 — the reply-language list an admin saves.
  'languages',
]);

const cacheKeyFor = (companyId) =>
  buildTenantCacheKey({
    companyId,
    namespace: AI_TENANT_CONFIG_CACHE.namespace,
    version: AI_TENANT_CONFIG_CACHE.version,
  });

/**
 * Normalise a document (or cached JSON) into one frozen, plain shape.
 *
 * Every field is coerced here so a hit and a miss are indistinguishable:
 * `updatedBy` is a string or null (never an ObjectId), `monthlyQuotaTokens`
 * is a number or null (never undefined), and the arrays are copies so a
 * caller cannot mutate what is in the cache.
 */
const toSnapshot = (doc) => {
  if (!doc) return null;

  const quota =
    doc.monthlyQuotaTokens === null || doc.monthlyQuotaTokens === undefined
      ? null
      : Number(doc.monthlyQuotaTokens);

  return Object.freeze({
    companyId: String(doc.companyId),
    enabled: doc.enabled !== false,
    monthlyQuotaTokens:
      Number.isFinite(quota) && quota >= 0 ? Math.trunc(quota) : null,
    allowedCategories: Array.isArray(doc.allowedCategories)
      ? [...doc.allowedCategories]
      : [],

    // 36.7 — the reply languages this tenant offers.
    //
    // Copied, not referenced, exactly like allowedCategories above: a frozen
    // snapshot that aliases the live mongoose array would let a caller mutate
    // the document by accident.
    //
    // An empty or missing array becomes the DEFAULT SET rather than []. A row
    // written before 36.7 has no `languages` key at all, and handing a caller
    // an empty list would offer a selector with nothing in it.
    languages:
      Array.isArray(doc.languages) && doc.languages.length > 0
        ? [...doc.languages]
        : [...AI_TENANT_LANGUAGE_DEFAULT],
    updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  });
};

/**
 * Read the doc from Mongo, creating the defaults on first sight of a tenant.
 *
 * `setDefaultsOnInsert` matters: without it an upsert writes a row with the
 * schema defaults MISSING, and the first read of that tenant would see
 * `enabled: undefined` (falsy) — a brand-new tenant silently disabled.
 */
const loadFromMongo = async (Model, companyId) => {
  const doc = await Model.findOneAndUpdate(
    { companyId },
    { $setOnInsert: { companyId } },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );

  return toSnapshot(doc);
};

const wrapFailure = (operation, error) => {
  // Metadata only: the operation name and the Mongo/Redis error CODE. The
  // Mongo message can name collections, indexes and the connection string
  // host, none of which belongs in a log line a tenant could trigger.
  logger.warn('ai.tenant.config_error', {
    operation,
    errorCode: String(error?.code || error?.name || 'error'),
  });

  return new AIError(503, AI_ERROR_CODES.CONFIG_READ_FAILED);
};

/**
 * Effective per-tenant config: cache first, Mongo on miss, defaults on first
 * ever sight of the tenant.
 *
 * FAILS CLOSED. A throw here becomes an AIError(CONFIG_READ_FAILED), which
 * the provider treats as "refuse the call" — the same direction as the quota
 * read. Allowing an AI call because the config was unreadable would be a
 * silent bypass of the per-tenant kill switch.
 *
 * @param {string} companyId   SERVER-DERIVED tenant authority
 * @param {object} [deps]      { Model, io } — DI seam for hermetic tests
 */
export const getTenantConfig = async (companyId, deps = {}) => {
  const { Model = AITenantConfig } = deps;

  const cache = cacheIo(deps.io);

  try {
    const key = cacheKeyFor(companyId);

    // A cache failure is NOT a config failure. Redis being down must degrade
    // to a Mongo read — refusing the AI call would turn a cache outage into
    // an AI outage, and the tenant's switch would appear to be broken.
    let cached = null;

    try {
      cached = key ? await cache.get(key) : null;
    } catch {
      cached = null;
    }

    if (cached) return cached;

    const snapshot = await loadFromMongo(Model, companyId);

    if (key && snapshot) {
      // A failed write is equally harmless: the entry is simply not cached
      // and the next read goes to Mongo again.
      try {
        await cache.set(key, snapshot, AI_TENANT_CONFIG_CACHE.ttlSeconds);
      } catch {
        /* cache write is best-effort by design */
      }
    }

    return snapshot;
  } catch (error) {
    if (error instanceof AIError) throw error;

    throw wrapFailure('get', error);
  }
};

/**
 * 36.7 — the reply languages this tenant actually offers.
 *
 * Returns the EFFECTIVE list: the tenant's own `languages` when a config row
 * exists, and the platform DEFAULT SET when it does not. Callers get a list
 * they can validate against and normalise into, and they never have to know
 * whether this tenant has been configured.
 *
 * WHY THIS EXISTS RATHER THAN READING config.languages DIRECTLY.
 * A tenant with no row must still get the five 36.5 languages, and a caller
 * that forgot the fallback would offer an empty selector. One function means
 * the fallback is written once.
 *
 * FAILS CLOSED to the default set rather than throwing. A config read failure
 * must not turn "which languages can I pick" into a 500 — the worst case is
 * that a tenant temporarily sees the default five instead of its own list,
 * which is strictly better than an assistant nobody can open. The KILL SWITCH
 * still fails closed inside getTenantConfig; this is a presentation list, not
 * an authority.
 *
 * @param {string} companyId   SERVER-DERIVED tenant authority
 * @param {object} [deps]      { Model, io } — DI seam for hermetic tests
 * @returns {Promise<string[]>}
 */
export const getTenantLanguages = async (companyId, deps = {}) => {
  try {
    const config = await getTenantConfig(companyId, deps);

    const list = config?.languages;

    // An empty or missing array is impossible by schema validation, but a
    // stale cached row from before 36.7 could carry one. Falling back beats
    // offering a selector with nothing in it.
    if (Array.isArray(list) && list.length > 0) return list;

    return [...AI_TENANT_LANGUAGE_DEFAULT];
  } catch {
    return [...AI_TENANT_LANGUAGE_DEFAULT];
  }
};

/**
 * Apply an operator update, then invalidate this tenant's cache entry.
 *
 * The invalidation is a DEL of the exact key — never a wildcard, never a
 * FLUSH (Phase 36 §10). A wildcard here would drop every other tenant's
 * cached config, which is an availability incident dressed as a cache
 * invalidation.
 */
export const updateTenantConfig = async (
  companyId,
  updates,
  adminUserId,
  deps = {},
) => {
  const { Model = AITenantConfig } = deps;

  const patch = {};

  for (const field of UPDATABLE_FIELDS) {
    if (updates && Object.prototype.hasOwnProperty.call(updates, field)) {
      patch[field] = updates[field];
    }
  }

  const rejected = Object.keys(updates || {}).filter(
    (field) => !UPDATABLE_FIELDS.includes(field),
  );

  if (rejected.length > 0) {
    throw AIError.requestInvalid(
      `Unsupported AI config field(s): ${rejected.join(', ')}. Allowed: ${UPDATABLE_FIELDS.join(', ')}.`,
    );
  }

  try {
    const doc = await Model.findOneAndUpdate(
      { companyId },
      {
        $set: { ...patch, updatedBy: adminUserId ?? null },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    );

    await invalidateTenantConfigCache(companyId, deps);

    return toSnapshot(doc);
  } catch (error) {
    if (error instanceof AIError) throw error;

    throw wrapFailure('update', error);
  }
};

/** DEL this tenant's exact config key. Never a wildcard, never a FLUSH. */
export const invalidateTenantConfigCache = async (companyId, deps = {}) => {
  const cache = cacheIo(deps.io);

  const key = cacheKeyFor(companyId);

  if (!key) return false;

  try {
    return await cache.del(key);
  } catch {
    // A failed invalidation is not worth failing an update over: the entry
    // expires by itself in AI_TENANT_CONFIG_CACHE.ttlSeconds.
    return false;
  }
};

/**
 * The effective monthly token cap for a tenant.
 *
 * null in the document means "no tenant-specific allowance", so the env
 * default applies. 0 means unlimited (36.1 semantics). A positive integer is
 * a hard cap for this tenant only.
 */
export const resolveTenantQuota = async (companyId, deps = {}) => {
  const config = await getTenantConfig(companyId, deps);

  if (config && config.monthlyQuotaTokens !== null) {
    return config.monthlyQuotaTokens;
  }

  return getAIConfig().monthlyQuotaTokens;
};

/** The per-tenant kill switch. Read failure throws — the provider refuses. */
export const isTenantAIEnabled = async (companyId, deps = {}) => {
  const config = await getTenantConfig(companyId, deps);

  return config?.enabled === true;
};
