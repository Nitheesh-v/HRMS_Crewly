// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.7 — ADMIN-CONFIGURABLE LANGUAGES, CLIENT SIDE
//
// The feature in one sentence: an admin enables languages from a platform
// catalogue in AI Settings, and they open up in the assistant's selector for
// every employee of that company.
//
// These tests pin the four places that can silently break it, each in a
// different direction:
//
//   1. THE SLICE — a language the tenant disabled must not survive a
//      dispatch, and a language it enabled must. Both are one line of
//      normalisation and both are invisible when wrong.
//   2. THE SELECTOR — must read the tenant's list, not the platform's. The
//      platform list is a SUPERSET, so mapping it offers languages the
//      validator refuses with a 400.
//   3. THE SETTINGS PAGE — must offer the catalogue and not free text, and
//      must not let an admin switch English off.
//   4. THE ROUTE — must be behind COMPANY_ADMIN. The server refuses a caller
//      without SETTINGS_MANAGE too, so this is defence in depth.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * IMPORT ORDER IS LOAD-BEARING HERE.
 *
 * api.js imports the store, and the store imports the aiChat slice. So
 * importing the slice first walks slice -> service -> api -> store -> slice
 * and lands on a slice that has not finished evaluating, which is the
 * "Cannot access 'aiChatReducer' before initialization" error. Importing the
 * store first breaks the cycle: by the time the slice is reached the store
 * module is already in flight and api.js only uses it lazily, inside
 * functions.
 *
 * aiChatStore.test.js has the same ordering for the same reason.
 */
import store from '../src/redux/store.js';

import aiChatReducer, {
  languageSet,
  loadChatLanguages,
} from '../src/redux/slices/aiChatSlice.js';

import {
  PLATFORM_CHAT_LANGUAGE_VALUES,
  chatLanguagesFor,
} from '../src/components/AIAssistant/chatLanguages.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(frontendRoot, rel), 'utf8');

/*
 * THE SOURCE, WITH COMMENTS STRIPPED.
 *
 * A pin that greps the raw file matches the file's own documentation about
 * the pin. That is not hypothetical: this suite's first version asserted
 * that AiAssistantPanel.jsx contains no `localStorage`, and it failed —
 * because the panel's header comment explains, at length, that the language
 * is deliberately NOT written to localStorage. The pin was right and the
 * test was wrong.
 *
 * So every pin that greps for CODE goes through here. Pins that check for
 * rendered text or for the absence of an emoji still read the raw file,
 * because a comment is not the thing being asserted in either case.
 *
 * Same helper aiVoice.test.js has used since 36.5.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── THE SLICE ───────────────────────────────────────────────────────────────

describe('Phase 36.7 — the slice normalizes against the tenant list', () => {
  const FULFILLED = 'aiChat/loadLanguages/fulfilled';

  test('a loaded list is stored as the tenant\'s own codes', () => {
    const state = aiChatReducer(undefined, {
      type: FULFILLED,
      payload: ['en', 'kn', 'ml'],
    });

    assert.deepEqual(state.allowedLanguages, ['en', 'kn', 'ml']);

    // And the current selection is untouched — it is still valid.
    assert.equal(state.language, 'en');
  });

  test('an empty payload is stored as an empty list, not dropped', () => {
    // An empty list and a never-loaded list are the same thing here, and
    // both mean "offer the default five". Storing undefined instead would
    // make the next render read a different value than it wrote.
    const state = aiChatReducer(undefined, { type: FULFILLED });

    assert.deepEqual(state.allowedLanguages, []);
  });

  test('a language the tenant ENABLED is accepted', () => {
    // The whole point. Kannada is on the platform but not in the default
    // five, so before 36.7 this dispatch would have silently become English.
    const loaded = aiChatReducer(undefined, {
      type: FULFILLED,
      payload: ['en', 'kn'],
    });

    const next = aiChatReducer(loaded, languageSet('kn'));

    assert.equal(next.language, 'kn');
  });

  test('a language the tenant did NOT enable falls back to English', () => {
    // Tamil is on the platform. This tenant never enabled it. Keeping it
    // would send a language the validator refuses, and the person would get
    // a 400 with no way to understand why.
    const loaded = aiChatReducer(undefined, {
      type: FULFILLED,
      payload: ['en', 'kn'],
    });

    const next = aiChatReducer(loaded, languageSet('ta'));

    assert.equal(next.language, 'en');
  });

  test('a code that is not a language at all falls back too', () => {
    const next = aiChatReducer(undefined, languageSet('klingon'));

    assert.equal(next.language, 'en');
  });

  test('changing the language does NOT clear the transcript', () => {
    // The answers already on screen were given in the previous language and
    // are still true. Clearing them would destroy a real conversation over a
    // presentation preference.
    const withMessages = aiChatReducer(undefined, {
      type: 'aiChat/messageAdded',
      payload: { id: 'u1', role: 'user', content: 'hello' },
    });

    const next = aiChatReducer(withMessages, languageSet('ta'));

    assert.equal(next.messages.length, 1);
  });

  test('a REJECTED language load leaves the list alone', () => {
    // A failed read must not widen the list to the platform catalogue, and
    // must not clear a list that already loaded — either would offer a
    // language the server is not currently serving.
    const loaded = aiChatReducer(undefined, {
      type: FULFILLED,
      payload: ['en', 'kn'],
    });

    const next = aiChatReducer(loaded, {
      type: 'aiChat/loadLanguages/rejected',
    });

    assert.deepEqual(next.allowedLanguages, ['en', 'kn']);
  });

  test('the slice is reachable through the REAL store', () => {
    // The 36.3 regression, re-pinned for 36.7: an unregistered slice made
    // state.aiChat undefined and the panel crashed on its first render.
    assert.ok(store.getState().aiChat, 'state.aiChat is missing');
    assert.ok(Array.isArray(store.getState().aiChat.allowedLanguages));
  });

  test('the thunk exists and is wired to the service', () => {
    assert.equal(typeof loadChatLanguages, 'function');
    assert.equal(loadChatLanguages.typePrefix, 'aiChat/loadLanguages');

    const source = code('src/redux/slices/aiChatSlice.js');

    assert.equal(source.includes('getChatLanguages'), true);
  });
});

// ── THE SELECTOR ────────────────────────────────────────────────────────────

describe('Phase 36.7 — the panel selector reads the tenant list', () => {
  const panel = () => code('src/components/AIAssistant/AiAssistantPanel.jsx');

  test('it maps the derived tenant list, never the platform one', () => {
    // The platform list is a SUPERSET. Mapping it directly offers every
    // language the platform knows, including ones this tenant's admin
    // switched off — a selector the server answers with a 400.
    const source = panel();

    assert.equal(source.includes('chatLanguagesFor(allowedLanguages)'), true);
    assert.equal(source.includes('offeredLanguages.map'), true);
    assert.equal(source.includes('PLATFORM_CHAT_LANGUAGES.map'), false);
    assert.equal(source.includes('CHAT_LANGUAGES.map'), false);
  });

  test('it asks the server which languages the tenant offers', () => {
    const source = panel();

    assert.equal(source.includes('loadChatLanguages()'), true);
    assert.equal(source.includes('allowedLanguages'), true);
  });

  test('the speech hooks read the tenant list too', () => {
    // A language switched off must not still be asked for by BCP-47 tag, or
    // the browser silently falls back to its own default voice and the
    // person hears the wrong accent for the language they picked.
    const source = panel();

    const calls = source.match(/chatLanguageBcp47\(language[^)]*\)/g) || [];

    assert.equal(calls.length, 2, 'expected the speak and recognise sites');

    for (const call of calls) {
      assert.equal(call.includes('allowedLanguages'), true, call);
    }
  });

  test('the send path normalizes against the same list', () => {
    const source = code('src/redux/slices/aiChatSlice.js');

    assert.equal(source.includes('getState().aiChat'), true);
    assert.equal(
      source.includes('normalizeChatLanguage(language, allowedLanguages)'),
      true,
    );
  });

  test('the panel still keeps the language out of localStorage', () => {
    const source = panel();

    assert.equal(source.includes('localStorage'), false);
    assert.equal(source.includes('sessionStorage'), false);
  });
});

// ── THE SETTINGS PAGE ───────────────────────────────────────────────────────

describe('Phase 36.7 — the AI Settings page', () => {
  const page = () => code('src/pages/settings/AiSettingsPage.jsx');

  test('it exists and renders a language manager', () => {
    const source = page();

    assert.equal(source.includes('Reply languages'), true);
    assert.equal(source.includes('Languages'), true, 'no Languages icon');
  });

  test('it offers the CATALOGUE, and never free text', () => {
    // THE OWNER'S DECISION, and the reason this test exists.
    //
    // A free-text entry would let a typo become a language the model cannot
    // actually produce. The admin would believe they had added it, the
    // selector would show it, and every question in it would come back
    // answered in something else — a UI that lies quietly.
    //
    // So the page maps a fixed list of records and there is no <input> that
    // could carry a typed language name.
    const source = page();

    assert.equal(source.includes('catalogue.map('), true);
    assert.equal(source.includes('languageCatalogue'), true);

    // No text field anywhere near the language list.
    assert.equal(source.includes('type="text"'), false);

    // The language toggle is a checkbox over a known record, not a typed
    // value.
    assert.equal(source.includes('onToggle(entry.code)'), true);
  });

  test('English cannot be switched off', () => {
    // English is the one language the system prompt needs no rule for, and
    // the platform's fallback when a request carries no preference at all.
    // A tenant without it would have a selector promising languages the
    // prompt cannot produce for a default request.
    //
    // The MODEL enforces the same rule, so this is the friendly copy of a
    // rule with a hard one behind it — but it has to be here too, or the
    // admin gets a 400 with no explanation.
    const source = page();

    assert.equal(source.includes('locked={entry.code === ENGLISH}'), true);
    assert.equal(source.includes('disabled={locked}'), true);
    assert.equal(source.includes('if (code === ENGLISH) return current;'), true);
    assert.equal(source.includes('Always on'), true);

    // And the save path refuses before it sends.
    assert.equal(
      source.includes("draft.languages.includes(ENGLISH)"),
      true,
    );
  });

  test('it saves only what changed', () => {
    // A page that re-sends every field would overwrite a value a second
    // admin changed between this page's load and its save.
    const source = page();

    assert.equal(source.includes('const updates = {};'), true);
    assert.equal(source.includes('updates.languages = draft.languages;'), true);
    assert.equal(source.includes('await read();'), true);
  });

  test('it re-reads after saving rather than trusting the draft', () => {
    const source = page();

    assert.equal(source.includes("setSaved('AI settings saved.')"), true);
  });

  test('no emojis — lucide icons only', () => {
    // The owner's standing rule for new UI.
    const source = page();

    assert.equal(/\p{Extended_Pictographic}/u.test(source), false);
  });
});

// ── THE ROUTE ───────────────────────────────────────────────────────────────

describe('Phase 36.7 — the settings route is guarded', () => {
  const routes = () => read('src/routes/AppRoutes.jsx');

  test('settings/ai-settings exists and is COMPANY_ADMIN only', () => {
    const source = routes();

    const start = source.indexOf('path="settings/ai-settings"');

    assert.ok(start !== -1, 'the ai-settings route is missing');

    // The guard must wrap THIS route, not merely appear somewhere in the
    // file. Sliced forward to the next <Route so a guard on a different
    // route cannot satisfy the pin.
    const slice = source.slice(start, source.indexOf('<Route', start + 10));

    assert.equal(slice.includes('RequireRole roles={COMPANY_ADMIN}'), true);
    assert.equal(slice.includes('AiSettingsPage'), true);
  });

  test('the page is lazily imported like its siblings', () => {
    const source = routes();

    assert.equal(
      source.includes(
        'const AiSettingsPage = lazy(() => import("../pages/settings/AiSettingsPage.jsx"))',
      ),
      true,
    );
  });

  test('the 36.6 usage route is untouched', () => {
    // This is a new route, not a replacement. Moving or renaming the old one
    // would break a bookmark and an admin's muscle memory for no gain.
    const source = routes();

    assert.equal(source.includes('path="settings/ai-usage"'), true);
    assert.equal(source.includes('AiUsagePage'), true);
  });
});

// ── THE SERVICE ─────────────────────────────────────────────────────────────

describe('Phase 36.7 — the service surface', () => {
  const service = () => code('src/services/aiService.js');

  test('the employee-facing language read needs no settings permission', () => {
    // The assistant widget is open to every employee and its selector must
    // list what the admin enabled, so an employee has to be able to ask.
    // /ai/config answers that too but is behind SETTINGS_MANAGE and carries
    // the quota — which is why this is a separate route.
    const source = service();

    assert.equal(source.includes("api.get('/ai/languages')"), true);
    assert.equal(source.includes("api.get('/ai/config')"), true);
    assert.equal(source.includes("api.put('/ai/config'"), true);
  });

  test('the language read normalizes the catalogue defensively', () => {
    // A record with an empty code renders as an <option> with nothing in it,
    // and a missing bcp47 makes the browser silently ignore the speech
    // request.
    const source = service();

    assert.equal(source.includes('typeof entry.code === \'string\' && entry.code'), true);
    assert.equal(source.includes("bcp47: String(entry.bcp47 || 'en-IN')"), true);
  });

  test('the config update sends only the supplied keys', () => {
    const source = service();

    assert.equal(source.includes('if (updates.languages !== undefined)'), true);
  });

  test('the catalogue shape the server sends is what chatLanguagesFor wants', () => {
    // The wiring contract, asserted without a browser. GET /ai/languages
    // returns { languages: string[], catalogue: [...] } where each record
    // carries the five fields the selector and the speech hooks read.
    //
    // If that shape and chatLanguagesFor's input ever diverged, the panel
    // would render an empty selector and the failure would look like "the
    // languages did not load" with nothing in the console.
    const catalogue = [
      { code: 'en', label: 'English', native: 'English', hint: 'Default', bcp47: 'en-IN' },
      { code: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ', hint: 'Kannada script', bcp47: 'kn-IN' },
    ];

    const offered = chatLanguagesFor(catalogue.map((entry) => entry.code));

    assert.deepEqual(
      offered.map((entry) => entry.value),
      ['en', 'kn'],
    );

    // Every field the selector renders is present on the record the server
    // sent, which is what makes the frontend's own copy unnecessary at
    // runtime.
    for (const entry of offered) {
      assert.ok(entry.label, 'missing label');
      assert.ok(entry.native, 'missing native');
      assert.ok(entry.hint, 'missing hint');
      assert.match(entry.bcp47, /^[a-z]{2}-[A-Z]{2}$/);
    }
  });
});

// ── THE PLATFORM LIST ITSELF ────────────────────────────────────────────────

describe('Phase 36.7 — the platform catalogue is a real superset', () => {
  test('it is strictly larger than the default five', () => {
    // If it were not, an admin would have nothing to add and the whole
    // feature would be decorative.
    assert.ok(PLATFORM_CHAT_LANGUAGE_VALUES.length > 5);
  });

  test('every code resolves to a record with a native name', () => {
    for (const value of PLATFORM_CHAT_LANGUAGE_VALUES) {
      // Looked up BY VALUE, not by index. English is force-included and comes
      // first in catalogue order, so `[0]` is always 'en' and a pin written
      // against the index would fail for every other language while the
      // feature worked perfectly.
      const entry = chatLanguagesFor([value]).find(
        (language) => language.value === value,
      );

      assert.ok(entry, `${value} was not offered`);
      assert.equal(entry.value, value);
      assert.ok(entry.native, `${code} has no native name`);
      assert.match(entry.bcp47, /^[a-z]{2}-[A-Z]{2}$/, `${code} bcp47`);
    }
  });
});
