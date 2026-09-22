# Phase 33.1A — Socket.IO Foundation (chat transport, foundation only)

**Status:** implemented, hermetic-verified. No chat features yet.
**Scope of this unit:** backend transport foundation ONLY. No chat models,
no chat routes, no chat UI, no frontend change, no new permissions.

---

## 1. What this unit is (and is not)

Crewly already has a realtime foundation built on **SSE** (Phase 32.11):
`/api/realtime/ticket` + `/api/realtime/stream`, with single-use 30 s tickets
in shared Redis. That foundation is **untouched and still active** — Socket.IO
is *additive*, reserved for Chat (33.5+).

This unit delivers the transport seam only:

| Delivered | Not delivered (later units) |
| --- | --- |
| Socket.IO server attached to the **existing** `http.Server` | Chat models / collections (33.2) |
| Tenant-only JWT handshake identity | Conversation REST APIs (33.3–33.4) |
| Strict CORS (same allowlist as Express) + `cookie: false` | `chat:*` event family (33.5–33.7) |
| Redis adapter for cross-replica fan-out (node-redis) | Chat UI / composer (33.8) |
| Truthful degraded behaviour (Redis down ⇒ refused) | Moderation, attachments, rate limits (33.9–33.11) |
| Bounded registry, payload caps, hermetic tests | Presence / typing — **OUT of Phase 33 entirely** |

---

## 2. Files

### Created

```
Backend/src/infrastructure/socket/
  socketConfig.js     ONE enable flag + code-owned bounds + event allowlist
  socketRegistry.js   bounded process-local socket counters (per user / per process)
  socketProtocol.js   event allowlist + 16 KB payload cap (pure, never throws)
  socketAuth.js       handshake identity — mirrors authMiddleware's laws
  socketAdapter.js    @socket.io/redis-adapter wired to DEDICATED node-redis connections
  socketGateway.js    create/start/stop lifecycle + handshake pipeline + process singleton

Backend/src/config/corsOrigins.js   shared origin allowlist (app.js + socket)
Backend/test/socketFoundation.test.js  45 hermetic tests
docs/PHASE_33_1A_SOCKET_FOUNDATION.md  this document
```

### Modified

| File | Change | Why |
| --- | --- | --- |
| `Backend/src/app.js` | Local CORS allowlist replaced by an import from `config/corsOrigins.js` | ONE allowlist, so REST and sockets cannot diverge |
| `Backend/src/server.js` | Start the gateway after the SSE gateway; stop it in the existing drain chain | Attach to the same HTTP server; never hold shutdown open |
| `Backend/package.json` | `+ socket.io`, `+ @socket.io/redis-adapter`, `+ redis`; new `test:socket-foundation`; suite added to `test:all` | Transport + adapter; ladder coverage |
| `Backend/.env.example` | `SOCKET_ENABLED=false` (name only) | Configuration inventory stays complete |

---

## 3. Dependencies (user-approved; 3 backend packages, 0 frontend)

| Package | Version | Role |
| --- | --- | --- |
| `socket.io` | ^4.8.3 | Server transport |
| `@socket.io/redis-adapter` | ^8.3.0 | Cross-replica fan-out |
| `redis` (node-redis) | ^5.12.1 | Dedicated pub/sub clients **for the adapter only** |

**ioredis remains the client for everything else** — BullMQ, cache, rate
limits, SSE tickets, worker heartbeat. The two libraries coexist by design;
the adapter owns its own connections and shares nothing.

`@socket.io/redis-adapter` peer requirement is only
`socket.io-adapter ^2.5.4` (verified). `createAdapter(pubClient, subClient)` is
the documented node-redis entry point (verified in the installed README).

---

## 4. Laws enforced by this unit

1. **Disabled by default.** `SOCKET_ENABLED` parsed explicitly (`=== 'true'`);
   unset means a logged no-op. Same stance as 32.11.
2. **Same HTTP server, no new port.** `io` attaches to the `http.Server`
   returned by `app.listen(...)`, so the §32.1 replica topology is unchanged.
3. **Tenant-only handshake.** `socketAuth.js` mirrors `protect` check for
   check: signature → subject → verifier principal → account exists → ACTIVE →
   tenant user (has `companyId`) → session claim → `tokenVersion`/`companyId`
   match → live `SecuritySession`. Kiosk device tokens, BGV verifier tokens and
   platform principals are refused.
4. **No cookies.** `cookie: false`; the token travels in the handshake auth
   payload. No cookie-auth surface exists anywhere in the API.
5. **Websocket-only.** Polling requires sticky sessions, which the
   multi-replica law forbids — so polling is refused rather than partially
   working. `connectionStateRecovery` is consequently not enabled either.
6. **Strict CORS.** The socket handshake calls the *same* `originAllowed`
   function as the Express layer.
7. **Truthful degradation.** Redis is required. `isAvailable()` is
   `started && adapterReady && redisAvailable()`, re-evaluated on **every**
   handshake, so a mid-life Redis outage stops new connections instead of
   half-serving them. Refusal code: `FEATURE_UNAVAILABLE`.
8. **Bounded.** 16 KB payloads, 5 sockets/user, 500 sockets/process,
   handshake/ping/upgrade timeouts set in code (not env).
9. **Generic refusals.** Clients receive exactly one code —
   `UNAUTHORIZED` / `FEATURE_UNAVAILABLE` / `CAPACITY`. The internal reason
   word and any token material stay in the server log. No enumeration oracle.
10. **No message content in logs.** Only counts, codes and reason words.
11. **Shutdown-safe.** `stop()` disconnects sockets, closes the adapter's Redis
    connections and detaches handlers. It deliberately does **not** call
    `io.close()`, which would close the `http.Server` and pre-empt the bounded
    32.2 graceful shutdown (`node_modules/socket.io/dist/index.js:489-501`).

---

## 5. Event vocabulary (infrastructure-only)

```js
['connection:ready', 'system:ping', 'socket:proof']
```

Product families (`chat:*`, `message:*`, `presence:*`, `typing:*`, `user:*`)
are **forbidden** here and are pinned as forbidden by test. Presence and
typing are out of Phase 33 entirely: no availability inference, no last-seen,
no activity tracking.

---

## 6. Localhost acceptance

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run test:socket-foundation     # 45/45 hermetic
```

**Step 1 — default OFF (no Redis needed).**

```powershell
npm run dev
```
**Expect:** the log shows no `[Socket]` listener line, and the API behaves
exactly as before (SSE untouched).

**Step 2 — enabled without Redis ⇒ refuse, don't half-work.**

```powershell
$env:SOCKET_ENABLED="true"; npm run dev
```
**Expect:** a `[Socket] Redis is not ready — chat will refuse connections
(FEATURE_UNAVAILABLE)` warning and `adapter: unavailable` in the listener line.
A handshake attempt is refused with the `FEATURE_UNAVAILABLE` code.
Finally: `Remove-Item Env:SOCKET_ENABLED`

**Step 3 — enabled with Redis ⇒ adapter ready.**

```powershell
$env:SOCKET_ENABLED="true"; $env:REDIS_ENABLED="true"; $env:REDIS_URL="redis://127.0.0.1:6379"; npm run dev
```
**Expect:** `adapter: ready`. `GET /api/health/ready` still reports the same
shape as before.

**Step 4 — SSE must still work exactly as before (regression).**

```powershell
$env:REALTIME_ENABLED="true"; npm run dev
```
**Expect:** `/api/realtime/ticket` + `/api/realtime/stream` behave as they did
before 33.1A — this unit changed neither.

Cleanup: `Remove-Item Env:SOCKET_ENABLED, Env:REALTIME_ENABLED`

---

## 7. Known limits (honest)

- No chat feature exists yet; this is a transport seam with an
  infrastructure-only vocabulary.
- Session revocation is enforced **at handshake**. Per-command revalidation
  (membership + live session) is a 33.5 requirement, not a 33.1A one.
- Cross-replica fan-out requires a real Redis; the sandbox has none, so the
  adapter path is proven by injected fakes + wiring assertions, not by two
  live replicas. A live two-instance check belongs to 33.12.
- `@socket.io/redis-adapter` adds node-redis alongside ioredis. That is the
  approved decision; the risk to watch is connection-count growth per replica
  (2 extra connections), to be measured in 33.11.
