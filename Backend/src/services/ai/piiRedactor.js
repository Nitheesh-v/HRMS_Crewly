// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.1 — PII REDACTOR (pure, dependency-free, runs BEFORE the vendor)
//
//  THE LAW (Phase 36 §5.2)
//    Before any text leaves the CREWLY server toward the AI vendor it passes
//    through this function. Aadhaar, PAN, UAN, Indian mobile numbers, email
//    addresses, bank account numbers, IFSC codes and salary amounts are
//    replaced with stable placeholders. There is no per-request opt-out: the
//    only override is AI_PII_REDACTION=false in development/test, and it is
//    fail-closed in production (see aiConfig.isRedactionEnforced).
//
//  WHY PURE AND DEPENDENCY-FREE
//    This is the one function in the AI suite that MUST be trivially
//    auditable and trivially testable. No imports, no I/O, no clock, no
//    randomness — the same input always produces the same output, so the
//    hermetic suite can assert exact strings.
//
//  WHAT THIS IS NOT
//    · Not a detector of "sensitive context". It matches Indian identifier
//      SHAPES; a salary written as "twelve lakhs a year" is not matched.
//    · Not reversible and not meant to be. The vendor sees the placeholder;
//      the human sees the same placeholder. An answer that says "your
//      [AADHAAR_REDACTED] is on file" is the intended, honest outcome.
//
//  ORDER IS A LAW, NOT STYLE
//    EMAIL first (a digit run inside a local part must not be eaten by the
//    identifier rules), then the labelled rules (IFSC / bank account — a
//    label makes the intent unambiguous and must win over a bare digit run),
//    then the bare identifier rules, then amounts. Changing the order changes
//    what is removed; test/aiProviderFoundation.test.js pins the observable
//    result for every row of the table.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stable placeholders. Deliberately NOT the original value, and deliberately
 * NOT a hash of it: a hash of an Aadhaar number is still an identifier.
 */
export const PII_PLACEHOLDERS = Object.freeze({
  AADHAAR: '[AADHAAR_REDACTED]',
  PAN: '[PAN_REDACTED]',
  MOBILE: '[MOBILE_REDACTED]',
  EMAIL: '[EMAIL_REDACTED]',
  BANK_ACCOUNT: '[BANK_ACCOUNT_REDACTED]',
  IFSC: '[IFSC_REDACTED]',
  AMOUNT: '[AMOUNT_REDACTED]',
});

// ── THE PATTERN TABLE ──────────────────────────────────────────────────────
// One row per class of identifier, applied in array order.
//
// `keep` lists the capture groups whose text is PRESERVED around the
// placeholder (a label such as "bank account number is " must survive so the
// answer still reads as English). Everything else the pattern matched is
// replaced. A row with no `keep` replaces its whole match.
//
// AADHAAR and UAN share a row ON PURPOSE: both are 12-digit numbers and no
// regular expression can tell them apart. Pretending otherwise would mean
// guessing which one a number is, and a wrong guess leaks. The placeholder
// names the more common of the two and the unit doc records the ambiguity —
// the GUARANTEE (the number does not leave the server) holds for both.
const PATTERNS = Object.freeze([
  {
    key: 'EMAIL',
    placeholder: PII_PLACEHOLDERS.EMAIL,
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },

  {
    key: 'IFSC',
    placeholder: PII_PLACEHOLDERS.IFSC,
    // 4 letters, a literal zero, 6 alphanumerics (e.g. HDFC0001234).
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
  },

  {
    key: 'PAN',
    placeholder: PII_PLACEHOLDERS.PAN,
    // 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F). Uppercase only —
    // that is the real-world shape of a PAN.
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
  },

  {
    key: 'BANK_ACCOUNT',
    placeholder: PII_PLACEHOLDERS.BANK_ACCOUNT,
    // LABEL-ANCHORED on purpose. A bare 9–18 digit run is indistinguishable
    // from an employee code, a ticket id or a timestamp, so an unlabelled
    // rule would redact ordinary business numbers and produce useless
    // answers. With a label the intent is unambiguous.
    // Group 1 is the label and is KEPT; group 2 is the number.
    pattern:
      /\b((?:a\/c|a\/c\.|ac\b|acct\b|account(?:\s+(?:no|number|num|#))?|bank\s+account(?:\s+(?:no|number|num|#))?)\s*(?:is|are|:|=|-|#)?\s*)([0-9][0-9\s-]{7,20}[0-9])/gi,
    keep: [1],
  },

  {
    key: 'AADHAAR',
    placeholder: PII_PLACEHOLDERS.AADHAAR,
    // 12 digits, bare or in the canonical 4-4-4 grouping. The lookbehind
    // excludes a digit AND a '+', so the country-code prefix of
    // "+919876543210" is never mistaken for the start of a 12-digit number
    // (that used to leave a dangling "+" and the wrong placeholder).
    pattern: /(?<![0-9+])(?:[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4})(?![0-9])/g,
  },

  {
    key: 'MOBILE',
    placeholder: PII_PLACEHOLDERS.MOBILE,
    // Indian mobile: optional +91 / 0 country/trunk prefix, then a digit 6-9
    // and nine more. Separators inside the number are tolerated, and the
    // lookarounds stop it from matching inside a longer digit run.
    pattern: /(?<![0-9])(?:\+?91[ -]?|0)?[6-9](?:[ -]?[0-9]){9}(?![0-9])/g,
  },

  {
    // Currency-marked amounts: ₹1,20,000 / Rs 50000 / INR 4.5 / 45,000/-.
    // Group 1 is an optional salary label and is kept, so "my salary is
    // Rs 45,000" still reads as a sentence after redaction.
    key: 'AMOUNT',
    placeholder: PII_PLACEHOLDERS.AMOUNT,
    pattern:
      /\b((?:salary|ctc|gross(?:\s+pay)?|net(?:\s+pay)?|take[\s-]?home|in[\s-]hand)\s*(?:is|:|=|of|was)?\s*)?(?:₹\s?|rs\.?\s?|inr\s?)[0-9][0-9,]*(?:\.[0-9]{1,2})?(?:\s*\/-)?/gi,
    keep: [1],
  },

  {
    // Salary-labelled PLAIN numbers ("my salary is 45000", "CTC 1200000").
    // Deliberately separate from the currency row: without a currency mark a
    // bare number is only redacted when a salary label precedes it, so
    // ordinary business numbers survive.
    key: 'AMOUNT',
    placeholder: PII_PLACEHOLDERS.AMOUNT,
    pattern:
      /\b((?:salary|ctc|gross(?:\s+pay)?|net(?:\s+pay)?|take[\s-]?home|in[\s-]hand)\s*(?:is|:|=|of|was)?\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?(?:\s*\/-)?)/gi,
    keep: [1],
  },
]);

// The set of placeholder strings. Used by the idempotence guarantee: once a
// value is redacted, running the redactor again must not change it.
const PLACEHOLDER_VALUES = new Set(Object.values(PII_PLACEHOLDERS));

const asText = (value) => {
  if (value === null || value === undefined) return '';

  if (typeof value === 'string') return value;

  // Numbers/booleans are stringified so a client sending `content: 50000`
  // is still redacted rather than silently skipped.
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  // Anything else (objects, arrays) has no defined identifier shape. Dropping
  // it is the safe direction: the redactor must never pass a structure it
  // cannot inspect straight to the vendor.
  return '';
};

/**
 * Replace every Indian PII shape in `text` with its stable placeholder.
 *
 * Pure and synchronous. Never throws: a redactor that throws would either
 * break the request or tempt a caller into catching it and sending the raw
 * text, so the safe behaviour is to always return a string.
 */
export const redactPII = (text) => {
  const input = asText(text);

  if (input === '') return '';

  let output = input;

  for (const rule of PATTERNS) {
    const keep = rule.keep ?? [];

    const replaceWith = (_match, ...groups) => {
      const kept = keep.map((index) => groups[index - 1] ?? '').join('');

      return `${kept}${rule.placeholder}`;
    };

    // A fresh RegExp is used per call so `lastIndex` state from a previous
    // invocation can never make this function non-deterministic.
    output = output.replace(
      new RegExp(rule.pattern.source, rule.pattern.flags),
      replaceWith,
    );
  }

  return output;
};

/**
 * Redact every message's content. Applied to ALL roles, including 'system'
 * and 'assistant' history: a system prompt written by a later unit may embed
 * tenant policy text, and a pasted assistant answer may contain the very PII
 * this function exists to remove. Redacting a placeholder is a no-op, so
 * re-redacting history is free.
 */
export const redactMessages = (messages) => {
  if (!Array.isArray(messages)) return [];

  return messages.map((message) => ({
    role: String(message?.role ?? ''),
    content: redactPII(message?.content),
  }));
};

/** True when the redactor would change the text (used by tests + telemetry). */
export const containsRedactablePII = (text) => redactPII(text) !== asText(text);

export { PLACEHOLDER_VALUES, PATTERNS };
