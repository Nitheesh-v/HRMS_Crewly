// ══════════════════════════════════════════════════════════════════════════════
// PHASE 36.5 / 36.7 — THE LANGUAGE LIST THE ASSISTANT OFFERS
//
// Kept as a plain data module rather than inline JSX for the same reason as
// chatPrompts.js: plain Node can load a `.js` file but not a `.jsx` one, so
// putting the list here makes it assertable by a test without a browser.
//
// ══ THE TWO HALVES MUST AGREE ══
//   This list is the frontend's copy of AI_LANGUAGE_CATALOGUE in
//   Backend/src/services/ai/aiConfig.js. They are separate because the browser
//   cannot import from the backend, and a test pins them together by reading
//   the backend file — so drift fails a test rather than shipping a selector
//   that offers a language the server refuses with a 400.
//
//   In production the server SENDS the catalogue over GET /ai/languages, so
//   this copy is only the offline fallback for the first paint and for tests.
//
// ══ WHAT CHANGED IN 36.7 ══
//   36.5 offered the same five languages to every tenant, and an admin who
//   wanted a sixth had to change code. 36.7 makes the list a TENANT SETTING:
//   an admin enables languages from the platform catalogue in AI Settings and
//   they open up in this selector.
//
//   So there are now two lists here, and the distinction matters:
//
//     PLATFORM_CHAT_LANGUAGES  every language the platform knows (14)
//     CHAT_LANGUAGES           the default tenant set (the 36.5 five)
//
//   `chatLanguagesFor(allowed)` turns one into the other. CHAT_LANGUAGES is
//   kept as an alias exactly like AI_SUPPORTED_LANGUAGES on the backend, so
//   nothing that imported the 36.5 name breaks.
//
// ══ WHAT THIS IS NOT ══
//   A language is a PRESENTATION preference. It changes how the answer is
//   phrased and which script it is written in. It never changes what the
//   caller is allowed to read — the server scopes that from req.companyId
//   and req.user._id before this value is ever looked at.
//
// ══ NO AUTO-DETECTION ══
//   The product never guesses a language from what the person typed. The
//   header shows what is currently selected, and that is the only input.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * EVERY language the platform knows, in catalogue order.
 *
 * `native` is the name in the language itself, because that is what a person
 * scans for. `hint` is the script note shown under the selector so nobody
 * picks Tamil expecting Roman letters.
 *
 * `bcp47` mirrors the browser tags. `tanglish` deliberately maps to `en-IN`:
 * Tanglish is written in Latin letters, so asking a recogniser for Tamil
 * script would mis-hear it.
 *
 * This is NOT what the selector shows. It is the SUPERSET, and the selector
 * shows `chatLanguagesFor(tenantCodes)`.
 */
export const PLATFORM_CHAT_LANGUAGES = Object.freeze([
  Object.freeze({
    value: 'en',
    label: 'English',
    native: 'English',
    hint: 'Default',
    bcp47: 'en-IN',
  }),
  Object.freeze({
    value: 'ta',
    label: 'Tamil',
    native: '\u0ba4\u0bae\u0bbf\u0bb4\u0bcd',
    hint: 'Tamil script',
    bcp47: 'ta-IN',
  }),
  Object.freeze({
    value: 'tanglish',
    label: 'Tanglish',
    native: 'Tanglish',
    hint: 'Tamil in English letters',
    bcp47: 'en-IN',
  }),
  Object.freeze({
    value: 'hi',
    label: 'Hindi',
    native: '\u0939\u093f\u0902\u0926\u0940',
    hint: 'Hindi or Hinglish',
    bcp47: 'hi-IN',
  }),
  Object.freeze({
    value: 'te',
    label: 'Telugu',
    native: '\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41',
    hint: 'Telugu script',
    bcp47: 'te-IN',
  }),
  Object.freeze({
    value: 'kn',
    label: 'Kannada',
    native: '\u0c95\u0ca8\u0ccd\u0ca8\u0ca1',
    hint: 'Kannada script',
    bcp47: 'kn-IN',
  }),
  Object.freeze({
    value: 'ml',
    label: 'Malayalam',
    native: '\u0d2e\u0d32\u0d2f\u0d3e\u0d33\u0d02',
    hint: 'Malayalam script',
    bcp47: 'ml-IN',
  }),
  Object.freeze({
    value: 'mr',
    label: 'Marathi',
    native: '\u092e\u0930\u093e\u0920\u0940',
    hint: 'Marathi script',
    bcp47: 'mr-IN',
  }),
  Object.freeze({
    value: 'gu',
    label: 'Gujarati',
    native: '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0',
    hint: 'Gujarati script',
    bcp47: 'gu-IN',
  }),
  Object.freeze({
    value: 'pa',
    label: 'Punjabi',
    native: '\u0a2a\u0a70\u0a1c\u0a3e\u0a2c\u0a40',
    hint: 'Punjabi script (Gurmukhi)',
    bcp47: 'pa-IN',
  }),
  Object.freeze({
    value: 'bn',
    label: 'Bengali',
    native: '\u09ac\u09be\u0982\u09b2\u09be',
    hint: 'Bengali script',
    bcp47: 'bn-IN',
  }),
  Object.freeze({
    value: 'or',
    label: 'Odia',
    native: '\u0b13\u0b21\u0b3c\u0b3f\u0b06',
    hint: 'Odia script',
    bcp47: 'or-IN',
  }),
  Object.freeze({
    value: 'as',
    label: 'Assamese',
    native: '\u0985\u09b8\u09ae\u09c0\u09af\u09bc\u09be',
    hint: 'Assamese script',
    bcp47: 'as-IN',
  }),
  Object.freeze({
    value: 'ur',
    label: 'Urdu',
    native: '\u0627\u0631\u062f\u0648',
    hint: 'Urdu script',
    bcp47: 'ur-IN',
  }),
]);

/**
 * The languages an UNCONFIGURED tenant offers — the 36.5 five.
 *
 * Kept as a named export so every 36.5 import site keeps working. It is the
 * DEFAULT, not the ceiling: an admin can widen it in AI Settings.
 */
export const CHAT_LANGUAGES = Object.freeze([
  Object.freeze({
    value: 'en',
    label: 'English',
    native: 'English',
    hint: 'Default',
    bcp47: 'en-IN',
  }),
  Object.freeze({
    value: 'ta',
    label: 'Tamil',
    native: '\u0ba4\u0bae\u0bbf\u0bb4\u0bcd',
    hint: 'Tamil script',
    bcp47: 'ta-IN',
  }),
  Object.freeze({
    value: 'tanglish',
    label: 'Tanglish',
    native: 'Tanglish',
    hint: 'Tamil in English letters',
    bcp47: 'en-IN',
  }),
  Object.freeze({
    value: 'hi',
    label: 'Hindi',
    native: '\u0939\u093f\u0902\u0926\u0940',
    hint: 'Hindi or Hinglish',
    bcp47: 'hi-IN',
  }),
  Object.freeze({
    value: 'te',
    label: 'Telugu',
    native: '\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41',
    hint: 'Telugu script',
    bcp47: 'te-IN',
  }),
]);

/** The platform's own codes, for validation and for the admin page. */
export const PLATFORM_CHAT_LANGUAGE_VALUES = Object.freeze(
  PLATFORM_CHAT_LANGUAGES.map((language) => language.value),
);

/** English is the base case and the default. */
export const DEFAULT_CHAT_LANGUAGE = 'en';

/** The closed set of accepted values for an unconfigured tenant. */
export const CHAT_LANGUAGE_VALUES = Object.freeze(
  CHAT_LANGUAGES.map((language) => language.value),
);

/**
 * The records a given tenant actually offers.
 *
 * @param {string[]} [allowed] the tenant's enabled codes, from
 *   GET /ai/languages. Omitted, empty or malformed means "unconfigured" and
 *   yields the default five.
 * @returns {readonly Array} the matching catalogue records, IN CATALOGUE
 *   ORDER rather than the order the codes arrived in. A stable order means
 *   the selector does not reshuffle between reloads.
 *
 * English is force-included. It is the base case and the one language the
 * system prompt needs no rule for, so a tenant without it would render a
 * selector promising a language the prompt cannot produce for a default
 * request. The backend enforces the same rule at the model, so this is a
 * belt-and-braces guard for a stale cached list, not the only line of
 * defence.
 */
export const chatLanguagesFor = (allowed) => {
  // KEEP ONLY REAL PLATFORM CODES.
  //
  // Filtering by type alone is not enough: an empty string is a string, and
  // a list of [''] would otherwise be read as "the tenant enabled exactly
  // one language" and render a selector with a single nameless entry in it.
  //
  // Dropping unknown codes here rather than trusting the caller is the same
  // fail-closed direction as the backend's validator, one layer out.
  const codes = Array.isArray(allowed)
    ? allowed.filter((code) => PLATFORM_CHAT_LANGUAGE_VALUES.includes(code))
    : [];

  // NOTHING USABLE MEANS UNCONFIGURED. A widget whose config read failed, or
  // a list holding only junk, still has to show a working selector rather
  // than an empty one.
  if (codes.length === 0) {
    return CHAT_LANGUAGES;
  }

  const wanted = new Set(codes);

  wanted.add(DEFAULT_CHAT_LANGUAGE);

  return PLATFORM_CHAT_LANGUAGES.filter((language) =>
    wanted.has(language.value),
  );
};

/**
 * Resolve anything to a language this UI can actually use.
 *
 * An unknown, missing or non-string value becomes English silently. The
 * selector only ever writes values from the tenant's list, so this is the
 * guard for a stale Redux value or a future caller, not the normal path.
 *
 * @param {string} value
 * @param {string[]} [allowed] the tenant's enabled codes. When supplied, a
 *   value that is on the platform but NOT enabled for this tenant also falls
 *   back — the UI must never claim a language the tenant switched off.
 */
export const normalizeChatLanguage = (value, allowed) => {
  const codes = chatLanguagesFor(allowed).map((language) => language.value);

  return codes.includes(value) ? value : DEFAULT_CHAT_LANGUAGE;
};

/** The full record, or the English record when the value is unknown. */
export const getChatLanguage = (value, allowed) =>
  chatLanguagesFor(allowed).find(
    (language) => language.value === normalizeChatLanguage(value, allowed),
  );

/** The display name, e.g. 'Tamil'. */
export const chatLanguageLabel = (value, allowed) =>
  getChatLanguage(value, allowed).label;

/** The name in the language itself, e.g. 'தமிழ்'. */
export const chatLanguageNative = (value, allowed) =>
  getChatLanguage(value, allowed).native;

/** The BCP-47 tag for the Web Speech APIs, e.g. 'ta-IN'. */
export const chatLanguageBcp47 = (value, allowed) =>
  getChatLanguage(value, allowed).bcp47;

/** The script note, e.g. 'Tamil in English letters'. */
export const chatLanguageHint = (value, allowed) =>
  getChatLanguage(value, allowed).hint;

export default {
  PLATFORM_CHAT_LANGUAGES,
  PLATFORM_CHAT_LANGUAGE_VALUES,
  CHAT_LANGUAGES,
  CHAT_LANGUAGE_VALUES,
  DEFAULT_CHAT_LANGUAGE,
  chatLanguagesFor,
  normalizeChatLanguage,
  getChatLanguage,
  chatLanguageLabel,
  chatLanguageNative,
  chatLanguageBcp47,
  chatLanguageHint,
};
