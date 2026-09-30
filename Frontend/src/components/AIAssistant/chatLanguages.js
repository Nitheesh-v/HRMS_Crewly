// ════════════════════════════════════════════════════════════════════════
// PHASE 36.5 — THE LANGUAGE LIST THE ASSISTANT OFFERS
//
// Kept as a plain data module rather than inline JSX for the same reason as
// chatPrompts.js: plain Node can load a `.js` file but not a `.jsx` one, so
// putting the list here makes it assertable by a test without a browser.
//
// THE TWO HALVES MUST AGREE.
//   This list is the frontend's copy of AI_SUPPORTED_LANGUAGES in
//   Backend/src/services/ai/aiConfig.js. They are separate because the browser
//   cannot import from the backend, and a test pins them together by reading
//   the backend file — so drift fails a test rather than shipping a selector
//   that offers a language the server refuses with a 400.
//
// WHAT THIS IS NOT. A language is a PRESENTATION preference. It changes how the
// answer is phrased and which script it is written in. It never changes what
// the caller is allowed to read — the server scopes that from req.companyId
// and req.user._id before this value is ever looked at.
//
// NO AUTO-DETECTION. The product never guesses a language from what the person
// typed. The header shows what is currently selected, and that is the only
// input.
// ════════════════════════════════════════════════════════════════════════

/**
 * The five offered languages.
 *
 * `native` is the name in the language itself, because that is what a person
 * scans for. `hint` is the script note shown under the selector so nobody
 * picks Tamil expecting Roman letters.
 *
 * `bcp47` mirrors the browser tags. `tanglish` deliberately maps to `en-IN`:
 * Tanglish is written in Latin letters, so asking a recogniser for Tamil
 * script would mis-hear it.
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
    native: 'தமிழ்',
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
    native: 'हिंदी',
    hint: 'Hindi or Hinglish',
    bcp47: 'hi-IN',
  }),
  Object.freeze({
    value: 'te',
    label: 'Telugu',
    native: 'తెలుగు',
    hint: 'Telugu script',
    bcp47: 'te-IN',
  }),
]);

/** English is the base case and the default. */
export const DEFAULT_CHAT_LANGUAGE = 'en';

/** The closed set of accepted values, for validation. */
export const CHAT_LANGUAGE_VALUES = Object.freeze(
  CHAT_LANGUAGES.map((language) => language.value),
);

/**
 * Resolve anything to a language this UI can actually use.
 *
 * An unknown, missing or non-string value becomes English silently. The
 * selector only ever writes values from this list, so this is the guard for a
 * stale Redux value or a future caller, not the normal path.
 */
export const normalizeChatLanguage = (value) =>
  CHAT_LANGUAGE_VALUES.includes(value) ? value : DEFAULT_CHAT_LANGUAGE;

/** The full record, or the English record when the value is unknown. */
export const getChatLanguage = (value) =>
  CHAT_LANGUAGES.find(
    (language) => language.value === normalizeChatLanguage(value),
  );

/** The display name, e.g. 'Tamil'. */
export const chatLanguageLabel = (value) => getChatLanguage(value).label;

/** The name in the language itself, e.g. 'தமிழ்'. */
export const chatLanguageNative = (value) => getChatLanguage(value).native;

/** The BCP-47 tag for the Web Speech APIs, e.g. 'ta-IN'. */
export const chatLanguageBcp47 = (value) => getChatLanguage(value).bcp47;

export default {
  CHAT_LANGUAGES,
  CHAT_LANGUAGE_VALUES,
  DEFAULT_CHAT_LANGUAGE,
  normalizeChatLanguage,
  getChatLanguage,
  chatLanguageLabel,
  chatLanguageNative,
  chatLanguageBcp47,
};
