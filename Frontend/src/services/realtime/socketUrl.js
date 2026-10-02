// ═══════════════════════════════════════════════════════════════════════════
// WHERE THE CHAT SOCKET CONNECTS
//
// 36.8 — the socket used to connect to whatever origin the PAGE was served
// from, because `io()` was called with no URL at all. That is correct in
// development, where the Vite proxy forwards `/socket.io` to the backend on
// the same origin. It is wrong the moment the SPA and the API live on
// different hosts: on a static host the page origin has no Socket.IO server,
// every handshake is refused, and the chat hub degrades to read-only REST
// while the rest of the app keeps working. That is precisely the "everything
// works except chat" report that cannot be localised from the UI, because
// nothing in the product looks broken — the banner says "realtime
// unavailable", which reads like a Redis problem and not like a URL.
//
// The rule is one line: the socket goes to the API's origin, never to the
// page's. The API's origin is already known — VITE_API_URL points at it for
// every REST call — so it is DERIVED rather than configured a second time. A
// second variable is a second thing to forget, and forgetting it reproduces
// the bug exactly.
//
// WHY AN ORIGIN AND NOT THE API URL ITSELF: VITE_API_URL carries the `/api`
// path prefix, because it is the axios baseURL. The socket does not live
// under `/api`; it lives at `/socket.io` on the host root. Handing over the
// whole URL would ask for `https://api.example.com/api/socket.io`, which does
// not exist, and the handshake would fail with a 404 that looks like a server
// fault.
//
// WHY '' AND NOT undefined WHEN THERE IS NOTHING TO POINT AT: the caller then
// omits the URL argument entirely, which is the pre-existing same-origin
// behaviour. Deriving nothing is not an error — development has no deployed
// API to point at, and refusing to start would be the wrong trade for a
// cosmetic transport choice.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The origin of an absolute HTTP(S) URL, or '' for anything else.
 *
 * A relative value has no origin. `VITE_API_URL` defaults to `/api`, which is
 * the Vite proxy path — there is no host in it, and inventing one would point
 * the socket at nothing. Anything that is not http(s) is refused for the same
 * reason: a socket needs a real host, and `//host`-style values are resolved
 * against the page origin by the client, which is the bug this module exists
 * to prevent.
 *
 * @param {unknown} value
 * @returns {string} an absolute origin such as `https://api.example.com`, or ''
 */
const toOrigin = (value) => {
  const raw = String(value ?? '').trim();

  if (!/^https?:\/\//i.test(raw)) return '';

  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
};

/**
 * The URL the chat socket should connect to.
 *
 * Precedence:
 *   1. `VITE_SOCKET_URL` — an explicit override, for the rare deploy where
 *      the realtime host genuinely differs from the API host. Passed through
 *      verbatim: socket.io resolves both absolute and page-relative values.
 *   2. the origin of `VITE_API_URL` — the normal deployed case, derived so
 *      that ONE variable configures both transports and neither can drift.
 *   3. `''` — development. The caller keeps same-origin behaviour.
 *
 * Pure and re-runnable against any source, the same shape as
 * `getRedisConfig(source)` and `validateProductionConfig(source)` in the
 * backend, so it is testable with no DOM and no bundler.
 *
 * @param {Record<string, string | undefined>} source
 * @returns {string} an absolute origin, a relative override, or '' for same-origin
 */
export const resolveSocketUrl = (source = import.meta.env) => {
  const explicit = String(source?.VITE_SOCKET_URL ?? '').trim();

  if (explicit) return explicit;

  return toOrigin(source?.VITE_API_URL);
};
