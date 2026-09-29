// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.1 — AI PROVIDER FOUNDATION & GUARDRAILS (hermetic)
//
// No Mongo, no Redis, no network, no clock dependence beyond `new Date()`.
// Every dependency of aiProvider.js is injectable, so the REAL control flow
// runs against in-memory fakes: a fake OpenAI client, a fake limiter, a fake
// quota reader and a fake usage model.
//
// The comments explain WHY each assertion exists, not what it does.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_ai_foundation_test';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

const {
  AI_DEFAULT_MODEL,
  AI_FEATURE_HR_CHAT,
  AI_MESSAGE_MAX_CHARS,
  AI_MESSAGE_MAX_COUNT,
  AI_MESSAGE_ROLES,
  getAIConfig,
  describeAIConfig,
  isRedactionEnforced,
  isRedactionOverridePermitted,
  parseAiEnabled,
  parseAiPiiRedaction,
  validateAIConfig,
} = await import('../src/services/ai/aiConfig.js');

const {
  PII_PLACEHOLDERS,
  PATTERNS,
  redactPII,
  redactMessages,
  containsRedactablePII,
} = await import('../src/services/ai/piiRedactor.js');

const {
  AIError,
  AI_ERROR_CODES,
  classifyVendorError,
  sendAIError,
} = await import('../src/services/ai/aiErrors.js');

const AIUsageLog = (await import('../src/models/AIUsageLog.js')).default;

const {
  monthWindow,
  recordUsage,
  checkQuota,
} = await import('../src/services/ai/aiUsageTracker.js');

const {
  aiChat,
  embed,
  initAIProvider,
  getAIProviderState,
  getAIRateLimitIdentity,
  drainAIUsageWrites,
} = await import('../src/services/ai/aiProvider.js');

// ── SHARED FAKES ───────────────────────────────────────────────────────────

const COMPANY_ID = '64b00000000000000000000aa';
const USER_ID = '64b00000000000000000000bb';

// A resolved environment that has AI switched ON with a key, so the guards
// under test are the quota/limiter/redaction ones rather than the kill switch.
const enabledSource = (overrides = {}) => ({
  AI_ENABLED: 'true',
  AI_API_KEY: 'synthetic-not-a-real-key',
  ...overrides,
});

// In-memory usage model. `aggregate` mirrors the shape the tracker queries.
const makeUsageModel = (rows = []) => ({
  created: [],
  async create(entry) {
    this.created.push(entry);

    return entry;
  },
  async aggregate(pipeline) {
    const match = pipeline.find((stage) => stage.$match)?.$match || {};

    const from = match.createdAt?.$gte;
    const to = match.createdAt?.$lt;

    const total = rows
      .filter(
        (row) =>
          String(row.companyId) === String(match.companyId) &&
          (!from || new Date(row.createdAt) >= new Date(from)) &&
          (!to || new Date(row.createdAt) < new Date(to)),
      )
      .reduce((sum, row) => sum + (Number(row.totalTokens) || 0), 0);

    return [{ _id: null, total }];
  },
});

// A fake OpenAI client that records exactly what it was asked to send. This is
// how the redactor's position in the pipeline is proven rather than assumed.
const makeClient = (reply = { content: 'Here is your answer.', usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }) => {
  const calls = [];

  return {
    calls,
    chat: {
      completions: {
        async create(payload) {
          calls.push(payload);

          if (reply instanceof Error) throw reply;

          return {
            choices: [{ message: { role: 'assistant', content: reply.content } }],
            usage: reply.usage,
          };
        },
      },
    },
  };
};

const neverLimitedLimiter = () => ({
  hits: 0,
  async hit() {
    this.hits += 1;

    return { limited: false, count: 1, remaining: 19, tier: 'shared' };
  },
});

// The full dependency set for a happy-path call. Each test overrides the one
// thing it is about.
//
// The fake client and the fake usage model are created HERE and handed back on
// the returned object (`deps.client`, `deps.usage`), because the provider
// resolves its SDK client through `resolveClient` — a test that builds its own
// client must be the same one the provider calls, or it would be asserting
// against a different object.
const happyDeps = (overrides = {}) => {
  const client = overrides.client ?? makeClient();
  const usage = overrides.UsageModel ?? makeUsageModel();

  return {
    client,
    usage,
    getConfig: () => getAIConfig(enabledSource()),
    isTenantEnabled: async () => true,
    resolveQuota: async () => 1_000_000,
    checkQuotaFn: async () => ({
      allowed: true,
      used: 0,
      limit: 1_000_000,
      remaining: 1_000_000,
    }),
    limiter: neverLimitedLimiter(),
    createCompletion: async ({ client: sdk, messages, config }) =>
      sdk.chat.completions.create({
        model: config.model,
        messages,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      }),
    resolveClient: () => client,
    UsageModel: usage,
    ...overrides,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE PII REDACTOR — the one guard that must never be wrong
// ═══════════════════════════════════════════════════════════════════════════
describe('PII redactor (Phase 36 §5.2 — mandatory before the vendor)', () => {
  test('every Indian identifier class is removed', () => {
    const cases = [
      // [input, expected]
      ['My Aadhaar is 1234 5678 9012 ok', `My Aadhaar is ${PII_PLACEHOLDERS.AADHAAR} ok`],
      ['Aadhaar 123456789012 ok', `Aadhaar ${PII_PLACEHOLDERS.AADHAAR} ok`],
      ['UAN 123456789012 check', `UAN ${PII_PLACEHOLDERS.AADHAAR} check`],
      ['PAN is ABCDE1234F here', `PAN is ${PII_PLACEHOLDERS.PAN} here`],
      ['call me on 9876543210 now', `call me on ${PII_PLACEHOLDERS.MOBILE} now`],
      ['call me on +919876543210 now', `call me on ${PII_PLACEHOLDERS.MOBILE} now`],
      ['call me on +91 98765 43210 now', `call me on ${PII_PLACEHOLDERS.MOBILE} now`],
      ['call me on 09876543210 now', `call me on ${PII_PLACEHOLDERS.MOBILE} now`],
      ['email john.doe@example.com now', `email ${PII_PLACEHOLDERS.EMAIL} now`],
      [
        'my bank account number is 00112233445566 please',
        `my bank account number is ${PII_PLACEHOLDERS.BANK_ACCOUNT} please`,
      ],
      ['a/c 0011223344 updated', `a/c ${PII_PLACEHOLDERS.BANK_ACCOUNT} updated`],
      ['IFSC HDFC0001234 branch Chennai', `IFSC ${PII_PLACEHOLDERS.IFSC} branch Chennai`],
      ['my salary is Rs 45,000 per month', `my salary is ${PII_PLACEHOLDERS.AMOUNT} per month`],
      ['CTC is \u20b912,00,000 total', `CTC is ${PII_PLACEHOLDERS.AMOUNT} total`],
      ['my salary is 45000 per month', `my salary is ${PII_PLACEHOLDERS.AMOUNT} per month`],
      ['net pay INR 85000', `net pay ${PII_PLACEHOLDERS.AMOUNT}`],
    ];

    for (const [input, expected] of cases) {
      assert.equal(redactPII(input), expected, `input: ${input}`);
    }
  });

  test('ordinary business text survives untouched (over-redaction breaks answers)', () => {
    const clean = [
      'My leave balance is 12 days and I joined on 2024-04-01',
      'employee code 12345 and ticket #88213',
      'office 044-12345678 call',
      'How do I apply for work from home?',
      '',
    ];

    for (const text of clean) {
      assert.equal(redactPII(text), text, `input: ${text}`);
      assert.equal(containsRedactablePII(text), false);
    }
  });

  test('redaction is idempotent — a second pass changes nothing', () => {
    const inputs = [
      'Aadhaar 123456789012 PAN ABCDE1234F mobile 9876543210 email a@b.com',
      'bank account number is 00112233445566 IFSC HDFC0001234 salary Rs 45,000',
    ];

    for (const input of inputs) {
      const once = redactPII(input);
      const twice = redactPII(once);

      assert.equal(twice, once, `input: ${input}`);
    }
  });

  test('no placeholder is itself matchable (the table is closed)', () => {
    for (const placeholder of Object.values(PII_PLACEHOLDERS)) {
      assert.equal(redactPII(placeholder), placeholder, `placeholder: ${placeholder}`);
    }
  });

  test('non-string input degrades safely instead of reaching the vendor', () => {
    // A structure the redactor cannot inspect must NOT be forwarded. Dropping
    // it is the safe direction; passing it through would be a leak.
    assert.equal(redactPII({ a: 1 }), '');
    assert.equal(redactPII(['x']), '');
    assert.equal(redactPII(null), '');
    assert.equal(redactPII(undefined), '');

    // Numbers ARE stringified: a client sending content: 9876543210 must not
    // slip a mobile number past the redactor by using a JSON number.
    assert.equal(redactPII(9876543210), PII_PLACEHOLDERS.MOBILE);
  });

  test('redactMessages covers EVERY role, including system and assistant history', () => {
    const out = redactMessages([
      { role: 'system', content: 'Policy for Aadhaar 123456789012' },
      { role: 'user', content: 'my PAN is ABCDE1234F' },
      { role: 'assistant', content: 'your salary is Rs 45000' },
    ]);

    assert.equal(out[0].content, `Policy for Aadhaar ${PII_PLACEHOLDERS.AADHAAR}`);
    assert.equal(out[1].content, `my PAN is ${PII_PLACEHOLDERS.PAN}`);
    assert.equal(out[2].content, `your salary is ${PII_PLACEHOLDERS.AMOUNT}`);

    // Roles are preserved verbatim — the vendor needs them to interpret turns.
    assert.deepEqual(
      out.map((message) => message.role),
      ['system', 'user', 'assistant'],
    );
  });

  test('the pattern table is pure source: no vendor, no DB, no network import', () => {
    const source = read('src/services/ai/piiRedactor.js');

    for (const forbidden of ['openai', 'mongoose', 'fetch(', 'http', 'process.env']) {
      assert.ok(
        !source.includes(forbidden),
        `piiRedactor.js must not reference ${forbidden}`,
      );
    }

    // A fresh RegExp per call keeps lastIndex state from leaking between
    // invocations; that is what makes the function deterministic.
    assert.match(source, /new RegExp\(rule\.pattern\.source/);
  });

  test('every pattern row declares a placeholder from the frozen set', () => {
    assert.ok(PATTERNS.length >= 8, 'all eight identifier classes are covered');

    const allowed = new Set(Object.values(PII_PLACEHOLDERS));

    for (const rule of PATTERNS) {
      assert.ok(allowed.has(rule.placeholder), `unknown placeholder for ${rule.key}`);
      assert.ok(rule.pattern instanceof RegExp);
      assert.ok(rule.pattern.flags.includes('g'), 'every pattern must be global');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CONFIGURATION — strict parsers and the fail-closed redaction override
// ═══════════════════════════════════════════════════════════════════════════
describe('AI configuration parsers (28.1 law: never Boolean(env))', () => {
  test('AI_ENABLED accepts only an explicit truthy set', () => {
    assert.equal(parseAiEnabled({ AI_ENABLED: 'true' }), true);
    assert.equal(parseAiEnabled({ AI_ENABLED: '1' }), true);
    assert.equal(parseAiEnabled({ AI_ENABLED: 'TRUE' }), true);

    // The SAME explicit allowlist config/redis.js uses (28.1 law: an
    // allowlist, never Boolean(env)). What matters is that an UNRECOGNISED
    // value falls to OFF rather than to truthiness.
    assert.equal(parseAiEnabled({ AI_ENABLED: 'yes' }), true);
    assert.equal(parseAiEnabled({ AI_ENABLED: 'on' }), true);
    assert.equal(parseAiEnabled({}), false);
    assert.equal(parseAiEnabled({ AI_ENABLED: 'false' }), false);
    assert.equal(parseAiEnabled({ AI_ENABLED: '0' }), false);
    assert.equal(parseAiEnabled({ AI_ENABLED: 'garbage' }), false);
    assert.equal(parseAiEnabled({ AI_ENABLED: '  TRUE  ' }), true);
  });

  test('PII redaction defaults ON and an unknown value stays ON', () => {
    assert.equal(parseAiPiiRedaction({}), true);
    assert.equal(parseAiPiiRedaction({ AI_PII_REDACTION: 'garbage' }), true);
    assert.equal(parseAiPiiRedaction({ AI_PII_REDACTION: 'false' }), false);
  });

  test('the redaction override is honoured ONLY outside production', () => {
    assert.equal(isRedactionOverridePermitted('development'), true);
    assert.equal(isRedactionOverridePermitted('test'), true);
    assert.equal(isRedactionOverridePermitted('production'), false);
    assert.equal(isRedactionOverridePermitted(undefined), false);
  });

  test('redaction is ENFORCED in production even with the flag set to false', () => {
    // The runtime answer, independent of the startup validator: a production
    // process that somehow boots with the flag off still redacts.
    assert.equal(
      isRedactionEnforced({ AI_PII_REDACTION: 'false', NODE_ENV: 'production' }),
      true,
    );

    assert.equal(
      isRedactionEnforced({ AI_PII_REDACTION: 'false', NODE_ENV: 'development' }),
      false,
    );
  });

  test('numeric bounds are clamped, never trusted raw', () => {
    const wild = getAIConfig({
      AI_ENABLED: 'true',
      AI_API_KEY: 'k',
      AI_MAX_TOKENS: '999999',
      AI_MONTHLY_QUOTA_TOKENS: '-5',
      AI_TIMEOUT_MS: '1',
      AI_TEMPERATURE: '9',
    });

    assert.equal(wild.maxTokens, 4096);
    assert.equal(wild.monthlyQuotaTokens, 0);
    assert.equal(wild.timeoutMs, 1000);
    assert.equal(wild.temperature, 1);
  });

  test('validateAIConfig refuses a missing key the moment AI is enabled', () => {
    const verdict = validateAIConfig({ AI_ENABLED: 'true', NODE_ENV: 'production' });

    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((error) => error.startsWith('AI_API_KEY')));
  });

  test('validateAIConfig refuses the redaction override in production', () => {
    const verdict = validateAIConfig({
      AI_ENABLED: 'true',
      AI_API_KEY: 'synthetic',
      AI_PII_REDACTION: 'false',
      NODE_ENV: 'production',
    });

    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((error) => error.startsWith('AI_PII_REDACTION')));
  });

  test('the SAME override is allowed in development', () => {
    const verdict = validateAIConfig({
      AI_ENABLED: 'true',
      AI_API_KEY: 'synthetic',
      AI_PII_REDACTION: 'false',
      NODE_ENV: 'development',
    });

    assert.equal(verdict.ok, true);
  });

  test('a deployment that does not use AI contributes no errors at all', () => {
    assert.deepEqual(validateAIConfig({}).errors, []);
    assert.deepEqual(validateAIConfig({ AI_ENABLED: 'false' }).errors, []);
  });

  test('describeAIConfig never carries the key (the only printable shape)', () => {
    const secret = 'sk-synthetic-value-that-must-never-appear';

    const described = describeAIConfig({
      AI_ENABLED: 'true',
      AI_API_KEY: secret,
    });

    assert.equal(described.hasApiKey, true);
    assert.ok(!JSON.stringify(described).includes(secret));

    // And the key-bearing shape is NOT what anything may print.
    assert.equal(getAIConfig({ AI_API_KEY: secret }).apiKey, secret);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. PROVIDER INITIALISATION — the fail-fast
// ═══════════════════════════════════════════════════════════════════════════
describe('initAIProvider — fail-fast, never silent', () => {
  test('AI_ENABLED=false initialises to a clean disabled state', () => {
    const state = initAIProvider({ source: {}, clientFactory: () => {
      throw new Error('must not build a client when disabled');
    } });

    assert.equal(state.enabled, false);
    assert.equal(state.initialized, true);
    assert.equal(state.reason, 'DISABLED');
    assert.equal(getAIProviderState().enabled, false);
  });

  test('AI_ENABLED=true with NO key throws a config error naming no value', () => {
    assert.throws(
      () => initAIProvider({ source: { AI_ENABLED: 'true' } }),
      (error) => {
        assert.ok(error instanceof AIError);
        assert.equal(error.code, AI_ERROR_CODES.CONFIG_INVALID);
        assert.equal(error.statusCode, 500);

        const text = JSON.stringify({ message: error.message, code: error.code });

        // Never the key (there is none), never a vendor sentence.
        assert.ok(!text.toLowerCase().includes('api_key='));

        return true;
      },
    );
  });

  test('AI_ENABLED=true WITH a key builds exactly one client', () => {
    let built = 0;

    const state = initAIProvider({
      source: enabledSource(),
      clientFactory: () => {
        built += 1;

        return { fake: true };
      },
    });

    assert.equal(state.enabled, true);
    assert.equal(state.reason, null);
    assert.equal(built, 1);
  });

  test('the provider state never contains the key', () => {
    initAIProvider({ source: enabledSource(), clientFactory: () => ({}) });

    assert.ok(!JSON.stringify(getAIProviderState()).includes('synthetic-not-a-real-key'));
  });

  test('embed() refuses loudly instead of failing halfway', async () => {
    // Groq has no first-party embeddings endpoint. A future unit must not be
    // able to build on a capability that does not exist, so the refusal is
    // immediate and distinguishable from a transient failure (501).
    await assert.rejects(
      () => embed(),
      (error) => {
        assert.ok(error instanceof AIError);
        assert.equal(error.code, AI_ERROR_CODES.EMBEDDINGS_UNSUPPORTED);
        assert.equal(error.statusCode, 501);

        return true;
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. aiChat — the guard ladder, in order
// ═══════════════════════════════════════════════════════════════════════════
describe('aiChat — every guard, in the order the law requires', () => {
  test('the global kill switch refuses with AI_UNAVAILABLE before any I/O', async () => {
    const client = makeClient();
    const usage = makeUsageModel();
    const limiter = neverLimitedLimiter();

    await assert.rejects(
      () =>
        aiChat({
          messages: [{ role: 'user', content: 'hello' }],
          companyId: COMPANY_ID,
          userId: USER_ID,
          deps: happyDeps({
            getConfig: () => getAIConfig({ AI_ENABLED: 'false' }),
            createCompletion: async (args) => client.chat.completions.create(args),
            limiter,
            UsageModel: usage,
          }),
        }),
      (error) => error.code === AI_ERROR_CODES.UNAVAILABLE && error.statusCode === 503,
    );

    // Nothing was spent and nothing was attempted.
    assert.equal(client.calls.length, 0);
    assert.equal(limiter.hits, 0);
    assert.equal(usage.created.length, 0);
  });

  test('a provider that was never initialised answers CONFIG_INVALID, not a vendor error', async () => {
    // Without this guard a missing SDK client would surface as
    // AI_VENDOR_ERROR, which sends an operator hunting a vendor outage that
    // does not exist instead of at the missing initialisation.
    await assert.rejects(
      () =>
        aiChat({
          messages: [{ role: 'user', content: 'hello' }],
          companyId: COMPANY_ID,
          userId: USER_ID,
          deps: happyDeps({ resolveClient: () => null }),
        }),
      (error) => error.code === AI_ERROR_CODES.CONFIG_INVALID && error.statusCode === 500,
    );
  });

  test('the per-tenant kill switch refuses the same way (36.2 seam)', async () => {
    const client = makeClient();

    await assert.rejects(
      () =>
        aiChat({
          messages: [{ role: 'user', content: 'hello' }],
          companyId: COMPANY_ID,
          userId: USER_ID,
          deps: happyDeps({
            isTenantEnabled: async () => false,
            createCompletion: async (args) => client.chat.completions.create(args),
          }),
        }),
      (error) => error.code === AI_ERROR_CODES.UNAVAILABLE,
    );

    assert.equal(client.calls.length, 0);
  });

  test('a tenant-config read failure refuses rather than allowing the call', async () => {
    const client = makeClient();

    await assert.rejects(
      () =>
        aiChat({
          messages: [{ role: 'user', content: 'hello' }],
          companyId: COMPANY_ID,
          userId: USER_ID,
          deps: happyDeps({
            isTenantEnabled: async () => {
              throw new Error('config store unavailable');
            },
            createCompletion: async (args) => client.chat.completions.create(args),
          }),
        }),
      (error) => error.code === AI_ERROR_CODES.UNAVAILABLE,
    );

    assert.equal(client.calls.length, 0);
  });

  test('the rate limiter refuses with RATE_LIMITED and records the refusal', async () => {
    const client = makeClient();
    const usage = makeUsageModel();

    await assert.rejects(
      () =>
        aiChat({
          messages: [{ role: 'user', content: 'hello' }],
          companyId: COMPANY_ID,
          userId: USER_ID,
          deps: happyDeps({
            limiter: {
              async hit() {
                return { limited: true, count: 21, remaining: 0, tier: 'shared' };
              },
            },
            createCompletion: async (args) => client.chat.completions.create(args),
            UsageModel: usage,
          }),
        }),
      (error) => error.code === AI_ERROR_CODES.RATE_LIMITED && error.statusCode === 429,
    );

    assert.equal(client.calls.length, 0);

    // The refusal is part of the audit trail and costs zero tokens.
    await drainAIUsageWrites();
    assert.equal(usage.created.length, 1);
    assert.equal(usage.created[0].status, 'ERROR');
    assert.equal(usage.created[0].errorType, 'rate_limit');
    assert.equal(usage.created[0].totalTokens, 0);
  });

  test('the quota refuses with QUOTA_EXCEEDED, records it, and never calls the vendor', async () => {
    const client = makeClient();
    const usage = makeUsageModel();

    await assert.rejects(
      () =>
        aiChat({
          messages: [{ role: 'user', content: 'hello' }],
          companyId: COMPANY_ID,
          userId: USER_ID,
          deps: happyDeps({
            checkQuotaFn: async () => ({
              allowed: false,
              used: 1_000_000,
              limit: 1_000_000,
              remaining: 0,
            }),
            createCompletion: async (args) => client.chat.completions.create(args),
            UsageModel: usage,
          }),
        }),
      (error) => error.code === AI_ERROR_CODES.QUOTA_EXCEEDED && error.statusCode === 429,
    );

    assert.equal(client.calls.length, 0);

    await drainAIUsageWrites();
    assert.equal(usage.created.length, 1);
    assert.equal(usage.created[0].status, 'QUOTA_EXCEEDED');
    assert.equal(usage.created[0].errorType, 'quota');
    assert.equal(usage.created[0].totalTokens, 0);
  });

  test('an unreadable quota refuses the call — fail CLOSED, never open', async () => {
    const client = makeClient();

    await assert.rejects(
      () =>
        aiChat({
          messages: [{ role: 'user', content: 'hello' }],
          companyId: COMPANY_ID,
          userId: USER_ID,
          deps: happyDeps({
            checkQuotaFn: async () => {
              throw new Error('mongo unavailable');
            },
            createCompletion: async (args) => client.chat.completions.create(args),
          }),
        }),
      // A silent allowance here would be exactly the overage the quota exists
      // to prevent.
      (error) => error.code === AI_ERROR_CODES.UNAVAILABLE,
    );

    assert.equal(client.calls.length, 0);
  });

  test('the SUCCESS path redacts BEFORE the vendor call', async () => {
    const client = makeClient();
    const usage = makeUsageModel();

    const result = await aiChat({
      messages: [
        { role: 'user', content: 'My Aadhaar is 123456789012 and PAN is ABCDE1234F' },
      ],
      companyId: COMPANY_ID,
      userId: USER_ID,
      deps: happyDeps({
        createCompletion: async (args) => client.chat.completions.create(args),
        UsageModel: usage,
      }),
    });

    // The vendor saw the redacted text, not the original.
    assert.equal(client.calls.length, 1);
    const sent = client.calls[0].messages[0].content;

    assert.ok(!sent.includes('123456789012'), 'Aadhaar reached the vendor');
    assert.ok(!sent.includes('ABCDE1234F'), 'PAN reached the vendor');
    assert.equal(
      sent,
      `My Aadhaar is ${PII_PLACEHOLDERS.AADHAAR} and PAN is ${PII_PLACEHOLDERS.PAN}`,
    );

    // The answer comes back clean, with its cost.
    assert.equal(result.content, 'Here is your answer.');
    assert.deepEqual(result.usage, {
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
    });

    // The vendor payload carries NO tenant identity: the AI gets text, not a
    // companyId to reason about.
    const payload = JSON.stringify(client.calls[0]);
    assert.ok(!payload.includes(COMPANY_ID));
    assert.ok(!payload.includes(USER_ID));
  });

  test('the success path records token counts and NO text', async () => {
    const deps = happyDeps();

    await aiChat({
      messages: [{ role: 'user', content: 'What is my leave balance? Aadhaar 123456789012' }],
      companyId: COMPANY_ID,
      userId: USER_ID,
      deps,
    });

    await drainAIUsageWrites();

    assert.equal(deps.usage.created.length, 1);

    const row = deps.usage.created[0];

    assert.equal(row.status, 'SUCCESS');
    assert.equal(row.errorType, 'none');
    assert.equal(row.totalTokens, 20);
    assert.equal(row.promptTokens, 12);
    assert.equal(row.completionTokens, 8);
    assert.equal(row.feature, AI_FEATURE_HR_CHAT);
    assert.equal(String(row.companyId), COMPANY_ID);
    assert.equal(String(row.userId), USER_ID);
    assert.ok(row.latencyMs >= 0);
  });

  test('a vendor failure becomes ONE generic 503 and keeps its words server-side', async () => {
    const vendorError = new Error('Groq says: invalid api key for project xyz');

    vendorError.name = 'AuthenticationError';
    vendorError.status = 401;

    const usage = makeUsageModel();

    await assert.rejects(
      () =>
        aiChat({
          messages: [{ role: 'user', content: 'hello' }],
          companyId: COMPANY_ID,
          userId: USER_ID,
          deps: happyDeps({
            createCompletion: async () => {
              throw vendorError;
            },
            UsageModel: usage,
          }),
        }),
      (error) => {
        assert.ok(error instanceof AIError);
        assert.equal(error.code, AI_ERROR_CODES.VENDOR_ERROR);
        assert.equal(error.statusCode, 503);

        // The client sentence is the generic one — no vendor, no detail.
        assert.equal(error.message, 'The AI service could not complete your request. Please try again shortly.');
        assert.ok(!error.message.includes('Groq'));
        assert.ok(!error.message.includes('invalid api key'));

        return true;
      },
    );

    // What IS persisted is the classification, not the message.
    await drainAIUsageWrites();
    assert.equal(usage.created.length, 1);
    assert.equal(usage.created[0].status, 'ERROR');
    assert.equal(usage.created[0].errorType, 'auth');
  });

  test('vendor error classification covers the bounded vocabulary only', () => {
    const withStatus = (status, name = 'Error') => {
      const error = new Error('vendor detail');

      error.name = name;
      error.status = status;

      return error;
    };

    assert.equal(classifyVendorError(withStatus(429)), 'rate_limit');
    assert.equal(classifyVendorError(withStatus(401)), 'auth');
    assert.equal(classifyVendorError(withStatus(403)), 'auth');
    assert.equal(classifyVendorError(withStatus(500)), 'vendor');
    assert.equal(classifyVendorError(new Error('x')), 'vendor');

    const timeout = new Error('timed out');

    timeout.name = 'APIConnectionTimeoutError';
    assert.equal(classifyVendorError(timeout), 'timeout');

    const network = new Error('refused');

    network.code = 'ECONNREFUSED';
    assert.equal(classifyVendorError(network), 'network');
  });

  test('a missing tenant or caller is refused before the vendor', async () => {
    const client = makeClient();

    for (const identity of [
      { companyId: undefined, userId: USER_ID },
      { companyId: COMPANY_ID, userId: undefined },
    ]) {
      await assert.rejects(
        () =>
          aiChat({
            messages: [{ role: 'user', content: 'hello' }],
            ...identity,
            deps: happyDeps({
              createCompletion: async (args) => client.chat.completions.create(args),
            }),
          }),
        (error) => error.code === AI_ERROR_CODES.REQUEST_INVALID && error.statusCode === 400,
      );
    }

    assert.equal(client.calls.length, 0);
  });

  test('an unknown feature label is refused — the vocabulary is closed', async () => {
    await assert.rejects(
      () =>
        aiChat({
          messages: [{ role: 'user', content: 'hello' }],
          companyId: COMPANY_ID,
          userId: USER_ID,
          feature: 'hr.something-else',
          deps: happyDeps(),
        }),
      (error) => error.code === AI_ERROR_CODES.REQUEST_INVALID,
    );
  });

  test('the limiter identity is companyId + userId, both server-derived', () => {
    assert.equal(
      getAIRateLimitIdentity(COMPANY_ID, USER_ID),
      `${COMPANY_ID}:${USER_ID}`,
    );
  });

  test('the vendor request is bounded by the configured token/timeout caps', async () => {
    const deps = happyDeps({
      getConfig: () =>
        getAIConfig(enabledSource({ AI_MAX_TOKENS: '999999', AI_TIMEOUT_MS: '999999' })),
    });

    await aiChat({
      messages: [{ role: 'user', content: 'hello' }],
      companyId: COMPANY_ID,
      userId: USER_ID,
      deps,
    });

    // A wild AI_MAX_TOKENS is clamped to the code-owned ceiling, so no
    // deployment can ask the vendor for an unbounded completion.
    assert.equal(deps.client.calls[0].max_tokens, 4096);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. USAGE MODEL + TRACKER — the privacy law, enforced by the schema
// ═══════════════════════════════════════════════════════════════════════════
describe('AIUsageLog — no field can hold a prompt or a response', () => {
  test('the schema declares NO text-bearing path', () => {
    const forbidden = [
      'prompt',
      'response',
      'message',
      'messages',
      'content',
      'text',
      'body',
      'question',
      'answer',
      'completion',
      'input',
      'output',
    ];

    const paths = Object.keys(AIUsageLog.schema.paths);

    for (const name of forbidden) {
      assert.ok(
        !paths.includes(name),
        `AIUsageLog must not declare "${name}" — Phase 36 §5.3 forbids storing text`,
      );
    }

    // It DOES declare the bookkeeping the product needs.
    for (const name of [
      'companyId',
      'userId',
      'feature',
      'promptTokens',
      'completionTokens',
      'totalTokens',
      'latencyMs',
      'status',
      'errorType',
    ]) {
      assert.ok(paths.includes(name), `missing ${name}`);
    }
  });

  test('every field the tracker writes is declared by the schema', () => {
    // Phase 35.5 shipped a real defect where the service wrote status/message/
    // at into a schema that declared outcome/reason/occurredAt, and Mongoose
    // strict mode silently dropped all three. This is the pin that stops the
    // same class of bug here.
    const written = [
      'companyId',
      'userId',
      'feature',
      'provider',
      'model',
      'promptTokens',
      'completionTokens',
      'totalTokens',
      'latencyMs',
      'status',
      'errorType',
    ];

    const declared = new Set(Object.keys(AIUsageLog.schema.paths));

    for (const name of written) {
      assert.ok(declared.has(name), `recordUsage writes "${name}" but the schema does not declare it`);
    }
  });

  test('status and errorType are closed enums', () => {
    assert.deepEqual(AIUsageLog.schema.path('status').options.enum, [
      'SUCCESS',
      'ERROR',
      'QUOTA_EXCEEDED',
    ]);

    const errorTypes = AIUsageLog.schema.path('errorType').options.enum;

    assert.ok(errorTypes.includes('quota'));
    assert.ok(errorTypes.includes('rate_limit'));
    assert.ok(errorTypes.includes('timeout'));
    // An empty string can never be stored, so a stray classification cannot
    // silently become a blank error type.
    assert.ok(!errorTypes.includes(''));
  });

  test('the quota read is served by a tenant-first compound index', () => {
    const indexes = AIUsageLog.schema.indexes();

    assert.ok(
      indexes.some(([keys]) => keys.companyId === 1 && keys.createdAt === -1),
      'the monthly aggregation needs {companyId, createdAt}',
    );
  });

  test('recordUsage never throws — a failed audit write is not a failed answer', async () => {
    const exploding = {
      async create() {
        throw new Error('mongo down');
      },
    };

    const ok = await recordUsage({
      companyId: COMPANY_ID,
      userId: USER_ID,
      feature: AI_FEATURE_HR_CHAT,
      status: 'SUCCESS',
      UsageModel: exploding,
    });

    assert.equal(ok, false);
  });

  test('recordUsage writes exactly what it was given, nothing more', async () => {
    const usage = makeUsageModel();

    await recordUsage({
      companyId: COMPANY_ID,
      userId: USER_ID,
      feature: AI_FEATURE_HR_CHAT,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      latencyMs: 120,
      status: 'SUCCESS',
      UsageModel: usage,
    });

    assert.equal(usage.created.length, 1);
    assert.equal(usage.created[0].totalTokens, 15);
    assert.equal(usage.created[0].latencyMs, 120);
  });

  test('an unknown errorType is normalised to none, never stored raw', async () => {
    const usage = makeUsageModel();

    await recordUsage({
      companyId: COMPANY_ID,
      userId: USER_ID,
      feature: AI_FEATURE_HR_CHAT,
      status: 'ERROR',
      errorType: 'Groq said something with a token in it',
      UsageModel: usage,
    });

    assert.equal(usage.created[0].errorType, 'none');
  });
});

describe('checkQuota — hard, calendar-month, fail-closed', () => {
  test('a limit of 0 means unlimited and costs no read', async () => {
    const verdict = await checkQuota({
      companyId: COMPANY_ID,
      limitTokens: 0,
      UsageModel: {
        async aggregate() {
          throw new Error('must not read the database');
        },
      },
    });

    assert.equal(verdict.allowed, true);
    assert.equal(verdict.limit, 0);
  });

  test('under the allowance: allowed with a real remaining count', async () => {
    const now = new Date('2026-09-15T10:00:00Z');

    const verdict = await checkQuota({
      companyId: COMPANY_ID,
      limitTokens: 1_000_000,
      now,
      UsageModel: makeUsageModel([
        { companyId: COMPANY_ID, totalTokens: 400, createdAt: new Date('2026-09-02T00:00:00Z') },
        { companyId: COMPANY_ID, totalTokens: 600, createdAt: new Date('2026-09-20T00:00:00Z') },
      ]),
    });

    assert.equal(verdict.allowed, true);
    assert.equal(verdict.used, 1000);
    assert.equal(verdict.remaining, 999_000);
  });

  test('at the allowance: refused (hard, no soft overage)', async () => {
    const now = new Date('2026-09-15T10:00:00Z');

    const verdict = await checkQuota({
      companyId: COMPANY_ID,
      limitTokens: 1000,
      now,
      UsageModel: makeUsageModel([
        { companyId: COMPANY_ID, totalTokens: 1000, createdAt: new Date('2026-09-02T00:00:00Z') },
      ]),
    });

    assert.equal(verdict.allowed, false);
    assert.equal(verdict.remaining, 0);
  });

  test('another tenant\'s spend never counts against this one', async () => {
    const now = new Date('2026-09-15T10:00:00Z');

    const verdict = await checkQuota({
      companyId: COMPANY_ID,
      limitTokens: 1000,
      now,
      UsageModel: makeUsageModel([
        { companyId: '64b0000000000000000000ff', totalTokens: 999_999, createdAt: new Date('2026-09-02T00:00:00Z') },
      ]),
    });

    assert.equal(verdict.used, 0);
    assert.equal(verdict.allowed, true);
  });

  test('last month\'s spend is outside the window', async () => {
    const verdict = await checkQuota({
      companyId: COMPANY_ID,
      limitTokens: 1000,
      now: new Date('2026-09-15T10:00:00Z'),
      UsageModel: makeUsageModel([
        { companyId: COMPANY_ID, totalTokens: 5000, createdAt: new Date('2026-08-31T23:59:59Z') },
      ]),
    });

    assert.equal(verdict.used, 0);
    assert.equal(verdict.allowed, true);
  });

  test('an unreadable quota throws AI_UNAVAILABLE — it never fails open', async () => {
    await assert.rejects(
      () =>
        checkQuota({
          companyId: COMPANY_ID,
          limitTokens: 1000,
          UsageModel: {
            async aggregate() {
              throw new Error('mongo down');
            },
          },
        }),
      (error) => error instanceof AIError && error.code === AI_ERROR_CODES.UNAVAILABLE,
    );
  });

  test('monthWindow is a UTC calendar month', () => {
    const { start, end } = monthWindow(new Date('2026-09-15T10:00:00Z'));

    assert.equal(start.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(end.toISOString(), '2026-10-01T00:00:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE CODED REPLY — why it cannot go through the shared error pipeline
// ═══════════════════════════════════════════════════════════════════════════
describe('sendAIError — the ONE place a code-bearing AI reply is written', () => {
  test('it emits the stable code, the status and a generic sentence', () => {
    let captured = null;

    const res = {
      status(code) {
        this.code = code;

        return this;
      },
      json(body) {
        captured = { code: this.code, body };

        return this;
      },
    };

    sendAIError(res, AIError.quotaExceeded());

    assert.equal(captured.code, 429);
    assert.equal(captured.body.success, false);
    assert.equal(captured.body.code, AI_ERROR_CODES.QUOTA_EXCEEDED);
    assert.equal(captured.body.statusCode, 429);
    assert.ok(captured.body.message.length > 0);
  });

  test('an error with no known code still answers a generic 503', () => {
    let captured = null;

    const res = {
      status(code) {
        this.code = code;

        return this;
      },
      json(body) {
        captured = { code: this.code, body };

        return this;
      },
    };

    sendAIError(res, { statusCode: 502, code: 'SOMETHING_WE_MADE_UP' });

    // The upstream status is NOT passed through: an uncoded failure is a
    // generic 503, whatever the vendor said.
    assert.equal(captured.code, 503);
    assert.equal(captured.body.code, AI_ERROR_CODES.VENDOR_ERROR);
    assert.equal(captured.body.statusCode, 503);
  });

  test('the shared errorHandler really does drop a custom code (why this exists)', () => {
    // Pins the PITFALL, not a preference: utils/errorHandler emits no `code`
    // field, so an AIError routed through next() would lose QUOTA_EXCEEDED and
    // the frontend could not tell a quota refusal from a vendor outage.
    const source = read('src/middlewares/errorHandler.js');

    // The response literal must not carry a `code` key. (The string `err.code`
    // does appear — the 11000 duplicate branch reads it — so pinning the
    // absence of that substring would be pinning the wrong thing.)
    const responseLiteral = source.slice(
      source.indexOf('res.status(statusCode).json({'),
    );

    assert.ok(!/\bcode:/.test(responseLiteral), 'errorHandler must not emit a code field');
    assert.match(responseLiteral, /success:\s*false/);
    assert.match(responseLiteral, /message,/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. THE HTTP SURFACE — shape, identity, and what it refuses
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/ai/chat — the verification pipeline', () => {
  test('the route mounts protect + tenantContext and nothing weaker', () => {
    const source = read('src/routes/ai.js');

    assert.match(source, /router\.use\(protect,\s*tenantContext\)/);
    assert.match(source, /router\.route\('\/chat'\)\.post\(/);
  });

  test('the validator and route modules actually IMPORT (no broken relative path)', async () => {
    // A wrong relative import is invisible to every source-string pin: the
    // file reads correctly and the module simply cannot be loaded. This unit
    // shipped exactly that bug once - the validator pointed at
    // ../../../utils/ApiError.js - and it only surfaced as an async
    // ERR_MODULE_NOT_FOUND inside two OTHER suites that import the route
    // tree. So the real modules are imported here.
    const { aiChatValidator } = await import('../src/validators/ai/aiValidator.js');

    assert.ok(Array.isArray(aiChatValidator));
    assert.ok(aiChatValidator.length >= 4, 'the chain must end in validate');

    const aiRoutes = (await import('../src/routes/ai.js')).default;

    assert.equal(typeof aiRoutes, 'function');

    // The controller resolves too - it pulls in the provider and the errors.
    const controller = await import('../src/controllers/aiController.js');

    assert.equal(typeof controller.chat, 'function');
  });

  test('the router is mounted under /ai by routes/index.js', () => {
    const source = read('src/routes/index.js');

    assert.match(source, /router\.use\("\/ai",\s*aiRoutes\)/);
  });

  test('the controller takes identity from the session, never from the body', () => {
    const source = read('src/controllers/aiController.js');

    assert.match(source, /companyId:\s*req\.companyId/);
    assert.match(source, /userId:\s*req\.user\._id/);

    // It must never read a tenant or user out of the request body.
    assert.ok(!/req\.body\?*\.companyId/.test(source));
    assert.ok(!/req\.body\?*\.userId/.test(source));
  });

  test('the validator caps messages, roles and length, and refuses identity overrides', () => {
    const source = read('src/validators/ai/aiValidator.js');

    assert.match(source, /isArray\(\{\s*min:\s*1,\s*max:\s*AI_MESSAGE_MAX_COUNT\s*\}\)/);
    assert.match(source, /isIn\(AI_MESSAGE_ROLES\)/);
    assert.match(source, /isLength\(\{\s*min:\s*1,\s*max:\s*AI_MESSAGE_MAX_CHARS\s*\}\)/);

    for (const field of ['companyId', 'userId', 'feature']) {
      assert.ok(source.includes(`'${field}'`), `${field} must be refused from the client`);
    }

    // A chain that never calls validationResult collects errors and discards
    // them — the 29.11 audit found exactly that bug elsewhere.
    assert.match(source, /validationResult\(req\)/);
  });

  test('the bounds themselves are the documented ones', () => {
    assert.equal(AI_MESSAGE_MAX_COUNT, 10);
    assert.equal(AI_MESSAGE_MAX_CHARS, 2000);
    assert.deepEqual([...AI_MESSAGE_ROLES], ['system', 'user', 'assistant']);
  });

  test('the AI provider module never logs or returns the API key', () => {
    const source = read('src/services/ai/aiProvider.js');

    // The key reaches the SDK constructor and nowhere else.
    assert.match(source, /apiKey:\s*config\.apiKey/);

    const logCalls = source.match(/logger\.(info|warn|error|debug)\([^)]*\)/g) || [];

    for (const call of logCalls) {
      assert.ok(!call.includes('apiKey'), `a log call references the key: ${call}`);
    }
  });

  test('the provider imports the vendor SDK and the 32.4 limiter, nothing new', () => {
    const source = read('src/services/ai/aiProvider.js');

    assert.match(source, /from 'openai'/);
    assert.match(source, /createRateLimitStore/);

    // No second limiter implementation, no queue system, no framework.
    for (const forbidden of ['langchain', 'llamaindex', 'bullmq', 'new Queue']) {
      assert.ok(!source.toLowerCase().includes(forbidden), `unexpected ${forbidden}`);
    }
  });

  test('server.js calls initAIProvider inside its existing fail-fast path', () => {
    const source = read('src/server.js');

    assert.match(source, /initAIProvider\(\);/);
    // The existing catch logs and exits 1 — no new shutdown behaviour.
    assert.match(source, /Server startup failed/);
    assert.match(source, /process\.exit\(1\)/);
  });

  test('the AI keys are in .env.example and in config:check', () => {
    const example = read('.env.example');

    for (const name of [
      'AI_ENABLED',
      'AI_API_KEY',
      'AI_BASE_URL',
      'AI_MODEL',
      'AI_MAX_TOKENS',
      'AI_MONTHLY_QUOTA_TOKENS',
      'AI_PII_REDACTION',
    ]) {
      assert.ok(example.includes(name), `.env.example is missing ${name}`);
    }

    const check = read('scripts/config-check.js');

    for (const name of ['AI_ENABLED', 'AI_API_KEY', 'AI_PII_REDACTION']) {
      assert.ok(check.includes(name), `config:check does not report ${name}`);
    }

    // The key is reported as a secret, never as a value.
    assert.match(check, /state\('AI_API_KEY',\s*aiConfig\.apiKey,\s*\{\s*secret:\s*true\s*\}\)/);
  });

  test('the default model is the one the unit specifies', () => {
    assert.equal(
      getAIConfig({}).model,
      'openai/gpt-oss-120b',
    );
    // 36.3-fix: the previous default was decommissioned by Groq, which made
    // every call a generic 503. A dead vendor default is a product defect, so
    // it is pinned here rather than rediscovered at runtime.
    assert.equal(AI_DEFAULT_MODEL, 'openai/gpt-oss-120b');
  });
});
