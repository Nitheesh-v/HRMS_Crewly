// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.10-fix2 — CHAT TEXT VISIBILITY RULES
//
//  WHY THIS FILE EXISTS
//    Localhost acceptance produced a message bubble that rendered as nothing
//    but a timestamp (2026-09-26, 10:57). The stored body was invisible: a
//    zero-width space (or a variation selector / BOM / word joiner) pasted
//    from another app. `String(text).trim()` does NOT remove those characters
//    — trim only strips WhiteSpace and line terminators — so an all-invisible
//    body passed every "is it empty?" check, was stored, and reached every
//    member's screen as a blank bubble.
//
//  THE LAW
//    A chat message body must contain at least one VISIBLE character. A
//    character is invisible when it exists only to shape rendering: C0/C1
//    controls, zero-width joiners/marks, BOM, variation selectors, invisible
//    operators and the Hangul fillers. A body made only of those is empty in
//    every sense a reader cares about, so it must be refused where it is
//    written: the socket validators, the model validator, and the create path.
//
//  SCOPE
//    Pure functions, no env, no DB, no language model. The character set is a
//    deliberate, documented list — not a guess about "a good message" — and a
//    visible character anywhere in the body makes the whole body visible, so
//    everything the product already accepts (Tamil, emoji, punctuation,
//    leading/trailing spaces) keeps working.
//
//  The frontend mirrors this rule in Frontend/src/utils/chatText.js so the
//  send button is disabled before a round-trip. The backend stays the
//  authority; a frontend/backend drift fails test/chatMessageBodyRules.test.js.
// ═══════════════════════════════════════════════════════════════════════════

// Characters that occupy no visible space in any font/rendering:
//   \u0000-\u001F  C0 controls (NUL, BEL, ...)
//   \u007F-\u009F  DEL + C1 controls
//   \u00AD         soft hyphen (renders only when the line breaks)
//   \u180E         Mongolian vowel separator
//   \u200B-\u200F  zero-width space / non-joiner / joiner / directional marks
//   \u2028-\u202F  line/paragraph separators + bidi embedding controls
//   \u205F-\u206F  medium math space + invisible operators (word joiner, ...)
//   \u3164         Hangul filler
//   \uFE0E-\uFE0F  text/emoji variation selectors (shape a neighbour)
//   \uFEFF         zero-width no-break space (BOM)
//   \uFFA0         halfwidth Hangul filler
// eslint-disable-next-line no-control-regex
export const INVISIBLE_TEXT_PATTERN =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u2028-\u202F\u205F-\u206F\u3164\uFE0E\uFE0F\uFEFF\uFFA0]/g;

/**
 * True when the value carries at least one visible character.
 * `null`, `undefined`, numbers and objects are never visible chat bodies.
 */
export const hasVisibleText = (value) => {
  if (typeof value !== 'string') return false;

  return value.replace(INVISIBLE_TEXT_PATTERN, '').trim().length > 0;
};

export default hasVisibleText;
