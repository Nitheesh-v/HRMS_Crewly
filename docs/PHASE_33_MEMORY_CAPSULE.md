# CREWLY — PHASE 33 (+ SESSION/AUTH) MEMORY CAPSULE

> **What this file is.** A start-here handoff for a NEW Agent/session on this
> repo. §0 is a self-contained prompt you can paste into a fresh chat; §1–§13
> are the detailed reference behind it. **The repository is always the source
> of truth** — if this file and the code disagree, the code wins and this file
> gets fixed.
>
> **Verified state at write time:** branch `arena/01a0c87e-hrms-crewly`, tip
> `43afd4d` (parent `9170a60`; base of the branch `52c31fb` — "till phase 32").
> `npm run test:all` = **2518 tests / 88 suites / 0 fail**. Frontend build ✓
> 1.08 s (`dist/assets/index-nlQYrWtC.js`, gzip 102.09 kB). **No secret values
> anywhere in this file.** Earlier capsules: `docs/PROJECT_MEMORY_CAPSULE.md`
> (through Phase 30) and `docs/PHASE_32_MEMORY_CAPSULE.md` (Phase 32 — still the
> best description of the infrastructure layer).

---

## 0. THE OPENING PROMPT (paste this into a new chat)

```text
You are continuing work on CREWLY, a multi-tenant SaaS HRMS + RMS/ATS,
at /home/user/HRMS_Crewly (branch arena/01a0c87e-hrms-crewly — always work on
this branch, never another; commit and push to it with git/gh).

STACK: Backend = Node ESM + Express 5 + MongoDB (Atlas, Mongoose) + Redis +
BullMQ + Socket.IO (chat only) + Cloudinary (private storage) + Razorpay +
SMTP. Frontend = Vite + React + Redux Toolkit + react-router + Tailwind.
Workers run as a separate process. Hermetic tests are node:test files in
Backend/test/ (FLAT directory, explicit paths in package.json scripts).

READ FIRST, IN THIS ORDER: docs/PHASE_33_MEMORY_CAPSULE.md (this file, the
current state), README.md, docs/PHASE_33_CHAT_HUB.md (§22 close-out summary,
§23 session/cookie), docs/COOKIE_SESSION.md, docs/SESSION_REFRESH_RESILIENCE.md,
docs/PHASE_33_CHAT_RUNBOOKS.md, docs/PHASE_32_MEMORY_CAPSULE.md (infrastructure
laws that still apply). Then inspect the actual code before touching anything.

HOW I WANT YOU TO WORK (non-negotiable):
1. AUDIT FIRST. Inspect the real files, grep for call sites, check what tests
   already pin. Never propose a change from memory. Report what you found.
2. ONE build plan. After the audit, state exactly ONE plan (files, approach,
   risks, what stays unchanged). No menu of options unless I ask.
3. Implement. Small, surgical, in the repo's existing style (ES6+/ESM, the
   existing comment convention, controller comments).
4. Test hermetically (fake models / dependency injection — no Mongo, no Redis,
   no network in tests). Then run the full suite.
5. Docs are part of the work, not an afterthought. If behaviour changed, the
   doc changes in the same commit.
6. Commit + push to arena/01a0c87e-hrms-crewly with a long explanatory message
   (why, not just what), then report.

REPORT FORMAT (every unit, no exceptions):
  · What was actually wrong (the real cause, not a guess)
  · What you changed and why
  · FILES CHANGED — Added / Modified / Deleted (paths)
  · EXACT test results — ACTUAL totals (e.g. 2491 → 2518, 88 suites, 0 fail).
    Never estimate, never carry over an old number, never say "should pass".
  · Frontend build + lint result if frontend changed
  · Docs updated (file list)
  · Honest flags (anything unverified, anything I must click/test myself)

HARD RULES:
  · ZERO new npm packages unless I explicitly authorize one. Stop and ask.
  · Never weaken security to make something work. Never print, log, commit or
    repeat a secret. Never print raw tokens or PII.
  · Multi-tenancy: every query scoped by companyId; tenant authority comes ONLY
    from req.companyId — never from a client-supplied id.
  · Never `git reset --hard`. Never `git push --force`. Never switch branches.
  · Never claim exactly-once delivery/processing (queues are at-least-once),
    never claim malware scanning, never claim capacity/N-user numbers (none
    exist), never claim my localhost acceptance.
  · If tests fail, report the real failing output — BLOCKED is not PASS.
  · PowerShell-first commands for me (I am a beginner; give exact copy-paste
    lines, no bash-only syntax), with a hard-reload/restart step where needed.
  · If something is genuinely ambiguous or security-sensitive, STOP and ask me.
  · Reply to me in ENGLISH with short bullets + code blocks (owner's instruction;
    earlier sessions used Tamil-English — use plain English unless he asks otherwise).

CURRENT OPEN ITEMS: my localhost acceptance of Phase 33.10–33.12, the UI/UX
pass and the session/cookie work (33.14) was never confirmed; the super-admin
(AdminSession) portal still keeps its bearer token in localStorage; see §11 for
the candidate next units. Ask me which one before starting.
```

---

## 1. What the product is

**Crewly** — multi-tenant SaaS **HRMS + Enterprise RMS/ATS**, with billing,
platform super-admin, and a public career portal.

- **Backend/**: Node.js **ESM**, Express 5, MongoDB Atlas (Mongoose), Redis +
  BullMQ (jobs, scheduled work, cache), Socket.IO (chat realtime only),
  Cloudinary (private file storage), Razorpay (billing), SMTP (email),
  winston (logs), helmet, jsonwebtoken, bcryptjs, multer, pdfkit.
- **Frontend/**: Vite + React, Redux Toolkit, react-router, Tailwind v4.
  One SPA serves: tenant app (`/app/*`), platform super-admin
  (`/super-admin/*`), BGV verifier portal, attendance kiosk, public career
  portal / candidate consent pages.
- **Workers**: `node src/workers/index.js` (separate process from the API).
- **Tests**: `node --test`, files FLAT in `Backend/test/` (115 on disk), wired
  by explicit paths in `package.json` (`test:all` = the baseline, 112 files;
  111 script entries exist, many per-domain).
- **Phases 1–32 are closed.** Phase 33 = the chat hub, closed at 33.12, then
  session/auth work labelled 33.13 and 33.14 (see §7).

**Durable product laws** (from Phase 32, still enforced):

- Multi-tenancy is NON-NEGOTIABLE: every business document is scoped by
  `companyId`; tenant authority is `req.companyId` derived from the verified
  token + the Mongo user, never a client value.
- There is **no separate Employee collection** — employees are `User` records
  with payroll/profile fields.
- Middleware order: **auth → tenant → subscription → RBAC → cache**; the cache
  never authorizes.
- Attendance is append-only (regularization overlays); `PayrollResult` is
  immutable/versioned; `PaymentStatus` is never manually set to PAID.
- Secrets are hash-only at rest (reset tokens, kiosk device secrets/PIN, QR
  challenges) and `select:false`.
- Errors are generic (no enumeration oracles); never raw user input into
  `$regex` (use `src/utils/searchInput.js`); never CORS `*`; no
  `FLUSHALL`/`FLUSHDB`/`KEYS`/wildcard deletes against production Redis.
- Redis/queue keys are namespaced `crewly:<env>:`.
- Files are private: no permanent public URLs, auth-gated download, `Cache-Control: private, no-store, max-age=0`.
- Production local-disk storage is refused; scanners never fake a CLEAN verdict.

## 2. Repo map, ports, commands

```
Backend/
  src/
    app.js  server.js           Express app + HTTP server (socket attach BEFORE listen)
    config/                     env.js, logger.js, redis.js, queueConfig.js, proxyTrust.js
    controllers/                33 flat + domain subdirs (attendance, bgv, chat, payroll,
                                platform, recruitment) — verified 100 files
    routes/                     25 flat + the same domain subdirs — 56 files
    validators/                 50 files (flat + domain subdirs)
    models/                     128 FLAT (User, Company, SecuritySession, RefreshToken,
                                SecurityEvent, Chat*, …) — flat on purpose
    services/                   attendance, bgv, chat, ops, payroll, recruitment + flat
    middlewares/                protect/authMiddleware.js, tenantMiddleware.js, securityRateLimit.js, …
    utils/                      tokenService.js, securityPolicy.js, securityauditService.js, searchInput.js, …
    infrastructure/             observability/ realtime/ (SSE gateway + one-time tickets) storage/
    socket/                     Socket.IO chat layer (initSocketServer, socketAuth, socketConfig, handlers…)
    workers/                    BullMQ processors + registry
  test/                         115 FLAT node:test suites (112 of them wired into test:all)
  scripts/                      ops CLIs (config-check, chat-blank-check, load/, preview/)
Frontend/
  src/
    pages/<domain>/             login, register, dashboard, chat, attendance, payroll, admin, bgvVerifier, kiosk, …
    components/  layout/  routes/  hooks/  utils/
    redux/slices/               AuthSlices.js, chatSlice.js, …
    services/                   api.js (axios), authService.js, chatService.js, realtime/chatSocketClient.js, …
    style.css                   the single stylesheet (there is NO index.css)
docs/                           phase hubs, runbooks, capsules (see §12)
```

**Ports & dev commands**

| What | Command | Where |
|---|---|---|
| Backend API + socket | `npm run dev` (nodemon) — default `PORT=5000` | `Backend/` |
| Frontend | `npm run dev` (Vite, **5173**) | `Frontend/` |
| Full backend suite | `npm run test:all` | `Backend/` |
| Phase 33 suites | `npm run test:chat` | `Backend/` |
| Session units | `npm run test:session`, `npm run test:cookie` | `Backend/` |
| Config truth | `npm run config:check` | `Backend/` |
| Blank message scan | `npm run chat:blank-check` | `Backend/` |
| Frontend build | `npm run build` | `Frontend/` |
| Frontend lint | `npx eslint src/...` | `Frontend/` |

`Backend/src/config/env.js` defaults: `PORT=5000`, `NODE_ENV=development`,
`CLIENT_URL=http://localhost:5173`. In production, `MONGO_URI` and a real
`JWT_SECRET` are required (`npm run config:check --production` enforces it;
config errors name KEYS ONLY, never values).

**Preview environment (Arena sandbox only):** dev servers must bind `0.0.0.0`,
must accept the proxied preview host/origin (Vite `server.allowedHosts` /
backend CORS allowlist), and browser code must call the API through a
**relative** path (Vite `server.proxy`) — never `localhost` from the browser.

## 3. The law: standing rules (never violate)

These were given explicitly by the owner across sessions. Treat them as law
until he reverses them.

**Process**

1. **Audit before code.** Inspect the repo first; never propose from memory.
2. **Exactly ONE build plan** after the audit (files, approach, risks, what
   stays). No option menus unless he asks.
3. One unit at a time, on explicit authorization. Do not start the next unit
   because the previous one finished.
4. **Report ACTUAL totals.** Never carry an old number forward, never estimate,
   never say "should pass". `BLOCKED ≠ PASS`.
5. **Mandatory report fields:** cause · fix · **FILES CHANGED (Added/Modified/
   Deleted)** · **exact test results** · docs-updated list · honest flags.
6. Handoff ends with the exact awaiting-acceptance line when a prompt demands
   one (e.g. `Phase 33.12 awaiting localhost acceptance.` + `pit rules locked in 🏁`).
7. Never claim the owner's localhost acceptance — he does that himself.
8. **PowerShell-first** instructions (there is no bash on his machine), beginner
   level, exact lines, plus "restart the server / hard reload" where needed.

**Scope & dependencies**

9. **ZERO new npm packages** unless explicitly authorized (only
   `socket.io-client` was allowed, in 33.8). No `npm audit fix --force`, no
   legacy `bull`, no new vendors, no production deploy, no seed/demo scripts,
   no chaos toggles, no `/metrics` endpoint.
10. Test/documentation structure improvements only — no broad restructures, no
    moving production code for aesthetics.
11. Tests are **FLAT** in `Backend/test/` with **clearly named** files
    (`chat*`, `cookieSession`, `sessionRefreshResilience`), never a nested
    `test/phase33/` folder.

**Security & data**

12. Never weaken security to make something work; security-sensitive
    discrepancies → STOP and report.
13. Never print, log, commit or repeat a secret (the owner once leaked a Redis
    password in a screenshot; it was rotated — never store or echo it). No raw
    tokens/PII in logs.
14. Multi-tenancy: `req.companyId` only. Never trust a client-supplied tenant id.
15. Never `git reset --hard`; never force-push; never switch branches; PR only
    when he asks.
16. Never claim **exactly-once** (queues are at-least-once), never claim
    **malware scanning**, never **invent capacity claims** ("supports N users").
17. Admin/moderation audit rows carry **ids + a bounded reason, never message
    text**.

**Docs & truth**

18. Docs must be truthful: runbooks use **DETECT / IMPACT / DO / DO NOT /
    VERIFY / ESCALATE**. Live checks are **opt-in**, and never run destructive
    Redis operations in hot paths.
19. Stale test pins are **inverted, not deleted** (keep the guarantee, change
    the mechanism) — with a comment saying why.
20. Chat feature locks (Phase 33, still binding): SSE stays (32.11 as-is);
    Socket.IO is **chat-only**; **no presence/typing/last-seen**; read model
    **C1 only** (no per-message receipts); no emojis in new UI; metadata-only
    logging; payload caps early with `VALIDATION_ERROR`; Redis-down must never
    fail open.
21. "Chat enabled + Redis off" is a pre-flight **WARNING**, never a blocked
    deployment (pinned by `deploymentConfig.test.js`).

## 4. Working strategy (the loop that has been working)

```
1. AUDIT      grep the real call sites; read the tests that already pin the
              behaviour; check git log for why it is the way it is.
2. PLAN       one plan, with "what does NOT change" stated.
3. BUILD      smallest correct change; follow local conventions.
4. TEST       hermetic suite first (fake models via DI), then npm run test:all.
5. BUILD UI   Frontend: npm run build (+ eslint on the touched files).
6. DOCS       hub/runbook/capsule update in the SAME commit.
7. COMMIT     long message: symptom → root cause → mechanism → tests → docs.
8. REPORT     FILES CHANGED + exact totals + honest flags. Then STOP.
```

Notes that keep paying off:

- Every non-trivial unit gets its **own hermetic test file** whose comments
  explain *why each assertion exists* (the repo's house style).
- Source-pin tests (regex over a source file) are used to stop regressions in
  wiring/ordering — keep them **shape-tolerant** (whitespace/prettier-proof).
- When a fix changes a documented mechanism, update the doc **in the same
  commit** and say which docs changed.
- Verify claims against the running code before writing them (`node -e`
  checks, grep for consumers, `git log -S` for history).

## 5. Reporting contract (copy this shape)

```
## Why it happened
  <the actual mechanism, with the code path>
## Fix
  <what changed, and what deliberately stayed the same>
## FILES CHANGED
  Added:     path (what it contains)
  Modified:  path (one line why)
  Deleted:   none
## Tests
  npm run test:all  →  <exact> tests / <exact> suites / <exact> fail  (before → after)
  Frontend build    →  ✓ <time>, <bundle> (gzip <size>)
  eslint            →  <n> errors / <n> warnings
## Docs updated
  <file list, one line each>
## Honest flags
  <what is NOT verified, what he must click himself, what remains>
```

## 6. Phase 33 — the chat hub (33.1 → 33.12), what shipped

Authoritative summary: **`docs/PHASE_33_CHAT_HUB.md` §22** (purpose, topology,
data model, REST surface, socket protocol, security posture, degraded modes,
the 14-row verification matrix, the deferred list). Runbooks:
**`docs/PHASE_33_CHAT_RUNBOOKS.md`** (§7 is the opt-in two-instance live proof).

| Unit | Scope | Notable law |
|---|---|---|
| 33.1 | Socket.IO foundation + JWT handshake + Redis adapter + `FEATURE_UNAVAILABLE` gate | socket attaches BEFORE `listen()`; `io.close()` also closes the HTTP server so shutdown never calls it; **`cookie:false` — no cookies on sockets**; auth payload is the ONLY token source |
| 33.2 | Chat models + indexes (`ChatConversation`, `ChatMessage`, `ChatMessageEdit`, `ChatAttachment`) | Mongo is truth |
| 33.3 | Conversation REST (create/list/get, membership) | membership enforced on every read |
| 33.4 | History REST — keyset `seq` pagination, tombstone-safe | C1 read model only |
| 33.5 | Join + send over the socket (ACK + idempotency + broadcast) | per-socket write guard |
| 33.6 | Edits (history, `editVersion` concurrency) + tombstone delete | disabled conversation blocks writes, history stays readable |
| 33.7 | Read cursors + unread counts | no per-message receipts |
| 33.8 | Frontend chat UI + socket lifecycle + honest degraded states | `socket.io-client` added here (the only new dep) |
| 33.9 | Moderation | moderators delete but never edit others' messages; audit = ids + bounded reason, never text |
| 33.10 | Attachments | private storage, no permanent public URLs, auth-gated download, `private, no-store, max-age=0`; **never claim malware scanning** — `scanState` is truthful; server-constructed storage keys; hermetic tests via DI |
| 33.11 | Hardening | reuses the 32.4 shared Redis limiter (no new deps); Redis-down must NOT fail open; REST 429 in the existing error style; stable `RATE_LIMITED` socket refusal; conservative payload caps + early `VALIDATION_ERROR`; metadata-only logging |
| 33.12 | Close-out | verification matrix rows 1–11 + frontend checks; runbook format DETECT/IMPACT/DO/DO NOT/VERIFY/ESCALATE; opt-in live checks with no destructive Redis ops |

**Captions decision (shipped):** one message may carry text **and** a file; the
file may carry an optional caption that must satisfy `hasVisibleText` and
`≤ CHAT_MESSAGE_TEXT_MAX`; a file with zero references is still refused
("A file is required."); SYSTEM/deleted messages carry no body.

**Known stale label (harmless):** hub §22.5 writes `chat:message:edited` while
the source emits `chat:message:updated`. Not pinned by any test — fix only if
that doc is touched again.

## 7. Session & auth architecture as of 33.13 / 33.14

Two units of session work were done after the chat hub. They are **cross-cutting**
(they touch every authenticated request and the chat handshake), so they are
documented in **`docs/COOKIE_SESSION.md`** (model, CSRF, verification steps,
incident table) and **`docs/SESSION_REFRESH_RESILIENCE.md`** (the rotation race),
and summarised in **hub §23**.

### 33.13 — "session expired too fast" (commit `9170a60`)

Three real mechanisms, all fixed:

1. **A two-tab rotation race was read as theft.** The refresh cookie is shared
   by every tab and rotation is single-use, so the losing tab presented a token
   the winner had *just* rotated → the old code revoked the whole token family
   **and** bumped `User.tokenVersion` → every tab and device signed out. Now a
   token presented after use inside `REFRESH_RACE_GRACE_MS` (60 s, in
   `Backend/src/utils/tokenService.js`), not explicitly revoked, answers
   `409 REFRESH_IN_PROGRESS` + a `REFRESH_TOKEN_CONCURRENT_REFRESH` security
   event: no tokens, no family revocation, no `tokenVersion` bump, cookie
   untouched. Outside the window, reuse is still theft (family revoked,
   `tokenVersion` bumped, cookies cleared).
2. **Any refresh failure burned the cookie.** `securityAuthController.refresh`
   cleared the refresh cookie for ANY error → a transient 5xx became a permanent
   logout. Now only `401`/`403` clear it (and both cookies with it).
3. **`clearRefreshCookie` was not clearing.** `cookieString()` guarded
   `Max-Age` with `if (options.maxAge)`, which skips `0`, so the delete path
   emptied the value but never expired the cookie. Guard is now
   `!== undefined && !== null`.

Frontend: the refresh path takes a cross-tab **Web Lock**
(`navigator.locks.request('crewly.refresh', …)`) and retries `409` (≤3 attempts,
250–500 ms jitter) — never a logout.

### 33.14 — the browser session is a cookie, and the socket a ticket (`43afd4d`)

| | Before | Now |
|---|---|---|
| Refresh token | HttpOnly cookie `crewly_refresh`, `Path=/api/auth` | unchanged |
| Access token | login/refresh **body** → `localStorage['infolexus_token']` → `Authorization: Bearer` | **HttpOnly cookie** `crewly_access`, `Path=/api`, `Max-Age = accessTokenMinutes` |
| What JS holds | a 15-minute credential anyone could read and post elsewhere | nothing — the store keeps the user profile only |
| Socket handshake | the access JWT in the auth payload | a **60-second chat ticket** |
| Cross-site writes | bearer token (nothing to protect) | `SameSite` + required `X-Requested-With: XMLHttpRequest` |

- `Secure` + `SameSite=None` **in production only**; `Lax` + insecure in dev.
- `Path=/api` and never `/` — the browser must not attach a long-lived
  credential to `/socket.io` (33.1's locked "no cookies on sockets" decision
  stays intact, so cross-site WebSocket hijacking stays structurally
  impossible).
- **CSRF:** cookie-authenticated, state-changing requests must carry
  `X-Requested-With: XMLHttpRequest`, else `403 CSRF_HEADER_REQUIRED` (written
  directly in `protect` — the shared error pipeline carries no custom `code`).
  `GET/HEAD/OPTIONS` stay open; bearer callers are never gated.
  `X-Requested-With` must stay in the CORS `allowedHeaders` of `src/app.js`.
  `POST /auth/refresh` is the only cookie route outside `protect`, so it mounts
  `requireCsrfProof` explicitly.
- **Precedence in `protect`:** explicit `Authorization: Bearer` first, then the
  cookie. `req.authSource` records which one won. Everything downstream
  (tokenVersion, SecuritySession row, tenant, platform/verifier/kiosk gates) is
  unchanged.
- **The socket ticket:** `POST /api/realtime/chat-ticket` (protect +
  tenantContext, customers only) binds a 64-hex ticket in the shared store to
  `{userId, companyId, sessionId, tokenVersion}` for `CHAT_TICKET_TTL_SECONDS`
  (60 s). The handshake presents it in `auth.token`; `verifyChatSocketToken`
  accepts a **ticket** (no dot) or a **JWT** (two dots) and runs the SAME Mongo
  gates for both. It is reusable inside its TTL on purpose (a socket reconnects
  on its own and cannot mint mid-reconnect) — the SSE ticket keeps its
  single-use contract (`consumeReusable()` refuses anything not marked
  `reusable`, `consume()` is still an atomic GET+DEL). Redis down → `503`, the
  chat banner appears, REST keeps working.
- **Platform portal is a different session and is unaffected:** super-admin /
  support / billing keep a bearer `AdminSession` token, now in its own key
  `infolexus_platform_token` (a legacy `infolexus_token` is migrated once for
  platform users and purged for everyone else). So a customer login can never
  leave a stray platform header on a tenant call, or the reverse.
- Also fixed on the way: `res.setHeader('Set-Cookie', …)` **replaces**, so
  writing two cookies on one response silently deleted the first (all cookie
  writes now append); and `readCookie()` could throw on a malformed
  percent-escape while the access cookie is read on **every** `/api` call.

**Policy knobs:** `accessTokenMinutes` (default **15**), `refreshTokenDays`
(default **30**, sliding via `SecuritySession.expiresAt`) — per-company via
`CompanySecurityPolicy` / the Security Settings page (`securityPolicy.js:23-24`).
`REFRESH_RACE_GRACE_MS = 60 s`, `CHAT_TICKET_TTL_SECONDS = 60 s`.
`env.JWT_EXPIRES_IN='7d'` + `generateToken.js` are legacy and are NOT the
customer login path.

## 8. Known pitfalls & dead ends (do not retry these)

| Pitfall | Truth |
|---|---|
| `errorHandler` drops a custom `err.code` | It emits no `code`. Any code-bearing reply (`409 REFRESH_IN_PROGRESS`, `403 CSRF_HEADER_REQUIRED`) must be written directly with `res.status(...).json({...})` |
| Truthiness checks on `maxAge` | `if (options.maxAge)` skips `0` — the exact value the cookie-delete path needs |
| `Set-Cookie` via `setHeader` twice | **Replaces.** Append (read `getHeader`, push, set) |
| Socket handshake reading cookies | Locked out in 33.1 (CSWSH). The ticket replaced the token instead |
| `io.close()` | Also closes the underlying HTTP server — never inside graceful shutdown |
| `attach()` after `listen()` | Engine.IO initialises on `listening`; attaching late leaves `ws` dead while polling still "works" |
| eslint 10 `react-hooks/set-state-in-effect` | Do not setState synchronously in an effect — derive it (see MessageList's `scrollState` template) |
| `.auth-*` CSS "missing" | It never existed; it is defined once in `Frontend/src/style.css` (there is no `index.css`) |
| Multi-line JSX vs a source-pin regex | Pins must tolerate newlines/whitespace, e.g. `/\{error && \(\s*<p[^>]*>\s*\{error\}/` — the `>` matters |
| Markdown table edits | A scripted replacement once wiped the hub unit-map. Run `node --test test/phase33Closeout.test.js` after every §1/§22 edit |
| Importing `routes/index.js` under `node --test` | Hangs. Smoke-test route modules with `MONGO_URI` set instead |
| `grep` with zero matches in a `&&` chain | Kills the chain — use `|| true` / separate commands |
| Claiming security guarantees | Never "exactly-once", never "malware scanned", never "supports N users" |

## 9. Environment / sandbox quirks (Arena)

- **The sandbox re-clones the repo stale on session restore.** Local commits can
  vanish from the local object store while the working tree stays correct. Repair
  (never `--hard`):

  ```bash
  git fetch origin '+refs/heads/*:refs/remotes/origin/*'
  git rev-parse origin/arena/01a0c87e-hrms-crewly   # confirm the expected tip
  git reset --mixed origin/arena/01a0c87e-hrms-crewly   # index/HEAD only, files untouched
  git status --short                                # expect clean
  ```

- `node_modules` disappears → `npm install --no-audit --no-fund` on that side
  (Frontend ≈249 packages; a missing `vite` binary shows as
  `sh: 1: vite: not found`).
- `Backend/.env` disappears → recreate a **gitignored** dev `.env` with
  synthetic values (`MONGO_URI`, `JWT_SECRET`, `CLIENT_URL`, `PORT`, `NODE_ENV`,
  `JWT_EXPIRES_IN`, `FIELD_ENCRYPTION_KEY`) or ~14 suites exit on import-time
  guards. Never commit it; `.env.example` carries names/placeholders only.
- No `mongod`/Redis binaries in the sandbox → hermetic tests only (fake models
  via DI). Live Redis checks are opt-in and use the owner's cloud instance.
- Dev servers must bind `0.0.0.0` and accept the preview host (Vite
  `allowedHosts`, backend CORS allowlist); browser code uses relative URLs and
  the Vite proxy for `/api` and `/socket.io`.

## 10. Current state (verified at `43afd4d`)

- Branch `arena/01a0c87e-hrms-crewly`; `main` is still `52c31fb` ("till phase
  32") — **everything from 32.9 onward lives on the branch only**, so the PR is
  what lands it.
- `npm run test:all` → **2518 / 88 suites / 0 fail** (2491 at the 33.12
  close-out, 2498 after 33.13, 2518 after 33.14).
- Frontend build ✓ 1.08 s; `index-nlQYrWtC.js` 337.25 kB / gzip 102.09 kB.
- Newest test files: `Backend/test/cookieSession.test.js` (20),
  `Backend/test/sessionRefreshResilience.test.js` (7),
  `Backend/test/phase33Closeout.test.js` (11).
- Newest docs: `docs/COOKIE_SESSION.md`, `docs/SESSION_REFRESH_RESILIENCE.md`,
  hub §23.
- **Not verified by the agent:** the owner's localhost acceptance of 33.10,
  33.11, 33.12, the UI/UX pass (`ec6c2b7`) and the session work (33.13/33.14).

## 11. Candidate next units (NOT authorized — ask first)

1. **Owner acceptance runs** for 33.10–33.12 + UI pass + 33.13/33.14 (his own
   localhost clicks, e.g. the two-tab expiry test).
2. **Platform portal cookie migration** — super-admin/support/billing still
   keep a bearer `AdminSession` token in localStorage; bring it to HttpOnly
   cookies with its own CSRF story (different session model, so a separate unit).
3. **`refreshRateLimit` 429 handling** — a 429 on `/auth/refresh` currently
   takes the same path as an expired session; the race retry only handles 409.
4. **Hub §22.5 label fix** (`chat:message:edited` → `chat:message:updated`) if
   that doc is touched again.
5. Anything the owner names next (phases are numbered only when he says so).

## 12. Doc map

| File | What it is |
|---|---|
| `docs/PHASE_33_MEMORY_CAPSULE.md` | **this file** — current state, rules, strategy |
| `docs/PHASE_33_CHAT_HUB.md` | the chat hub (2564 lines, 134 sections): build log §1–§21, **§22 close-out summary**, §23 session/cookie cross-cutting |
| `docs/PHASE_33_CHAT_RUNBOOKS.md` | DETECT/IMPACT/DO/DO NOT/VERIFY/ESCALATE runbooks + §7 opt-in live proof |
| `docs/COOKIE_SESSION.md` | the cookie session model, CSRF, socket ticket, self-verification steps, incident table |
| `docs/SESSION_REFRESH_RESILIENCE.md` | the rotation race, the 60 s grace window, the cookie-clear rules |
| `docs/PROJECT_MEMORY_CAPSULE.md` | full project capsule (Phases 1–30) |
| `docs/PHASE_32_MEMORY_CAPSULE.md` | infrastructure laws that still apply (CDN, rate limits, observability, storage, deployment) |
| `docs/PHASE_32_RUNBOOKS.md`, `docs/PHASE_32_ARCHITECTURE.md` | Phase-32 operations/architecture truth |
| `docs/*_LOCALHOST_ACCEPTANCE_GUIDE.md` | per-unit acceptance guides (owner-run) |

## 13. Owner's machine: exact commands (PowerShell)

```powershell
# --- get the latest code --------------------------------------------------
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly
git pull

# --- run the app (two terminals) ------------------------------------------
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev                     # API + socket on :5000

cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm run dev                     # UI on :5173  →  open http://localhost:5173

# --- run the tests (no Redis/Mongo needed) --------------------------------
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run test:all                # everything
npm run test:chat               # Phase 33 chat + realtime
npm run test:cookie             # the cookie session unit
npm run test:session            # the refresh-race unit
npm run config:check            # configuration truth

# --- if npm says a command/module is missing -------------------------------
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm install

cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm install
```

Browser habits that matter after a session/auth change: **hard reload
(`Ctrl+Shift+R`)** after pulling, and check **F12 → Application → Local Storage
/ Cookies** (there should be no `infolexus_token`; `crewly_access` and
`crewly_refresh` should both be marked `HttpOnly`).
