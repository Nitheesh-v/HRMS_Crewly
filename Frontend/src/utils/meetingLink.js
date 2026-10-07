// ─────────────────────────────────────────────────────────────
// Meeting links — the client half of Backend/src/utils/meetingLink.js
//
// Two jobs:
//   1. RENDER. The Join Meeting anchor must never receive a scheme-less
//      value. `href="meet.google.com/abc"` is a relative path, so the
//      browser sends the user to
//          http://localhost:5173/meet.google.com/abc
//      which reads as "the meeting link does not open".
//   2. TELL THE TRUTH BEFORE SAVING. The form refuses a link it cannot
//      salvage and says why, instead of storing something that will be
//      dead for every reader of the meeting.
//
// The server normalises too (that is the authoritative copy — it must
// hold for third-party API clients), so this file is defence in depth
// plus the better message. Keep the two implementations in step.
// ─────────────────────────────────────────────────────────────

const UNSAFE_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOOKS_LIKE_HOST = /^[\w.-]+\.[a-z]{2,}(?:[/?#]|$)/i;

const INCOMPLETE_MESSAGE =
  'Meeting link looks incomplete — include the full address (for example https://meet.google.com/abc-defg-hij)';

const UNSAFE_MESSAGE = 'Meeting link must be a normal http(s) web address';

export const parseMeetingLink = (raw) => {
  if (raw === undefined || raw === null) return { link: '', error: null };

  const value = String(raw).trim();
  if (!value) return { link: '', error: null };

  const lower = value.toLowerCase();

  if (UNSAFE_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    return { link: '', error: UNSAFE_MESSAGE };
  }

  if (HAS_SCHEME.test(value)) {
    if (!/^https?:\/\//i.test(value)) return { link: '', error: UNSAFE_MESSAGE };
    if (!/^https?:\/\/\S+$/i.test(value)) return { link: '', error: INCOMPLETE_MESSAGE };

    return { link: value, error: null };
  }

  if (LOOKS_LIKE_HOST.test(value)) {
    return { link: `https://${value}`, error: null };
  }

  return { link: '', error: INCOMPLETE_MESSAGE };
};

export default parseMeetingLink;
