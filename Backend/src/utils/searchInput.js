// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.10 — SEARCH INPUT BOUNDS (shared, pure)
//
// The newer domain services (presence, timesheets, candidate inbox,
// interviews, public careers…) each keep a local escaped+bounded search
// implementation. The legacy controllers predate that law and passed RAW
// user input into Mongo `$regex` — regex injection (a `.*` query forces a
// scan-shaped match; crafted patterns are CPU-heavy) and unbounded length.
//
// This is the ONE shared implementation the legacy controllers now use:
//   · boundedSearchTerm — trim + hard length cap (matches the presence
//     service's 60-char law).
//   · escapeRegExp — the user's text matches LITERALLY (what a name/email/
//     title search always meant); `$regex` anchors like `.*` or `(a+)+$`
//     from a caller can never reach the database.
//
// Pure functions — no I/O, fully hermetically testable.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_SEARCH_LENGTH = 60;

export const escapeRegExp = (value) =>
  String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Returns '' for non-string/empty input; otherwise the trimmed, length-
 * capped, REGEX-ESCAPED term ready for `$regex: term, $options: 'i'`.
 */
export const boundedSearchTerm = (value, maxLength = MAX_SEARCH_LENGTH) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().slice(0, Math.max(1, Number(maxLength) || MAX_SEARCH_LENGTH));
  if (!trimmed) return '';
  return escapeRegExp(trimmed);
};
