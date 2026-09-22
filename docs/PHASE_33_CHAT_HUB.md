# CREWLY — PHASE 33: CHAT HUB

Multi-tenant, membership-authorized, multi-replica in-app chat for the Crewly
tenant app. Built on Mongo (truth) + Redis (fanout) + Socket.IO (transport).
No external vendor, no third-party API.

**Status:** 33.1 IMPLEMENTED · TESTED. Product features **NOT BUILT YET**.

---

## 1. Unit map

| Unit | Scope | Status |
|---|---|---|
| **33.1** | **Realtime foundation: Socket.IO server + JWT handshake + Redis adapter + FEATURE_UNAVAILABLE gate** | **IMPLEMENTED · TESTED** (`chatSocketFoundation`, 86 tests) |
| **33.2** | **Chat persistence models + indexes (`ChatConversation`, `ChatMessage`, `ChatMessageEdit`)** | **IMPLEMENTED · TESTED** (`chatModels`, 54 tests) |
| 33.3 | Conversation REST APIs (create/list/get, membership enforced) | NOT STARTED |
| 33.4 | Message history REST APIs (paginated, Mongo-authoritative) | NOT STARTED |
| 33.5 | Socket protocol: server-authorized room join + send with ACK + idempotency | NOT STARTED |
| 33.6 | Edits (with history + concurrency control) + tombstone deletes | NOT STARTED |
| 33.7 | Read cursors + unread counts (C1 model) | NOT STARTED |
| 33.8 | Frontend chat UI + socket lifecycle | NOT STARTED |
| 33.9 | Moderation + admin controls + moderation audit | NOT STARTED |
| 33.10 | Private attachments | NOT STARTED |
| 33.11 | Rate limits, abuse controls, observability, runbooks | NOT STARTED |
| 33.12 | Production verification matrix (cross-instance proof) | NOT STARTED |

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
| `npm run test:all` | **2315 / 2315 pass, 0 fail** (2175 before 33.1 + 85 + 54 + 1) |
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
| `Backend/src/controllers/chatController.js` | 33.3 | pending |
| `Backend/src/routes/chatRoutes.js` | 33.3 | pending |
| `Backend/src/validators/chatValidators.js` | 33.3 | pending |
| `Backend/src/services/chatService.js` | 33.3 | pending |

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
