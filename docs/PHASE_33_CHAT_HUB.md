# CREWLY — PHASE 33: CHAT HUB

Multi-tenant, membership-authorized, multi-replica in-app chat for the Crewly
tenant app. Built on Mongo (truth) + Redis (fanout) + Socket.IO (transport).
No external vendor, no third-party API.

**Status:** 33.1 → 33.11 IMPLEMENTED · TESTED. **For the authoritative summary of
the whole phase (scope, architecture, data model, REST + socket surface, security
posture, degraded modes, the verification matrix and the deferred list), read
[§22](#22-phase-33-close-out--the-authoritative-summary-3312) — the section below
is the unit-by-unit build log that got us there.**

---

## 1. Unit map

| Unit | Scope | Status |
|---|---|---|
| **33.1** | **Realtime foundation: Socket.IO server + JWT handshake + Redis adapter + FEATURE_UNAVAILABLE gate** | **IMPLEMENTED · TESTED** (`chatSocketFoundation`, 88 tests) |
| **33.2** | **Chat persistence models + indexes (`ChatConversation`, `ChatMessage`, `ChatMessageEdit`, `ChatAttachment`)** | **IMPLEMENTED · TESTED** (`chatModels`, 60 tests) |
| **33.3** | **Conversation REST APIs (create/list/get + member management, membership enforced)** | **IMPLEMENTED · TESTED** (`chatConversations`, 13 tests) |
| **33.4** | **Message history REST API (keyset seq pagination, membership, tombstone-safe)** | **IMPLEMENTED · TESTED** (`chatHistory`, 9 tests) |
| **33.5** | **Socket protocol: server-authorized join + send (ACK + idempotency) + broadcast** | **IMPLEMENTED · TESTED** (`chatSocketSend`, 6 tests) |
| **33.6** | **Edits (with history + `editVersion` concurrency control) + tombstone deletes** | **IMPLEMENTED · TESTED** (`chatEditDelete`, 10 tests) |
| **33.7** | **Read cursors + unread counts (C1 model only, no per-message receipts)** | **IMPLEMENTED · TESTED** (`chatReadMarkers`, 10 tests) |
| **33.8** | **Frontend chat UI + socket lifecycle + honest degraded states** | **IMPLEMENTED · TESTED** (`chatRealtimeNudge`, `chatSocketResilience`, frontend build) |
| **33.9** | **Moderation + admin controls + moderation audit (no message text in audit)** | **IMPLEMENTED · TESTED** (`chatModeration`, 25 tests) |
| **33.10** | **Private attachments (auth-gated streaming, server-built keys, optional caption)** | **IMPLEMENTED · TESTED** (`chatAttachments`, 23 tests) |
| **33.11** | **Rate limits, payload caps, safe observability, incident runbooks** | **IMPLEMENTED · TESTED** (`chatHardening`, 25 tests) |
| **33.12** | **Production verification matrix + close-out docs (this unit)** | **IMPLEMENTED · TESTED** (`phase33Closeout`, see §22) |

---

# 2. PHASE 33.1 — REALTIME FOUNDATION

## 2.1 What 33.1 is

A Socket.IO server attached to the **same Node HTTP server as Express**,
authenticated for **tenant users only**, fanned out across stateless API
replicas by `@socket.io/redis-adapter`, and refused outright as
`FEATURE_UNAVAILABLE` whenever Redis is not usable.

## 2.2 What 33.1 is NOT (explicit)

**No chat product surface exists.** There are no chat models, no REST
routes/controllers/validators/services, no room-join or send/edit/delete
events, no unread counters, no attachments, no frontend code, and no
presence / typing / last-seen / activity tracking of any kind. A socket
connected under 33.1 can do nothing except exist and be counted.

This is pinned by tests, not just by intent
(`test/chatSocketFoundation.test.js` → "33.1 non-goals").

## 2.3 Topology

```
                          Browser (tenant app)
                                  |
                      Socket.IO handshake (HTTP upgrade)
                                  v
                     LOAD BALANCER  (TLS; 32.3 proxy trust)
                     /            |            \
                    v             v             v
                API #1        API #2        API #N      ← node src/server.js
                    |             |             |
        http.createServer(app)  ── SAME server ── Express + Socket.IO
                    |             |             |
                    +------+------+------+------+
                           |             |
                        MongoDB        Redis
                       (truth)    @socket.io/redis-adapter
                                  pub/sub channel prefix
                                  crewly:<env>:chat:adapter
```

Socket.IO rides the API process (no fourth process type), exactly like the
32.11 SSE foundation.

### Coexistence with the 32.11 SSE foundation (locked decision)

SSE stays **as-is**. Nothing in `src/infrastructure/realtime/*`,
`src/routes/realtimeRoutes.js` or
`Frontend/src/services/realtime/realtimeClient.js` was modified, disabled
or retired. The two transports use **different Redis namespaces**:

| Transport | Namespace | Status |
|---|---|---|
| SSE (32.11) | `crewly:<env>:realtime:*` | unchanged, `REALTIME_ENABLED=false` |
| Chat Socket.IO (33.1) | `crewly:<env>:chat:adapter` | new, `CHAT_SOCKET_ENABLED=false` |

## 2.4 Attach-order law (verified, not stylistic)

Engine.IO builds its WebSocket engine inside `init()`, which it runs on the
HTTP server's `'listening'` event (`engine.io/build/server.js:479`,
registered at `:676`). **Attaching after `listen()` silently leaves the ws
transport dead while polling still appears to work.** Therefore
`src/server.js` was refactored from `app.listen()` to
`http.createServer(app)` + `attach(server)` + `server.listen()`.

Engine.IO also caches and re-registers the server's existing `'request'`
listeners (`engine.io/build/server.js:673-690`), delegating every
non-`/socket.io` request back to Express. Verified by a live smoke run:
`/api/health/live` still returns 200 with the 32.16
`Cache-Control: private, no-store, max-age=0` header and all helmet
headers intact.

## 2.5 Handshake authentication

**Token source: `socket.handshake.auth.token` only.** Never the query
string (a token in a URL reaches proxy and access logs), never a cookie.

A Socket.IO handshake is **not** an Express request — none of
`protect`, `tenantContext`, `auditTrail` or the rate limiter runs for it.
`src/socket/socketAuth.js` therefore re-expresses
`src/middlewares/authMiddleware.js` (`protect`) with the **same
accept/reject decisions**, and the two are pinned against each other by
test so they cannot drift.

Checks, in order:

1. Token present (auth payload).
2. Signature + expiry (`jwt.verify` with `JWT_SECRET`).
3. **Principal gates** — `principalType === 'BGV_VERIFIER'` refused;
   `typ: 'kiosk'` and `typ: 'kiosk-employee'` refused. (Evaluated before
   the subject check so the internal reason is precise; both orders
   reject identically.)
4. Subject present (`sub`, falling back to `id`).
5. `User` + `SecuritySession` read **concurrently**, bounded select
   (`status role companyId tokenVersion`).
6. Account exists and `status === 'ACTIVE'`.
7. Platform roles (`SUPER_ADMIN`, `PLATFORM_ADMIN`, `SUPPORT_ADMIN`,
   `BILLING_ADMIN`) with no tenant refused — platform auth is
   `AdminSession`-based, not a tenant JWT.
8. Customer-token validity: `sessionId` present, `tokenVersion` present and
   matching, and the signed `companyId` claim **equal to the Mongo user's**
   `companyId`. This rejects legacy `generateToken` tokens and platform
   tokens.
9. Session row present, unrevoked, unexpired.
10. Company document exists and is not `SUSPENDED` / `DEACTIVATED` /
    `ARCHIVED` (the socket equivalent of `tenantContext`).

On success the handler sets exactly three server-derived values:
`socket.data.userId`, `socket.data.companyId`, `socket.data.sessionId`.

**Tenant authority:** `companyId` comes from the **Mongo `User`
document**. The signed claim is only *compared* against it. There is no
code path that reads a client-supplied `companyId` — pinned by test.

Candidate portals hold no JWT at all (their surfaces are slug/secure-token
scoped), so there is no candidate token shape this handshake can accept.

**Error contract:** one generic refusal for every auth failure —
`{ code: 'UNAUTHORIZED', message: 'Authentication failed. Please sign in
again.' }`. Internal reasons (`TENANT_MISMATCH`, `LEGACY_TOKEN`,
`SESSION_INVALID`, …) are logged/counted only, never sent, so a caller
cannot enumerate why a token failed.

Verified on a real transport: a namespace CONNECT with a bad token returns
the Engine.IO frame `44{"message":"Authentication failed…","data":{"code":"UNAUTHORIZED",…}}`.

## 2.6 Redis adapter requirement

`@socket.io/redis-adapter` is what makes delivery correct across replicas:
a message published on instance #1 reaches a socket held by instance #2.
It is therefore a **hard requirement** for chat realtime.

**This is the documented exception to Crewly's general law** that
"Redis is coordination, never truth" (cache, limiters and queues all
degrade and keep serving). Half-working realtime — where a user silently
misses messages held by another replica — is worse than none, so chat
refuses instead. The exception is contained to `src/socket/` and must
never be copied into the cache, limiter or queue layers.

Client library: **node-redis (`redis`)**, per the locked decision. Verified
against the installed versions:

- `@socket.io/redis-adapter` 8.3.0 — `createAdapter(pubClient, subClient,
  opts?)` where **`opts.key`** is the channel prefix. It depends on
  *neither* Redis client library; it only calls
  `publish / subscribe / pSubscribe / on / off`.
- `redis` 6.2.1 — `duplicate()` preserves url + socket options;
  `connect()` rejects when `reconnectStrategy` returns an `Error`;
  `'connect' / 'ready' / 'end' / 'error'` are re-emitted on the client and
  `'ready'` fires on reconnect; `destroy()` on an already-closed client
  throws `ClientClosedError` (guarded).
- `rediss://` → `@redis/client`'s `parseURL` sets `socket.tls = true`
  automatically. **TLS certificate verification is never disabled** — no
  `rejectUnauthorized` anywhere in `src/socket/` (pinned by test).

Two **dedicated** connections (pub + sub, the subscriber via `duplicate()`),
never the shared general client: a subscribed connection is
command-restricted. Same law as 32.11.

The enablement parser is **reused**, not reimplemented: `getRedisConfig()`
from `src/config/redis.js`, which owns the strict `REDIS_ENABLED` parser
(`true|1|yes|on` vs `false|0|no|off|''`, invalid → disabled).

Adapter key: `crewly:<env>:chat:adapter` — env-namespaced so staging can
never consume production chat fanout.

## 2.7 Degraded behaviour (truthful)

| Condition | Chat realtime | HTTP API |
|---|---|---|
| `CHAT_SOCKET_ENABLED != true` | Not created. `/socket.io` → Express 404 (the endpoint does not exist) | unaffected |
| `REDIS_ENABLED != true` | `FEATURE_UNAVAILABLE` — every connection refused | **unaffected** |
| `REDIS_ENABLED=true`, no `REDIS_URL` | `FEATURE_UNAVAILABLE` (`REDIS_MISCONFIGURED`) | **unaffected** |
| Redis unreachable / slow | `FEATURE_UNAVAILABLE` (`REDIS_ERROR` / `REDIS_CONNECT_TIMEOUT`) | **unaffected** |
| Adapter cannot be attached | `FEATURE_UNAVAILABLE` (`ADAPTER_FAILURE`) — **the API does not crash** | **unaffected** |
| Redis lost at runtime | Flips to `FEATURE_UNAVAILABLE`; flips back on `'ready'`, but **only while an adapter is attached** | **unaffected** |
| Process draining | Sockets disconnected; `stop()` never calls `io.close()` | 32.2 drain unchanged |

**One stable client contract** for every non-ready state:
`{ code: 'FEATURE_UNAVAILABLE', message: 'Chat realtime is not available
right now. Please try again later.' }`. It never reveals whether Redis is
disabled, misconfigured, down or connecting.

Note the deliberate asymmetry: when the feature is **disabled**, no
Socket.IO server is created at all, so `/socket.io` returns an Express
404 — truthful, because the endpoint genuinely does not exist. When the
feature is **enabled but Redis is unavailable**, the server IS created so
Engine.IO owns the path and answers with the stable 403 refusal instead of
a misleading 404.

Internal reasons are surfaced in logs and in
`describeDiagnostics()` (state + safe reason word + counters) — never to
the client, never with a URL or credential.

## 2.8 Security posture

| Control | Implementation |
|---|---|
| **No cookies** | `cookie: false` (Engine.IO skips `Set-Cookie` entirely for a falsy value). Verified live: no `Set-Cookie` on any handshake response. |
| **No wildcard CORS** | `cors.origin` = the `CLIENT_URL` allowlist array; `credentials: false`. |
| **Real origin gate** | `allowRequest` — the browser does **not** apply CORS to WebSocket upgrades, so the `cors` option alone is decoration. `allowRequest` runs for **both** transports. Stricter than `app.js`: a **missing** Origin is refused (a browser handshake always carries one). |
| **Dev preview** | `https://<port>-<id>.e2b.app` allowed in non-production only, mirroring `app.js`. |
| **Bounded frames** | `maxHttpBufferSize: 16 KiB`. `express.json`'s 10 kb limit does **not** bound socket frames; Engine.IO's default is 1 MiB. |
| **No served client** | `serveClient: false`; `allowEIO3: false`. |
| **No compression** | `perMessageDeflate: false` — the edge/CDN owns compression (32.16). |
| **No secrets in logs** | Connect/disconnect log ids + the server-derived tenant only. Redis errors log a safe `error.code` label, one warning per outage spell — never a URL, message or credential. |
| **TLS** | `rediss://` verified; certificate validation never weakened. |
| **Crash safety** | Every Redis client carries an `'error'` handler; adapter attach is guarded; socket-level errors are swallowed. |

**No surveillance.** No presence inference, no idle tracking, no last-seen,
no activity monitoring. The 25 s ping is **transport liveness only** and
writes no employee state anywhere. Pinned by test.

## 2.9 Configuration

One new environment name, placeholder only in `Backend/.env.example`:

```
CHAT_SOCKET_ENABLED=false
```

Everything else is code-owned in `src/socket/socketConfig.js`: path
(`/socket.io`), frame cap (16 KiB), connect timeout (20 s), ping interval
(25 s) / timeout (20 s), adapter ready timeout (5 s), reconnect bounds
(1 s → 15 s), and the origin allowlist derivation.

`REDIS_ENABLED` / `REDIS_URL` are unchanged and continue to be owned by
`src/config/redis.js`.

## 2.10 Files

**New**

| File | Role |
|---|---|
| `Backend/src/socket/socketConfig.js` | Enablement parser, code-owned bounds, stable error contracts, adapter key, origin allowlist |
| `Backend/src/socket/socketAuth.js` | Handshake verification (the socket re-expression of `protect`) + handshake middleware |
| `Backend/src/socket/socketAvailability.js` | Availability state machine + the `FEATURE_UNAVAILABLE` refusal |
| `Backend/src/socket/socketRedisAdapter.js` | node-redis pub/sub clients + `createAdapter` + failure classification |
| `Backend/src/socket/initSocketServer.js` | Server options, attach/stop lifecycle, diagnostics, process singleton |
| `Backend/test/chatSocketFoundation.test.js` | 85 hermetic tests |
| `docs/PHASE_33_CHAT_HUB.md` | This document |

**Modified**

| File | Change |
|---|---|
| `Backend/src/server.js` | `http.createServer(app)`; attach **before** `listen()`; chat sockets drain on the existing SIGTERM/SIGINT path |
| `Backend/package.json` | + `socket.io`, `@socket.io/redis-adapter`, `redis`; + `test:chat-socket`; suite appended to `test:all` |
| `Backend/package-lock.json` | Lockfile |
| `Backend/.env.example` | + `CHAT_SOCKET_ENABLED=false` (placeholder only) |

**Frontend: zero changes.** `socket.io-client` is deliberately deferred to
33.8.

## 2.11 Verification (this checkout)

| Check | Result |
|---|---|
| `npm run test:chat-socket` | **86 / 86 pass** |
| `npm run test:all` | **2340 / 2340 pass, 0 fail** (2334 before 33.5 + 6) |
| `npm run index:check` | All hot-query catalog entries index-served or documented (no GAP) |
| `npm run config:check` | ✓ Configuration valid |
| Live smoke (Redis off) | `/api/health/live` 200 · `/socket.io` polling → **403 `FEATURE_UNAVAILABLE`** · no `Set-Cookie` · evil origin → 403 · HTTP alive after `stop()` |
| Live smoke (adapter ok) | handshake **200** with `maxPayload:16384`, `pingInterval:25000` · evil origin → **403 `ORIGIN_NOT_ALLOWED`** · bad token → `44{…UNAUTHORIZED…}` |

## 2.12 Known limitations / deferred

- `scripts/config-check.js` does not yet list `CHAT_SOCKET_ENABLED`
  (modifying it was outside the 33.1 file scope). Add it in 33.11.
- No live two-instance cross-delivery proof in this sandbox (no Redis
  binary). 33.12 owns the opt-in live matrix.
- Recovery to `READY` depends on the node-redis `'ready'` event; if it
  never fires, the gate stays closed until restart. That is **fail-closed
  by design** — it can never fail open into single-instance delivery.
- No per-user connection cap yet (32.11 has 5/user for SSE). Assigned to
  33.11 with the rest of the abuse controls.
- No socket-level rate limiting yet — `securityRateLimit` is Express
  middleware and cannot guard socket events; 33.11 wires
  `createRateLimitStore({ sharedName })` into the handlers.
- No audit rows for socket events: `auditTrail` is Express middleware and
  never sees them. 33.9 must write `AuditLog` explicitly for moderation.
- The subscription write-gate (`readOnlyIfExpired`) has nothing to gate in
  33.1 (no write events). It must be re-expressed in 33.5.

---

## 3. Localhost acceptance (Windows PowerShell, names only — no secrets)

```powershell
cd <repo root>\Backend        # the repo root is the folder that contains .git
npm install

# 1. Feature OFF (default): API must behave exactly as before.
npm run dev
#    log: "[ChatSocket] disabled (CHAT_SOCKET_ENABLED!=true) — no socket connections will be accepted."
#    GET http://localhost:5000/api/health/live  -> 200
#    GET http://localhost:5000/socket.io/?EIO=4&transport=polling -> 404

# 2. Feature ON, Redis OFF: sockets refused, HTTP fine.
$env:CHAT_SOCKET_ENABLED="true"
$env:REDIS_ENABLED="false"
npm run dev
#    log: "[ChatSocket] REDIS_ENABLED is not true — chat realtime is FEATURE_UNAVAILABLE."
#    log: "[ChatSocket] redis unavailable — every socket connection is refused as
#           FEATURE_UNAVAILABLE. The HTTP API is unaffected."
#    /api/health/live -> 200
#    /socket.io/?EIO=4&transport=polling -> 403 {"code":4,"message":"FEATURE_UNAVAILABLE"}
Remove-Item Env:CHAT_SOCKET_ENABLED
Remove-Item Env:REDIS_ENABLED

# 3. Hermetic tests (no Redis, no Mongo, no ports).
npm run test:chat-socket
npm run test:all

# 4. Optional, only if you run Redis locally.
$env:REDIS_ENABLED="true"
$env:REDIS_URL="redis://127.0.0.1:6379"
$env:CHAT_SOCKET_ENABLED="true"
npm run dev
#    log: "[ChatSocket] redis adapter attached (key=crewly:development:chat:adapter) — cross-instance chat fanout active."
#    log: "[ChatSocket] foundation ready (path=/socket.io, adapterKey=crewly:development:chat:adapter). No chat product events exist in 33.1."
Remove-Item Env:REDIS_ENABLED
Remove-Item Env:REDIS_URL
Remove-Item Env:CHAT_SOCKET_ENABLED
```

No destructive Redis commands at any point.

---

# 4. PHASE 33 OPERATING CONTRACT (applies to 33.1 and every later unit)

Set by the maintainer. These are process rules, not design choices — they bind
every Phase 33 unit. Where a mandated path conflicts with the repository, the
repository wins, and the mapping below records the deviation.

## 4.1 Folder layout

Backend — **matches repository structure exactly, no mapping needed.**

| Path | Unit | Status |
|---|---|---|
| `Backend/src/socket/initSocketServer.js` | 33.1 | exists |
| `Backend/src/socket/socketAuth.js` | 33.1 | exists |
| `Backend/src/socket/socketRedisAdapter.js` | 33.1 | exists |
| `Backend/src/socket/socketAvailability.js` | 33.1 | exists |
| `Backend/src/socket/socketConfig.js` | 33.1 | exists (holds `parseChatSocketEnabled`, bounds, the `FEATURE_UNAVAILABLE` contract) |
| `Backend/src/models/ChatConversation.js` | 33.2 | exists |
| `Backend/src/models/ChatMessage.js` | 33.2 | exists |
| `Backend/src/models/ChatMessageEdit.js` | 33.2 (model) · 33.6 (behaviour) | exists |
| `Backend/src/controllers/chat/chatController.js` | 33.3 | exists (chat/ subfolder, mirrors attendance/bgv) |
| `Backend/src/routes/chat/chatRoutes.js` | 33.3 | exists (chat/ subfolder) |
| `Backend/src/validators/chat/chatValidators.js` | 33.3 | exists (chat/ subfolder) |
| `Backend/src/services/chat/chatService.js` | 33.3 | exists (chat/ subfolder) |
| `Backend/src/services/chat/chatMessageService.js` | 33.5 | exists (chat/ subfolder) |

Frontend — **four mandated paths do not match repository truth.** "Follow repo
truth first" applies; each deviation is recorded rather than made silently.

| Mandated path | Repository truth (verified) | Phase 33 path |
|---|---|---|
| `Frontend/src/pages/Chat/` | every page folder is lowercase (`pages/attendance/`, `pages/bgvVerifier/`); no uppercase page folder exists | `Frontend/src/pages/chat/ChatHubPage.jsx`, `…/ConversationPage.jsx` |
| `Frontend/src/store/chatSlice.js` | there is no `src/store/`; state lives in `src/redux/store.js` + `src/redux/slices/` (`AuthSlices.js`, `PermissionSlices.js`) | `Frontend/src/redux/slices/chatSlice.js` |
| `Frontend/src/realtime/socketClient.js` | there is no top-level `src/realtime/`; the 32.11 SSE client is at `src/services/realtime/realtimeClient.js` | `Frontend/src/services/realtime/chatSocketClient.js` |
| `Frontend/src/services/chatApi.js` | all 62 service files are named `*Service.js` | `Frontend/src/services/chatService.js` — rename to `chatApi.js` only on explicit instruction |
| `Frontend/src/components/chat/` | feature-local component folders already exist (`components/attendance/`, `components/auth/`, `components/recruitment/`) | unchanged — feature-local components only |

Hard limits: no deep `domain/application/http` trees; no moving or renaming
existing files without explicit authorisation and justification; no
restructuring of the repository.

## 4.2 Mandatory end-of-unit report

Every unit ends with a `FILES CHANGED` section:

```
FILES CHANGED
- Added:
  - <path>
- Modified:
  - <path>
- Deleted (if any; avoid unless required):
  - <path>
```

plus the exact commands run and their exact pass/fail counts. A blocked check is
reported as blocked, never as a pass.

## 4.3 Stop discipline

One unit per turn. Exactly one build plan, emitted before any code. End with,
verbatim:

```
Phase 33.<unit> awaiting localhost acceptance.
```

Then stop — no unrequested next-unit work.

## 4.4 Standing rules that constrain every Phase 33 unit

- Inspect before modifying; the repository is authoritative over any document
  or summary, including this one.
- Never ask for, print, or commit secrets (`REDIS_URL`, `SMTP_*`, `CLOUDINARY_*`,
  `RAZORPAY_*`, `JWT_SECRET`, `FIELD_ENCRYPTION_KEY`). `.env.example` carries
  names and placeholders only. No frontend Redis dependency of any kind — there
  is no `VITE_REDIS_URL` and none will be added.
- Controller comment convention, in this order, inside `try {}` when present:
  `// Data from frontend - requests from frontend` before the first `req` read,
  `// DB Logic - DB logics` before the first service or query call,
  `// Data to frontend - response to frontend` before the response statement.
  Omit the request comment rather than mislabel a DB call.
- ESM only. Arrow functions, `const`/`let`, destructuring, template literals,
  `?.`, `??`, `async/await`. No `var`, no `function` declarations, no
  `require`/`module.exports`, no `.prototype`, no `Object.assign()`.
- Tenant authority is `req.companyId` on HTTP and the Mongo-derived
  `socket.data.companyId` on sockets. A client-supplied tenant id is never
  trusted.
- Redis laws: explicit `REDIS_ENABLED` parser, `redis://` and `rediss://` both
  supported, never `rejectUnauthorized: false`, no `FLUSHALL`/`FLUSHDB`/`KEYS`,
  hermetic tests never touch a live server.
- At-least-once only — exactly-once is never claimed. Workers revalidate Mongo
  and never trust queue data. No tokens, PII or provider credentials in job
  data, job ids or logs.
- Cache only after auth + tenant + subscription + RBAC. The cache never
  authorises anything.
- No surveillance: no presence inference, no idle tracking, no default
  last-seen, no activity monitoring. Metadata only, never message content, in
  logs and metrics.
- Windows PowerShell instructions: exact commands, `$env:NAME="value"`,
  `Remove-Item Env:NAME`, no Unix env-prefix npm scripts, no
  `git reset --hard`, watch for `.js.js` filename traps.

---

# 5. PHASE 33.2 — MODELS & INDEXES

Persistence layer only. Nothing in this unit reads or writes chat data: there
are no routes, no controllers, no validators, no services and no socket events.
Declaring the schema first means every invariant below is already in force the
moment the first write path appears in 33.3/33.5.

## 5.1 Schema summaries

All three collections use `{ timestamps: true, versionKey: false }` — no
Mongoose `__v`, because chat writes never use Mongoose optimistic concurrency;
33.6 uses its own `editVersion`.

### ChatConversation (`Backend/src/models/ChatConversation.js`)

| Field | Type | Rule |
|---|---|---|
| `companyId` | ObjectId → `Company` | required, immutable |
| `type` | enum `DIRECT` \| `GROUP` | required, uppercase, trim, immutable |
| `directKey` | String ≤49 | **derived**, lowercase, trim, immutable, `null` for GROUP |
| `title` | String ≤80 | trim, `null` for DIRECT, required (≥2 chars) for GROUP |
| `members[]` | subdocs, `_id:false` | DIRECT: exactly 2 distinct · GROUP: 2–200 |
| `members[].userId` | ObjectId → `User` | required |
| `members[].role` | enum `MEMBER` \| `ADMIN` | default `MEMBER` |
| `members[].joinedAt` | Date | default now |
| `members[].joinedAtSeq` | Number ≥0 | default 0 — late-joiner unread baseline |
| `members[].lastReadSeq` | Number ≥0 | default 0 — **the C1 read cursor** |
| `lastMessageSeq` | Number ≥0 | default 0 |
| `lastMessageAt` | Date | default `null` |
| `lastMessagePreview` | String ≤200 | default `null` |
| `lastMessageSenderUserId` | ObjectId → `User` | default `null` |
| `isDisabled` / `disabledAt` / `disabledByUserId` | Boolean / Date / ObjectId | default `false` / `null` / `null` — behaviour in 33.9 |

`lastMessage*` is a **cache of the newest message, never its authority**. A
wrong preview is a display bug; a wrong `lastMessageSeq` would corrupt every
read cursor, which is why seq allocation (33.5) is the only atomic write that
touches it.

### ChatMessage (`Backend/src/models/ChatMessage.js`)

| Field | Type | Rule |
|---|---|---|
| `companyId` | ObjectId → `Company` | required, immutable |
| `conversationId` | ObjectId → `ChatConversation` | required, immutable |
| `senderUserId` | ObjectId → `User` | required, immutable |
| `seq` | Number ≥1 | **required, immutable** — allocated atomically in 33.5 |
| `clientMessageId` | String ≤80 | required, trim, immutable — client idempotency key |
| `type` | enum `TEXT` \| `SYSTEM` \| `FILE` | default `TEXT` |
| `text` | String ≤4000 | trim; non-empty for TEXT, forbidden otherwise |
| `editVersion` | Number ≥0 | default 0 |
| `editedAt` / `editedByUserId` | Date / ObjectId | default `null` |
| `deletedAt` / `deletedByUserId` | Date / ObjectId | default `null` — **tombstone** |

No embedded read receipts. Read state is the per-member cursor on
`ChatConversation`. A receipts array grows with readers on every message; a
cursor grows with members on the conversation. For a chat system the cursor is
the only shape that stays cheap.

### ChatMessageEdit (`Backend/src/models/ChatMessageEdit.js`)

| Field | Type | Rule |
|---|---|---|
| `companyId` | ObjectId → `Company` | required, immutable |
| `conversationId` | ObjectId → `ChatConversation` | required, immutable |
| `messageId` | ObjectId → `ChatMessage` | required, immutable |
| `version` | Number ≥1 | required, immutable |
| `previousText` | String ≤4000 | required, trim |
| `editedAt` | Date | required, default now |
| `editedByUserId` | ObjectId → `User` | required, immutable |

Append-only, one row per edit, holding the text that was **replaced**. Separate
collection on purpose: embedding history in `ChatMessage` would grow the
hottest document in the system, drag the whole history through every
history-page read, and turn the 33.6 retention cap into array surgery instead of
a bounded, indexable delete.

## 5.2 Indexes (all schema-declared)

| Collection | Index | Options | Serves |
|---|---|---|---|
| ChatConversation | `{ companyId: 1, directKey: 1 }` | `unique`, `partialFilterExpression: { type: 'DIRECT' }` | one DIRECT conversation per pair per tenant |
| ChatConversation | `{ companyId: 1, 'members.userId': 1, lastMessageAt: -1 }` | — | "my conversations" list |
| ChatMessage | `{ companyId: 1, conversationId: 1, seq: -1 }` | — | history pagination |
| ChatMessage | `{ companyId: 1, conversationId: 1, senderUserId: 1, clientMessageId: 1 }` | `unique` | idempotent send |
| ChatMessageEdit | `{ companyId: 1, messageId: 1, version: 1 }` | `unique` | append-only edit versions |
| ChatMessageEdit | `{ companyId: 1, conversationId: 1, messageId: 1, version: -1 }` | — | edit-history fetch |

**No runtime index management exists.** `grep -rn "createIndex|syncIndexes|dropIndex|ensureIndex" src/ scripts/`
returns zero hits repo-wide, and `test/chatModels.test.js` pins that the three
chat model files stay that way.

**Partial unique strategy.** `(companyId, directKey)` with
`partialFilterExpression: { type: 'DIRECT' }` was chosen over
`(companyId, type, directKey)` because the filter removes GROUP documents from
the index *entirely*, so their `null` directKey can never enter a uniqueness
conflict. It matches the existing `Notification` and `BgvOrder` precedent.

**Deliberate deviation from house convention: no standalone `companyId` index.**
Most repo models set `index: true` on `companyId`. The chat collections do not,
because every index above already leads with `companyId`, so a single-field
index would be redundant write amplification on the highest-volume collections
in the system. Both halves of that decision are pinned by test: every chat
index must lead with `companyId` **and** no single-field `companyId` index may
exist.

## 5.3 Invariants

Enforced in the schema, so they hold before any API exists:

1. **Tenant scope is structural.** `companyId` is required + immutable on all
   three collections and is the leading key of every index. A chat query that
   omits `companyId` is unindexable and wrong by construction.
2. **`directKey` is derived, never trusted.** A `pre('validate')` hook
   recomputes it from the sorted member ids on every validation. A
   client-supplied `directKey` is overwritten, not honoured — so `A:B` and
   `B:A` collapse to one key and cannot become two conversations.
3. **Self-chat is rejected.** A DIRECT conversation needs exactly 2 *distinct*
   members; a degenerate key over one person is not a product.
4. **GROUP needs a title (≥2 chars) and 2–200 members.** A group of one is a
   malformed DIRECT.
5. **A TEXT message must have a body; SYSTEM and FILE must not.** Body text
   cannot be smuggled through a non-text message type.
6. **A tombstone cannot keep its body.** Deleting clears `text` and edit state
   while preserving `seq`, `clientMessageId` and the document's place in
   history — so pagination and read cursors stay stable, and a re-send of the
   same deleted message is still deduped.
7. **Edit versions are unique per message.** `(companyId, messageId, version)`
   unique makes a lost update a write failure rather than a silent overwrite.
8. **No surveillance anywhere.** No presence, `lastSeen`, `isOnline`, typing or
   idle field exists on any chat model, and a test asserts it by both exact
   name and shape. `joinedAt` is membership bookkeeping, not observation.

### Mongoose 9 note (verified, not assumed)

Two API facts were confirmed against the installed Mongoose 9.9.1 before use:

- **`validateSync()` is deprecated and removed in v10.** All offline validation
  tests use `await document.validate()`. This matters beyond style: in a
  probe, `validateSync()` **silently skipped a `pre('validate')` hook** while
  `await validate()` ran it — a sync-only test would have passed a broken
  invariant.
- **`validate` hooks receive no `next` callback.** Declaring one and calling it
  throws `next is not a function` on *every* validation, which would break
  every chat write path at once. `save` hooks still receive `next`; `validate`
  hooks do not. Pinned by both a source-shape test and a behavioural test.

## 5.4 Limitations (no APIs yet)

- Nothing creates, reads, updates or deletes chat documents. No REST route, no
  controller, no validator, no service, no socket event exists.
- `seq` is **not allocated here**. 33.5 must allocate it from an atomic `$inc`
  on `ChatConversation.lastMessageSeq` (or `TenantSequence` key
  `CHAT:<conversationId>`); two concurrent senders must never receive the same
  number.
- The idempotency index gives **at-least-once delivery resolved by a unique
  index**. Nothing in Phase 33 claims exactly-once.
- Unread maths (`lastMessageSeq − max(lastReadSeq, joinedAtSeq)`), the
  `chat:readUpTo` event and the monotonic-cursor rule land in 33.7.
- The edit retention cap, the `expectedEditVersion` concurrency check and the
  permission gate on reading edit history land in 33.6.
- `FILE` is an enum value with no storage behind it. Attachments land in 33.10.
- Tombstones written through an atomic update that does **not** pass
  `{ runValidators: true }` bypass both the validator and the `pre('validate')`
  self-heal. 33.6 must pass `runValidators` or explicitly `$set` text to null.
  This is called out in the model source as well as here.
- No index has been created on any real database. Indexes are declarations
  until a connection applies them; nothing exists until 33.3+ writes documents.

## 5.5 Verification (this checkout)

| Check | Result |
|---|---|
| `npm run test:chat-models` | **54 / 54 pass** |
| `npm run test:chat-socket` | **86 / 86 pass** (the 33.1 "no chat model" pin was inverted, not deleted) |
| `npm run test:all` | **2315 / 2315 pass, 0 fail, 88 suites** (2260 before 33.2) |
| `npm run index:check` | `models loaded: 127/127` · 621 declared indexes · no GAP |

Hermetic: no Mongo connection, no Redis, no open ports.

---

# 6. PHASE 33.3 — CONVERSATION REST APIS

REST only. No socket chat events, no message send, no history, no unread, no
attachments. Files: `controllers/chatController.js` (thin), `services/chatService.js`
(all Mongo + authorization), `validators/chatValidators.js` (express-validator),
`routes/chatRoutes.js` (mounted at `/api/chat`), `test/chatConversations.test.js`.

## 6.1 Endpoints

All routes run `protect` → `tenantContext` → `checkSubscriptionStatus`; every
mutating route additionally runs `checkWriteAccess`.

| Method | Path | Body / Query | Result |
|---|---|---|---|
| POST | `/api/chat/conversations` | `{ type: 'DIRECT', targetUserId }` or `{ type: 'GROUP', name, memberUserIds[] }` | `{ conversation }`, 201 if created else 200 |
| GET | `/api/chat/conversations` | `?cursor=&limit=` | `{ conversations[] }` + `meta { nextCursor, hasMore, limit }` |
| GET | `/api/chat/conversations/:conversationId` | — | `{ conversation }` (membership required) |
| POST | `/api/chat/conversations/:conversationId/members` | `{ memberUserIds[] }` | `{ conversation, added }` (GROUP, caller ADMIN) |
| DELETE | `/api/chat/conversations/:conversationId/members/:userId` | — | `{ conversation, removed }` (GROUP, ADMIN or self) |

## 6.2 Authorization (deliberate, documented)

**No new permissions and no new subscription feature were added.** The repo's
permission catalogue (`SYSTEM_PERMISSION_VERSION=36`, 231 permissions) and the
plan feature map are strictly versioned and contain no CHAT entries; adding
them is a separate, carefully-versioned unit. Instead:

- Tenant + session: `protect` (Mongo-derived `req.companyId`), `tenantContext`
  (rejects suspended companies), `checkSubscriptionStatus` / `checkWriteAccess`.
- Membership: every read queries with
  `{ _id?, companyId, 'members.userId': req.user._id }`, so a non-member —
  including a user from another tenant — gets a 404, never a leak.
- Group writes: the in-conversation `members[].role === 'ADMIN'` gates
  add/remove (33.2 schema). The creator of a group is created as ADMIN.

If named `CHAT_*` permissions are wanted later, do it in a dedicated unit that
follows the `SYSTEM_PERMISSION_VERSION` bump process and updates the startup
count (currently 231) — do not bolt them on here.

## 6.3 Tenancy + membership rules

- `companyId` is taken **only** from `req.companyId`; the body/query never
  supplies a tenant.
- DIRECT: `targetUserId` must be an ACTIVE user in the same company and not the
  requester; uniqueness by `directKey` = sorted ids joined by `:`; create is
  idempotent and an E11000 race refetches and returns the winner.
- GROUP: name trimmed 2..80; at least one other member; total capped at
  `CHAT_GROUP_MAX_MEMBERS = 50`; every member must be an ACTIVE same-company
  user; duplicates are dropped.
- Add: caller must be a member with role ADMIN; no duplicates; cap enforced;
  same-company ACTIVE only.
- Remove: caller ADMIN or self; GROUP only; cannot drop below two members;
  cannot remove the last ADMIN.

## 6.4 Pagination

Keyset over `{ lastMessageAt: -1, _id: -1 }`. `lastMessageAt` is seeded to
"now" on create, so an un-messaged conversation sorts by its creation time —
exactly "lastMessageAt desc with createdAt fallback" — and 33.5 only bumps it
when a message lands. `limit` is clamped 1..50 (default 20); the service
requests `limit+1` to compute `hasMore` and returns an opaque `nextCursor`
(base64url of `{a, id}`); an undecodable cursor restarts from the top instead
of erroring.

## 6.5 Limitations (messages not yet implemented)

- No message history endpoint (33.4), no socket send (33.5), no unread /
  `readUpTo` (33.7), no attachments (33.10).
- `lastMessageSeq` / previews stay at their defaults until 33.5 writes them.
- Member add is not atomic against the cap under heavy concurrency (read then
  update); acceptable for 33.3 group sizes, tighten in 33.9 if needed.

## 6.6 Verification (this checkout)

| Check | Result |
|---|---|
| `npm run test:chat-conversations` | **13 / 13 pass** (hermetic — in-memory fakes) |
| `npm run test:chat-socket` | **87 / 87 pass** (boundary pin updated for 33.3) |
| `npm run test:all` | **2334 / 2334 pass, 0 fail, 88 suites** (33.3 snapshot + 5) |
| `npm run index:check` | `models loaded: 127/127` · no GAP |
| `npm run config:check` | ✓ Configuration valid |

---

# 7. PHASE 33.4 — MESSAGE HISTORY API

Read-only. One endpoint. No send (33.5), no edit-history read (33.6), no
unread markers (33.7), no attachments (33.10), no socket events.

## 7.1 Endpoint

`GET /api/chat/conversations/:conversationId/messages?cursor=<seq>&limit=<n>`

Runs under the 33.3 stack: `protect` → `tenantContext` →
`checkSubscriptionStatus`. It is a read, so no `checkWriteAccess`.

Query params:
- `cursor` — optional positive integer = a message `seq`. When present, the
  page is the messages strictly older than it (`seq < cursor`). When absent,
  the newest page is returned.
- `limit` — optional integer, clamped 1..50 (default 20). The service fetches
  `limit+1` to compute `hasMore`.

## 7.2 Ordering + cursor semantics

Newest-first, keyset over `seq` desc — this rides the 33.2 index
`(companyId, conversationId, seq desc)`, so every page is an index scan, never
a collection scan. `nextCursor` is the `seq` of the last item on the page, or
`null` when `hasMore` is false. Cursors are monotonic message sequence
numbers, so a page boundary is stable even while new messages arrive (new
messages have higher seq and simply appear on the first page).

## 7.3 Membership rule

Membership is verified BEFORE any message is read, by the same scoped lookup
as 33.3:
`ChatConversation.findOne({ _id, companyId, 'members.userId': req.user._id })`.
A miss is a 404 — a non-member or another tenant learns nothing. The message
query itself is scoped by `companyId + conversationId`.

## 7.4 Response shape

```
{
  message: "Messages fetched",
  data: {
    conversationId,
    items: [ { _id, seq, senderUserId, type, text, editedAt, editVersion, deletedAt, createdAt } ],
    nextCursor, hasMore
  },
  meta: { limit }
}
```

Tombstones: if `deletedAt` is set, `text` is always `null` (sanitized on read
as defense-in-depth, even if a half-delete left a body behind), and
`deletedAt` is surfaced so the UI can render "message deleted". Edit history
is NOT included here (33.6).

## 7.5 Limitations

- No send path yet — history is empty until 33.5 writes messages.
- No edit-history entries (33.6), no unread/read state (33.7).
- Read-only; a `GET .../messages` on a conversation the user is not a member
  of returns 404.

## 7.6 Verification (this checkout)

| Check | Result |
|---|---|
| `npm run test:chat-history` | **5 / 5 pass** (hermetic in-memory fakes) |
| `npm run test:chat-socket` | **87 / 87 pass** (boundary pin flipped for 33.4) |
| `npm run test:all` | **2334 / 2334 pass, 0 fail, 88 suites** |
| `npm run index:check` | `models loaded: 127/127` · no GAP |
| `npm run config:check` | ✓ Configuration valid |

---

# 8. PHASE 33.5 — SOCKET PROTOCOL (JOIN + SEND)

First realtime capability. Files: `socket/chatSocketHandlers.js`,
`socket/chatSocketValidators.js`, `services/chatMessageService.js`,
`utils/chatKeys.js`; wired into the 33.1 foundation via an injectable
`registerSocketHandlers` called in the connection handler. No edits/deletes/
read-markers/attachments/UI/presence.

## 8.1 Events

Client → server (each answered with an ACK):
- `chat:join` `{ conversationId }` → `{ ok:true }` or `{ ok:false, code, message }`
- `chat:leave` `{ conversationId }` → `{ ok:true }`
- `chat:message:send` `{ conversationId, clientMessageId, text }` →
  `{ ok:true, data:{ message } }` or `{ ok:false, code, message }`

Server → client:
- `chat:message:created` `{ conversationId, message }` (broadcast to room
  `chat:conv:<conversationId>`; emitted ONLY for a genuinely new message).

Rooms: `chat:conv:<id>` (`utils/chatKeys.js`); `chat:company:<id>` and
`chat:user:<id>` reserved for future targeted fan-out.

## 8.2 Error codes (stable)

`UNAUTHORIZED`, `FEATURE_UNAVAILABLE`, `VALIDATION_ERROR`,
`NOT_FOUND_OR_FORBIDDEN`, `CONVERSATION_DISABLED`, `RETRYABLE`,
`RATE_LIMITED`. `NOT_FOUND_OR_FORBIDDEN` deliberately does not distinguish
"other tenant" from "not a member", so the socket surface leaks no tenant
existence.

## 8.3 Membership + tenant enforcement

`companyId`/`userId` come ONLY from `socket.data` (33.1 handshake). Every
`chat:join`/`chat:message:send` re-checks Mongo membership via
`ChatConversation.findOne({ _id, companyId, 'members.userId': userId })`; a
miss or a disabled conversation refuses. Payloads are validated by
`chatSocketValidators.js` (text 1..4000 trimmed, clientMessageId 1..80).

## 8.4 Send flow (idempotency + seq)

1. validate → 2. membership + disabled → 3. idempotency pre-check (find by
`clientMessageId`) → 4. atomic `$inc lastMessageSeq` with `{ new: true }`
(which also refreshes `lastMessageAt/lastMessagePreview/
lastMessageSenderUserId`) → 5. `ChatMessage.create` with the new seq → on
E11000 refetch the winner and return `created:false`.

AT-LEAST-ONCE, never exactly-once: a retry resolves to the same message via
the unique `(companyId, conversationId, senderUserId, clientMessageId)` index
and is acknowledged to the sender WITHOUT re-broadcasting. Seq gaps are
tolerated by the C1 cursor model. A minimal fixed-window per-socket send guard
(30/10s) returns `RATE_LIMITED`; it is in-memory, dies with the socket, and
stores nothing about the user.

## 8.5 Limitations

No edits (33.6), deletes (33.6), read markers (33.7), attachments (33.10) or
UI (33.8). Realtime send is exercised here by hermetic handler tests; a live
browser round-trip is proven in 33.8 when `socket.io-client` lands.

## 8.6 Verification (this checkout)

| Check | Result |
|---|---|
| `npm run test:chat-send` | **6 / 6 pass** (hermetic mock socket + io + fakes) |
| `npm run test:chat-socket` | **87 / 87 pass** (pins updated for 33.5) |
| `npm run test:all` | **2340 / 2340 pass, 0 fail, 88 suites** |
| `npm run index:check` | `models loaded: 127/127` · no GAP |
| `npm run config:check` | ✓ Configuration valid |

---

# 9. FOLDER LAYOUT (CHAT DOMAIN, PER-LAYER SUBFOLDERS)

Following the repo's established domain convention (attendance, bgv, payroll,
recruitment each live in per-layer subfolders), the chat product files were
restructured from flat shared folders into `chat/` subfolders:

| Layer | Path |
|---|---|
| Controller | `src/controllers/chat/chatController.js` |
| Routes | `src/routes/chat/chatRoutes.js` (mounted at `/api/chat` in `src/routes/index.js`) |
| Validators | `src/validators/chat/chatValidators.js` |
| Services | `src/services/chat/chatService.js`, `src/services/chat/chatMessageService.js` |
| Socket | `src/socket/` stays as its own layer (foundation + `chatSocketHandlers.js` / `chatSocketValidators.js`) — there is no per-domain socket precedent, and it is already isolated |
| Models | `src/models/Chat*.js` unchanged (33.2) |
| Utils | `src/utils/chatKeys.js` |

Only import paths and path-based test pins changed; no logic moved. Verified by
`npm run test:all` (2340/2340), `index:check` (127/127) and `config:check` after
the move.

---

# 10. PHASE 33.6 — MESSAGE EDIT + EDIT HISTORY + DELETE (TOMBSTONE)

Realtime edit/delete over Socket.IO. No REST routes added, no UI, no read
markers, no attachments. Sender-only permission model (moderation deferred
to 33.9).

## 10.1 Events

Client → server (each ACKed `{ok:true,data}` / `{ok:false,code,message}`):

| Event | Payload | ACK data |
|---|---|---|
| `chat:message:edit` | `{ conversationId, messageId, expectedEditVersion, newText, clientEditId? }` | `{ message }` (broadcast shape) |
| `chat:message:delete` | `{ conversationId, messageId, reason? }` | `{ messageId, deletedAt }` |

Server → client (room `chat:conv:<id>`, emitted only on a real change):

| Event | Payload |
|---|---|
| `chat:message:updated` | `{ conversationId, messageId, newText, editedAt, editVersion, editedByUserId }` |
| `chat:message:deleted` | `{ conversationId, messageId, deletedAt, deletedByUserId }` |

Payloads carry no tokens, Redis ids, job ids or debug objects.

## 10.2 Edit rules + optimistic concurrency

Order (cheapest rejection first): payload validation (`newText` trimmed
1..4000, `expectedEditVersion` integer ≥ 0, optional `clientEditId` ≤ 80) →
membership + tenant + disabled (Mongo-authoritative) → message fetch scoped
`{_id, companyId, conversationId}` → `MESSAGE_DELETED` → `MESSAGE_NOT_EDITABLE`
for non-TEXT or non-sender → history cap → atomic
`findOneAndUpdate({ ..., editVersion: expectedEditVersion, deletedAt: null },
{ $set:{text,editedAt,editedByUserId}, $inc:{editVersion:1} },
{ new:true, runValidators:true })`. A null result refetches and classifies:
missing → `NOT_FOUND_OR_FORBIDDEN`, tombstoned → `MESSAGE_DELETED`,
version moved → `CONFLICT_EDIT_VERSION`, else `RETRYABLE`. Two simultaneous
edits cannot both win; the loser gets `CONFLICT_EDIT_VERSION` and must
refresh from `chat:message:updated`.

`clientEditId` is accepted and bounded but is NOT a dedupe key in 33.6 —
the version check is the honest retry behaviour (a blind retry fails loudly
instead of silently re-applying).

## 10.3 Edit history (append-only) + retention cap

Every successful edit appends ONE `ChatMessageEdit` row:
`{ companyId, conversationId, messageId, version: <new editVersion>,
previousText: <replaced text>, editedAt, editedByUserId }`.
`(companyId, messageId, version)` is unique, so a row can never be
overwritten. Cap = **20** rows per message (`CHAT_EDIT_HISTORY_MAX`); beyond
it the edit is REFUSED with `HISTORY_LIMIT_REACHED` (refuse, not prune — no
destructive history writes). History is internal: the 33.4 history endpoint
does NOT return it.

## 10.4 Tombstone delete

Never a hard delete: `$set { deletedAt, deletedByUserId, text: null,
editVersion: 0, editedAt: null, editedByUserId: null }` with
`runValidators: true` (the update both passes validators and explicitly
nulls the body, as the ChatMessage model header demands). `seq` is preserved
so cursors stay stable; 33.4 already renders tombstones as null text.
Idempotent: deleting an already-tombstoned message returns ok with the
EXISTING `deletedAt` and `changed:false` → no re-broadcast. A disabled
conversation does NOT block tombstoning (removal of one's own content stays
available). `lastMessagePreview` is NOT recomputed on delete in 33.6
(documented limitation; refreshes on the next send). `reason` is validated
(≤ 200) but not persisted — ChatMessage has no reason field until 33.9.

## 10.5 Stable error codes (utils/chatErrors.js, single source)

`UNAUTHORIZED`, `FEATURE_UNAVAILABLE`, `VALIDATION_ERROR`,
`NOT_FOUND_OR_FORBIDDEN`, `CONVERSATION_DISABLED`, `RETRYABLE`,
`RATE_LIMITED` (33.1/33.5) + `CONFLICT_EDIT_VERSION`, `MESSAGE_DELETED`,
`MESSAGE_NOT_EDITABLE`, `HISTORY_LIMIT_REACHED` (33.6). Ownership failures
surface as `MESSAGE_NOT_EDITABLE` to members who can already see the
message; tenant existence is never confirmed (`NOT_FOUND_OR_FORBIDDEN`).

## 10.6 Layout + tests

`services/chat/chatEditService.js` (edit + tombstone logic),
`utils/chatErrors.js` (codes), extended `socket/chatSocketHandlers.js` +
`socket/chatSocketValidators.js`. The per-socket fixed-window write guard
(30/10s) now covers send + edit + delete. Tests: `test/chatEditDelete.test.js`
10/10 hermetic (mock socket/io + in-memory model fakes); foundation pins
inverted to allow the 33.6 events while typing/presence/read markers stay
forbidden. `npm run test:all` → **2350 / 2350 pass, 0 fail, 88 suites**
(2340 before 33.6 + 10); index:check 127/127; config:check valid.

## 10.7 Limitations (honest)

No moderation (33.9), no read markers/unread (33.7), no attachments (33.10),
no UI (33.8), no edit-history read endpoint (33.9), preview not recomputed on
delete, `clientEditId`/`reason` accepted but not persisted, at-least-once
never exactly-once.

---

# 11. PHASE 33.7 — READ MARKERS + UNREAD COUNTS (C1)

## 11.1 The C1 model

One cursor per member, one counter per conversation:

    unreadCount = max(0, lastMessageSeq - max(lastReadSeq, joinedAtSeq))

`joinedAtSeq` participates so a late joiner never inherits the backlog as
unread (`addMembers` also seeds both fields at join time; the max is the
defense-in-depth the 33.2 model header promises). There are NO per-message
receipt arrays — receipts scale with readers × messages, cursors scale with
members.

## 11.2 REST contract (Postman-testable)

`POST /api/chat/conversations/:conversationId/read`
(protect + tenantContext + checkSubscriptionStatus + checkWriteAccess +
readMarkerValidator: `lastReadSeq` integer ≥ 0).

Body `{ "lastReadSeq": N }` → response
`{ message: "Read marker updated", data: { conversationId, myLastReadSeq,
lastMessageSeq, unreadCount } }`. Non-member / other tenant → 404,
indistinguishable (no existence leak).

Rules: clamp `target = min(lastReadSeq, lastMessageSeq)`; monotonic
`next = max(current, target)`; positional `$set members.$.lastReadSeq`
written only when it increases; bounded ONE re-read/retry if a concurrent
device raced. Mongo authoritative; no Redis.

## 11.3 Socket contract

`chat:readUpTo { conversationId, lastReadSeq }` →
ACK `{ ok:true, data:{ myLastReadSeq, unreadCount } }` or
`{ ok:false, code, message }` with `UNAUTHORIZED / VALIDATION_ERROR /
NOT_FOUND_OR_FORBIDDEN`. **Read state is NEVER broadcast** — it is
privacy-sensitive and would become presence-ish surveillance.

## 11.4 Privacy projection

`GET /api/chat/conversations` and `GET /:conversationId` now return each
conversation projected for the caller: top-level `myLastReadSeq`,
`lastMessageSeq`, `unreadCount`; every member entry is stripped of
`lastReadSeq` / `joinedAtSeq` (other people's read state never leaves the
service). Membership bookkeeping (`userId`, `role`, `joinedAt`) stays.

## 11.5 Tests + verification

`test/chatReadMarkers.test.js` 9/9 hermetic (C1 math incl. late joiner;
upward / monotonic / clamped updates; non-member + cross-tenant refusal;
privacy projection; list decoration; socket ACK shape + zero broadcasts).
Foundation pins inverted: `chat:readUpTo` is now an allowed registered
event and the router gains `/read`; typing / presence / lastSeen /
per-message receipt broadcasts stay forbidden.
`npm run test:all` → **2359 / 2359 pass, 0 fail, 88 suites**
(2350 before 33.7 + 9); index:check 127/127; config:check valid.

## 11.6 Limitations (honest)

No "seen by" lists, no presence/last-seen, no notifications, no read
receipts; unread is conversation-level only; a tombstoned last message still
counts toward seq (C1 counts positions, not content).

---

# 12. PHASE 33.8 — FRONTEND CHAT UI + SOCKET CLIENT

## 12.1 Repo-truth layout (prompt skeleton adjusted, SS4.1 applied)

The 33.8 prompt's preferred skeleton was adjusted to repo truth (recorded in
SS4.1, applied under the 33.8 authorization "adjust to repo truth"):

| Prompt skeleton | Repo truth (implemented) |
|---|---|
| `pages/chat/ChatPage.jsx` | `src/pages/chat/ChatPage.jsx` (pages are lowercase dirs) |
| `components/chat/*` | `src/components/chat/*` (8 feature-local components) |
| `services/chatApi.js` | `src/services/chatService.js` (all 62+ services are `*Service.js`) |
| `realtime/chatSocket.js` | `src/services/realtime/chatSocketClient.js` (with 32.11 SSE client) |
| `store/chatSlice.js` | `src/redux/slices/chatSlice.js` (repo has redux/slices, no store/) |

## 12.2 Routes + nav

`/app/chat` and `/app/chat/:conversationId` — lazy() child routes of the
existing tenant stack (RequireAuth + RequireRole(TENANT_ROLES) + AppLayout),
so ChatPage ships as its own chunk (verified in `vite build` output:
`ChatPage-*.js`). "Chat" nav item added to all five role nav arrays.

## 12.3 State model (chatSlice)

`realtimeStatus: idle|connected|unavailable`; `conversations[]` (as returned
by 33.7, caller-projected); `byId[conversationId] = { items(ASC by seq),
nextCursor, hasMore, status, error }`; `pending[conversationId]` keyed by
clientMessageId until the created broadcast resolves it. Reducers:
messageCreated (dedupe by _id/seq, clears matching pending, bumps
lastMessage*, increments unread only for inactive conversations),
messageUpdated, messageDeleted (text -> null), olderLoaded (prepend, no
dups), readUpToApplied.

## 12.4 Socket behaviour

`io({ path:'/socket.io', auth:{ token } })` SAME ORIGIN via vite proxy
(token from the Redux auth slice, never query string, never logged).
Refused handshake (FEATURE_UNAVAILABLE / UNAUTHORIZED) closes the socket —
no infinite retry; the orange banner shows and history stays readable via
REST. ACKs are callback-promises with a 10s bound. Join on open, leave on
close/unmount; readUpTo on open and on new arrivals while active (socket
first, REST /read fallback). CONFLICT_EDIT_VERSION refetches history and
warns. Delete asks for confirmation, then tombstone placeholder renders.
Text is rendered only as plain React text nodes — no
dangerouslySetInnerHTML anywhere in the feature.

## 12.5 Vite proxy fix (required for same-origin socket)

`server.proxy` gains `/socket.io` and `ws:true`; the DUPLICATE `preview`
key (second silently won, dropping the proxy block) is merged into one.
Preview now proxies /api + /socket.io on 4173.

## 12.6 Dependency

Frontend: `socket.io-client ^4.8.3` only (matches backend socket.io 4.8.3).
Backend deps untouched.

## 12.7 Verification (honest)

- `npm run build` (Frontend): SUCCESS, ChatPage emitted as its own lazy
  chunk (59.65 kB).
- chatSlice reducer exercised in Node with real dispatched actions:
  pending resolve, unread increment rules, update/delete, older-page
  dedupe, read marker — ALL PASS.
- NOT verifiable in this sandbox (no Mongo/Redis): live login, two-user
  round trip, banner-with-Redis-down in a real browser. Those are the
  localhost acceptance steps below.

## 12.8 Limitations

No attachments UI (33.10), no moderation UI (33.9), no notifications, no
presence/typing (never), DIRECT list title resolves names via the member
identity projection (12.10) with the scoped /users list as a supplementary
source, list pagination "load more conversations" not wired (first page
of 30), virtualization not added (no new deps).

## 12.9 Localhost acceptance origin flag (33.8 fix)

Local acceptance runs hit the 33.1 origin gate with `NODE_ENV=production`
and a `CLIENT_URL` that may not list the Vite origin. `socketConfig.js`
gains an EXPLICIT opt-in: `CHAT_ALLOW_LOCALHOST_ORIGINS=true` accepts
loopback origins (any port) and the absent-Origin edge produced by
same-origin proxied polling. Default off; parsed like every enablement
flag (literal `true` only); never widens to non-loopback origins; pinned by
test/chatSocketFoundation.test.js. Public deployments must leave it unset.
Remember: enablement flags are read AT STARTUP - the backend must be
restarted after changing them.

## 12.10 Member identities + live list nudge (33.8 fix)

"Unknown user" root cause: name resolution relied on `GET /users`, which is
permission-scoped (`scopedUserFilter`) - an EMPLOYEE holding only
`EMPLOYEE_READ_SELF` lists only themselves, while a DIRECT conversation
still contains a colleague. Fix (no new permission surface):

- `chatReadService.buildMemberDirectory` does ONE bounded `User.find`
  (`name email avatarUrl` only - no role/status/cursor) per read call;
  `sanitizeConversationForMember` attaches it as `members[].user` on both
  list and detail. Cursors stay private exactly as before (pinned).
- Frontend `nameOfUserId` merges the /users directory with the projected
  member identities; the directory wins only when it has the id.

Live discovery of a conversation created in ANOTHER window: socket rooms are
joined per OPEN conversation only, so a window sitting on the Chat page
never saw brand-new conversations until reload. Added:

- personal room `chat:user:<id>` joined at connect (chatKeys already had it);
- `src/socket/realtimeNudge.js` - a REST-to-socket seam bound in
  `initSocketServer.attach()` / unbound in `stop()`; controllers call
  `notifyConversationsChanged(memberIds)` after create/addMembers/remove;
- the event `chat:conversations:changed` carries NO payload (data-less
  nudge). The client sets `chat.conversationsStale`; ChatPage refetches the
  list once. Mongo stays the single source of truth; when realtime is off
  the seam is a no-op and REST behaviour is unchanged. Not presence, not
  typing, not receipts - pinned by test/chatRealtimeNudge.test.js and the
  updated event/folder pins in test/chatSocketFoundation.test.js.

Degraded-mode honesty (same fix): a refused handshake closes the client
socket by design, so after Redis/API recovery the window stays "unavailable"
until the user retries. The orange banner now has a Retry button
(one re-handshake per click, never an automatic retry loop), and an ACK that
times out over a half-dead transport reports "Chat realtime is not
connected." instead of a misleading server-blame message.

---

# 13. PHASE 33.9 — MODERATION + ADMIN CONTROLS + AUDIT

## 13.1 What this unit adds (and what it deliberately does not)

Adds the company-level moderation layer on top of the 33.2/33.3/33.6
primitives:

- disable / re-enable a conversation (read-only lock),
- moderator tombstone-delete of ANY message,
- group membership management widened (never narrowed) by a permission,
- an audit trail for every moderation action.

Not in this unit: presence, typing, last-seen, per-message receipts,
attachments (33.10), rate limits/observability (33.11). Read state stays C1
and stays private — moderation never reads or exposes another member's
cursor.

## 13.2 Permissions (SYSTEM_PERMISSION_VERSION 36 → 37)

The chat domain previously had NO catalogue entries on purpose: chat access
is MEMBERSHIP, enforced Mongo-authoritatively. Moderation is a different
thing — a company-level power — so 33.9 adds the smallest possible entry:

  resource CHAT, actions MODERATE + GROUP_MANAGE (both scope ALL)

  CHAT_MODERATE      disable/enable any conversation; tombstone any message
  CHAT_GROUP_MANAGE  add/remove members in any group

Grants (DEFAULT_ROLE_MATRIX):

  COMPANY_ADMIN  both (inherited automatically: every scope-ALL permission)
  HR_MANAGER     both
  MANAGER        CHAT_MODERATE only — a manager moderates content but does
                 not administer group membership
  EMPLOYEE       neither

NO CHAT_READ was invented: reading stays membership-gated, so an employee
who is not a member still sees nothing.

The bump to 37 flows through the existing migration in
`ensureCompanyRoles` (permissionVersion $lt → $addToSet), so already
provisioned company roles receive the two permissions exactly once on the
next ensure. No plan/subscription feature is attached (unmapped resource =
allowed by `permissionAllowedByPlan`), matching how 33.3–33.8 shipped; the
subscription gates (`checkSubscriptionStatus` / `checkWriteAccess`) still
apply to every route.

`hasPermission` resolution is wrapped to fail CLOSED (`.catch(() => false)`)
exactly like the payroll analytics/fnf/statutory call sites: a broken
permission resolve can never become moderation power.

## 13.3 REST contracts

    PATCH /api/chat/conversations/:conversationId/disable
      body { reason? }        (≤ 200 chars, optional, trimmed)
      → { conversation, changed }
    PATCH /api/chat/conversations/:conversationId/enable
      → { conversation, changed }
    POST  /api/chat/conversations/:conversationId/messages/:messageId/moderate-delete
      body { reason? }        (≤ 200 chars, optional)
      → { conversationId, messageId, deletedAt, changed }

All three require `checkWriteAccess` + `requireAnyPermission(['CHAT_MODERATE'])`.
Membership is NOT required: tenant scope (req.companyId) + the permission is
the gate, so an HR admin can moderate a group they are not in. A conversation
in another tenant answers 404 "Conversation not found." — the same shape a
genuinely missing id produces, so no cross-tenant existence leaks.

Idempotence is part of the contract: disabling a disabled conversation (or
enabling an enabled one) returns `changed: false`, writes nothing and audits
nothing — a retry is not a moderation event.

## 13.4 The lock (read-only mode)

`ChatConversation.isDisabled / disabledAt / disabledByUserId` (33.2) are set
and cleared by the service. Enforcement:

  send / edit / delete   refused with CONVERSATION_DISABLED for every
                         non-moderator, on socket AND REST paths
  history (33.4)         unchanged — always readable, which is the point of
                         a lock: silence the channel, preserve the record
  moderator delete       still allowed (removing abuse in a locked channel is
                         the primary use case)
  moderator send/edit    still refused — a moderator is not above the lock
  join / readUpTo        unaffected

Lock/unlock fans the existing data-less 33.8-fix nudge
(`chat:conversations:changed`) to every member's personal room, so other
windows show the banner without a manual reload. When realtime is off the
nudge is a no-op and each window learns on its next fetch — REST stays truth.

## 13.5 Moderator deletion

`socket chat:message:delete` keeps its sender-only rule. When that rule
refuses (MESSAGE_NOT_EDITABLE / CONVERSATION_DISABLED /
NOT_FOUND_OR_FORBIDDEN) the handler resolves CHAT_MODERATE for the socket's
server-derived principal and, only then, retries through
`moderateDeleteMessage`. The refusal codes are the ONLY trigger, so the happy
path stays a single Mongo round-trip and the moderator lookup never runs for
ordinary members.

The tombstone mechanics are 33.6's, unchanged: `deletedAt` +
`deletedByUserId` set, `text` nulled, runValidators on, idempotent on retry,
`chat:message:deleted` broadcast with `deletedByUserId`. Because the deleted
event carries BOTH ids, the client can tell a self-delete from a moderator
removal and renders "Message removed by a moderator" without ever seeing the
original text.

Moderators may NOT edit other people's messages: edit stays sender-only.
Delete-only is the deliberate choice (an edited message under someone else's
name is a forgery surface).

## 13.6 Group membership management

The 33.2 rule — a member of the group who holds the in-group ADMIN role — is
untouched. 33.9 only WIDENS it: a caller holding CHAT_GROUP_MANAGE may manage
any group in the tenant without being a member and without the in-group role.
Invariants (pinned by tests):

- a group keeps ≥ 1 ADMIN (the existing orphan guard — the last admin cannot
  be removed),
- a group keeps ≥ 2 members (cannot be emptied),
- late joiners still start unread-free (`joinedAtSeq`/`lastReadSeq` seeded at
  the current `lastMessageSeq`),
- membership management stays tenant-scoped.

## 13.7 Audit semantics (privacy law)

Every real moderation action writes exactly one `AuditLog` row:
actor/actorName/actorRole, action (`CHAT_CONVERSATION_DISABLED`,
`CHAT_CONVERSATION_ENABLED`, `CHAT_MESSAGE_MODERATED_DELETE`), method, path,
ip, targetType, targetId, previousValue/newValue.

- NO message text ever enters the audit. The tombstone nulls the text in
  ChatMessage; the audit stores `{ conversationId, reason }` only.
- NO read state, NO member cursors, NO other members' data.
- The reason is bounded twice (validator + `boundModerationReason`, 200 chars)
  and stored in the audit only — not on the conversation or message document.
- Writes are best-effort by design: a failed audit must not mask a successful
  moderation action, but it is logged by error NAME only (never payloads).
- The socket path audits through the same service, so a moderator removal is
  recorded whichever transport performed it.

## 13.8 Frontend (minimal, permission-gated)

- `usePermission()` resolves CHAT_MODERATE from the server permission set —
  never from a role name. Loading state keeps the controls hidden.
- Header: a Disable / Re-enable button (moderators only, with confirm).
- A red banner "Conversation disabled by an admin..." plus a `Disabled` badge
  in the title; the composer is disabled and edit/delete affordances hide for
  everyone (`locked` prop) while history stays scrollable.
- A moderator gets a shield delete action on other members' messages; the
  removal goes over REST (audited, works even when realtime is down) and the
  local row is tombstoned immediately.
- Deleted bubbles read "Message removed by a moderator" when
  `deletedByUserId ≠ senderUserId`, otherwise "This message was deleted".
- No new presence/typing UI, no new vendors, no emojis.

## 13.9 Tests + verification

`test/chatModeration.test.js` (23 tests, hermetic — no Mongo, no Redis, no
socket.io-client) pins: catalogue + role-matrix grants, version 37, the 403
refusals, the lock/unlock writes, cross-tenant 404s, idempotence without
duplicate audits, the bounded reason, the absence of message text in audit
rows, moderator tombstone of another member's message, socket fallback
(positive + negative + happy-path non-invocation), disabled-conversation send
refusal, and the membership invariants.

Stale pins inverted, not deleted: the three attendance suites that asserted
the literal `SYSTEM_PERMISSION_VERSION = 36` now assert the version FLOOR
(≥ 36) with a comment naming 36 (31.15) and 37 (33.9).

## 13.10 Limitations (honest)

- Group-level roles beyond ADMIN/MEMBER are not modelled; a moderator cannot
  be scoped to "their" group only — CHAT_MODERATE is company-wide.
- A disabled conversation has no auto-expiry; re-enabling is manual.
- The audit is write-behind best-effort (no transactional outbox), so an audit
  row can be missing if the process dies between the write and the audit.
- Moderators can delete but never edit others' messages.
- No moderation UI for message history/audit browsing (the existing admin
  audit surface is unchanged).
- Lock/unlock during an open socket session is visible to other members on
  their next fetch or nudge; there is no per-message "locked" system line.

---

# 14. PHASE 33.9-FIX — THE EDIT CRASH (unhandled rejection → API shutdown)

## 14.1 Symptom

Live acceptance of 33.9: the first TEXT edit that actually reached Mongo took
the API down.

    [error]: Unhandled Rejection: ValidationError: text: TEXT messages require
             non-empty text; SYSTEM, FILE and deleted messages must not carry
             body text.
    [info]: [Shutdown] unhandledRejection received - draining gracefully...
    [error]: [Shutdown] Graceful shutdown timed out after 10000ms - forcing exit.

## 14.2 Root cause (latent 33.6 defect, exposed by 33.9 acceptance)

`ChatMessage.text` carries a cross-field validator that needs `type` and
`deletedAt` ("may this document carry a body right now?"). It read them as
`this.type` / `this.deletedAt` and assumed `this` is the document.

That assumption is wrong for **update validators**. Mongoose runs
findOneAndUpdate/updateOne validators with `this` = the **query** (see
`node_modules/mongoose/lib/helpers/updateValidators.js`: `const context =
query`), and only validates the paths present in the update. Reproduced
offline (33.9-fix):

    scope.type = undefined | scope.deletedAt = undefined | scope.getUpdate ? function
    FAIL  EDIT   $set {text, editedAt, editedByUserId} -> <the exact crash message>
    PASS  TOMBSTONE $set {text:null, deletedAt}

So `editTextMessage`'s `$set: { text: newText, ... }` saw `type === undefined`
and threw on every edit; the tombstone update happened to pass only because
`$set.text` was already null. Sends were never affected — they use
`ChatMessage.create`, i.e. full-document validation.

Earlier edit attempts in acceptance never reached Mongo (realtime was down, so
the client failed first). This crash needed the socket to be alive at the same
moment as the DB write — which is exactly what 33.9's acceptance produced.

## 14.3 Why it was an *outage* and not a 500

socket.io invokes listeners through EventEmitter and ignores the returned
promise, so a rejected `async` chat listener becomes an
**unhandledRejection** — and the 32.x process policy drains the whole API on
one. A bad edit from one client therefore killed every tenant's API.

## 14.4 The fix (two layers)

1. **Model — the validator now reads state where it actually lives.**
   `updateScopeOf(scope)` returns the update (`$set` / `$setOnInsert`) when
   `this` is a query, else the document itself; the rule then enforces only
   what is knowable:
   - a tombstoned/bodied conflict (`deletedAt` set) must carry no body —
     checkable on both paths;
   - a SYSTEM/FILE body must be empty — checkable when `type` is named;
   - otherwise the value is a TEXT body and must be non-empty.
   Services still own the full decision (edit filters on `{ type: 'TEXT',
   deletedAt: null }`), so an update that does not mention those fields is
   held to its local rule — never to a guess. The misleading comment that
   caused the bug is gone.

2. **Socket — no async listener may reject.** Every authenticated chat
   listener now runs inside a `guard(socket, log, event, handler)` that turns
   a service throw into a stable `RETRYABLE` ACK and logs the error **name**
   only. This is defense in depth: ANY future service error (network blip,
   validation, bug) can no longer take the process down. The unauthenticated
   stubs stay raw — they are synchronous and cannot produce a rejection.

## 14.5 Pins

- `test/chatModels.test.js` (+6): drives the REAL schema validator the way
  mongoose does (`path.doValidate(value, query, { updateValidator: true })`)
  for the edit and tombstone shapes, plus the offline document path, plus a
  source pin that the scope helper exists.
- `test/chatSocketResilience.test.js` (NEW, 7 tests): a throwing service yields
  a RETRYABLE ack for send/edit/delete/readUpTo, the log carries the error
  name and nothing else, the success path is untouched, and no chat listener is
  registered as a raw async function.
- `test/chatSocketFoundation.test.js`: the event-registration pin now detects
  BOTH registration shapes (raw stubs + guarded listeners) — inverted, not
  deleted, so "which events exist" is still enforced.

## 14.6 Operator note

The crash is a server-side defect, not an environment problem: after pulling
this fix the API no longer needs a restart to survive a bad edit. If a window
still shows "Chat realtime is not connected.", that is the separate
Redis/transport issue (section 12.10) — use the banner's Retry button.

---

# 15. PHASE 33.9 — LOCALHOST ACCEPTANCE (PowerShell, beginner-friendly)

Everything below is copy-paste. Nothing here needs Postman unless you want
the raw REST checks; the UI covers the product surface.

## 15.1 What changed in the logs (read this first)

The development console line now prints the metadata the observability
middleware already attached — status code first:

    2026-09-26 10:12:41 [info]: http.request.complete status=200 method=GET route=/api/chat/conversations durationMs=12.4 requestId=...
    2026-09-26 10:12:56 [warn]: http.request.slow status=403 method=PATCH route=/api/chat/conversations/:conversationId/disable durationMs=1602.5 thresholdMs=1500

So while you accept 33.9 you can read the RBAC verdict straight off the
terminal: **200** = allowed, **403** = refused (no CHAT_MODERATE),
**404** = not found / other tenant. These are the SAME events as before —
only the human line got the fields (production JSON and logs/combined.log
always had them).

## 15.2 Start the stack

    # Terminal 1 — API
    cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly
    git pull
    cd Backend
    npm install
    npm run dev

    # Terminal 2 — UI
    cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
    npm install
    npm run dev

Wait for "Server running" in Terminal 1, then open
http://localhost:5173 in the browser.

IMPORTANT (permissions changed in 33.9): log out and log back in once, so the
frontend refetches your permission set. The new permissions are granted to
existing roles by the version migration (36 → 37) on the first API start
after `git pull` — if the Disable button does not appear for an admin, check
Terminal 1 for the role-migration log and restart the API.

## 15.3 Acceptance — the five checks

Check 1 — the button exists for a moderator, and only for a moderator
  1. Log in as Manikandan (COMPANY ADMIN). Open Chat, pick a conversation.
  2. A "Disable" button appears in the conversation header (next to the
     title). Log out and back in as an EMPLOYEE: it must NOT appear.
  3. Expect in Terminal 1: a GET (or PATCH) line with status=200 for the
     admin; the employee never issues the call at all (no log line).

Check 2 — disabling locks the conversation, for everyone, live
  1. As the admin, click Disable → confirm.
  2. The header shows the "Disabled" badge and the red banner
     "Conversation disabled by an admin..." appears; the message box is
     greyed out.
  3. In a second browser window (or another machine on localhost), logged in
     as the other member, the same banner appears within a second or two
     WITHOUT a reload (the lock nudge), and their composer is locked too.
  4. History stays readable in both windows — that is the point of a lock.
  5. Terminal 1 shows: status=200 on PATCH .../disable.

Check 3 — a locked conversation refuses sending (and a member cannot unlock)
  1. As the member, try to send a message → it is refused with
     "This conversation is disabled." and no message appears.
  2. As the member, try calling the REST endpoints anyway (the UI hides the
     button, the server must still refuse). In PowerShell:

       $token = "PASTE_YOUR_JWT_HERE"
       $id    = "PASTE_CONVERSATION_ID_HERE"
       Invoke-RestMethod -Method Patch `
         -Uri "http://localhost:5000/api/chat/conversations/$id/enable" `
         -Headers @{ Authorization = "Bearer $token" }

     Expect a 403 (Forbidden) — and a `status=403` line in Terminal 1.
     That 403 is the acceptance: the gate is the server, not the UI.

Check 4 — moderator delete of someone else's message
  1. As the admin (conversation re-enabled), hover another member's message:
     a shield (remove as moderator) button appears.
  2. Click it → confirm. The bubble is replaced by
     "Message removed by a moderator" in every open window.
  3. As the message's own author, hover a message that was NOT
     removed by a moderator: you see the normal pencil/trash; the pencil is
     never offered on somebody else's message (moderators delete, they do
     not edit).
  4. Terminal 1 shows status=200 on POST .../moderate-delete.

Check 5 — the audit trail (no message text anywhere)
  Using MongoDB Compass (or mongosh) against your own database:

      db.auditlogs.find({ action: /^CHAT_/ }).sort({ createdAt: -1 }).limit(10)

  Expect rows with action CHAT_CONVERSATION_DISABLED /
  CHAT_CONVERSATION_ENABLED / CHAT_MESSAGE_MODERATED_DELETE, carrying ids and
  the bounded reason only. Confirm by eye: NO message text in any of them.

## 15.4 Automated tests (exact)

    cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
    node --test test/chatModeration.test.js          # 33.9 moderation
    node --test test/chatSocketResilience.test.js    # the crash guard
    node --test test/loggerStatusLine.test.js        # the status line
    npm run test:all                                 # the whole suite

Expected: 23, 7 and 8 passing respectively; `test:all` 2400+ passing with
0 failures (the same totals this workspace reports).

## 15.5 If something looks wrong

- No Disable button as admin → log out/in (permission refetch), and confirm
  Terminal 1 restarted AFTER `git pull` (the role migration runs then).
- Banner says "Realtime unavailable" → that is the Redis/transport issue, not
  33.9; click the banner's Retry once Redis is awake (section 12.10).
- 403 on your own disable → that account lacks CHAT_MODERATE; only
  COMPANY_ADMIN, HR_MANAGER and MANAGER have it by default.
- 404 on the REST call → wrong conversation id, or the conversation belongs to
  another company (that is the intended non-leaking answer).
- Old log lines had no status → the API was not restarted after pulling this
  change.

---

# 16. PHASE 33.10 — PRIVATE ATTACHMENTS (UPLOAD + GATED DOWNLOAD)

## 16.1 What this unit adds

A conversation member can attach a file to a message, and any member of that
conversation can download it later. The bytes live in the repo's EXISTING
private storage; the database stores a server-generated key and display
metadata only. There is no public URL, and no signed URL is ever persisted.

Not in this unit: virus scanning (there is no scanner in this repo — see
§16.6), image thumbnails/previews, drag-and-drop, multi-file drag, resumable
upload, background purge of removed bytes (documented limitation in §16.7).

## 16.2 Data model

`src/models/ChatAttachment.js` (NEW)

    companyId, conversationId, uploadedByUserId   (all indexed, immutable)
    storageProvider   CLOUDINARY_AUTHENTICATED | LOCAL_PRIVATE (repo enum)
    storageKey        select: false  — never returned by a normal read
    checksumSha256    select: false  — durable integrity proof, not a payload
    originalFileName  sanitized at upload (max 220)
    mimeType, sizeBytes
    scanStatus        NOT_CONFIGURED | PENDING | CLEAN | REJECTED | ERROR
    scanCheckedAt, removedAt
    index: (companyId, conversationId, createdAt desc)

`ChatMessage.attachments[]` (NEW field, `_id: false`)

    { attachmentId, fileName, mimeType, sizeBytes }

References ONLY. No key, no URL, no bytes. `ChatMessage` now also carries
`{ companyId, conversationId, 'attachments.attachmentId' }` (multikey) for
the "is this attachment already used?" check.

## 16.3 Limits (utils/chatFileRules.js)

- allowlist: PDF / JPG / JPEG / PNG / WEBP — the repo's OWN list
  (`middlewares/documentFilePolicy.js`), with the extension↔MIME cross-check,
  so a `.pdf`-named executable or a browser MIME lie is refused.
- size: 10 MB per file — the repo's document cap, not a new number.
- count: 5 files per message.
- storage keys are built by the SERVER only
  (`crewly-private-chat-attachments/<companyId>/<conversationId>/<uuid>`);
  caller input never reaches a key. A read-side guard
  (`assertSafeStorageKey`) refuses `..`, `\`, absolute paths, percent-encoded
  traversal and oversized keys.
- No new env var: the dev-local directory has a code default
  (`private_storage/chat-attachments`, already gitignored). Production
  refuses the local fallback entirely.

## 16.4 REST contract

    POST /api/chat/conversations/:conversationId/attachments   (multipart, field "file")
      → { attachment: { _id, conversationId, fileName, mimeType, sizeBytes,
                        scanState, createdAt } }
      404 for a non-member / other tenant (same shape as a missing row)
      400 for type/size violations and for a disabled conversation

    GET  /api/chat/attachments/:attachmentId/download
      → 200 streamed bytes with
          Cache-Control: private, no-store, max-age=0
          X-Content-Type-Options: nosniff
          Content-Disposition: attachment; filename="<sanitized>"
      404 for a non-member, another tenant, a withdrawn file, or a row whose
      provider is unknown — all four are indistinguishable on purpose.

Downloads are decision-ordered: tenant + membership are proven from Mongo
FIRST, then the bytes are fetched (bounded, 15 s timeout, 413 if the provider
body exceeds the cap). For Cloudinary rows a signed URL (≤ 5 min) is minted as
an INTERNAL hop only — the browser never receives a provider URL, and there is
exactly one auth model (the same Bearer token as every other endpoint). This
mirrors how the BGV evidence download already streams private files.

## 16.5 Socket contract (FILE messages)

    client → server : chat:message:sendFile { conversationId, clientMessageId,
                                              attachmentIds: [...],
                                              text? }   (33.10-fix4: caption)
    server → client : chat:message:created  { conversationId, message }  (broadcast,
                                              message.attachments = references)
    ACK             : { ok: true, data: { message } } | { ok: false, code, message }

Server rules:

- every id is revalidated against the SAME tenant and the SAME conversation,
  and must not already be referenced by another message — an id from another
  room cannot be attached, and an id cannot be replayed (the message stores
  what the service RETURNED, never what the client asked for);
- the idempotency index, atomic seq allocation and E11000 convergence are the
  SAME ones TEXT uses (`persistMessage` core, shared by both senders);
- the conversation-list preview for a FILE message is the generic word
  "Attachment" — a private filename never lands in a denormalized field;
- a locked conversation refuses the send (CONVERSATION_DISABLED), exactly as
  text does.

## 16.6 ScanState truthfulness

This repository has NO malware scanner. `scanDocumentForMalware()` in the
pre-onboarding security service returns `{ status: 'NOT_CONFIGURED' }` and
there is nothing to call instead. Chat attachments therefore store
`scanStatus: 'NOT_CONFIGURED'` and the API reports it as `scanState`. Nothing
in this unit converts it to CLEAN, and no UI claims a file was scanned. If a
scanner is configured later, the enum already has PENDING / CLEAN / REJECTED /
ERROR and the field is where the result belongs.

## 16.7 Delete-for-everyone also withdraws the file

Tombstoning a message (sender delete 33.6, or moderator delete 33.9) marks
every attachment it referenced as `removedAt`, and the download endpoint
refuses withdrawn rows. Without this, "deleted" would be a half-truth: the
bubble would say the message was removed while the bytes stayed fetchable by
id. The withdraw step is best-effort and idempotent, and it runs before the
tombstone write so the intent is recorded even if that write then races.

## 16.8 Frontend (minimal)

- `AttachmentPicker.jsx` — paperclip in the composer; the file uploads on
  SELECT (REST) and appears as a removable chip. Server caps are mirrored for
  a fast error, the server stays the authority.
- `AttachmentBubble.jsx` — filename, human size, download button. The download
  calls the gated endpoint through the api client (Bearer token), receives a
  blob and hands it to the browser; a 404 renders "This file is no longer
  available." No provider URL ever exists in the component.
- `MessageBubble.jsx` renders attachments above the text; the edit pencil is
  hidden for a FILE message (editing references is not supported in this
  unit); pending (optimistic) messages show the file names while the send is
  in flight.
- Files stay in the tray if the send is refused, so a retry does not
  re-upload.

## 16.9 Tests

`test/chatAttachments.test.js` — 21 hermetic tests, storage layer injected
(no Cloudinary, no Mongo, no HTTP server): non-member and cross-tenant
refusals for upload and download, the response shape never carrying
key/checksum/URL, server-built keys, oversize/type/MIME-lie refusals, upload
refused on a locked conversation, withdrawn-file refusal, traversal-key
refusal, streaming delivery for both providers with 503/413 degradation, the
linking rules (tenant + conversation + unused), reference-only broadcast, and
the download headers (`private, no-store, max-age=0`, sanitized
`Content-Disposition`) driven through the real controller.

Stale pins were INVERTED, not deleted: the 33.1 lifecycle event list and the
33.1/33.2 boundary test now expect `chat:message:sendFile`, `ChatAttachment.js`
and the attachment routes, while still forbidding REST send, edit-history
reads and receipts; the index inventory records the new multikey index; the
resilience pin expects the FILE stub among the unauthenticated raw listeners.

## 16.10 Limitations (honest)

- No malware scanning (nothing to scan with) and no content-disarm; the
  allowlist and structural checks are the only pre-storage validation.
- Removing a message withdraws the FILE reference and refuses the download,
  but the stored bytes are not deleted from the provider — a purge job is a
  deliberate later unit (documented, not forgotten).
- No thumbnails, previews or inline image rendering; every file is a
  download.
- No resumable/sharded upload; the whole file is held in memory for the
  request (bounded by the 10 MB cap and the multer memory policy the rest of
  the repo already uses).
- Attachment storage counts toward nothing (no per-tenant quota in this unit).
- A FILE message cannot be edited (its references are immutable).

---

# 17. PHASE 33.10-fix — THE LOCALHOST UPLOAD 400 + THE TERMINAL LINE

## 17.1 The failure

During localhost acceptance the composer answered **"The file could not be
uploaded."** and the API logged:

    [info]: http.request.complete status=400 method=POST route=/conversations/:conversationId/attachments ...
    [warn]: http.request.rejected status=400 method=POST route=/conversations/:conversationId/attachments error={"name":"Error","message":"A file is required.","statusCode":400,"stack":"Error: A file is required.\n    at ...

Two problems behind one message:

1. **The upload was never multipart.** `services/api.js` creates the shared
   axios instance with `headers: { 'Content-Type': 'application/json' }`. Axios
   serializes a FormData body to JSON when that header survives, so the server
   received a JSON document, multer found no file, and the service threw
   `A file is required.` — a message that names the symptom, never the cause.
   Every other uploader in this repo already states the header explicitly
   (`docsService.js`, `selfService.js`, `companyService.js`); the 33.10 chat
   upload was the one place that relied on auto-detection.
2. **The error text never reached the screen.** `api.js` normalizes every
   failure into `{ message, status, code, data }` and drops `response`, but
   `AttachmentPicker` read `err?.response?.data?.message` — so the server's real
   reason was replaced by the generic sentence. It now reads
   `err?.data?.message || err?.message` and shows the actual refusal (size cap,
   locked conversation, type, membership).

## 17.2 The fixes

- `Frontend/src/services/chatService.js` — the upload posts with
  `{ headers: { 'Content-Type': 'multipart/form-data' } }`, matching the
  established repo pattern for real multipart.
- `Frontend/src/components/chat/AttachmentPicker.jsx` — surfaces the
  normalized error message.
- `Backend/src/utils/chatFileRules.js` — `CHAT_ATTACHMENT_FIELD` (one field
  name for multer and the client), `CHAT_ATTACHMENT_MESSAGES.NOT_MULTIPART`,
  and `isMultipartRequest(req)`.
- `Backend/src/routes/chat/chatRoutes.js` — the upload route checks
  `isMultipartRequest` BEFORE multer and answers
  `400 Attachments must be sent as multipart/form-data (file field "file").`
  A JSON body can therefore never masquerade as a missing file again — for
  this route, the field name and the shape are now named in the refusal.
- Pins: `test/chatAttachments.test.js` §7 exercises the gate through the real
  route middleware (not a source-text pin) and asserts the frontend appends
  `CHAT_ATTACHMENT_FIELD` with an explicit multipart header to the right URL,
  plus the picker's normalized-error read. A future client field rename or a
  dropped header fails the suite instead of failing acceptance.

## 17.3 The terminal line

The 33.9-fix metadata tail made every request a key=value paragraph and printed
the error serializer's JSON — stack included — straight into the terminal:

    [info]: http.request.complete status=200 method=GET route=/api/... durationMs=12.4 bytes=812 requestId=... userId=... companyId=...
    [warn]: http.request.rejected status=400 ... error={"name":"Error",...}

The development console now renders request events as the compact access row
the product has always been read in, one row per request, with the failure
reason on its own line:

    2026-09-26 10:43:26 [http]: POST /conversations/:conversationId/attachments 200 212.500 ms - 49
    2026-09-26 10:43:34 [warn]: 400 - A file is required.
    2026-09-26 10:43:34 [http]: POST /conversations/:conversationId/attachments 400 212.500 ms - 49
    2026-09-26 10:44:02 [error]: 500 - MongoServerError: E11000 duplicate key error ...
    2026-09-26 10:44:09 [warn]: GET /attendance/today/live 200 1370.730 ms - - (slow)

Rules of the row:

- one line, always — control characters and newlines collapse to spaces, the
  row is bounded at 300 chars, and a 5xx keeps its error class name;
- the path is the normalized ROUTE TEMPLATE, never the raw URL: 32.12's
  redaction law strips query strings and tokenized segments (§12/§15), and the
  template is what metrics label on;
- `requestId`, `userId`, `companyId` and the bounded stack are NOT dropped —
  they still travel to `Backend/logs/combined.log` and `Backend/logs/error.log`
  as JSON, which is where an incident is correlated. The production console and
  both file transports are byte-for-byte unchanged; this is a rendering change
  in `logger.js` (`formatAccessRow`) for the development console only.

Spec: `test/loggerStatusLine.test.js` (11 tests) pins the row shape, the
refusal line, the 5xx class name, the 300-char/newline bounds, and that the
JSON transports keep the ids and the stack.

---

# 18. PHASE 33.10-fix2 — THE INVISIBLE MESSAGE (THE BLANK BUBBLE)

## 18.1 The symptom

Localhost acceptance showed a bubble carrying nothing but a timestamp
(2026-09-26, 10:57) in BOTH members' views, while the file sent a minute later
rendered correctly. Nothing looked wrong in the database or the network tab:
the row was there, it was broadcast, and every client drew it.

## 18.2 The cause

The stored body was **invisible** — a zero-width space (\u200B), the class of
character that arrives by copy/paste from other apps. `String(text).trim()`
removes only WhiteSpace and line terminators, so an all-invisible body passed
every "is it empty?" check:

    text = '\u200B'
    text.trim().length      -> 1        (trim does not touch it)
    validateSendPayload(...) -> { ok: true, text: '\u200B' }

The message was therefore stored legitimately, broadcast legitimately, and
rendered by every client as a bubble with no visible character in it. The
blank box was not a rendering failure — the row really contained nothing a
human can read. The client's `canSend` gate had the same hole
(`text.trim()` non-empty), so the composer allowed the send.

## 18.3 The law

**A chat body must contain at least one visible character.** A character is
invisible when it only shapes rendering: C0/C1 controls, zero-width
space/non-joiner/joiner and directional marks, BOM, line/paragraph and bidi
separators, invisible operators (word joiner, ...), soft hyphen, variation
selectors and the Hangul fillers. Anything else — Tamil, emoji (with or
without a variation selector), punctuation, digits — is visible, and one
visible character anywhere in the body makes the whole body visible, so
nothing the product already accepted stopped working.

**A message must render something.** Beyond the text rule: a stored message
must carry either a visible body or at least one attachment reference. A FILE
message's content IS its references, so a FILE message with an empty reference
list is the same hollow bubble and is refused the same way.

## 18.4 What changed

Backend

- `utils/chatTextRules.js` (NEW) — the character law, `hasVisibleText()`,
  documented and pure. `INVISIBLE_TEXT_PATTERN` is a deliberate list, not a
  guess about "a good message".
- `socket/chatSocketValidators.js` — send AND edit require a visible body
  ("A message must not be empty." / "The edited text must not be empty." — the
  existing wording, now enforced correctly).
- `models/ChatMessage.js` — the schema's own `text` validator uses the same
  rule, so the invariant holds for every writer, including `runValidators`
  atomic updates.
- `services/chat/chatMessageService.js` — **the create path refuses what
  nobody could read**: an unrenderable mutation (no visible text AND no
  attachment reference) is refused BEFORE any database work with code
  `EMPTY_BODY`, and logged as `chat.message.unrenderable` with safe scalars
  only (conversation id, sender id, type, text LENGTH, attachment count —
  never the body).
- `socket/chatSocketHandlers.js` — `EMPTY_BODY` is answered as a
  `VALIDATION_ERROR` carrying the rule, not as a retryable server fault, for
  both TEXT and FILE sends.

Frontend

- `utils/chatText.js` (NEW) — the mirror of the rule, so the send button is
  disabled before a round-trip. `test/chatMessageBodyRules.test.js` runs the
  same sample table through BOTH implementations; drift fails the suite.
- `MessageComposer.jsx` — `canSend` uses `hasVisibleText`.
- `ChatPage.jsx` — the optimistic row can never render blank (a body without
  visible characters falls back exactly as a FILE message does).
- `MessageBubble.jsx` — a row with no visible body and no attachment now says
  **"This message could not be displayed"** instead of rendering as a hollow
  box. Rows written before this rule existed stay visible as a fact rather
  than looking like a UI glitch.

## 18.5 The row that is already stored

Nothing is rewritten: the existing blank row now renders as "This message
could not be displayed" (it is a real message with an invisible body, and the
product does not guess what it should have said).

To see how many such rows a database holds — read-only, no writes, no bodies
printed:

    cd Backend
    npm run chat:blank-check

The auditor (`scripts/chat-blank-check.js`) scans every non-tombstoned
message with the SAME rule the API now enforces, prints up to 20 examples as
id/conversation/type/seq/timestamp plus a bounded code-point summary of the
invisible body, and exits 1 when it finds any.

There is deliberately NO automatic repair job: a body nobody can read is
indistinguishable from a body that was never there, and silently deleting
messages is not a UI fix. Operators who want the rows gone delete them through
the normal product path (sender or moderator delete — audited, tombstoned,
`seq` preserved).

## 18.6 Tests

`test/chatMessageBodyRules.test.js` (NEW, 10 hermetic tests): the
`hasVisibleText` sample table, frontend/backend drift, send + edit refusals,
the schema-level refusal (`validateSync`), the create-path invariant
(`EMPTY_BODY` for invisible text, empty lists and missing lists; writes for
renderable text and files), the socket's VALIDATION_ERROR mapping, the FILE
validator's non-empty rule, and the UI pins (gate + fallback). Suite wired
into `test:all`.

## 18.7 The other half of the same lesson

`test/chatMessageBodyRules.test.js` caught a second, self-inflicted bug on the
first run: the new model import did not apply, so the schema validator threw
`hasVisibleText is not defined` for EVERY text write. Mongoose reports a
throwing validator as a validation failure with the validator's own message —
which looks exactly like a legitimate refusal. A rule that can throw is not a
rule; the suite pins both the refusal AND the acceptance so a broken import
cannot masquerade as enforcement.

---

# 19. PHASE 33.10-fix3 — THE HISTORY DROPPED THE FILE

## 19.1 The symptom

After the page was reloaded, a file message that had rendered correctly on
arrival showed as **"This message could not be displayed"**. The database was
fine: the same rows rendered their pdf bubbles whenever they arrived live over
the socket.

## 19.2 The cause

`sanitizeMessageForHistory` (33.4, `services/chat/chatService.js`) is a field
**whitelist**, and 33.10 never added `attachments` to it. The two surfaces
therefore disagreed about the same document:

    socket broadcast  -> { ..., attachments: [ { attachmentId, fileName, ... } ] }
    GET .../messages  -> { ..., attachments: undefined }        ← the file vanished

A FILE message renders its content from `attachments`; with the field missing,
the bubble had nothing to draw. This was invisible in the first acceptance run
because the file was still the live socket copy at the time.

## 19.3 The fix

- `utils/chatAttachmentView.js` (NEW) — `toAttachmentReferences()`: THE
  definition of an attachment reference on the wire (id + fileName + mimeType +
  sizeBytes; never a storage key, URL or checksum).
- `services/chat/chatService.js` — the history projection now carries
  `attachments` through that helper.
- `socket/chatSocketHandlers.js` — the broadcast uses the same helper, so the
  two surfaces cannot drift again; `test/chatHistory.test.js` compares them
  directly for the same row.
- Nothing in the database was ever wrong, and nothing needs repairing: reload
  the page and the files come back.

## 19.4 Why the 33.10 tests missed it

The 33.10 suite pinned the socket projection, the linking rules and the
download headers, but nothing pinned the REST **history** shape — a whitelist
regression is exactly the kind of bug a projection test catches and a service
test does not. `test/chatHistory.test.js` now pins:

- the history view of a FILE row (references only; a storage key, a checksum,
  a key namespace or any URL must not appear in the serialized item);
- a tombstoned FILE row keeps its references (the bubble shows the tombstone);
- `listMessages` returns FILE messages with their files attached;
- **the history view and the socket broadcast are deep-equal for the same
  row**, which is the assertion that would have caught this on day one.

## 19.5 The blank row at 10:57

§18 fixed a body that cannot be read; this section fixed a file that was never
sent to the client. They are different failures with the same visible symptom,
and one command separates them:

    cd Backend
    npm run chat:blank-check

- **It reports a row** → that row is genuinely blank in the database (an
  invisible body, or a FILE message with no references). §18's rule now
  refuses to write either; the row itself stays visible as
  "This message could not be displayed" until it is deleted through the
  product.
- **It reports 0 rows** → the blank bubble you saw was purely this projection
  bug, and it is fixed.

---

# 20. PHASE 33.10-fix4 — ATTACHMENT PLUS MESSAGE (CAPTIONS)

## 20.1 What was wrong

The composer has always handed the typed text to `onSend(text, files)`, and the
optimistic bubble showed it — but the FILE payload never carried it and
`sendFileMessage` stored `text: null`, so **typing a message and attaching a
file silently threw the message away**. The phase-33.2 model rule made that
explicit: "a SYSTEM/FILE message must not smuggle body text into `text`".

That rule was aimed at SYSTEM messages and at bodies smuggled into a FILE row
by an update. A caption the sender typed next to the file is neither of those:
it is the message. `33.10-fix4` makes it legal and carries it end to end.

## 20.2 The rules

- The caption is **optional**: a FILE message may carry one, or not carry one.
- A caption **is a body**: it must contain at least one visible character
  (§18) and it obeys the same length cap (`CHAT_MESSAGE_TEXT_MAX`) as any text.
- A FILE message **must still reference at least one file**. "Caption, no file"
  is not a FILE message — it is a TEXT message, and the create path refuses it
  ("A file is required.").
- A SYSTEM message still carries no body, and a tombstoned message still clears
  its caption (the tombstone is the whole render).
- The conversation-list preview prefers the caption (it is a normal body) and
  falls back to the generic word `Attachment` — a private filename still never
  reaches a denormalized field.
- **Not supported:** editing a caption. Edit stays sender-only and TEXT-only
  (§16.5); a FILE message's caption is immutable with its references, which
  keeps the edit-history contract and the attachment link intact.

## 20.3 What changed

- `socket/chatSocketValidators.js` — the FILE payload takes an optional
  `text`: trimmed, visibility-checked, length-capped, returned as `null` when
  absent (never an empty string).
- `services/chat/chatMessageService.js` — `sendFileMessage` stores the caption
  and uses it as the preview; the renderability invariant now also refuses a
  FILE mutation with **no file** (message "A file is required.") even when a
  caption is present.
- `socket/chatSocketHandlers.js` — the FILE handler forwards the caption.
- `models/ChatMessage.js` — the text validator: TEXT needs visible text, FILE
  may carry only a visible caption, SYSTEM and deletions carry none.
- `Frontend/src/pages/chat/ChatPage.jsx` — the caption travels IN the FILE
  payload (sending it in the text event would split one message into two).

## 20.4 Tests

`test/chatMessageBodyRules.test.js` 14 tests: the FILE payload with/without a
caption, an invisible caption refused, an over-long caption refused, the stored
message keeping its caption while the caption stays optional, a FILE mutation
with no file refused even with a caption, and the socket path forwarding the
caption and broadcasting it (payload + ACK). `test/chatModels.test.js`
INVERTED the old "FILE must not carry a body" pin to "FILE may carry a visible
caption" and added the invisible-caption refusal; the two wording pins moved to
the reworded validator message.

---

# 21. PHASE 33.11 — HARDENING (ABUSE CONTROLS, PAYLOAD CAPS, OBSERVABILITY)

No new chat features. This unit makes the existing surfaces hard to abuse and
hard to misread in production.

## 21.1 Rate limits — one design, two surfaces

Both surfaces ride the **32.4 distributed store**
(`utils/rateLimitStore.js`) and the existing express middleware
(`middlewares/securityRateLimit.js`). No new limiter, no new package.

**Identity is always `companyId` + `userId`, server-derived:** for REST from
`req.companyId` / `req.user._id` (after `protect` + `tenantMiddleware`), for
sockets from `socket.data` (written during the JWT handshake). A client cannot
choose its own bucket, and one tenant's traffic never consumes another's
(pinned by `test/chatHardening.test.js`).

| Surface | Action | Window | Max | Why this number |
|---|---|---|---|---|
| REST | create conversation | 10 min | 10 | a human creates a handful; a script is obvious |
| REST | list conversations | 1 min | 120 | clients refetch on every nudge |
| REST | conversation detail | 1 min | 120 | same |
| REST | add member | 10 min | 20 | membership churn is rare |
| REST | remove member | 10 min | 20 | same |
| REST | message history | 1 min | 60 | paging is a few calls per screen |
| REST | read marker | 1 min | 120 | fires on every incoming message |
| REST | moderation delete | 1 min | 30 | a moderator acting in bulk is still not 30/min |
| REST | lock / unlock conversation | 1 min | 30 | a state change that notifies every member; cheap once, expensive in a loop |
| REST | attachment upload | 10 min | 20 | each upload can hold 10 MB of memory |
| REST | attachment download | 1 min | 120 | downloads are cheap per call, bounded per file |
| Socket | `chat:join` | 1 min | 30 | reconnects + room hops |
| Socket | `chat:message:send` | 10 s | 20 | 2/s sustained is generous for a human |
| Socket | `chat:message:sendFile` | 1 min | 20 | the most expensive send |
| Socket | `chat:message:edit` | 10 s | 20 | matches send |
| Socket | `chat:message:delete` | 10 s | 20 | matches send |
| Socket | `chat:readUpTo` | 10 s | 60 | fires per message, never blocked by normal use |

Refusals:

- **REST** → `429` with the repo's shape `{statusCode, success:false,
  code:'RATE_LIMITED', message}` plus `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, `X-RateLimit-Reset` and `Retry-After` (shared tier).
- **Socket** → ACK `{ok:false, code:'RATE_LIMITED', message:'Too many
  messages. Slow down and retry.'}` — the same stable code the 33.5 burst
  guard already used, so a client cannot tell the two apart (no probing
  surface).

**The 33.5 per-socket guard stays:** 10 s / 30 writes, one connection, in
memory. It is a cheap first line that costs no Redis hop; it is NOT the abuse
control (it never left the process). Both may refuse; both answer
`RATE_LIMITED`.

## 21.2 Degraded behaviour (never fail-open)

| State | What happens |
|---|---|
| Redis healthy | one shared counter per `(companyId, userId, action)` across API #1/#2/#N (`crewly:<env>:rl:chat-<action>:<companyId>:<userId>`) |
| `REDIS_ENABLED` not `true` | quiet **local** mode: bounded per-process bucket, same refusal contract, no warning spam |
| Redis down / erroring / slower than 250 ms | 30 s process-local circuit + ONE bounded warn per family; every hit served by the bounded local bucket |
| Limiter store throws unexpectedly | the socket limiter refuses (`RATE_LIMITED`) — an abuse control must never fail open |
| A window's `EXPIRE` failed (Redis op timeout) | the counter has no TTL, so without help that identity would be refused FOREVER. The refused request re-asserts the TTL (`EXPIRE ... NX`), so the identity recovers within **one window** — pinned in `test/chatHardening.test.js` |
| `CHAT_SOCKET_ENABLED != true` or the adapter can't attach | socket connections are refused `FEATURE_UNAVAILABLE` (33.1); the REST limits above still apply |

Degradation is always **stricter** (per-process buckets ≈ per-instance limits)
and never unlimited. `chat.rate_limit_degraded{tier}` makes the degraded state
visible to ops instead of silently changing behaviour.

## 21.3 Payload caps

Product caps (enforced by validators, unchanged): text **4,000 characters**,
**5 attachments** per message, delete reason **200 characters**,
`clientMessageId` **80 characters**, conversation title **120**.

Transport cap: `CHAT_MAX_HTTP_BUFFER_BYTES` — **16 KB → 48 KB** in this unit.

Why (measured, not guessed): the largest LEGAL frame was **16,178 B**
(`chat:message:send` with a max emoji message) and **16,330 B**
(`chat:message:sendFile` with a max caption + five attachments — legal since
33.10-fix4) against a 16,384 B bound: **54 bytes of headroom before Engine.IO
framing**, i.e. a user could compose a payload the transport dropped with **no
ACK**. 48 KB gives the product's worst case ≥2× headroom while staying 21×
under Engine.IO's 1 MB default.

The law is pinned: `CHAT_MAX_HTTP_BUFFER_BYTES >= 2 × worstCaseFrameBytes()`
(`utils/chatPayloadCaps.js` + `test/chatHardening.test.js`), so a future
product-cap raise fails the SUITE instead of failing in a user's session.
Oversized payloads are refused with `VALIDATION_ERROR` (never truncated).

## 21.4 Observability rules

Logged on a refusal — `chat.rate_limited` (warn), metadata only:

    { surface, action, tier, count, maximum, windowMs, companyId, userId }

- `action` comes from a **fixed vocabulary** (`CHAT_LIMIT_ACTIONS`); an unknown
  action or surface is **not logged at all** (fail closed) — an unrecognized
  string can never become a log field.
- ids are bounded to 64 chars and dropped if longer (a token pasted into an id
  field never leaks).
- counters `chat.rate_limited{action}` and `chat.rate_limit_degraded{tier}` are
  **allowlisted low-cardinality families** in the existing metrics registry,
  visible through the existing Super Admin Operations diagnostics. No new
  `/metrics`, no new vendor.

**Never logged:** message text, captions, attachment names, storage keys, file
bytes, tokens, cookies, URLs, payload dumps, client-supplied identifiers.
Pinned by a sentinel test: a message body containing
`salary-details-of-employee-42.pdf`, a storage key and a bearer token is logged
as metadata and none of the sentinels appear in the captured output.

Socket lifecycle logs stay as 33.1 wrote them (ids + tenant + disconnect
reason, no payload).

## 21.5 Tests

`test/chatHardening.test.js` — 15 hermetic tests (no Redis, no Mongo, no HTTP
server): REST threshold + 429 shape + headers, per-tenant/per-user bucket
isolation, every REST action has a policy and a middleware, Redis-disabled
local tier still limits, dead-Redis circuit degrades without pounding Redis,
a throwing store is a refusal, socket `RATE_LIMITED` after threshold with the
service never reached, a forged payload cannot move the bucket, one gate per
writing event (and `chat:leave` deliberately ungated), the cap-sufficiency law
+ measured worst frame, oversized text/attachment-list/reason refusals with
boundary cases passing, log-safety with sentinels, vocabulary fail-closed, and
metric increments with an unknown-label refusal.

The 33.1 transport-cap pin in `chatSocketFoundation.test.js` was INVERTED (not
deleted) to the new derivation, so the reason lives in the test.

## 21.6 Operational visibility (no new endpoint)

The platform diagnostics payload (32.12's existing `GET` diagnostics, platform
scope only) gained ONE block — nothing new was exposed, and there is still no
`/metrics`:

    chat: {
      realtime: { enabled, state, reason, localConnections, counters },
      payload:  { capBytes, worstCaseFrameBytes, headroomFactor, sufficient, headroomBytes },
      limits:   { rest: { <action>: { maximum, windowSeconds } },
                  socket: { <action>: { maximum, windowSeconds, event } } },
    }

- `realtime.state` is the process's truth for THIS instance
  (`READY` / `DISABLED` / `UNAVAILABLE` / `STOPPED`) with a reason word from
  the frozen 33.1 vocabulary — the question "is chat realtime up here, and why
  not?" is now answered without reading logs.
- `payload.sufficient` is the transport-vs-product law as a boolean; if a
  future cap change makes it false, ops sees it in the same place the test
  suite fails.
- `limits` is the policy in force, so "why did this 429?" is answerable with
  numbers instead of reading code.
- The block contains **no ids at all** (not even the caller's), no limiter
  keys, no URLs, no secrets. `chat.rate_limited{action}` and
  `chat.rate_limit_degraded{tier}` counters ride the existing `counters`
  section, so a degraded limiter is distinguishable from real abuse.

Deployment pre-flight (`npm run config:check`) now also reports the chat
hardening state, using the same parsers and the same cap law:

    CHAT_SOCKET_ENABLED          true
    CHAT_REALTIME_DEPENDENCY     WARNING: chat enabled with Redis off — every socket connection will be refused
    CHAT_SOCKET_FRAME_CAP        49152 bytes (worst-case frame 17464, sufficient)
    CHAT_RATE_LIMIT_TIER         local per-process (degraded but ENFORCED — never unlimited)

Enabled chat without Redis is reported as a loud **WARNING in every
environment**, never as a blocked deployment. That is a deliberate choice: the
product already handles the shape truthfully (the API starts, REST keeps
working, every socket is refused with the stable `FEATURE_UNAVAILABLE` code,
and the diagnostics block names the reason), so pre-flight's job is to make the
trade-off impossible to miss — not to contradict the server's own behaviour.
The two honest fixes are in the message: enable Redis, or set
`CHAT_SOCKET_ENABLED=false` for a chat that is knowingly HTTP-only.

## 21.7 Wiring is pinned, not assumed

A policy table can be perfect while a route forgets to mount its limiter, so
the suite walks the REAL `chatRoutes` stack and fails if ANY route lacks one —
each of the 12 routes mounts exactly one, for its own action, before the
controller. A future chat route therefore cannot ship as an unlimited abuse
surface: the test refuses it.

## 21.8 A limiter must never block an identity forever

Found in a real boot log during acceptance: `POST /api/auth/refresh 429`, twice,
twelve minutes apart, with **no preceding burst** in the logs and no recovery.

The mechanism: a fixed window gets its TTL on the FIRST hit
(`INCR` → `EXPIRE key ttl NX`). The `EXPIRE` rides the store's 250 ms op
timeout. When it fails — a momentarily loaded Redis is enough — the counter
exists with **no TTL**, so `count > maximum` is true for every later request
from that identity, permanently, until somebody deletes the key by hand. A
protection quietly becomes an outage, and nothing in the logs says why.

The fix (`utils/rateLimitStore.js`): the refusal path repairs the window. On
`count > maximum` the store calls the io contract's optional
`expireIfMissing(key, ttlSeconds)`, which reads `TTL` first and sets one only
when the answer is `-1`, so a healthy window is never extended and the identity
is blocked for at most one further window. It reads `TTL` rather than using
`EXPIRE ... NX` on purpose: `NX` needs Redis 7+ and this product must run
against older servers. Healing is best effort by design:
it can never change the refusal, and an injected io without the method (legacy
and test doubles) skips it entirely.

The suite pins all three halves: the heal happens and the identity recovers
within one window; a heal that itself fails leaves the refusal untouched and
throws nothing; and an io that lacks the method behaves exactly as before.

The runbooks no longer tell an operator that "the window expires on its own" —
that sentence was false for a key in this state, and a runbook that says it is
how a stuck key survives an incident review.

# 22. PHASE 33 CLOSE-OUT — THE AUTHORITATIVE SUMMARY (33.12)

Everything above this line is the unit-by-unit build log (33.1 → 33.11), kept
because the *reasoning* behind each decision still matters. **This section is the
summary**: read it first, follow the pointers when you need the history.

## 22.1 Purpose and scope

Phase 33 is an **in-app chat hub for tenant users**: conversations, messages with
edit history, tombstone deletes, read cursors with C1 unread counts, private
attachments and moderation — multi-tenant, membership-authorized, multi-replica.

| In scope | Deliberately OUT |
|---|---|
| Conversations (DIRECT + GROUP), membership management | Presence, typing indicators, last-seen, activity tracking |
| Messages: send, edit (versioned history), tombstone delete, FILE + optional caption | Reactions, threads, search, message forwarding |
| Read cursors + C1 unread counts (cursor arithmetic only) | Per-message read receipts (per-user fan-out tables) |
| Private attachments: upload, reference-only messages, auth-gated streaming | Public/permanent URLs, image transform vendors, malware scanning claims |
| Moderation: disable/enable, moderate-delete, bounded audit | Moderator text editing of another member's message (never allowed) |
| Rate limits, payload caps, diagnostics, runbooks | Production deployment, vendor selection, capacity claims |

Transport: **Socket.IO for chat** (this phase) and the **32.11 SSE foundation
unchanged**, both riding the same API process. Two transports, two Redis
namespaces, no retirement of either.

## 22.2 Architecture (one picture)

```
 Browser (tenant app)
    |                       |
    |  REST  /api/chat/*    |  Socket.IO  /chat-socket  (chat only)
    v                       v
 LOAD BALANCER (TLS; 32.3 proxy trust; sticky sessions while polling)
   /            |            \
  v             v             v
API #1       API #2        API #N      ← node src/server.js
  |             |             |        Express + Socket.IO on ONE HTTP server
  +------+------+------+------+
         |             |
      MongoDB        Redis
     (truth)     @socket.io/redis-adapter   crewly:<env>:chat:adapter
                 rate-limit counters        crewly:<env>:rl:*
                 SSE realtime channel       crewly:<env>:realtime:events

ONE prefix law for every namespace: BULLMQ_PREFIX when set, else crewly:<NODE_ENV>.
```

Mongo is the only source of truth. Redis is fan-out + counters: lose Redis and
history is still complete over REST — realtime is what degrades, and it says so.

## 22.3 Data model

| Model | Purpose | Notes |
|---|---|---|
| `ChatConversation` | room + members + cursors + lock | `members[]` carry `userId`/`role`; `isDisabled`/`disabledAt`/`disabledByUserId`; `lastMessageSeq`, `lastMessageAt`; per-member `lastReadSeq` |
| `ChatMessage` | one row per message | `seq` (per-conversation, gap-free), `type` TEXT/FILE/SYSTEM, `text` (null when tombstoned), `editVersion`, `deletedAt`, `clientMessageId` (unique per sender+conversation), `attachments[]`, references to system events |
| `ChatMessageEdit` | edit history | one row per edit, capped at 20, ids + bounded text only |
| `ChatAttachment` | private upload metadata | server-built storage key, provider, size, MIME, `scanState`, `removedAt`; never a public URL |
| `AuditLog` | moderation trail | action + ids + bounded reason. **Never message text** |

Full schemas + indexes: §5.1/§5.2. Invariants: §5.3.

## 22.4 REST surface (final, with its limits)

All routes are tenant-scoped, membership-checked and rate-limited per
`companyId:userId` (§21.1).

| Method | Path | Action budget |
|---|---|---|
| POST | `/api/chat/conversations` | `conversation.create` — 10 / 10 min |
| GET | `/api/chat/conversations` | `conversation.list` — 120 / min |
| GET | `/api/chat/conversations/:id` | `conversation.detail` — 120 / min |
| GET | `/api/chat/conversations/:id/messages` | `message.history` — 60 / min |
| POST | `/api/chat/conversations/:id/members` | `conversation.members.add` — 20 / 10 min |
| DELETE | `/api/chat/conversations/:id/members/:userId` | `conversation.members.remove` — 20 / 10 min |
| POST | `/api/chat/conversations/:id/read` | `message.read` — 120 / min |
| PATCH | `/api/chat/conversations/:id/disable` | `conversation.moderateState` — 30 / min |
| PATCH | `/api/chat/conversations/:id/enable` | `conversation.moderateState` — 30 / min |
| POST | `/api/chat/conversations/:id/messages/:messageId/moderate-delete` | `message.moderateDelete` — 30 / min |
| POST | `/api/chat/conversations/:id/attachments` | `attachment.upload` — 20 / 10 min |
| GET | `/api/chat/attachments/:attachmentId/download` | `attachment.download` — 120 / min |

Refusals use the existing error style with code `RATE_LIMITED` and a
`Retry-After` header. Downloads answer `Cache-Control: private, no-store, max-age=0`.

## 22.5 Socket protocol (final, with its limits)

Namespace/path `/chat-socket`; JWT in the handshake `auth` payload only (never
query, header or body). Every event is answered with an ACK envelope
`{ ok: true, data }` or `{ ok: false, code, message }`.

| Event (client → server) | Server → room | Identity budget |
|---|---|---|
| `chat:join` | — | 30 / min |
| `chat:message:send` | `chat:message:created` | 20 / 10 s |
| `chat:message:sendFile` | `chat:message:created` | 20 / min |
| `chat:message:edit` | `chat:message:edited` | 20 / 10 s |
| `chat:message:delete` | `chat:message:deleted` | 20 / 10 s |
| `chat:readUpTo` | — (ACK only; no broadcast) | 60 / 10 s |
| REST-created list changes | `chat:conversations:changed` (personal room) | — |

Stable refusal codes: `UNAUTHORIZED`, `FEATURE_UNAVAILABLE`, `VALIDATION_ERROR`,
`NOT_FOUND_OR_FORBIDDEN`, `CONVERSATION_DISABLED`, `MESSAGE_NOT_EDITABLE`,
`CONFLICT_EDIT_VERSION`, `HISTORY_LIMIT_REACHED`, `RATE_LIMITED`, `RETRYABLE`.
Plus the 33.5 per-socket write guard (30 writes / 10 s) on top of the identity
budget. Payload cap: 48 KB (> 2× the worst-case legal frame, §21.3).

## 22.6 Security posture (Phase 33 as a whole)

- **Tenancy**: every query carries `companyId`; cross-tenant reads and writes are
  a 404 in the same shape as a genuinely missing row — no existence leak.
- **Membership**: authorization is server-side on every surface (REST handler,
  socket listener, attachment stream). Non-members cannot read, send, edit,
  delete, mark read or download.
- **Identity**: `companyId:userId` is server-derived (`req.companyId` /
  `socket.data`) — a payload can never move its own identity or bucket.
- **Tokens**: chat uses the tenant-user JWT only. Kiosk, candidate and platform
  auth shapes are refused at the handshake.
- **No surveillance**: no presence, no typing, no last-seen, no per-message
  receipts. Read cursors are private: a member never sees another member's cursor.
- **No secrets in logs**: rate-limit and moderation logs carry ids, counts and
  bounded reasons — never message text, attachment names, tokens or URLs.
- **Attachments**: private by construction; the server builds storage keys,
  downloads stream through the backend, and no permanent public URL is stored.
- **Audit**: moderation actions record ids + bounded reason + previous/new state.
  Message text is never copied into the audit.

## 22.7 Degraded modes (truthful, never silent)

| Condition | What the product does |
|---|---|
| Redis disabled/down | Chat sockets are refused with `FEATURE_UNAVAILABLE` (no half-open gate); REST chat still works; history is complete |
| Limiter store unreachable | Rate limits fall back to a bounded per-process bucket (never unlimited); if even that is unavailable, the request is REFUSED — an abuse control never fails open |
| A limiter window lost its TTL | The refusal re-asserts the TTL, so no identity is blocked forever (§21.8) |
| Attachment storage unavailable | 503/413 with an honest sentence — never a crash, never a false success |
| Socket transport blocked | The client shows an explicit unavailable state and offers retry; REST remains usable (runbooks §2) |
| Mongo slow | Sockets answer `RETRYABLE` (bounded), the error NAME is logged, never the message or a stack |

## 22.8 Verification matrix

Every row below is **proven by a hermetic test that must exist** — the coupling
itself is pinned by `phase33Closeout.test.js` → "every matrix row points at a
test that exists", so this table cannot rot into fiction. "Live check" is the
manual step for the parts a hermetic test cannot own (two processes, real Redis).

| # | Feature / risk | Proof (hermetic) | Live check |
|---|---|---|---|
| 1 | Tenant isolation — no cross-company reads, uploads or moderation | `chatConversations.test.js › getConversation 404s for other tenants and non-members`<br>`chatConversations.test.js › DIRECT create rejects self-chat and cross-company targets`<br>`chatHistory.test.js › non-member and cross-tenant callers get 404 before any message read`<br>`chatAttachments.test.js › a cross-tenant upload is refused with the same 404 shape`<br>`chatModeration.test.js › moderation never crosses the tenant boundary (404, no existence leak)` | Sign in as a user of another company and open a conversation id from tenant A: 404, never content |
| 2 | Membership enforcement — read, history, join, send, edit, delete, readUpTo | `chatConversations.test.js › getConversation 404s for other tenants and non-members`<br>`chatHistory.test.js › non-member and cross-tenant callers get 404 before any message read`<br>`chatSocketSend.test.js › chat:join allowed for member, refused for non-member and other tenant`<br>`chatSocketSend.test.js › chat:message:send refused for non-member`<br>`chatEditDelete.test.js › chat:message:edit refused for non-member and for other tenant`<br>`chatEditDelete.test.js › chat:message:delete refused for non-member and for a member who is not the sender`<br>`chatReadMarkers.test.js › chat:readUpTo validates lastReadSeq and refuses non-members` | Remove yourself from a group in a second browser, then try to send: refused; history still readable |
| 3 | Socket auth — missing/invalid/expired/foreign tokens, kiosk/candidate/platform, origin | `chatSocketFoundation.test.js › rejects a missing token`<br>`chatSocketFoundation.test.js › rejects an expired token`<br>`chatSocketFoundation.test.js › rejects the kiosk device token (typ:"kiosk")`<br>`chatSocketFoundation.test.js › rejects the kiosk employee-context token (typ:"kiosk-employee")`<br>`chatSocketFoundation.test.js › rejects every platform role — platform auth is AdminSession, not a tenant JWT`<br>`chatSocketFoundation.test.js › candidate portals hold no JWT at all — secure tokens ride the URL, never a socket`<br>`chatSocketFoundation.test.js › a token claiming a DIFFERENT company than the Mongo user is refused`<br>`chatSocketFoundation.test.js › reads the token from the auth payload only — never query, header or body`<br>`chatSocketFoundation.test.js › refuses a MISSING origin — stricter than app.js (fail closed)` | In devtools, clear the token and (re)load chat: the socket is refused and the UI says so |
| 4 | Redis down — socket unavailable, REST unaffected, limits never fail open | `chatSocketFoundation.test.js › REDIS_ENABLED=false ⇒ adapter refused and NO client is created`<br>`chatSocketFoundation.test.js › attach() with Redis unavailable reports FEATURE_UNAVAILABLE and admits nothing`<br>`chatSocketResilience.test.js › a throwing send service becomes a RETRYABLE ack, never a rejection`<br>`chatHardening.test.js › with Redis intentionally disabled the limiter still limits (local tier)`<br>`chatHardening.test.js › a dead Redis degrades to the bounded local bucket, never to unlimited`<br>`chatHardening.test.js › a limiter store that throws is a REFUSAL, never an open door`<br>`chatHardening.test.js › a normal request passes while Redis is dead (degrade, not fail-closed)` | Set `REDIS_ENABLED=false` in a NEW terminal, restart the API: chat shows unavailable, history still loads (§J step 5) |
| 5 | Idempotency — a retried send/delete/create never duplicates | `chatSocketSend.test.js › idempotency: same clientMessageId twice returns same message, one broadcast`<br>`chatConversations.test.js › DIRECT create is idempotent and tenant-scoped`<br>`chatEditDelete.test.js › chat:message:delete is idempotent: second delete ok with same deletedAt, no re-broadcast`<br>`chatModeration.test.js › moderate-delete is idempotent: retry reports changed:false and writes no new audit` | Double-click Send with a slow network: one bubble appears |
| 6 | Edit concurrency + history | `chatEditDelete.test.js › chat:message:edit with a stale expectedEditVersion returns CONFLICT_EDIT_VERSION untouched`<br>`chatEditDelete.test.js › chat:message:edit updates text, bumps editVersion, appends history, broadcasts once`<br>`chatEditDelete.test.js › chat:message:edit refuses beyond the history cap (20) with HISTORY_LIMIT_REACHED`<br>`chatEditDelete.test.js › chat:message:edit payload validation rejects bad expectedEditVersion and empty text` | Edit the same message in two tabs: the second gets the conflict sentence, not a silent overwrite |
| 7 | Tombstone safety — deleted text never leaks, delete is idempotent | `chatHistory.test.js › sanitizeMessageForHistory never leaks a tombstone body`<br>`chatHistory.test.js › deleted messages come back tombstone-safe in a real page`<br>`chatEditDelete.test.js › chat:message:delete tombstones own message and broadcasts once`<br>`chatHistory.test.js › a tombstoned message keeps its references (the bubble shows the tombstone)` | Delete a message, reload: no text, tombstone row remains |
| 8 | Unread counts (C1) — formula, monotonicity, clamp | `chatReadMarkers.test.js › computeUnreadCount: zero messages, partial read, fully read, late joiner`<br>`chatReadMarkers.test.js › updateReadMarker is monotonic: a lower request never rewinds the cursor`<br>`chatReadMarkers.test.js › updateReadMarker clamps to lastMessageSeq (cannot read past the end)`<br>`chatReadMarkers.test.js › updateReadMarker refuses non-members and other tenants identically`<br>`chatReadMarkers.test.js › chat:readUpTo ACKs the caller with cursor + count and broadcasts nothing` | Read a conversation in one tab; the badge clears and never goes negative |
| 9 | Attachment privacy — membership, private headers, server-built keys, no public URL | `chatAttachments.test.js › a non-member cannot upload (404, and nothing is stored)`<br>`chatAttachments.test.js › the download controller streams privately: private,no-store + sanitized name`<br>`chatAttachments.test.js › the server builds the key: caller input cannot reach it`<br>`chatAttachments.test.js › a member upload returns display metadata only — never a key or checksum`<br>`chatAttachments.test.js › a locked conversation refuses uploads (the 33.9 lock covers files)`<br>`chatAttachments.test.js › delivery streams through the backend for both providers` | Copy a download URL into a private window (no session): refused |
| 10 | Moderation — the lock blocks writes, moderators still moderate, audit is text-free | `chatModeration.test.js › socket send in a disabled conversation is refused for a member (CONVERSATION_DISABLED)`<br>`chatModeration.test.js › socket edit in a disabled conversation is refused for a member (CONVERSATION_DISABLED)`<br>`chatModeration.test.js › socket delete in a disabled conversation is refused for a member, and overturned for a CHAT_MODERATE socket`<br>`chatModeration.test.js › moderator tombstones ANOTHER member message: text nulled, audited once, no content stored`<br>`chatModeration.test.js › non-moderator cannot disable a conversation (403, no write)` | As admin: disable a conversation → members cannot send/edit/delete; you still can; audit log holds ids only |
| 11 | Rate limits — REST + socket thresholds, identity-scoped, never fail open | `chatHardening.test.js › a restricted chat action refuses with 429 after its threshold`<br>`chatHardening.test.js › every route in the chat router carries an identity limiter`<br>`chatHardening.test.js › the socket refuses with the stable RATE_LIMITED ACK after the threshold`<br>`chatHardening.test.js › a payload claiming another identity cannot move the socket bucket`<br>`chatHardening.test.js › oversized payloads are refused with VALIDATION_ERROR, not truncation`<br>`chatHardening.test.js › every chat REST action has a policy and a built middleware`<br>`chatHardening.test.js › a window whose EXPIRE failed can no longer block an identity forever` | Send 21 messages fast: the 21st is refused with the slow-down sentence; sending resumes ~10 s later |
| 12 | Multi-instance fan-out — one channel, one prefix, cross-instance delivery | `chatSocketFoundation.test.js › the adapter key is env-namespaced and separate from the SSE namespace`<br>`realtimeFoundation.test.js › the gateway DEFAULTS to the app namespace law, not a hardcoded env`<br>`observabilityFoundation.test.js › diagnostics payload is bounded and secret-free (no URIs/hosts/keys/users)` | §J: run API #1 + API #2, two browsers, message crosses instances; stop #1 and #2 keeps serving |
| 13 | Frontend safety — no HTML injection, no token in console, explicit unavailable state | `chatHardening.test.js › a rate-limited send shows the server sentence, not a generic failure`<br>`phase33Closeout.test.js › the chat UI never injects HTML, never prints a token, and renders an explicit unavailable state` | Open the chat page with the API stopped: an explicit unavailable state, not a blank screen |
| 14 | Docs integrity — the matrix points at real tests; no secrets in docs; runbooks complete | `phase33Closeout.test.js › every matrix row points at a test that exists`<br>`phase33Closeout.test.js › the phase docs carry no credential-shaped strings`<br>`phase33Closeout.test.js › every runbook keeps its six-part structure` | `npm run test:chat` (this repo) |

**What this matrix does NOT claim.** No capacity numbers, no throughput, no
"supports N users" — those need load testing with real infrastructure, which
this phase deliberately does not do. The tests prove *correctness and
authorization*, not scale.

## 22.9 Deferred / not built (honest list)

- Presence, typing indicators, last-seen, activity tracking — locked OUT of Phase 33.
- Per-message read receipts — the read model is C1 (per-member cursor) only.
- Reactions, threads, replies, search, forwarding, message pinning.
- Malware scanning of attachments (`scanState` is truthful, not a scanner).
- Capacity/load certification and any production deployment.
- Frontend unit-test harness: the UI is verified by source pins + the production
  build + manual acceptance (the repo has no frontend test runner).

## 22.10 Operator entry points

| Command (from `Backend/`) | What it does |
|---|---|
| `npm run config:check` | Config truth, including the 4 chat lines (enablement, Redis dependency warning, frame cap law, limiter tier) |
| `npm run chat:blank-check` | Read-only scan for blank/unrenderable stored message bodies (exit 1 on findings) |
| `npm run test:chat` | Every chat/realtime test file (hermetic; no live Redis or Mongo required) |
| `npm run test:all` | The full hermetic suite |

Diagnostics ride the existing platform block (`chat: { realtime, payload, limits }`) —
counts, tiers and caps only. No new endpoint, no new metric surface.

## 22.11 Running the proof

```powershell
# From the repository root — hermetic: no Redis, no Mongo, no network.
cd Backend
npm run test:chat          # every Phase 33 test file
npm run test:all           # the whole backend suite
npm run config:check       # chat config lines (exit 1 on real problems)
```

Live, opt-in, two-instance verification: `docs/PHASE_33_CHAT_RUNBOOKS.md` §7 and
the handoff checklist in §J of the 33.12 build prompt.
