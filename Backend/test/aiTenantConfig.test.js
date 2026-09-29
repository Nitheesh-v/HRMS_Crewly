// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.2 — AITenantConfig MODEL + TENANT CONFIG SERVICE (hermetic)
//
// No Mongo, no Redis, no network. The service takes its model and its cache
// as injected dependencies, so the REAL read-through logic runs against an
// in-memory Map and a fake model that records its own call arguments — which
// is what makes "the cache was consulted" and "the query was tenant-scoped"
// assertable rather than assumed.
//
// The comments explain WHY each assertion exists.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_ai_tenant_test';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

const AITenantConfig = (await import('../src/models/AITenantConfig.js'))
  .default;

const {
  AI_TENANT_CONFIG_CACHE,
  AI_DEFAULT_MONTHLY_QUOTA_TOKENS,
  AI_CONTEXT_CATEGORIES,
} = await import('../src/services/ai/aiConfig.js');

const {
  AI_ERROR_CODES,
  AIError,
} = await import('../src/services/ai/aiErrors.js');

const {
  getTenantConfig,
  updateTenantConfig,
  invalidateTenantConfigCache,
  resolveTenantQuota,
  isTenantAIEnabled,
} = await import('../src/services/ai/aiTenantConfigService.js');

const { aiChat } = await import('../src/services/ai/aiProvider.js');

const { getAIConfig } = await import('../src/services/ai/aiConfig.js');

// 24 hex characters: buildTenantCacheKey rejects anything that is not a
// well-formed ObjectId, and a malformed id silently disables the cache.
const COMPANY = '0000000000000000000064b1';
const OTHER_COMPANY = '0000000000000000000064b2';
const ADMIN = '0000000000000000000064b3';

// ── FIXTURES ───────────────────────────────────────────────────────────────

const SCHEMA_DEFAULTS = Object.freeze({
  enabled: true,
  monthlyQuotaTokens: null,
  allowedCategories: ['profile', 'leaves', 'attendance', 'policies'],
  updatedBy: null,
});

/**
 * A fake AITenantConfig model.
 *
 * It records every findOneAndUpdate call so a test can assert the filter was
 * tenant-scoped, and it emulates the two upsert semantics that matter:
 * `$setOnInsert` fires only on insert, and `setDefaultsOnInsert` fills the
 * schema defaults on insert (without which a brand-new tenant would come back
 * with `enabled: undefined`, i.e. silently disabled).
 */
const makeModel = (seed = {}) => {
  const rows = new Map(Object.entries(seed));

  const calls = [];

  const model = {
    calls,
    rows,
    async findOneAndUpdate(filter, update, options = {}) {
      calls.push({ filter, update, options });

      const key = String(filter.companyId);

      const existing = rows.get(key);

      if (existing) {
        const next = {
          ...existing,
          ...(update.$set || {}),
        };

        rows.set(key, next);

        return next;
      }

      if (!options.upsert) return null;

      const created = {
        ...SCHEMA_DEFAULTS,
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      };

      rows.set(key, created);

      return created;
    },
  };

  return model;
};

/** A fake cache that counts operations and records the TTL it was given. */
const makeCache = (seed = new Map()) => {
  const data = new Map(seed);

  const calls = { get: 0, set: 0, del: 0 };

  const ttls = [];

  const keys = { set: [], del: [] };

  return {
    data,
    calls,
    ttls,
    keys,
    io: {
      async get(key) {
        calls.get += 1;

        return data.has(key) ? data.get(key) : null;
      },
      async set(key, value, ttlSeconds) {
        calls.set += 1;

        ttls.push(ttlSeconds);

        keys.set.push(key);

        data.set(key, value);

        return 'OK';
      },
      async del(key) {
        calls.del += 1;

        keys.del.push(key);

        data.delete(key);

        return 1;
      },
    },
  };
};

/** A cache whose every operation fails, i.e. Redis is down. */
const deadCache = () => ({
  io: {
    async get() {
      throw new Error('Redis is down');
    },
    async set() {
      throw new Error('Redis is down');
    },
    async del() {
      throw new Error('Redis is down');
    },
  },
});

const expectedKey = (companyId) =>
  `crewly:cache:company:${companyId}:${AI_TENANT_CONFIG_CACHE.namespace}:v${AI_TENANT_CONFIG_CACHE.version}:`;

// ═══════════════════════════════════════════════════════════════════════════
// A. THE MODEL — configuration only, never conversation
// ═══════════════════════════════════════════════════════════════════════════
describe('AITenantConfig model (Phase 36 §5)', () => {
  test('it declares exactly the configuration fields and nothing else', () => {
    const declared = Object.keys(AITenantConfig.schema.paths).filter(
      (field) => !['_id', '__v'].includes(field),
    );

    assert.deepEqual(
      [...declared].sort(),
      [
        'allowedCategories',
        'companyId',
        'createdAt',
        'enabled',
        'monthlyQuotaTokens',
        'updatedAt',
        'updatedBy',
      ],
    );
  });

  test('the enum is closed to the HR context categories and nothing else', () => {
    const options = AITenantConfig.schema.path('allowedCategories').options;

    assert.deepEqual([...options.enum].sort(), [...AI_CONTEXT_CATEGORIES].sort());

    // 36.4 widened the list from four to thirteen. Pinned so a future
    // category cannot be added to the retriever without also reaching the
    // tenant allowlist, which is what would let an operator switch on a
    // category nobody authorised.
    assert.equal(AI_CONTEXT_CATEGORIES.length, 13);

    // 'performance' must NOT be grantable by a config row: reading an
    // appraisal runs its own authorisation chain, and an employee must not
    // be able to read another employee's rating through a chat box.
    //
    // 'payslips' IS grantable since 36.4, but only for the caller's OWN
    // payslips - the builder scopes on employeeId = req.user._id, the same
    // rule payslipController pins as "only ever their own".
    assert.equal(options.enum.includes('performance'), false);
    assert.equal(options.enum.includes('payslips'), true);
    assert.equal(options.enum.includes('payroll'), false);
  });

  test('a negative quota is refused at the schema level', () => {
    const options = AITenantConfig.schema.path('monthlyQuotaTokens').options;

    // Mongoose keeps a `min` written as [value, message] as a 2-tuple, so the
    // bound lives at index 0.
    assert.equal(Array.isArray(options.min) ? options.min[0] : options.min, 0);
    assert.equal(options.default, null);
  });

  test('companyId is unique and indexed — one config row per tenant', () => {
    const options = AITenantConfig.schema.path('companyId').options;

    assert.equal(options.unique, true);
    assert.equal(options.index, true);
  });

  test('an empty allowlist is refused, so a tenant cannot silently get nothing', () => {
    const validator = AITenantConfig.schema
      .path('allowedCategories')
      .validators.find((entry) => typeof entry.validator === 'function');

    assert.equal(validator.validator([]), false);
    assert.equal(validator.validator(['profile']), true);
  });

  test('NO field could hold a prompt, a response or employee PII', () => {
    // The 36.1 privacy law, restated for this model: the absence of a field
    // is the guarantee, not a convention. A test that only checked the
    // writer would pass even if someone later added a `lastPrompt` column.
    const forbidden = [
      'prompt',
      'response',
      'message',
      'content',
      'text',
      'body',
      'question',
      'answer',
      'completion',
      'input',
      'output',
      'history',
      'transcript',
      'salary',
      'bankAccount',
      'pan',
      'aadhaar',
      'uan',
      'mobile',
      'personalEmail',
    ];

    const declared = Object.keys(AITenantConfig.schema.paths);

    const leaked = forbidden.filter((field) => declared.includes(field));

    assert.deepEqual(leaked, []);
  });

  test('the model file itself stores no prompt or response logic', () => {
    const source = read('src/models/AITenantConfig.js');

    // Belt and braces: the schema is the contract, but a stray pre-save hook
    // that wrote text would defeat it.
    assert.equal(source.includes('pre('), false);
    assert.equal(source.includes('post('), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. getTenantConfig — read-through, cache first, Mongo on miss
// ═══════════════════════════════════════════════════════════════════════════
describe('getTenantConfig (Phase 36 §6.1)', () => {
  test('a company never seen before gets the schema defaults', async () => {
    const Model = makeModel();

    const config = await getTenantConfig(COMPANY, { Model });

    assert.equal(config.enabled, true);
    assert.equal(config.monthlyQuotaTokens, null);
    assert.equal(config.allowedCategories.length, 4);
    assert.equal(config.updatedBy, null);

    // The upsert must carry setDefaultsOnInsert: without it a new tenant is
    // written with the defaults MISSING and reads back disabled.
    assert.equal(Model.calls[0].options.setDefaultsOnInsert, true);
    assert.equal(Model.calls[0].options.upsert, true);
  });

  test('the first read is tenant-scoped', async () => {
    const Model = makeModel();

    await getTenantConfig(COMPANY, { Model });

    assert.equal(String(Model.calls[0].filter.companyId), COMPANY);
  });

  test('a second read is served from the cache and never touches Mongo', async () => {
    const Model = makeModel();
    const cache = makeCache();

    const first = await getTenantConfig(COMPANY, {
      Model,
      io: cache.io,
    });

    const second = await getTenantConfig(COMPANY, {
      Model,
      io: cache.io,
    });

    assert.equal(Model.calls.length, 1);
    assert.equal(cache.calls.get, 2);
    assert.deepEqual(second, first);
  });

  test('the cache key is tenant-scoped and versioned', async () => {
    const Model = makeModel();
    const cache = makeCache();

    await getTenantConfig(COMPANY, { Model, io: cache.io });

    assert.equal(cache.keys.set[0], expectedKey(COMPANY));

    // A different tenant must never share a key: that is how one tenant's
    // disabled flag would become another tenant's disabled flag.
    await getTenantConfig(OTHER_COMPANY, { Model, io: cache.io });

    assert.equal(cache.keys.set[1], expectedKey(OTHER_COMPANY));
    assert.notEqual(cache.keys.set[0], cache.keys.set[1]);
  });

  test('the TTL is 600 seconds', async () => {
    const Model = makeModel();
    const cache = makeCache();

    await getTenantConfig(COMPANY, { Model, io: cache.io });

    assert.equal(cache.ttls[0], 600);
  });

  test('an existing document is cached after the miss', async () => {
    const Model = makeModel({
      [COMPANY]: { ...SCHEMA_DEFAULTS, enabled: false, companyId: COMPANY },
    });

    const cache = makeCache();

    const config = await getTenantConfig(COMPANY, { Model, io: cache.io });

    assert.equal(config.enabled, false);
    assert.equal(cache.calls.set, 1);
  });

  test('Redis down still returns the config from Mongo', async () => {
    const Model = makeModel({
      [COMPANY]: { ...SCHEMA_DEFAULTS, companyId: COMPANY },
    });

    const cache = deadCache();

    // A dead cache must degrade to a Mongo read, never to an exception: the
    // caller is an AI request, and a cache outage is not the tenant's fault.
    const config = await getTenantConfig(COMPANY, {
      Model,
      io: cache.io,
    });

    assert.equal(config.enabled, true);
  });

  test('a Mongo failure is an AIError, never a raw driver error', async () => {
    const Model = {
      async findOneAndUpdate() {
        const error = new Error('MongoServerError: connection refused');
        error.code = 'ECONNREFUSED';

        throw error;
      },
    };

    await assert.rejects(
      () => getTenantConfig(COMPANY, { Model }),
      (error) =>
        error instanceof AIError &&
        error.code === AI_ERROR_CODES.CONFIG_READ_FAILED &&
        error.statusCode === 503,
    );
  });

  test('a cached hit and a Mongo miss return the SAME shape', async () => {
    // ObjectId vs string, document vs plain object: if the two paths differed,
    // `enabled` would work by luck and `updatedBy` would be an ObjectId on
    // one path and a string on the other.
    const seeded = {
      ...SCHEMA_DEFAULTS,
      companyId: COMPANY,
      updatedBy: ADMIN,
      updatedAt: new Date('2026-01-02T03:04:05.000Z'),
    };

    const fromMongo = await getTenantConfig(COMPANY, {
      Model: makeModel({ [COMPANY]: seeded }),
    });

    const cache = makeCache();

    cache.data.set(expectedKey(COMPANY), fromMongo);

    const fromCache = await getTenantConfig(COMPANY, {
      Model: makeModel(),
      io: cache.io,
    });

    assert.deepEqual(Object.keys(fromCache).sort(), Object.keys(fromMongo).sort());
    assert.equal(typeof fromCache.updatedBy, 'string');
    assert.equal(fromCache.updatedBy, String(ADMIN));
    assert.equal(fromCache.updatedAt, seeded.updatedAt.toISOString());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. updateTenantConfig — narrow allowlist, then exact-key invalidation
// ═══════════════════════════════════════════════════════════════════════════
describe('updateTenantConfig (Phase 36 §6.2)', () => {
  test('a valid update persists and records who made it', async () => {
    const Model = makeModel();

    const config = await updateTenantConfig(
      COMPANY,
      { enabled: false },
      ADMIN,
      { Model },
    );

    assert.equal(config.enabled, false);
    assert.equal(config.updatedBy, String(ADMIN));
    assert.deepEqual(Model.calls[0].update.$set, {
      enabled: false,
      updatedBy: ADMIN,
    });
  });

  test('an unknown field is refused rather than silently dropped', async () => {
    const Model = makeModel();

    // A silently ignored key is how "disable AI" ends up doing nothing and
    // nobody finds out until the bill arrives.
    await assert.rejects(
      () =>
        updateTenantConfig(COMPANY, { enabled: false, mode: 'yolo' }, ADMIN, {
          Model,
        }),
      (error) =>
        error instanceof AIError &&
        error.statusCode === 400 &&
        error.message.includes('mode'),
    );

    assert.equal(Model.calls.length, 0);
  });

  test('companyId cannot be moved by an update payload', async () => {
    const Model = makeModel();

    await assert.rejects(
      () =>
        updateTenantConfig(COMPANY, { companyId: OTHER_COMPANY }, ADMIN, {
          Model,
        }),
      (error) => error instanceof AIError && error.statusCode === 400,
    );
  });

  test('the update invalidates exactly this tenant\'s cache key', async () => {
    const Model = makeModel();
    const cache = makeCache();

    await updateTenantConfig(COMPANY, { enabled: false }, ADMIN, {
      Model,
      io: cache.io,
    });

    assert.deepEqual(cache.keys.del, [expectedKey(COMPANY)]);

    // No wildcard, no FLUSH: a pattern delete here would drop every other
    // tenant's cached config, which is an availability incident dressed up as
    // an invalidation.
    assert.equal(
      cache.keys.del.every((key) => !key.includes('*')),
      true,
    );
  });

  test('a failing cache invalidation does not fail the update', async () => {
    const Model = makeModel();

    const cache = deadCache();

    const config = await updateTenantConfig(
      COMPANY,
      { enabled: true },
      ADMIN,
      { Model, io: cache.io },
    );

    // The entry expires by itself in 600s; failing the write because the
    // cache is down would turn a stale read into a lost configuration.
    assert.equal(config.enabled, true);
  });

  test('an invalid enum in allowedCategories is refused', async () => {
    const Model = {
      async findOneAndUpdate() {
        const error = new Error(
          '`payroll` is not a valid enum value for path `allowedCategories`.',
        );

        error.name = 'ValidationError';

        throw error;
      },
    };

    await assert.rejects(
      () =>
        updateTenantConfig(
          COMPANY,
          { allowedCategories: ['payroll'] },
          ADMIN,
          { Model },
        ),
      (error) =>
        error instanceof AIError &&
        error.code === AI_ERROR_CODES.CONFIG_READ_FAILED,
    );
  });

  test('invalidateTenantConfigCache deletes the exact key and nothing else', async () => {
    const cache = makeCache();

    cache.data.set(expectedKey(COMPANY), { enabled: false });
    cache.data.set(expectedKey(OTHER_COMPANY), { enabled: false });

    await invalidateTenantConfigCache(COMPANY, { io: cache.io });

    assert.equal(cache.data.has(expectedKey(COMPANY)), false);
    assert.equal(cache.data.has(expectedKey(OTHER_COMPANY)), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. resolveTenantQuota — null means the platform default, 0 means unlimited
// ═══════════════════════════════════════════════════════════════════════════
describe('resolveTenantQuota (Phase 36 §6.4)', () => {
  test('a tenant with no configured allowance gets the env default', async () => {
    const Model = makeModel();

    const quota = await resolveTenantQuota(COMPANY, { Model });

    assert.equal(quota, getAIConfig().monthlyQuotaTokens);
    assert.equal(quota, AI_DEFAULT_MONTHLY_QUOTA_TOKENS);
  });

  test('a tenant with a configured cap gets exactly that cap', async () => {
    const Model = makeModel({
      [COMPANY]: { ...SCHEMA_DEFAULTS, monthlyQuotaTokens: 500_000 },
    });

    const quota = await resolveTenantQuota(COMPANY, { Model });

    assert.equal(quota, 500_000);
  });

  test('a quota of 0 means unlimited, not locked out', async () => {
    // 36.1 semantics: a zero nobody meant must not disable a tenant. This is
    // the difference between "no allowance configured" and "unlimited".
    const Model = makeModel({
      [COMPANY]: { ...SCHEMA_DEFAULTS, monthlyQuotaTokens: 0 },
    });

    const quota = await resolveTenantQuota(COMPANY, { Model });

    assert.equal(quota, 0);
  });

  test('a config read failure propagates as a coded error', async () => {
    const Model = {
      async findOneAndUpdate() {
        throw new Error('boom');
      },
    };

    await assert.rejects(
      () => resolveTenantQuota(COMPANY, { Model }),
      (error) => error.code === AI_ERROR_CODES.CONFIG_READ_FAILED,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. isTenantAIEnabled — the per-tenant kill switch
// ═══════════════════════════════════════════════════════════════════════════
describe('isTenantAIEnabled (Phase 36 §6.5)', () => {
  test('enabled=true answers true', async () => {
    const Model = makeModel({
      [COMPANY]: { ...SCHEMA_DEFAULTS, enabled: true },
    });

    assert.equal(await isTenantAIEnabled(COMPANY, { Model }), true);
  });

  test('enabled=false answers false', async () => {
    const Model = makeModel({
      [COMPANY]: { ...SCHEMA_DEFAULTS, enabled: false },
    });

    assert.equal(await isTenantAIEnabled(COMPANY, { Model }), false);
  });

  test('an unconfigured tenant is enabled by default', async () => {
    // A brand-new tenant must work out of the box; the operator disables
    // deliberately, never by omission.
    const Model = makeModel();

    assert.equal(await isTenantAIEnabled(COMPANY, { Model }), true);
  });

  test('a read failure THROWS — it never answers "enabled"', async () => {
    // The provider treats a throw as "refuse". If this returned false the
    // call would be refused too, but if it returned true a dead Mongo would
    // silently re-enable AI for a tenant that had switched it off.
    const Model = {
      async findOneAndUpdate() {
        throw new Error('boom');
      },
    };

    await assert.rejects(
      () => isTenantAIEnabled(COMPANY, { Model }),
      (error) => error.code === AI_ERROR_CODES.CONFIG_READ_FAILED,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. THE SEAM — aiProvider now honours the tenant switch and the tenant quota
// ═══════════════════════════════════════════════════════════════════════════

const vendorOk = {
  choices: [{ message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const makeClient = () => ({
  chat: { completions: { async create() { return vendorOk; } } },
});

const neverLimited = () => ({ hit: async () => ({ limited: false }) });

// Both tenant seams are supplied HERE. Omitting either would let the real
// service run, which reaches for Mongo and turns a hermetic test into an
// environment failure that looks like a product bug.
const baseDeps = (overrides = {}) => ({
  getConfig: () => ({ ...getAIConfig(), enabled: true, model: 'test-model' }),
  isTenantEnabled: async () => true,
  resolveQuota: async () => 1_000_000,
  checkQuotaFn: async () => ({ allowed: true, used: 0, limit: 1 }),
  limiter: neverLimited(),
  createCompletion: async () => vendorOk,
  resolveClient: () => makeClient(),
  UsageModel: { async create() { return {}; } },
  now: () => new Date('2026-01-15T00:00:00.000Z'),
  ...overrides,
});

const chatArgs = (overrides = {}) => ({
  messages: [{ role: 'user', content: 'hello' }],
  companyId: COMPANY,
  userId: ADMIN,
  ...overrides,
});

describe('aiChat honours the per-tenant switch (Phase 36 §7.1)', () => {
  test('a disabled tenant is refused with 503 AI_UNAVAILABLE', async () => {
    await assert.rejects(
      () =>
        aiChat(
          chatArgs({
            deps: baseDeps({ isTenantEnabled: async () => false }),
          }),
        ),
      (error) =>
        error instanceof AIError &&
        error.code === AI_ERROR_CODES.UNAVAILABLE &&
        error.statusCode === 503,
    );
  });

  test('the disabled tenant gets a sentence that says WHO switched it off', async () => {
    // Same code as a transient outage (the frontend contract is unchanged),
    // but the sentence must not tell an employee to retry a decision their
    // own organisation made.
    await assert.rejects(
      () =>
        aiChat(
          chatArgs({
            deps: baseDeps({ isTenantEnabled: async () => false }),
          }),
        ),
      (error) => {
        assert.equal(
          error.clientMessage,
          'AI features are disabled for your organization.',
        );

        return true;
      },
    );
  });

  test('a resolver that THROWS is treated as disabled (fail closed)', async () => {
    // If a config read failure allowed the call, a Mongo outage would
    // silently bypass the per-tenant kill switch.
    //
    // The reply is AI_UNAVAILABLE, NOT AI_CONFIG_READ_FAILED: 36.1 pinned the
    // code for a failing resolver and Phase 36 section 10 forbids changing a
    // shipped code. The config-read failure is still distinguishable -- it
    // reaches the client through the QUOTA path (pinned below), and both
    // paths log the classification metadata-only.
    await assert.rejects(
      () =>
        aiChat(
          chatArgs({
            deps: baseDeps({
              isTenantEnabled: async () => {
                throw AIError.configReadFailed();
              },
            }),
          }),
        ),
      (error) =>
        error instanceof AIError &&
        error.code === AI_ERROR_CODES.UNAVAILABLE &&
        error.statusCode === 503,
    );
  });

  test('a CONFIG_READ_FAILED from the QUOTA path does reach the client', async () => {
    // The new code is a real, reachable contract, not a cosmetic one: it
    // surfaces wherever an AIError is already re-thrown unchanged.
    await assert.rejects(
      () =>
        aiChat(
          chatArgs({
            deps: baseDeps({
              resolveQuota: async () => {
                throw AIError.configReadFailed();
              },
            }),
          }),
        ),
      (error) =>
        error instanceof AIError &&
        error.code === AI_ERROR_CODES.CONFIG_READ_FAILED &&
        error.statusCode === 503,
    );
  });

  test('the tenant resolver receives the server-derived companyId', async () => {
    let seen = null;

    await aiChat(
      chatArgs({
        deps: baseDeps({
          isTenantEnabled: async ({ companyId }) => {
            seen = companyId;

            return true;
          },
        }),
      }),
    );

    assert.equal(seen, COMPANY);
  });
});

describe('aiChat honours the per-tenant quota (Phase 36 §7.2)', () => {
  test('the quota resolver receives the server-derived companyId', async () => {
    let seen = null;

    await aiChat(
      chatArgs({
        deps: baseDeps({
          resolveQuota: async ({ companyId }) => {
            seen = companyId;

            return 1_000_000;
          },
        }),
      }),
    );

    assert.equal(seen, COMPANY);
  });

  test('a tenant-specific cap is passed through to checkQuota', async () => {
    let limit = null;

    await aiChat(
      chatArgs({
        deps: baseDeps({
          resolveQuota: async () => 250,
          checkQuotaFn: async ({ limitTokens }) => {
            limit = limitTokens;

            return { allowed: true, used: 0, limit: limitTokens };
          },
        }),
      }),
    );

    assert.equal(limit, 250);
  });

  test('a quota resolution failure still refuses the call', async () => {
    await assert.rejects(
      () =>
        aiChat(
          chatArgs({
            deps: baseDeps({
              resolveQuota: async () => {
                throw AIError.configReadFailed();
              },
            }),
          }),
        ),
      (error) =>
        error instanceof AIError &&
        error.code === AI_ERROR_CODES.CONFIG_READ_FAILED,
    );
  });

  test('a tenant over its cap is refused with 429 QUOTA_EXCEEDED', async () => {
    await assert.rejects(
      () =>
        aiChat(
          chatArgs({
            deps: baseDeps({
              resolveQuota: async () => 10,
              checkQuotaFn: async () => ({
                allowed: false,
                used: 10,
                limit: 10,
              }),
            }),
          }),
        ),
      (error) =>
        error instanceof AIError &&
        error.code === AI_ERROR_CODES.QUOTA_EXCEEDED &&
        error.statusCode === 429,
    );
  });

  test('the guard ORDER is unchanged: tenant switch before rate limit', async () => {
    // 36.1 pinned the ladder order. If the switch moved after the limiter, a
    // disabled tenant would still be charged a rate-limit token.
    let limiterHit = false;

    await assert.rejects(
      () =>
        aiChat(
          chatArgs({
            deps: baseDeps({
              isTenantEnabled: async () => false,
              limiter: {
                hit: async () => {
                  limiterHit = true;

                  return { limited: false };
                },
              },
            }),
          }),
        ),
      (error) => error.code === AI_ERROR_CODES.UNAVAILABLE,
    );

    assert.equal(limiterHit, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. SOURCE PINS — laws that are easier to break than to test
// ═══════════════════════════════════════════════════════════════════════════
describe('source pins', () => {
  test('the tenant config service never uses a wildcard or a FLUSH', () => {
    const source = read('src/services/ai/aiTenantConfigService.js');

    // Redis command shapes only. A substring pin that caught `Object.keys(`
    // would be a pin about JavaScript, not about Redis, and would fail for a
    // reason that has nothing to do with the law.
    const banned = ['FLUSHALL', 'FLUSHDB', '.scan(', '.scanStream(', 'KEYS *'];

    for (const pattern of banned) {
      assert.equal(
        source.toUpperCase().includes(pattern.toUpperCase()),
        false,
        `banned Redis operation found: ${pattern}`,
      );
    }

    // The service must never hold a Redis client of its own: every cache call
    // goes through the 28.7 abstraction, which is where the exact-key-only
    // guarantee lives.
    assert.equal(source.includes('getRedisClient'), false);
    assert.equal(source.includes('createClient'), false);

    // Every deletion must be of a key this module built itself.
    assert.equal(source.includes('cacheKeyFor(companyId)'), true);
  });

  test('the provider still injects its tenant resolvers (the seam is real)', () => {
    const source = read('src/services/ai/aiProvider.js');

    assert.equal(
      source.includes('isTenantAIEnabled(companyId)'),
      true,
      'the per-tenant resolver must default to the real config read',
    );

    assert.equal(
      source.includes('resolveTenantQuota(companyId)'),
      true,
      'the quota resolver must default to the real tenant quota read',
    );

    assert.equal(
      source.includes('isTenantEnabled = async'),
      true,
      'the injection seam must survive the 36.2 wiring',
    );
  });

  test('the chat route is untouched and the config routes carry RBAC', () => {
    const source = read('src/routes/ai.js');

    assert.equal(source.includes("route('/chat')"), true);
    assert.equal(source.includes("route('/config')"), true);
    assert.equal(source.includes("route('/context/preview')"), true);

    // The config endpoints are admin surfaces; the preview is not, because
    // identity is server-derived and there is nothing to escalate.
    const configBlock = source.slice(
      source.indexOf("route('/config')"),
      source.indexOf("route('/context/preview')"),
    );

    assert.equal(configBlock.includes("requirePermission('SETTINGS_MANAGE')"), true);

    const previewBlock = source.slice(source.indexOf("route('/context/preview')"));

    assert.equal(previewBlock.includes('requirePermission'), false);
  });

  test('the context preview has its own, tighter limiter', () => {
    const source = read('src/controllers/aiController.js');

    assert.equal(source.includes('ai-context-preview'), false);

    const config = read('src/services/ai/aiConfig.js');

    assert.equal(config.includes("sharedName: 'ai-context-preview'"), true);
    assert.equal(config.includes('maximum: 10'), true);
  });
});
