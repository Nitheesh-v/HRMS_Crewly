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

    // The toggle is a checkbox over a KNOWN record. `name={entry.code}`
    // passes the catalogue's own code, never anything typed.
    assert.equal(source.includes('name={entry.code}'), true);
    assert.equal(source.includes('onToggle={toggleLanguage}'), true);
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

  test('the save payload is keyed to the field that changed, not to "dirty"', () => {
    // THE 36.7 BUG THIS PINS. The line used to be
    // `if (dirty) updates.languages = draft.languages`, which fired whenever
    // ANYTHING was dirty — so toggling the kill switch re-sent the whole
    // language list as well. Harmless in effect, but it meant the payload
    // did not describe the edit.
    const source = page();

    assert.equal(source.includes('if (dirty) updates.languages'), false);

    // And the categories are actually sent. They never were, which is why
    // the section below was read-only — the plumbing was missing.
    assert.equal(
      source.includes('updates.allowedCategories = draft.allowedCategories;'),
      true,
    );
    assert.equal(source.includes('dirtyFields.includes('), true);
  });

  test('the context categories are EDITABLE, not displayed as pills', () => {
    // The reported defect. The section rendered the tenant's categories as
    // read-only pills, which on a page called "Settings" reads as a broken
    // control rather than one that was never wired.
    const source = page();

    assert.equal(source.includes('toggleCategory'), true);
    assert.equal(source.includes('onToggle={toggleCategory}'), true);
    assert.equal(source.includes('categoryCodes.map('), true);

    // And the labels come from a table, not from the raw codes. A settings
    // page that shows `attendance-month` to an admin is a page only a
    // developer can use.
    assert.equal(source.includes('CATEGORY_LABELS'), true);
    assert.equal(source.includes('categoryLabel(code)'), true);
  });

  test('every category description is checkable against the retriever', () => {
    /*
     * The claims this page makes are load-bearing.
     *
     * An admin decides what the assistant may read based on the one-line
     * description under each checkbox. If the page says "month and status
     * only" and the retriever starts emitting figures, the admin has been
     * lied to about the single thing they were deciding. So each promise is
     * pinned to the code that has to keep it.
     */
    const retriever = code('../Backend/src/services/ai/hrContextRetriever.js');

    // "Month and status only — never a salary figure".
    assert.equal(
      retriever.includes('lines.push(`- ${label}: ${status}`)'),
      true,
      'renderPayslips no longer emits month+status only',
    );

    // "Their own document titles — never the files themselves".
    //
    // Pinned to the SELECT, not to the absence of the word `fileUrl`: the
    // retriever mentions fileUrl in a comment explaining that it is never
    // selected, and a ban on the token would fail on that comment while the
    // query was still correct.
    assert.equal(
      retriever.includes(".select('name category createdAt')"),
      true,
      'the documents query selects more than name, category and createdAt',
    );

    // And the payslip query is narrowed so snapshot.salary.* is never read.
    assert.equal(
      retriever.includes('snapshot.payroll.month'),
      true,
      'the payslip query no longer narrows to month+status fields',
    );
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

// ════════════════════════════════════════════════════════════════════════════════════════
// THE SAVE PROBLEM
//
// The owner's screenshot showed the AI Settings page scrolled into the
// language list with NO save button anywhere on screen. Both buttons lived in
// the page header, which scrolls away, and the language card alone is seven
// rows tall.
//
// These tests pin the fix, because the failure is invisible in a code review
// that only looks at the render tree: the buttons are all still there, they
// are just somewhere the person cannot reach.
// ═════════════════════════════════════════════════════════════════════════════════════════
describe('Phase 36.7 — the save action stays reachable', () => {
  const page = () => code('src/pages/settings/AiSettingsPage.jsx');

  const service = () => code('src/services/aiService.js');

  test('a save control is STICKY, not only in the page header', () => {
    const source = page();

    assert.equal(source.includes('sticky bottom-4'), true);

    // It must be a bar that renders its own Save button. A sticky container
    // holding only a label would be a status light, not a fix.
    assert.equal(source.includes('Save changes'), true);
  });

  test('the sticky bar only appears when there is something to save', () => {
    // A permanent bar is furniture. One that appears when there is work to
    // keep is a signal, and it does not sit over the settings the rest of the
    // time.
    const source = page();

    assert.equal(source.includes('{dirty && ('), true);
  });

  test('the sticky bar shows HOW MANY things are unsaved', () => {
    // Without a count the admin ticks four boxes, scrolls up, and has to
    // remember whether the bar was there before they started.
    const source = page();

    assert.equal(source.includes('dirtyCount'), true);
    assert.equal(source.includes('unsaved'), true);
    assert.equal(source.includes('dirtyFields'), true);
  });

  test('the sticky bar offers Discard as well as Save', () => {
    // "Discard" is the honest label for reloading the saved state. Calling it
    // "Cancel" would imply the edit is still pending somewhere.
    const source = page();

    assert.equal(source.includes('Discard'), true);
    assert.equal(source.includes('onClick={load}'), true);
  });

  test('the bar is at the BOTTOM, which is why it does not fight the shell', () => {
    // The app shell has `sticky top-0 z-30`. A second top bar would have to
    // be offset past a height that changes per breakpoint, and would slide
    // underneath the shell whenever the guess was wrong.
    const source = page();

    assert.equal(source.includes('sticky bottom-4 z-20'), true);
    assert.equal(source.includes('sticky top-0'), false);
  });

  test('unsaved work is guarded on refresh and tab close', () => {
    // The three ways a person actually loses work: refresh, close the tab,
    // type a new URL. All three are browser events, so the native handler is
    // the whole answer and needs no package.
    const source = page();

    assert.equal(source.includes("addEventListener('beforeunload', warn)"), true);
    assert.equal(source.includes("removeEventListener('beforeunload', warn)"), true);
    assert.equal(source.includes('event.returnValue'), true);

    // And it is registered ONLY while dirty. A permanent handler prompts on
    // every navigation, including after a successful save.
    assert.equal(source.includes('if (!dirty) return undefined;'), true);
  });

  test('the guard uses the browser event, not the hook that would not work', () => {
    // React Router's useBlocker WOULD cover sidebar navigation, but it only
    // functions with a data router (createBrowserRouter + RouterProvider) and
    // this app uses <BrowserRouter>, where it silently does nothing. So the
    // page uses the native event and does not pretend otherwise.
    //
    // Pinned against the CODE rather than the comment, because this helper
    // strips comments — a pin on prose that has been stripped away is not a
    // pin at all.
    const source = page();

    assert.equal(source.includes("addEventListener('beforeunload', warn)"), true);

    // And the hook is genuinely NOT imported, which is what proves the
    // decision was made rather than forgotten.
    assert.equal(source.includes('useBlocker'), false);
    assert.equal(/from 'react-router-dom'/.test(source), false);
  });

  test('the service sends the categories the admin ticked', () => {
    const source = service();

    assert.equal(source.includes('payload.allowedCategories = updates.allowedCategories'), true);
  });

  test('the backend offers the platform category codes to the page', () => {
    // Without the FULL set the section could only display what is already
    // on, which is the read-only dead end this replaced.
    const controller = code('../Backend/src/controllers/aiController.js');

    assert.equal(controller.includes('categoryCatalogue: AI_CONTEXT_CATEGORIES'), true);

    const backend = code('../Backend/src/services/ai/aiConfig.js');

    assert.equal(backend.includes("'attendance-month'"), true);
    assert.equal(backend.includes("'org-aggregates'"), true);
  });
});

// ── THE SAVE FIX ────────────────────────────────────────────────────────────
//
// The owner ran this page on localhost and reported "save not working", with a
// screenshot. Three separate things were wrong, and all three were mine:
//
//   1. THE FLOATING AI WIDGET COVERED THE SAVE BUTTON. The widget is
//      `fixed bottom-5 right-5 z-40`, 56px across. The sticky bar was z-20 —
//      BELOW it — so a click on Save opened the assistant instead.
//   2. THE PAGE OFFERED A STATE THE SERVER REFUSES. "Clear all" built
//      `allowedCategories: []`, which updateConfigValidator rejects with
//      "allowedCategories must be a non-empty array".
//   3. A FAILED SAVE SAID NOTHING WHERE THE BUTTON IS. The error banner sits
//      at the top of a long page; anyone scrolled into the language list —
//      which is everyone using this page — could not see it.
//
// Each of the three is pinned below, against the CODE, so a regression in any
// one of them fails here rather than in front of the owner again.

describe('Phase 36.7 — the save fix the owner asked for', () => {
  const page = () => code('src/pages/settings/AiSettingsPage.jsx');

  const widget = () => code('src/components/AIAssistant/AiAssistantWidget.jsx');

  test('the sticky bar steps AROUND the floating widget instead of under it', () => {
    // The widget is mounted by the app shell, so it is on every screen and it
    // is not this page's to hide or out-rank. The bar reserves room for it.
    const source = page();

    assert.equal(source.includes('sticky bottom-4 z-20 mt-4 pr-[76px]'), true);
  });

  test('the reserved space is the widget, measured', () => {
    // 76px is not a magic number: a 56px button (h-14 w-14) plus the 20px
    // offset from `bottom-5 right-5`. If the widget is ever resized this test
    // is the reminder that the bar has to move with it.
    const source = widget();

    assert.equal(source.includes('fixed bottom-5 right-5 z-40'), true);
    assert.equal(source.includes('h-14 w-14'), true);
  });

  test('the bar stays BELOW the widget on purpose', () => {
    // Raising the bar above z-40 would bury a global affordance that is
    // supposed to be reachable from every screen in the product. Stepping
    // around it is the only fix that does not cost something else.
    const source = page();

    assert.equal(/sticky bottom-4[^"]*z-(40|50)/.test(source), false);
    assert.equal(source.includes('sticky bottom-4 z-20 mt-4 pr-[76px]'), true);
  });

  test('there is NO control that empties the context categories', () => {
    // The old "Clear all" produced `allowedCategories: []`, which the server
    // refuses. A button whose result can never be saved is worse than no
    // button: it looks like the feature and then does nothing.
    //
    // Pinned through code(), which strips comments, so the explanation of why
    // the button is gone does not satisfy this assertion.
    const source = page();

    assert.equal(source.includes('Clear all'), false);

    // The precise shape of the old control: a setDraft updater that empties
    // the list. An empty DEFAULT is fine — the draft starts empty and is
    // overwritten by the server's config on load. An empty RESULT of a click
    // is what the server refuses, so that is the shape being banned.
    assert.equal(source.includes('...current, allowedCategories: []'), false);
  });

  test('a save with zero categories is stopped in the page, before any request', () => {
    // The server still refuses it — that is the real rule. This guard exists
    // so the admin is told in words they can act on, at the bottom of the
    // page where they are standing, instead of a 400 they never see.
    const source = page();

    assert.equal(source.includes('draft.allowedCategories.length === 0'), true);
    assert.equal(
      source.includes('At least one context category must stay enabled.'),
      true,
    );

    // And it names the honest alternative, which already exists on the page.
    assert.equal(source.includes('Switch the assistant off instead'), true);
  });

  test('a failed save reports itself INSIDE the sticky bar', () => {
    // The outcome has to appear where the action is. A banner at the top of a
    // long page is invisible to the person who just clicked Save at the
    // bottom, and a silent failure reads as a dead button.
    const source = page();

    const bar = source.indexOf('pr-[76px]');
    const alert = source.indexOf('role="alert"');

    assert.notEqual(bar, -1);
    assert.notEqual(alert, -1);

    // The alert is INSIDE the bar, not merely somewhere later in the file.
    assert.equal(alert > bar, true);
  });

  test('the page-level banner is kept as well, not replaced', () => {
    // Defence in depth: the in-bar message is for someone already scrolled
    // down, the page-level one is for someone who has not moved yet.
    const source = page();

    assert.equal(source.includes('Something went wrong'), true);
    assert.equal(source.includes('role="alert"'), true);
  });
});

// ── THE UNSAVABLE STATE, REMOVED AT THE SOURCE ──────────────────────────────
//
// The 36.7 follow-up made the context categories editable. It also left a
// warning on the page telling an admin that switching every category off was
// "ALLOWED" — which it is not. Both `updateConfigValidator` and the model's
// path validator refuse an empty `allowedCategories`, so an admin who followed
// that copy unticked thirteen boxes, clicked Save, and got nothing.
//
// That is the same shape of bug as the "Clear all" button, and it is fixed the
// same way: the page no longer offers the state at all. The last category left
// is locked, and the guard inside `save` is the backstop behind it.

describe('Phase 36.7 — the page never offers a state the server refuses', () => {
  const page = () => code('src/pages/settings/AiSettingsPage.jsx');

  test('the last remaining category is LOCKED, not merely warned about', () => {
    // Locking is the fix. A warning is not: it still lets the admin build a
    // payload that comes back a 400 and then reports nothing where they are
    // standing.
    const source = page();

    assert.equal(source.includes('locked={lastOne}'), true);
    assert.equal(source.includes("note={lastOne ? 'Keep at least one' : ''}"), true);
  });

  test('toggleCategory refuses to remove the last category in the reducer too', () => {
    // The UI lock is the fix; this is the backstop. A stale render, a keyboard
    // shortcut or a future refactor must not be able to build the state either.
    const source = page();

    assert.equal(source.includes('current.allowedCategories.length === 1'), true);
    assert.equal(source.includes('return current;'), true);
  });

  test('no copy on the page claims an empty category list is savable', () => {
    // The removed warning said switching everything off was "ALLOWED" and
    // described what the assistant would do. It was false, and it was the
    // instruction that led an admin into a refused save.
    const source = read('src/pages/settings/AiSettingsPage.jsx');

    assert.equal(source.includes('Switching everything off'), false);
    assert.equal(source.includes('With every category off'), false);
  });

  test('the honest alternative — the kill switch — is still on the page', () => {
    // Removing the trap is only half of it. The admin who wants "no HR data"
    // needs somewhere to go, and that is the enable switch in the first
    // section, which the server accepts.
    const source = page();

    assert.equal(source.includes('Assistant enabled'), true);
    assert.equal(source.includes('checked={draft.enabled}'), true);

    // And it is a real dirty field, so toggling it is a save the server takes.
    assert.equal(source.includes("'the assistant switch'"), true);
  });
});

// ── THE BUG THAT MADE SAVE IMPOSSIBLE ───────────────────────────────────────
//
// The owner's exact words: "save button click panna mudila, disabled la iruku"
// — the Save button is disabled and cannot be clicked.
//
// They were right, and the cause is one line. `loading` starts as `true`.
// `read()` never touches it; only `load()` clears it. The mount effect called
// `read()`, so the flag stayed true forever — and every control on the page is
// gated on it:
//
//   Save changes    disabled={saving || loading}
//   Discard         disabled={loading}
//   Enable all      disabled={loading}
//
// The page rendered perfectly. The config loaded, the checkboxes worked, the
// dirty bar counted correctly. Every button was dead. A page that looks alive
// with nothing clickable is the worst failure mode there is, and it is
// invisible to any test that only checks what is rendered.

describe('Phase 36.7 — the mount effect clears the loading flag', () => {
  const page = () => code('src/pages/settings/AiSettingsPage.jsx');

  test('the mount effect goes through load(), not read()', () => {
    // THE regression. `loading` starts true and only `load()` clears it, so an
    // effect that calls `read()` leaves every button on the page disabled.
    const source = page();

    assert.equal(/useEffect\(\(\) => \{\s*load\(\);/.test(source), true);
    assert.equal(/useEffect\(\(\) => \{\s*read\(\);/.test(source), false);
  });

  test('load() is the wrapper that actually clears the flag', () => {
    // Pinning the contract rather than the call site: whatever the effect
    // ends up calling has to be something that resets `loading`.
    const source = page();

    assert.equal(source.includes('setLoading(true)'), true);
    assert.equal(source.includes('setLoading(false)'), true);
  });

  test('read() does not silently swallow the flag either', () => {
    // `read()` is also called from `save()`, after the PUT. If it started
    // owning `loading` again the two would fight over the same flag, so the
    // split is pinned: read fetches, load gates.
    const source = page();

    const readBody = source.slice(
      source.indexOf('const read = useCallback'),
      source.indexOf('const load = useCallback'),
    );

    assert.equal(readBody.includes('setLoading'), false);
  });

  test('every button on the page is gated on the flag, so it must clear', () => {
    // This is why the one-line bug was fatal rather than cosmetic: the count
    // of gates is the blast radius.
    const source = page();

    const gates = source.match(/disabled=\{[^}]*loading[^}]*\}/g) || [];

    assert.ok(
      gates.length >= 4,
      `expected the page to gate several controls on loading, found ${gates.length}`,
    );
  });
});
