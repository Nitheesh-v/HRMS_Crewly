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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHAT_LANGUAGES,
  CHAT_LANGUAGE_VALUES,
  DEFAULT_CHAT_LANGUAGE,
  chatLanguageBcp47,
  chatLanguageLabel,
  chatLanguageNative,
  getChatLanguage,
  normalizeChatLanguage,
} from '../src/components/AIAssistant/chatLanguages.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendConfig = path.join(
  here,
  '..',
  '..',
  'Backend',
  'src',
  'services',
  'ai',
  'aiConfig.js',
);

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

  test('THE FRONTEND LIST AGREES WITH THE BACKEND LIST', () => {
    /*
     * THE DRIFT GUARD.
     *
     * The two halves are separate files because the browser cannot import
     * from the backend. That separation is exactly how they drift: a language
     * added to one and not the other ships a selector offering a value the
     * validator rejects with a 400, or a backend language nobody can pick.
     *
     * So the backend config is read as TEXT and its array is parsed out. It
     * is a source pin, and it is the only place in this suite where the
     * frontend looks at backend code — justified because the alternative is a
     * bug that only appears in the owner's hands.
     */
    assert.equal(fs.existsSync(backendConfig), true, 'backend aiConfig.js not found');

    const source = fs.readFileSync(backendConfig, 'utf8');

    const start = source.indexOf('AI_SUPPORTED_LANGUAGES');
    const end = source.indexOf(']);', start);

    assert.ok(start !== -1 && end !== -1, 'AI_SUPPORTED_LANGUAGES not found');

    const block = source.slice(start, end);

    const backendValues = [...block.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);

    // The backend list is the authority; the frontend must be a subset of it
    // and must not be missing anything it offers.
    for (const value of backendValues) {
      assert.equal(
        CHAT_LANGUAGE_VALUES.includes(value),
        true,
        `frontend is missing the backend language '${value}'`,
      );
    }

    for (const value of CHAT_LANGUAGE_VALUES) {
      assert.equal(
        backendValues.includes(value),
        true,
        `frontend offers '${value}' but the backend refuses it`,
      );
    }
  });
});
