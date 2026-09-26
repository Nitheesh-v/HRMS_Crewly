// PHASE 33.10-fix2 — chat text visibility (mirror of the backend rule).
//
// The backend is the authority (Backend/src/utils/chatTextRules.js); this
// mirror exists so the send button is disabled BEFORE a round-trip instead of
// after a refusal. `String.prototype.trim()` removes only WhiteSpace and line
// terminators, so a body pasted from another app can be entirely zero-width
// characters (\u200B and friends) and still look "non-empty" to the old check
// — that is how a blank bubble reached every member's screen on 2026-09-26.
// test/chatMessageBodyRules.test.js fails if the two lists drift.
// The class is deliberate: C0/C1 controls and variation selectors are
// exactly the characters that must be treated as invisible here.
/* eslint-disable no-control-regex, no-misleading-character-class */
export const INVISIBLE_TEXT_PATTERN =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u2028-\u202F\u205F-\u206F\u3164\uFE0E\uFE0F\uFEFF\uFFA0]/g;
/* eslint-enable no-control-regex, no-misleading-character-class */

export const hasVisibleText = (value) => {
  if (typeof value !== 'string') return false;

  return value.replace(INVISIBLE_TEXT_PATTERN, '').trim().length > 0;
};

export default hasVisibleText;
