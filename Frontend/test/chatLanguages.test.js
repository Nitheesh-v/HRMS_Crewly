// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.5 — THE LANGUAGE LIST (hermetic)
//
// Plain Node, no browser, no DOM. chatLanguages.js is deliberately a `.js`
// data module rather than inline JSX so it can be asserted here — the same
// reason chatPrompts.js is a sibling module.
//
// THE TEST THAT MATTERS MOST is the last one: it reads the BACKEND config and
// proves the two lists agree. Without it, someone could add a language to the
// selector that the validator refuses with a 400, and the failure would only
// show up as a broken dropdown in the owner's hands.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_LANGUAGES,
  CHAT_LANGUAGE_VALUES,
  DEFAULT_CHAT_LANGUAGE,
  PLATFORM_CHAT_LANGUAGES,
  PLATFORM_CHAT_LANGUAGE_VALUES,
  chatLanguageBcp47,
  chatLanguageHint,
  chatLanguageLabel,
  chatLanguageNative,
  chatLanguagesFor,
  getChatLanguage,
  normalizeChatLanguage,
} from '../src/components/AIAssistant/chatLanguages.js';


describe('Phase 36.5 chat languages', () => {
  test('exactly the five closed languages are offered', () => {
    // A closed set on purpose. An open string would let the client ask for a
    // language the prompt has no instruction for, and the model would answer
    // in English anyway while the UI claimed otherwise.
    assert.deepEqual([...CHAT_LANGUAGE_VALUES], [
      'en',
      'ta',
      'tanglish',
      'hi',
      'te',
    ]);
  });

  test('English is the default and the base case', () => {
    assert.equal(DEFAULT_CHAT_LANGUAGE, 'en');
    assert.equal(CHAT_LANGUAGES[0].value, 'en');
  });

  test('every language carries a label, a native name and a BCP-47 tag', () => {
    for (const language of CHAT_LANGUAGES) {
      assert.equal(typeof language.label, 'string', `${language.value} label`);
      assert.ok(language.label.length > 0, `${language.value} label empty`);

      assert.equal(
        typeof language.native,
        'string',
        `${language.value} native`,
      );
      assert.ok(language.native.length > 0, `${language.value} native empty`);

      // A malformed tag would make the browser silently fall back to its own
      // locale, so the shape is asserted rather than trusted.
      assert.match(language.bcp47, /^[a-z]{2}-[A-Z]{2}$/, language.value);
    }
  });

  test('the BCP-47 tags are the ones the spec names', () => {
    assert.equal(chatLanguageBcp47('en'), 'en-IN');
    assert.equal(chatLanguageBcp47('ta'), 'ta-IN');
    assert.equal(chatLanguageBcp47('hi'), 'hi-IN');
    assert.equal(chatLanguageBcp47('te'), 'te-IN');
  });

  test('Tanglish maps to en-IN because it is written in Latin letters', () => {
    // Asking a recogniser for Tamil script would mis-hear Tamil typed in
    // English letters. This is the one non-obvious mapping in the table.
    assert.equal(chatLanguageBcp47('tanglish'), 'en-IN');
  });

  test('an unknown language normalizes to English silently', () => {
    // No throw, no error. A stale Redux value must not break the chat.
    for (const bad of ['fr', 'Tamil', '', null, undefined, 42, {}, []]) {
      assert.equal(normalizeChatLanguage(bad), 'en', String(bad));
    }
  });

  test('a supported language is returned unchanged', () => {
    for (const value of CHAT_LANGUAGE_VALUES) {
      assert.equal(normalizeChatLanguage(value), value);
    }
  });

  test('the lookups never throw on bad input', () => {
    // These run on every render, so a throw here would be a blank panel.
    assert.equal(chatLanguageLabel('fr'), 'English');
    assert.equal(chatLanguageNative('fr'), 'English');
    assert.equal(getChatLanguage(null).value, 'en');
    assert.equal(getChatLanguage(undefined).bcp47, 'en-IN');
  });

  test('the native names are the real script names', () => {
    // Written as escapes so this file stays ASCII on disk while still pinning
    // the exact characters the selector shows.
    assert.equal(chatLanguageNative('ta'), '\u0ba4\u0bae\u0bbf\u0bb4\u0bcd');
    assert.equal(chatLanguageNative('hi'), '\u0939\u093f\u0902\u0926\u0940');
    assert.equal(chatLanguageNative('te'), '\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41');
  });

  test('THE FRONTEND LIST AGREES WITH THE BACKEND LIST', async () => {
    /*
     * THE DRIFT GUARD.
     *
     * The two halves are separate files because the browser cannot import
     * from the backend. That separation is exactly how they drift: a
     * language added to one and not the other ships a selector offering a
     * value the validator rejects with a 400, or a backend language nobody
     * can pick.
     *
     * 36.7 — AND IT IS WORSE NOW. Before 36.7 the frontend list WAS the
     * backend list, so drift was a missing option. Now the platform list is
     * what an admin picks from and the tenant list is what the selector
     * shows, so a frontend catalogue that disagrees with the backend's makes
     * the ADMIN PAGE offer a language the server will refuse to save. The
     * bug moves from the employee's dropdown to the admin's, and it is
     * quieter there because nothing visibly breaks until someone saves.
     *
     * HOW IT READS THE BACKEND: by IMPORTING it, not by parsing text.
     *
     * The 36.5 version sliced the file between two substrings and scraped
     * quotes out of the result. That broke the moment the module gained a
     * second export whose name appears earlier in a doc comment — the slice
     * started inside a comment and swallowed unrelated codes. aiConfig.js
     * has no imports and touches nothing at module scope, so importing it is
     * exact, cheap and cannot be fooled by a comment.
     */
    const backend = await import(
      '../../Backend/src/services/ai/aiConfig.js'
    );

    // FIELD BY FIELD, not just the codes. A catalogue that got the codes
    // right and a native name wrong would render a selector that lies about
    // what a language is called in its own script.
    assert.deepEqual(
      PLATFORM_CHAT_LANGUAGES.map((entry) => ({
        value: entry.value,
        label: entry.label,
        native: entry.native,
        hint: entry.hint,
        bcp47: entry.bcp47,
      })),
      backend.AI_LANGUAGE_CATALOGUE.map((entry) => ({
        value: entry.code,
        label: entry.label,
        native: entry.native,
        hint: entry.hint,
        bcp47: entry.bcp47,
      })),
    );

    // The default set is the same list on both sides, in the same order.
    assert.deepEqual(
      [...CHAT_LANGUAGE_VALUES],
      [...backend.AI_TENANT_LANGUAGE_DEFAULT],
    );

    // The catalogue is strictly LARGER than the default. If it were not,
    // there would be nothing for an admin to add and the feature would be
    // decorative.
    assert.ok(
      PLATFORM_CHAT_LANGUAGE_VALUES.length >
        backend.AI_TENANT_LANGUAGE_DEFAULT.length,
    );

    // Every default code really is on the platform.
    for (const value of CHAT_LANGUAGE_VALUES) {
      assert.equal(
        PLATFORM_CHAT_LANGUAGE_VALUES.includes(value),
        true,
        `default language '${value}' is not on the platform catalogue`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// PHASE 36.7 — THE TENANT LIST
//
// 36.5 offered the same five languages to every tenant and an admin could
// not add one without a code change. 36.7 makes the list a tenant setting:
// an admin enables languages from the platform catalogue and they open up in
// the assistant's selector.
//
// These tests pin the two halves of that, because they fail in opposite
// directions and both are silent:
//
//   · a language the tenant DISABLED must not be offered — otherwise the
//     selector promises something the server refuses with a 400;
//   · a language the tenant ENABLED must be offered — otherwise the admin
//     page is a lie and the feature does nothing.
// ════════════════════════════════════════════════════════════════════════════════════
describe('Phase 36.7 — the tenant list', () => {
  test('an unconfigured tenant gets the default five', () => {
    // Empty, missing and malformed all mean "nobody has configured this",
    // and all three must behave the same way. A widget whose config read
    // failed still has to show a usable selector.
    for (const input of [undefined, null, [], ['', 42], 'nope']) {
      assert.deepEqual(
        chatLanguagesFor(input).map((entry) => entry.value),
        ['en', 'ta', 'tanglish', 'hi', 'te'],
      );
    }
  });

  test('a tenant gets exactly its own list, in catalogue order', () => {
    // CATALOGUE ORDER, not the order the codes arrived in. A stable order
    // means the selector does not reshuffle between reloads just because
    // Mongo returned the array in a different sequence.
    const offered = chatLanguagesFor(['ml', 'en', 'kn']);

    assert.deepEqual(
      offered.map((entry) => entry.value),
      ['en', 'kn', 'ml'],
    );
  });

  test('a language the admin added is offered and resolves', () => {
    // The whole point. Kannada is on the platform but not in the default
    // five, so before 36.7 it could not be reached at all.
    const allowed = ['en', 'kn'];

    assert.equal(normalizeChatLanguage('kn', allowed), 'kn');
    assert.equal(getChatLanguage('kn', allowed).label, 'Kannada');
    assert.equal(chatLanguageBcp47('kn', allowed), 'kn-IN');
    assert.equal(chatLanguageHint('kn', allowed), 'Kannada script');
  });

  test('a language the admin did NOT enable falls back to English', () => {
    // Tamil is on the platform. This tenant never enabled it. Offering it
    // would produce a selector entry the validator refuses with a 400, and
    // the person would have no way to understand why.
    assert.equal(normalizeChatLanguage('ta', ['en', 'kn']), 'en');
    assert.equal(normalizeChatLanguage('ta', ['kn', 'en']), 'en');
    assert.equal(getChatLanguage('ta', ['en', 'kn']).value, 'en');
  });

  test('English is force-included even when the tenant list omits it', () => {
    // The backend refuses to PERSIST a list without English, so this is the
    // guard for a stale cached list or a hand-edited store rather than the
    // only line of defence.
    const offered = chatLanguagesFor(['ta', 'hi']);

    assert.deepEqual(
      offered.map((entry) => entry.value),
      ['en', 'ta', 'hi'],
    );
  });

  test('a platform code outside the catalogue is dropped, not invented', () => {
    // A code the frontend has never heard of must not become an <option>
    // with a blank label, and must not crash the lookup that runs on every
    // render.
    const offered = chatLanguagesFor(['en', 'zz', 'klingon']);

    assert.deepEqual(
      offered.map((entry) => entry.value),
      ['en'],
    );
  });

  test('the platform list is a superset of every tenant list', () => {
    // Structural, so a future tenant list can never contain a code the
    // catalogue does not describe — which would render as an option with no
    // native name and no BCP-47 tag for the speech APIs.
    for (const allowed of [
      ['en'],
      ['en', 'ta'],
      ['ta', 'hi', 'en'],
      PLATFORM_CHAT_LANGUAGE_VALUES,
    ]) {
      for (const entry of chatLanguagesFor(allowed)) {
        assert.equal(
          PLATFORM_CHAT_LANGUAGE_VALUES.includes(entry.value),
          true,
          `'${entry.value}' is offered but not on the platform`,
        );
      }
    }
  });

  test('the default five are unchanged from 36.5', () => {
    // The safety property. An unconfigured tenant must behave byte-for-byte
    // as it did before 36.7, or the feature would be a regression for
    // everyone who never opens AI Settings.
    assert.deepEqual([...CHAT_LANGUAGE_VALUES], [
      'en',
      'ta',
      'tanglish',
      'hi',
      'te',
    ]);

    assert.deepEqual(
      CHAT_LANGUAGES.map((entry) => entry.value),
      ['en', 'ta', 'tanglish', 'hi', 'te'],
    );
  });

  test('every platform entry carries everything the selector renders', () => {
    // The admin page maps over this list and shows native + label + hint,
    // and the speech hooks read bcp47. A record missing any of them renders
    // as a blank row or a request the browser silently ignores.
    for (const entry of PLATFORM_CHAT_LANGUAGES) {
      assert.ok(entry.value && entry.label, `${entry.value} is unnamed`);
      assert.ok(entry.native, `${entry.value} has no native name`);
      assert.ok(entry.hint, `${entry.value} has no script hint`);
      assert.match(entry.bcp47, /^[a-z]{2}-[A-Z]{2}$/, `${entry.value} bcp47`);
    }
  });

  test('the lookups never throw for any tenant list', () => {
    // These run on every render of the panel, so a throw is a blank widget.
    for (const allowed of [undefined, [], ['en'], PLATFORM_CHAT_LANGUAGE_VALUES]) {
      assert.doesNotThrow(() => {
        chatLanguageLabel(undefined, allowed);
        chatLanguageNative(null, allowed);
        chatLanguageBcp47(42, allowed);
        chatLanguageHint({}, allowed);
        getChatLanguage('zz', allowed);
        normalizeChatLanguage(undefined, allowed);
      });
    }
  });

  test('Tanglish still maps to a Latin-script tag', () => {
    // Pinned on its own because it is the one deliberate exception and the
    // easiest thing to "fix" by mistake. Tanglish is Tamil written in
    // English letters, so asking a recogniser for Tamil script would
    // mis-hear it.
    assert.equal(chatLanguageBcp47('tanglish'), 'en-IN');
    assert.equal(chatLanguageBcp47('tanglish', ['en', 'tanglish']), 'en-IN');
  });
});
