// ─────────────────────────────────────────────────────────────
// Meeting links — one parser, both ends (server + client).
//
// WHY THIS EXISTS
// The meeting link is the only user-authored string on the Meetings
// page that ends up inside an `href`. Rendered raw, a value typed the
// way people actually type it —
//
//     meet.google.com/abc-defg-hij
//
// is not a URL with a missing scheme, it is a *relative path*: the
// browser resolves it against whatever origin the app happens to be
// on, so the Join button navigates to
//
//     http://localhost:5173/meet.google.com/abc-defg-hij
//
// which is a 404 and looks like the meeting "does not open". The same
// raw pass-through is how `javascript:` and `data:` reach an anchor.
//
// So the rule is decided in ONE place and applied in three:
//   1. `createMeeting` / `updateMeeting` normalise before storing, so
//      every client (current and future) inherits a safe absolute URL.
//   2. The detail modal normalises again before rendering `href`.
//   3. A value that cannot be salvaged is REFUSED (400 server-side,
//      inline message client-side) instead of being stored broken.
//
// The frontend copy is `Frontend/src/utils/meetingLink.js`. Duplicated
// on purpose: a shared package would be a new dependency, and the repo
// keeps runtime-local helpers next to the runtime that uses them.
// ─────────────────────────────────────────────────────────────

// Schemes that can execute or exfiltrate when clicked. Refused outright
// rather than rewritten.
const UNSAFE_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];

// Anything that looks like a scheme: `https:`, `mailto:`, `zoommtg:`, …
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// A scheme-less value we are willing to trust as a host: at least one
// dot-separated label plus a TLD, optionally followed by a path/query.
const LOOKS_LIKE_HOST = /^[\w.-]+\.[a-z]{2,}(?:[/?#]|$)/i;

const INCOMPLETE_MESSAGE =
  'Meeting link looks incomplete — include the full address (for example https://meet.google.com/abc-defg-hij)';

const UNSAFE_MESSAGE = 'Meeting link must be a normal http(s) web address';

/**
 * Normalise a user-entered meeting link.
 *
 * @param {unknown} raw
 * @returns {{ link: string, error: string|null }} `link` is '' when there
 *          is nothing usable; `error` is a message meant for a human.
 */
export const parseMeetingLink = (raw) => {
  if (raw === undefined || raw === null) return { link: '', error: null };

  const value = String(raw).trim();
  if (!value) return { link: '', error: null };

  const lower = value.toLowerCase();

  if (UNSAFE_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    return { link: '', error: UNSAFE_MESSAGE };
  }

  if (HAS_SCHEME.test(value)) {
    // Only http(s) survives. `zoommtg:`, `mailto:`, `tel:` and friends are
    // rejected on purpose: an anchor with a non-web scheme either does
    // nothing in a browser or hands control to an installed app, and
    // neither belongs behind a button labelled "Join Meeting".
    if (!/^https?:\/\//i.test(value)) return { link: '', error: UNSAFE_MESSAGE };

    // `https://` with no host is not a link.
    if (!/^https?:\/\/\S+$/i.test(value)) return { link: '', error: INCOMPLETE_MESSAGE };

    return { link: value, error: null };
  }

  if (LOOKS_LIKE_HOST.test(value)) {
    return { link: `https://${value}`, error: null };
  }

  return { link: '', error: INCOMPLETE_MESSAGE };
};

export const MEETING_LINK_MESSAGES = {
  unsafe: UNSAFE_MESSAGE,
  incomplete: INCOMPLETE_MESSAGE,
};

export default parseMeetingLink;
