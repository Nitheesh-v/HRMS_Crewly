# Phase 37.4 — Distributed Realtime Presence (runtime reconciliation)

**Current status (Phase 37.8 hardening):** implementation and hermetic suites are in place. Localhost/owner acceptance has **not** been performed. Use [`PHASE_37_8_LOCALHOST_ACCEPTANCE.md`](./PHASE_37_8_LOCALHOST_ACCEPTANCE.md); the older shell-based script is superseded.

This file preserves the Phase 37.4 topic but corrects earlier architecture notes that described the SSE gateway as the presence transport. The runtime below is the source of truth as of 2026-10-07.

## Runtime transport and publisher/subscriber path

- Presence uses the existing Socket.IO `/presence` namespace and the already-installed `@socket.io/redis-adapter` with the existing `redis` Node client. It does **not** publish presence through the infrastructure SSE gateway.
- Each enabled API process creates one dedicated Redis publisher client and one duplicated subscriber client for the presence adapter. The adapter channel key is namespaced with the existing `getQueuePrefix()` value. The shared API ioredis client remains the presence live-store client; it is not repurposed as the adapter's pub/sub pair.
- A REST mutation, socket transition, or expiry observer publishes through `presenceBus.js` → `presenceSocketPublisher.js` → `namespace.to(tenantUserRoom).emit(...)`. The Socket.IO Redis adapter performs the local namespace delivery and cross-instance Redis fan-out. Its subscriber forwards remote packets locally; remote receipt does not call the publisher again. Adapter UID filtering drops a Redis echo back to the originating adapter.
- Product presence rooms are private and server-derived: `presence:user:<companyId>:<userId>`. No company-wide presence room is joined or used for product broadcasts. Teammate rows continue to come from the already-authorized, bounded team REST query and its polling recovery path.

## Configuration, startup, and lifecycle

`PRESENCE_SOCKET_ENABLED` is the only attachment switch (`.env.example` remains `false`). When false, no presence namespace is attached. When true, `server.js` mounts it before `server.listen()` and shares chat's Socket.IO engine if chat already owns one. There is no source edit/uncomment step and no second `listen()`.

Attachment is idempotent. Namespace middleware/connection listeners are installed once. Redis adapter initialization runs in the background; the HTTP startup path does not await its five-second Redis connect bound. On failure, socket admission stays closed with `FEATURE_UNAVAILABLE`, HTTP remains available, and adapter setup retries with capped exponential backoff (1–30 seconds). When the adapter's publisher or subscriber loses readiness, presence socket admission and publisher readiness are closed until both recover. If chat already created an adapter instance for the new namespace, that inherited instance is closed before the dedicated presence adapter replaces it.

The namespace and authenticated handshake may therefore exist while Redis is pending, but no presence socket is admitted until both the adapter and live store are usable. Diagnostics expose aggregate attachment/readiness/retry state only; logs do not include Redis URLs, employee IDs, or payload contents.

## Shared liveness, Away, and Offline

Redis keys use the existing environment prefix and trusted tenant identity:

```text
<prefix>:presence:<companyId>:<userId>            live hash, TTL
<prefix>:presence:conn:<companyId>:<userId>        shared set of socket IDs, TTL
<prefix>:presence:expiry-index                     sorted set of due [companyId,userId] tuples
```

The live hash contains only the fixed snapshot fields: `connected`, `connectionCount`, `connectedAt`, `lastHeartbeatAt`, and `lastActivityAt`. The heartbeat TTL defaults to 120 seconds (clamped to 30–300); a graceful final disconnect writes an explicit zero-connection snapshot for the 30-second grace period and removes the expiry-index member.

- Heartbeats refresh shared liveness only; they never update `lastActivityAt` or publish a presence transition.
- Actual user activity is server-stamped and is the only event that updates `lastActivityAt`.
- `presence:tick` is read-only recomputation. Away uses the newest valid activity/session anchor without fabricating activity.
- On connect/disconnect, the handler requests a room-scoped Socket.IO `fetchSockets()` result. The request is bounded to 1.5 seconds and at most 64 IDs are reconciled; uncertainty falls back to the existing shared-Redis connection-set operation, never process-local memory as distributed truth.
- A single process-level observer per API instance sweeps at most 100 due sorted-set entries every 15 seconds. Redis Lua compares the due score and atomically removes stale socket membership, records zero connections, and grants the grace TTL. Competing observers may inspect the same candidate, but only one wins the atomic claim and attempts an invalidation publish. This is not a per-employee timer, `KEYS`/`SCAN`, or keyspace-notification dependency.
- A crash/stale lease is observed after the shared heartbeat deadline, normally within about 120–135 seconds at defaults, assuming Redis and the observer are available. Realtime invalidation is best effort; REST and team polling remain the recovery authority.

Redis command failure remains **Unknown/degraded**, never a mass Offline transition. A successful read of a missing/expired liveness key is Offline. No heartbeat writes Mongo, and no presence/activity history is added.

## Tenant, visibility, and recovery boundaries

The Socket.IO handshake supplies `socket.data.companyId` and `socket.data.userId`; clients cannot select rooms or identities. Both the connection set and delivery room include company and user. The publisher rejects an envelope whose company does not match its target. The frontend drops a `presence:changed` frame from a different company before dispatching self/team refreshes. The authorized REST team service remains the only source of which employees a viewer may see; realtime never broad-broadcasts hidden employees.

Duplicate invalidation delivery is acceptable and handled idempotently. Missed events are recovered through the authoritative self/team HTTP reads, visibility ticks, and the bounded team-page refresh. No event delivery result is used as an HR decision.

## Tests and dependency scope

The backend presence gate is hermetic and uses in-memory Redis/Socket.IO fixtures, including an in-memory pub/sub broker with the installed Socket.IO Redis adapter. It covers adapter client cardinality/readiness, retry and idempotent attachment, cross-instance plus local delivery, no echo, tenant/user room isolation, stale-member reconciliation, atomic crash expiry, rate bounds, and existing A–I behavior. The focused frontend runtime/source-pin suite checks cross-company event rejection and no Redis/NATS browser configuration.

Latest local automated results: `MONGO_URI='mongodb://127.0.0.1:27017/crewly_phase37_distributed_test' npm run test:presence` → **217/217 passing**; `npm run test:presence-realtime` → **108/108 passing**; focused frontend runtime/source-pin suite → **27/27 passing**. These suites are hermetic with respect to Redis. These results are **not** owner localhost acceptance.

No npm dependency was added for Phase 37.8. No NATS, frontend Redis client, attendance/leave/payroll/AI integration, history, or productivity tracking was introduced.

## Local acceptance

Follow [`PHASE_37_8_LOCALHOST_ACCEPTANCE.md`](./PHASE_37_8_LOCALHOST_ACCEPTANCE.md) for Windows PowerShell-first steps, including A–I, Redis outage, and optional two-process fan-out verification. Do not use the older `PHASE_37_LOCALHOST_ACCEPTANCE.md` instructions; they contain obsolete transport, key, and TTL claims.
