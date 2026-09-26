# SESSION REFRESH RESILIENCE

**Symptom:** "my session expires too fast" — signed out mid-work, usually after
the 15-minute access token runs out, most often with **two or more tabs open**.
The login screen comes back with `?session=expired`, which is the client telling
you the refresh call failed — not that the session was actually over.

## The three mechanisms behind it

### 1. A rotation race was treated as theft (the main one)

The refresh cookie (`crewly_refresh`) is **shared by every tab**, and rotation is
**single use**.

1. Tab A and Tab B both reach access-token expiry at the same moment.
2. Both POST `/api/auth/refresh` with the same cookie value.
3. Tab A wins: the token is marked used, a successor is created, a fresh cookie
   is set.
4. Tab B presents the token that A **just** rotated. The server read that as
   token theft: it revoked the whole token family **and** bumped
   `User.tokenVersion`.
5. Bumping `tokenVersion` invalidates **every** access token that user holds —
   so the user is signed out of both tabs, and every other device too.

Using two tabs is not theft. Fixed with a **grace window**
(`REFRESH_RACE_GRACE_MS = 60 s`): a token presented after use, inside the window,
with no explicit revocation, is answered `409 REFRESH_IN_PROGRESS` — no tokens,
no family revocation, no `tokenVersion` bump, **and the fresh cookie is left
alone**. Outside the window, reuse is still theft: family revoked, `tokenVersion`
bumped, cookie cleared. The security property is unchanged.

The browser also stops creating the race at all: the refresh path takes a
cross-tab **Web Lock** (`navigator.locks`), so only one tab rotates at a time —
and a tab that was beaten retries on the `409` instead of rotating a second
time. (Until 33.14 the beaten tab also adopted the winner's token out of
`localStorage`; there is no client-side token to adopt any more, because the
session now rides HttpOnly cookies — see `docs/COOKIE_SESSION.md`.)

### 2. Every refresh failure burned the cookie

`securityAuthController.refresh` called `clearRefreshCookie(res)` in its `catch`
for **any** error. Clearing the refresh cookie is a one-way door — the user
cannot recover without typing their password again — so a transient Mongo blip
or a race became a permanent logout. Now only a dead session (`401`/`403`)
clears it; `409` and `5xx` leave it intact so the next attempt can succeed.

### 3. The clear was not actually clearing

`cookieString()` guarded `Max-Age` with `if (options.maxAge)` — which skips `0`,
the one value the clear path depends on. `clearRefreshCookie()` emptied the value
without expiring the cookie, so it survived as a session cookie. It now emits
`Max-Age=0` (a real delete).

## What the user actually sees now

| Situation | Before | After |
|---|---|---|
| Two tabs refresh together | both signed out, all devices invalidated | one refresh, both tabs continue |
| Refresh hits a 5xx / slow Mongo | signed out permanently | retried on the next request, session intact |
| Access token expires while reading | one 401 → silent refresh → continue | same, minus the race |
| Refresh token genuinely old/revoked | signed out | signed out (unchanged) |

## Knobs

- **Access token lifetime** is per company:
  `CompanySecurityPolicy.sessions.accessTokenMinutes` (default **15**). Longer
  lifetimes mean fewer refreshes; Security Settings exposes the session policy.
- **Refresh lifetime:** `refreshTokenDays` (default **30**).
- **Race window:** `REFRESH_RACE_GRACE_MS` in `src/utils/tokenService.js` (60 s).

## Verify

```powershell
cd Backend
npm run test:session     # the hermetic pin for all three mechanisms
npm run config:check     # env sanity
```

Live, the honest check is a two-tab one: sign in twice (two tabs), wait for the
access token to expire (15 min by default), then use both tabs. Neither should
return to the login screen, and the API log should show `REFRESH_TOKEN_ROTATED`
(with no `REFRESH_TOKEN_REUSE_DETECTED`).

Security events worth watching in an incident: `REFRESH_TOKEN_REUSE_DETECTED`
(real theft — family revoked) and `REFRESH_TOKEN_CONCURRENT_REFRESH` (a benign
race — nothing was revoked).
