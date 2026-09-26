# The browser session is a cookie (33.14)

**Audience:** anyone touching customer auth, `protect`, the chat socket, or
debugging "I keep getting logged out".
**Status:** shipped. Companion docs: `SESSION_REFRESH_RESILIENCE.md` (why the
session used to expire *fast*), `PHASE_33_CHAT_HUB.md` §23 (the socket ticket).

---

## 1. What changed, and why

| | Before | After |
|---|---|---|
| Refresh token | HttpOnly cookie `crewly_refresh` (`Path=/api/auth`) | unchanged |
| Access token | returned in the login/refresh **body**, kept in `localStorage['infolexus_token']`, sent as `Authorization: Bearer …` | **HttpOnly cookie** `crewly_access` (`Path=/api`) — JavaScript never sees it |
| What JS holds | a 15-minute credential anyone could read and post elsewhere | nothing: user profile only (name, role, company) |
| Socket handshake | the access JWT in the auth payload | a **60-second chat ticket** in the auth payload |
| Cross-site write protection | bearer token (nothing to protect) | `SameSite` **plus** a required `X-Requested-With` header on cookie-authenticated writes |

The reason is blast radius, stated honestly: an XSS, a malicious dependency, or
a screen-share of devtools could **read** the localStorage token and **post it
to another host**, where it stayed valid for the rest of its 15 minutes and
survived the tab closing. A cookie cannot be read by script and is not portable
to another origin — so the credential stops being exfiltratable.

What this does **not** claim: a live XSS in the page can still call the API as
the user while it runs (the browser attaches the cookie for it). Cookies remove
the *theft* path, not the *abuse* path. Nothing here replaces input handling,
CSP, or dependency hygiene.

---

## 2. The two cookies

```
Set-Cookie: crewly_access=<jwt>; Path=/api;     HttpOnly; SameSite=None|Lax; [Secure]; Max-Age=<accessTokenMinutes*60>
Set-Cookie: crewly_refresh=<opaque>; Path=/api/auth; HttpOnly; SameSite=None|Lax; [Secure]; Max-Age=<refreshTokenDays*86400>
```

* `Secure` and `SameSite=None` are used **in production only** (customer
  deployments can serve the SPA from a different site than the API, which is
  why `None` is already the refresh cookie's production setting). In
  development both cookies are `Lax` and not `Secure`, so `http://localhost`
  works.
* `Path=/api` — and never `/` on purpose: the browser must not attach a
  long-lived credential to the `/socket.io` handshake (33.1's locked "no
  cookies on sockets" decision, which is also what keeps the socket free of
  the cross-site WebSocket-hijacking surface).
* Both are written on **one response** by login, register, and every rotation.
  `res.setHeader('Set-Cookie', …)` *replaces*, so the writer appends instead —
  `Backend/test/cookieSession.test.js › one response carries BOTH cookies — the
  second write never clobbers the first` exists because a clobbered cookie
  looks like "login works, then 401s 15 minutes later".
* Logout and logout-all **delete both** (`Max-Age=0`, empty value).

## 3. Who sends what

| Caller | Credential | Notes |
|---|---|---|
| Customer SPA (browser) | the `crewly_access` cookie | sends `X-Requested-With: XMLHttpRequest` on every request |
| Super-admin / support / billing portal | `Authorization: Bearer <AdminSession token>` | **unchanged**, its own session model, its own storage key `infolexus_platform_token` |
| Kiosk devices, BGV verifiers | `Authorization: Bearer …` | unchanged |
| Scripts / curl / CI | `Bearer` from the login response body | the body copy of `accessToken` is still returned |

`protect` (Backend/src/middlewares/authMiddleware.js) resolves them in this
order: **explicit `Authorization: Bearer` first, then the cookie.** An explicit
header always wins — it is the caller stating which identity it means, and a
hostile page cannot set it. Everything downstream (tokenVersion, session row,
tenant, platform/verifier/kiosk gates) is byte-for-byte the old logic.

## 4. CSRF, precisely

Because a cookie is attached automatically by the browser, every state-changing
request authenticated **by cookie** must also carry:

```
X-Requested-With: XMLHttpRequest
```

* only cookie-authenticated requests are gated (a bearer caller already proved
  intent by holding a token no page can borrow);
* only state-changing methods — `GET`/`HEAD`/`OPTIONS` stay open (downloads,
  the SSE stream, preflight);
* a cross-site page **can** send the request, but it cannot add a custom header
  without a CORS preflight, and `src/app.js` never approves a preflight from an
  origin outside the allowlist — so the request arrives without the proof and is
  refused `403 CSRF_HEADER_REQUIRED` (written directly by `protect`, because the
  shared error pipeline does not carry a custom `code`).
* `X-Requested-With` is in the CORS `allowedHeaders` list. Removing it there
  makes the browser drop **every write** from our own SPA — that is the one
  way this design breaks loudly, so it is pinned.
* The one cookie-authenticated route **outside** `protect` is
  `POST /api/auth/refresh` (it authenticates with the refresh cookie and rotates
  tokens). It mounts the same guard explicitly (`requireCsrfProof`), because an
  unreadable cross-site write is still a write.

## 5. The socket: a ticket, not a cookie

The chat handshake still reads `socket.handshake.auth.token` **only** — it never
reads the cookie jar. The browser now puts a **chat ticket** there:

1. the page calls `POST /api/realtime/chat-ticket` (ordinary authenticated HTTP:
   the cookie goes along, and the CSRF header proves it is ours);
2. the server binds a 64-hex, crypto-random ticket in the shared Redis store to
   the verified `{userId, companyId, sessionId, tokenVersion}` for **60 s**;
3. the socket presents it. Identity stays 100 % server-derived, and the same
   Mongo gates run as for a JWT: an ACTIVE user, a live session, a matching
   `tokenVersion`, and an ACTIVE company. Logout, theft revocation
   (`tokenVersion` bump), or a suspended tenant kills the next handshake.

Deliberate difference from the SSE ticket: it is valid for its whole 60 s
instead of exactly once, because a socket reconnects on its own and cannot mint
a ticket mid-reconnect. It is not ambient authority — the browser must send it
explicitly — and it is worthless a minute later. The SSE path keeps its
single-use contract: `consumeReusable()` refuses any ticket whose stored mode is
not reusable, and `consume()` is still an atomic GET+DEL.

If Redis is down, `/chat-ticket` answers `503` and the chat UI shows the
"realtime unavailable" banner while REST keeps working (the documented 33.11
degradation — nothing fails open).

## 6. Verifying it yourself (localhost)

```powershell
# 1. backend + frontend
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend ; npm run dev
# (second terminal)
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend ; npm run dev
```

Then in the browser (F12):

* **Application → Local Storage → http://localhost:5173**
  `infolexus_token` is **gone** (an old one is deleted on the first load; a
  super-admin token is migrated to `infolexus_platform_token`).
* **Application → Cookies → http://localhost:5173**
  `crewly_access` and `crewly_refresh`, both `HttpOnly` ✔.
* **Console**, run `document.cookie` → neither cookie appears (that is the point).
* Log in, click around, open a second tab, leave it 16+ minutes, use both →
  still logged in (and the refresh keeps working, see the fast-expiry doc).
* **Logout** → both cookies disappear from the Cookies panel.
* Chat: open a conversation, send a message → the socket connects. In
  **Network → WS**, the handshake payload carries a ticket, not a JWT.
* Revocation smoke test: `Logout all devices` in another tab's session list,
  then let the socket reconnect → the next handshake is refused and the banner
  appears (history still loads over REST).

## 7. Knobs

| Knob | Where | Default | Effect |
|---|---|---|---|
| `accessTokenMinutes` | Security settings per company (`CompanySecurityPolicy`) | 15 | `Max-Age` of `crewly_access` |
| `refreshTokenDays` | same | 30 | `Max-Age` of `crewly_refresh` (sliding) |
| `REFRESH_RACE_GRACE_MS` | `Backend/src/utils/tokenService.js` | 60 s | the tab-race window (see the fast-expiry doc) |
| `CHAT_TICKET_TTL_SECONDS` | `Backend/src/socket/socketConfig.js` | 60 s | how long a chat handshake ticket lives |
| `CLIENT_URL` / `CLIENT_ORIGINS` | env | — | CORS allowlist; the CSRF preflight dies here for foreign origins |

## 8. Incident quick reference

| Symptom | Likely cause | First check |
|---|---|---|
| Every write 403 `CSRF_HEADER_REQUIRED` | the caller is a browser client that does not send `X-Requested-With` (a hand-rolled `fetch`, a proxy that strips headers, `allowedHeaders` lost the header) | Network tab → request headers; `src/app.js` CORS list |
| Login "works", 401 after 15 minutes | only one of the two cookies was written (a `setHeader` replacing the other) | `Backend/test/cookieSession.test.js` |
| Signed out right after login | `Path`/`SameSite` mismatch: the cookie is set but never sent (prod `None` without `Secure`, or an API on a different site) | Cookies panel → the request's Cookie header |
| Chat never connects, `503` on `/chat-ticket` | Redis down (chat realtime is unavailable by design) | backend log `[ChatSocket]` lines |
| Chat connects then drops after a minute | a ticket that was never re-minted (should be automatic on `UNAUTHORIZED`) | console log from `chatSocketClient.js` |

**Never** log a token, a cookie header, or a ticket. The suites in
`Backend/test/` include source scans for exactly that (`phase33Closeout.test.js`
plus the console-scan in the same file).
