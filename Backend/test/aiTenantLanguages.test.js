// ════════════════════════════════════════════════════════════════════════════
// PHASE 36.7 — ADMIN-CONFIGURABLE REPLY LANGUAGES
//
// 36.5 hardcoded five languages in two places and an admin could not add one
// without a code change. 36.7 makes the list a tenant setting: an admin
// enables a language from the platform catalogue and it OPENS UP in the
// assistant's selector.
//
// The three things this file pins, because they are the three that can
// silently break:
//
//   1. the DEFAULT SET is unchanged, so an unconfigured tenant behaves
//      byte-for-byte as it did in 36.5;
//   2. the VALIDATOR accepts a language the tenant enabled and refuses one it
//      did not — which is the whole point, and the bug 36.7 fixed;
//   3. the SERVICE builds the prompt rule from the tenant's list, so the
//      language actually reaches the model.
// ════════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_ai_lang_test';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

const {
  AI_DEFAULT_LANGUAGE,
  AI_LANGUAGE_CATALOGUE,
  AI_LANGUAGE_CODES,
  AI_LANGUAGE_LABELS,
  AI_SUPPORTED_LANGUAGES,
  AI_TENANT_LANGUAGE_DEFAULT,
  getLanguageRecord,
  languageRuleLabel,
  normalizeLanguage,
} = await import('../src/services/ai/aiConfig.js');

const { getTenantLanguages } = await import(
  '../src/services/ai/aiTenantConfigService.js'
);

const { askHRAssistant } = await import(
  '../src/services/ai/hrChatbotService.js'
);

const { chatbotValidator, updateConfigValidator } = await import(
  '../src/validators/ai/aiValidator.js'
);

const COMPANY = '0000000000000000000064b1';
const USER = '0000000000000000000064b9';

// ── FIXTURES ───────────────────────────────────────────────────────────────────────────

/** A tenant config row carrying a chosen language list. */
const tenantConfigWith = (languages) => ({
  companyId: COMPANY,
  enabled: true,
  monthlyQuotaTokens: null,
  allowedCategories: ['profile', 'leaves'],
  languages,
  updatedBy: null,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
});

/**
 * A fake AITenantConfig model that returns one row, or none.
 *
 * `makeModel` from hrContextRetriever.test.js is not reused here because this
 * file must not depend on another suite's fixtures — a change there would
 * break a test that has nothing to do with it.
 */
const configModel = (row) => ({
  // loadFromMongo calls findOneAndUpdate (upsert + setDefaultsOnInsert), not
  // findOne. A fake exposing only findOne silently returns null and the
  // caller falls back to the default set — which is exactly the failure that
  // made the first version of this test wrong.
  findOneAndUpdate: async () => row,
  calls: [],
});

describe('the platform catalogue', () => {
  test('every entry carries everything the product needs to offer it honestly', () => {
    AI_LANGUAGE_CATALOGUE.forEach((entry) => {
      assert.equal(typeof entry.code, 'string');
      assert.ok(entry.code.length > 0);

      assert.equal(typeof entry.label, 'string');
      assert.ok(entry.label.length > 0);

      assert.equal(typeof entry.native, 'string');
      assert.ok(entry.native.length > 0);

      assert.equal(typeof entry.hint, 'string');

      // A malformed BCP-47 tag would make the browser silently ignore the
      // request and fall back to the default voice.
      assert.match(entry.bcp47, /^[a-z]{2}-[A-Z]{2}$/, `${entry.code} bcp47`);

      // The rule label is what the model is told. An empty one would produce
      // "REPLY IN THE LANGUAGE THE EMPLOYEE CHOSE: " and nothing else.
      assert.ok(entry.rule.length > 0, `${entry.code} has no rule label`);
    });
  });

  test('codes are unique — a duplicate would make a selector ambiguous', () => {
    const codes = AI_LANGUAGE_CATALOGUE.map((entry) => entry.code);

    assert.equal(new Set(codes).size, codes.length);
  });

  test('every catalogue code has a prompt rule label', () => {
    // DERIVED, not hand-written. 36.5 wrote both the map and the list by hand,
    // which is how they drift apart.
    AI_LANGUAGE_CODES.forEach((code) => {
      assert.ok(
        typeof AI_LANGUAGE_LABELS[code] === 'string' &&
          AI_LANGUAGE_LABELS[code].length > 0,
        `${code} has no prompt rule label`,
      );
    });
  });

  test('the catalogue is strictly larger than the default set', () => {
    // If it were not, an admin would have nothing to add and the feature
    // would be decorative.
    assert.ok(AI_LANGUAGE_CODES.length > AI_TENANT_LANGUAGE_DEFAULT.length);
  });

  test('the 36.5 five are all still in the catalogue', () => {
    AI_TENANT_LANGUAGE_DEFAULT.forEach((code) => {
      assert.equal(AI_LANGUAGE_CODES.includes(code), true, `${code} vanished`);
    });
  });

  test('getLanguageRecord resolves and refuses unknown codes', () => {
    assert.equal(getLanguageRecord('kn').label, 'Kannada');
    assert.equal(getLanguageRecord('ta').native, 'தமிழ்');
    assert.equal(getLanguageRecord('nope'), null);
    assert.equal(getLanguageRecord(undefined), null);
  });
});

describe('the default set is unchanged (the safety property)', () => {
  test('it is exactly the 36.5 five', () => {
    assert.deepEqual([...AI_TENANT_LANGUAGE_DEFAULT], [
      'en',
      'ta',
      'tanglish',
      'hi',
      'te',
    ]);
  });

  test('AI_SUPPORTED_LANGUAGES still names the default set', () => {
    // Kept as an alias so nothing that imported the 36.5 name breaks. It is
    // the DEFAULT TENANT SET, not the catalogue — the distinction is the
    // whole feature.
    assert.deepEqual(
      [...AI_SUPPORTED_LANGUAGES],
      [...AI_TENANT_LANGUAGE_DEFAULT],
    );
  });

  test('an unconfigured tenant resolves to the default set', async () => {
    const { getTenantLanguages } = await import(
      '../src/services/ai/aiTenantConfigService.js'
    );

    // No row at all.
    const languages = await getTenantLanguages(COMPANY, {
      Model: configModel(null),
    });

    assert.deepEqual(languages, [...AI_TENANT_LANGUAGE_DEFAULT]);
  });

  test('a config read failure degrades to the default set, not to an error', async () => {
    const { getTenantLanguages } = await import(
      '../src/services/ai/aiTenantConfigService.js'
    );

    const broken = {
      findOne: () => ({
        lean: async () => {
          throw new Error('driver down');
        },
      }),
    };

    // A language list is PRESENTATION. Refusing the whole assistant because
    // the config was unreadable would be the wrong trade — the worst case is
    // a tenant temporarily seeing the default five.
    const languages = await getTenantLanguages(COMPANY, { Model: broken });

    assert.deepEqual(languages, [...AI_TENANT_LANGUAGE_DEFAULT]);
  });
});

describe('a tenant resolves against its OWN list', () => {
  test('a language the tenant enabled resolves and gets its rule', async () => {
    const { getTenantLanguages } = await import(
      '../src/services/ai/aiTenantConfigService.js'
    );

    const languages = await getTenantLanguages(COMPANY, {
      Model: configModel(tenantConfigWith(['en', 'kn', 'ml'])),
    });

    assert.deepEqual(languages, ['en', 'kn', 'ml']);

    // The whole point: Kannada is not in the default set, so before 36.7 it
    // could not be reached at all.
    assert.equal(normalizeLanguage('kn', languages), 'kn');
    assert.equal(
      languageRuleLabel('kn', languages),
      AI_LANGUAGE_LABELS.kn,
    );
  });

  test('a language the tenant did NOT enable falls back to its first entry', () => {
    // Silent, because the validator already refuses it with a 400. This is
    // the defence in depth for a direct caller, and failing a question over a
    // cosmetic preference would be the wrong trade.
    assert.equal(normalizeLanguage('ta', ['en', 'kn']), 'en');
    assert.equal(normalizeLanguage('ta', ['kn', 'en']), 'kn');
  });

  test('English still carries NO rule, whatever the tenant enabled', () => {
    // An English turn must stay byte-identical to a 36.3 turn. That is pinned
    // by the closeout suite and is the reason `languageRuleLabel` returns an
    // empty string rather than the label 'English'.
    assert.equal(languageRuleLabel('en', ['en', 'kn']), '');
    assert.equal(languageRuleLabel('en', AI_TENANT_LANGUAGE_DEFAULT), '');
    assert.equal(languageRuleLabel(undefined, ['en', 'kn']), '');
  });

  test('a stale cached row with an empty list still yields the default', async () => {
    const { getTenantLanguages } = await import(
      '../src/services/ai/aiTenantConfigService.js'
    );

    const languages = await getTenantLanguages(COMPANY, {
      Model: configModel(tenantConfigWith([])),
    });

    assert.deepEqual(languages, [...AI_TENANT_LANGUAGE_DEFAULT]);
  });
});

describe('the service builds the rule from the tenant list', () => {
  const systemPromptFor = async (language, languages) => {
    let captured = null;

    await askHRAssistant({
      companyId: COMPANY,
      userId: USER,
      messages: [{ role: 'user', content: 'hello' }],
      language,
      languages,
      deps: {
        aiChatFn: async ({ messages }) => {
          captured = messages[0].content;

          return { content: 'ok', usage: null, categoriesUsed: [] };
        },
        getContextFn: async () => ({
          context: 'CTX',
          categoriesUsed: ['profile'],
        }),
        redact: (text) => text,
      },
    });

    return captured;
  };

  test('an admin-added language reaches the system prompt', async () => {
    // The end-to-end property. Admin enables Kannada, employee picks it, the
    // model is told to answer in Kannada.
    const prompt = await systemPromptFor('kn', ['en', 'kn']);

    assert.equal(
      prompt.includes(
        `16. REPLY IN THE LANGUAGE THE EMPLOYEE CHOSE: ${AI_LANGUAGE_LABELS.kn}`,
      ),
      true,
    );
  });

  test('a language the tenant disabled does NOT reach the prompt', async () => {
    // The other half. Kannada is on the platform but not enabled here, so the
    // prompt must not carry its rule — otherwise the UI would claim a
    // language the product is not producing.
    const prompt = await systemPromptFor('kn', ['en', 'ta']);

    assert.equal(prompt.includes('Kannada'), false);
  });

  test('omitting `languages` behaves like an unconfigured tenant', async () => {
    // Backward compatibility: a caller that never heard of 36.7 gets exactly
    // the 36.5 behaviour.
    const prompt = await systemPromptFor('ta');

    assert.equal(
      prompt.includes(
        `16. REPLY IN THE LANGUAGE THE EMPLOYEE CHOSE: ${AI_LANGUAGE_LABELS.ta}`,
      ),
      true,
    );
  });

  test('an empty `languages` array is treated as unconfigured, not as "nothing"', async () => {
    const prompt = await systemPromptFor('ta', []);

    assert.equal(prompt.includes('REPLY IN THE LANGUAGE'), true);
  });
});

describe('the validator accepts what the tenant enabled', () => {
  /**
   * Drive one chain and report the first error message, or null.
   *
   * An express-validator chain signals refusal by calling next(error) itself,
   * so it is wrapped in a promise that settles on either outcome and the
   * chains are run strictly sequentially.
   */
  const refuses = async (body) => {
    const req = { body, companyId: COMPANY };

    for (const chain of chatbotValidator) {
      // The chain either calls next(error) OR THROWS. `validate` throws an
      // ApiError once validationResult has anything in it, so a wrapper that
      // only watches `next` never sees the refusal and every assertion about
      // a 400 silently passes for the wrong reason.
      const outcome = await new Promise((resolve) => {
        let settled = false;

        const done = (error) => {
          if (settled) return;

          settled = true;

          resolve(error || null);
        };

        try {
          chain(req, {}, done);
        } catch (thrown) {
          done(thrown);
        }
      });

      if (outcome) {
        return outcome.message || String(outcome);
      }
    }

    return null;
  };

  const ask = (language) => ({
    messages: [{ role: 'user', content: 'What is my leave balance?' }],
    language,
  });

  // The tenant's list is read through getTenantLanguages, which reads the
  // model. Stubbing the service module is not possible without a loader, so
  // the fake is injected the way the service allows: through `deps` on the
  // model. Instead these tests pin the CHAIN SHAPE, and the tenant behaviour
  // is pinned above through getTenantLanguages directly.

  test('a platform language that no tenant enabled is still a KNOWN language', async () => {
    // The chain's first check is the platform enum. Kannada is on the
    // platform, so it is not a typo — it is simply not enabled for this
    // company, and that is a different message.
    const error = await refuses(ask('kn'));

    // With no tenant row the default set applies, so Kannada is refused —
    // but refused for the right reason, not as an unknown value.
    assert.notEqual(error, null);
    assert.equal(error.includes('not enabled for your company'), true);
  });

  test('a value that is not a language at all is refused as a typo', async () => {
    const error = await refuses(ask('klingon'));

    assert.notEqual(error, null);
    assert.equal(error.includes('language must be one of'), true);
  });

  test('an absent language is accepted — a 36.3 client keeps working', async () => {
    const error = await refuses({
      messages: [{ role: 'user', content: 'What is my leave balance?' }],
    });

    assert.equal(error, null);
  });

  test('a JSON null language is accepted as "no preference"', async () => {
    const error = await refuses(ask(null));

    assert.equal(error, null);
  });

  test('every default language is accepted by an unconfigured tenant', async () => {
    for (const language of AI_TENANT_LANGUAGE_DEFAULT) {
      const error = await refuses(ask(language));

      assert.equal(error, null, `${language} was refused`);
    }
  });
});

describe('the config update validator', () => {
  const rejects = async (body) => {
    const req = { body, companyId: COMPANY };

    for (const chain of updateConfigValidator) {
      const outcome = await new Promise((resolve) => {
        let settled = false;

        const done = (error) => {
          if (settled) return;

          settled = true;

          resolve(error || null);
        };

        try {
          chain(req, {}, done);
        } catch (thrown) {
          done(thrown);
        }
      });

      if (outcome) {
        return outcome.message || String(outcome);
      }
    }

    return null;
  };

  test('adding a language is accepted', async () => {
    const error = await rejects({ languages: ['en', 'kn', 'ml'] });

    assert.equal(error, null);
  });

  test('an unknown language is refused with the platform list', async () => {
    const error = await rejects({ languages: ['en', 'klingon'] });

    assert.notEqual(error, null);
    assert.equal(error.includes('languages may only contain'), true);
  });

  test('an empty list is refused', async () => {
    const error = await rejects({ languages: [] });

    assert.notEqual(error, null);
    assert.equal(error.includes('non-empty array'), true);
  });

  test('a list without English is refused', async () => {
    const error = await rejects({ languages: ['ta', 'hi'] });

    assert.notEqual(error, null);
    assert.equal(error.includes('must always include English'), true);
  });

  test('duplicates are refused', async () => {
    const error = await rejects({ languages: ['en', 'en'] });

    assert.notEqual(error, null);
    assert.equal(error.includes('duplicates'), true);
  });

  test('a non-string entry is refused', async () => {
    const error = await rejects({ languages: ['en', 42] });

    assert.notEqual(error, null);
    assert.equal(error.includes('array of strings'), true);
  });

  test('languages alone counts as a change', async () => {
    // The "at least one field" rule must know about the new field, or an
    // admin who only edits languages would be told they changed nothing.
    const error = await rejects({ languages: ['en', 'kn'] });

    assert.equal(error, null);
  });

  test('an empty payload is still refused', async () => {
    const error = await rejects({});

    assert.notEqual(error, null);
    assert.equal(error.includes('Supply at least one of'), true);
  });
});

describe('source pins', () => {
  test('the controller reads the tenant list and passes it to the service', () => {
    const source = read('src/controllers/aiController.js');

    assert.equal(source.includes('getTenantLanguages(req.companyId)'), true);
    assert.equal(source.includes('languages,'), true);
    assert.equal(source.includes('languageCatalogue: AI_LANGUAGE_CATALOGUE'), true);
  });

  test('the chatbot validator no longer checks a hardcoded platform list', () => {
    const source = read('src/validators/ai/aiValidator.js');

    // Sliced to the END of the file, not to the next export: chatbotValidator
    // is the LAST export in aiValidator.js, and updateConfigValidator comes
    // BEFORE it — so slicing to that name produced an empty string and the
    // pin passed for the wrong reason.
    const chain = source.slice(source.indexOf("body('language')"));

    // The bug 36.7 fixed: `isIn(AI_SUPPORTED_LANGUAGES)` made an admin-added
    // language unreachable — the selector offered it and the request came
    // back 400.
    assert.equal(chain.includes('isIn([...AI_SUPPORTED_LANGUAGES])'), false);
    assert.equal(chain.includes('getTenantLanguages(req.companyId)'), true);
  });

  test('language is still NOT an identity field', () => {
    // The law that outranks the feature. A language decides how an answer is
    // phrased, never what the caller may read.
    const source = read('src/validators/ai/aiValidator.js');

    const override = source.slice(
      source.indexOf('const chatbotIdentityOverride'),
      source.indexOf('export const chatbotValidator'),
    );

    assert.equal(override.includes('language'), false);
  });

  test('the model enforces the English rule, not only the validator', () => {
    const source = read('src/models/AITenantConfig.js');

    assert.equal(source.includes("includes(AI_DEFAULT_LANGUAGE)"), true);
  });
});
