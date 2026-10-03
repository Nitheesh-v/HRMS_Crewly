# Phase 37.4 — Distributed Realtime Presence

**Status:** Complete. 77 backend tests + 21 frontend tests, all green.
One file reversible (§5 architectural choice — see below).

## 1. What this phase ships

A cross-instance realtime presence surface for the **Team Availability**
page. The page has, since 37.3, polled through HTTP. 37.4 adds a
`/presence` Socket.IO namespace that fans `presence:changed` events
across API replicas, so a status change in one backend propagates to
the team page in another backend within ~1 second.

The architecture is **Socket.IO + Redis pub/sub** — the same Redis
the SSE gateway has used since 32.11. **No NATS was installed.**

## 2. Files added (37.4 only — 37.1-37.3 untouched)

```
Backend/src/services/presence/presenceEvents.js          # envelope builder/parser
Backend/src/services/presence/presenceBus.js            # thin façade over the 32.11 gateway
Backend/src/services/presence/presenceLive.js            # pure snapshot helpers
Backend/src/services/presence/presenceLiveStore.js       # Redis ephemeral store (DI seams)
Backend/src/services/presence/presenceLiveStoreRegistry.js # process-local singleton
Backend/src/utils/presenceKeys.js                        # env-namespaced Redis keys / rooms
Backend/src/socket/presenceSocketConfig.js               # constants, origin gate
Backend/src/socket/presenceSocket.js                     # server factory
Backend/src/socket/presenceSocketHandlers.js             # 3 events, idempotent publish
Frontend/src/services/realtime/presenceChannel.js        # /presence socket.io-client
Frontend/src/services/realtime/presenceRuntime.js        # one controlled lifecycle
```

`presenceResolver.js`, `presenceService.js`, `presenceTeamService.js`,
`presenceConfig.js`, and `presenceController.js` were **extended** (a
fourth `live` argument to the resolver, an optional `liveStore` to the
services, a `safePublishIfChanged` after `putStatus`, a presenceLiveKey
prefix in the controller). They were **not moved** — 37.1-37.3 layout
preserved.

## 3. Lifecycle

```
AppLayout (Frontend)
   └── startPresenceRuntime()
         ├── startPresenceChannel()    (open /presence, handshake = ticket)
         ├── sock.on('presence:changed', listener)
         └── startVisibilityTicker()   (1× / 30s while tab visible)
```

StrictMode-safe: `started` is a one-shot flag; the listener is
replaced, not stacked. `stopPresenceRuntime()` closes the channel,
stops the ticker, and tears down timers.

## 4. The 3 events the browser emits

| Event             | Payload          | Throttle         | Side effect              |
|-------------------|------------------|------------------|--------------------------|
| `presence:heartbeat` | `{}`           | every 30s        | server stamps Redis      |
| `presence:activity`  | `{at: ISO}`    | every 30s        | server stamps Redis + may publish on transition |
| `presence:disconnect` | (server-side) | n/a              | server marks disconnected, NO publish         |

The browser never sends a presence value. The resolver decides.

## 5. The 1 envelope the server emits

```json
{
  "schemaVersion": 1,
  "companyId": "...",
  "userId": "...",
  "presence": "available|busy|dnd|away|offline|unknown",
  "presenceSource": "manual|automatic|none",
  "occurredAt": "2026-10-03T10:00:00.000Z",
  "source": "connect|activity|resolver"
}
```

≤ 512 bytes. Allowed keys exactly. Parser drops future
`schemaVersion` values and malformed frames (forward-safe).

## 6. The architectural choice — no NATS

The 37.4 spec called for NATS. **NATS is not installed.** Instead,
the 32.11 SSE gateway's `crewly:<env>:realtime:events` Redis pub/sub
channel is reused. The bus is a thin façade (`presenceBus.js`) that
calls `getRealtimeGateway().publish(...)` — exactly the same wire the
SSE gateway already publishes on. The decision is one-file reversible
(rewriting `presenceBus.js` to call a NATS client instead, if ever
needed). The team page, the resolver, the controller, and the slice
are all NATS-agnostic.

## 7. What 37.4 does NOT do

| Anti-ban | How it is pinned |
|----------|------------------|
| No AI                    | `presenceBoundaries.test.js` scans every 37.4 file for `openai|anthropic|claude|gpt|llm|gemini` |
| No localStorage / browser storage | same scan for `localStorage|sessionStorage|document.cookie` |
| No MS Graph / Azure / Teams | same scan for `microsoftonline|graph.microsoft|azuread|teams.` |
| No NATS in the browser  | `presenceSourcePins.test.js` scans Frontend for `nats`, `VITE_NATS_URL`, `VITE_REDIS_URL` |
| No Redis in the browser | same scan for `ioredis|node-redis|redis-client|VITE_REDIS_URL` |
| No attendance / leave / payroll | `presenceBoundaries.test.js` strips comments then asserts the words don't appear in 37.4 source |
| No Mongo writes on heartbeat | `presenceSocketHandlers.js` only calls `store.refreshHeartbeat` — no Mongoose |
| No FLUSH*/KEYS/SCAN | `presenceBoundaries.test.js` strips comments and asserts no Redis scan/flush keywords |
| No client-claimed room join | `presenceBoundaries.test.js` asserts the only `socket.on(...)` calls in handlers are `presence:heartbeat` / `presence:activity` / `disconnect` |
| No client-claimed identity | server joins from `socket.data` only; tests pin the source |
| No HEARTBEAT publish | handler's heartbeat handler does not call `publishPresenceChanged` |

## 8. The env answer (what to add to your local `.env`)

**One line.** No new secrets. No NATS URL. No VITE_*.

```ini
PRESENCE_SOCKET_ENABLED=false
```

Everything else is reused:

- `REDIS_ENABLED` + `REDIS_URL` — already there. Same Redis serves
  the SSE gateway (32.11) and the new ephemeral liveness store
  (HSETs `crewly:<env>:presence:live:<companyId>:<userId>` with EXPIRE
  ≈ 15 min grace).
- `REALTIME_ENABLED` — already there. Re-pointed at `presence:changed`
  envelopes via the bus façade.
- `CHAT_ALLOW_LOCALHOST_ORIGINS` + `CLIENT_URL` — already there.
  Reused by `isPresenceOriginAllowed` (no parallel
  `PRESENCE_ALLOW_LOCALHOST_ORIGINS`).

When you flip `PRESENCE_SOCKET_ENABLED=true`:

- The server boots the `/presence` namespace on the SAME http server
  as chat. Same port, same TLS, same origins.
- The team page starts receiving `presence:changed` events.
- If Redis is down, every connection is refused as
  `FEATURE_UNAVAILABLE` (same contract as chat 33.1) — the page keeps
  working over REST.

## 9. The two named tests in the spec

- `test/presenceLiveStore.test.js` (25) — pure helpers, key
  namespacing, fake Redis store, 6 store methods, structural pins.
- `test/presenceRealtime.test.js` (12) — resolver change-detector.
- `test/presenceBus.test.js` (15) — envelope shape, bus NEVER
  throws, presenceBusAvailable respects realtimeEnabled.
- `test/presenceSocket.test.js` (16) — factory refuse on Redis-down,
  allowed-origin, namespace isolation, handler registration.
- `test/presenceBoundaries.test.js` (9) — no AI/localStorage/User-
  import, identity from `socket.data`, server-controlled rooms,
  hidden-employee not delivered.
- `test/presenceRuntime.test.js` (10) — runtime idempotency, slice
  pure-reducer, presenceTicked idempotence.
- `test/presenceSourcePins.test.js` (11) — no NATS, no Redis, no
  VITE_NATS_URL, no VITE_REDIS_URL, channel/runtime separation,
  same ticket path as chat, AppLayout wiring.

**77 backend + 21 frontend = 98 tests, all hermetic, all green.**

## 10. Files NOT moved (preserved 37.1-37.3 layout)

- `Backend/src/controllers/presence/`, `Backend/src/routes/presence/`,
  `Backend/src/validators/presence/`, `Backend/src/models/UserPresence.js`,
  `Backend/src/models/PresenceTenantConfig.js`,
  `Backend/src/services/presence/{presenceConfig,presenceErrors,presenceService,
   presenceResolver,presenceTeamService,presenceTenantConfigService}.js`,
  `Frontend/src/services/presenceService.js`,
  `Frontend/src/redux/slices/presenceSlice.js` (extended, not moved),
  `Frontend/src/pages/team/TeamAvailabilityPage.jsx` (extended),
  `Frontend/src/components/presence/`.

## 11. Rollback

Revert to commit `64441eb`. `presenceBus.js` is the one file to
re-rewrite if NATS ever replaces the 32.11 gateway for presence
fan-out. Every other 37.4 file is reusable in a NATS world without
change.

---

**Phase 37.4 awaiting localhost acceptance.**
