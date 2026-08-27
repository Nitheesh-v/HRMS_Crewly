# Phase 28.1 — Redis Foundation

Status: COMPLETE (infrastructure only)

## Purpose

Phase 28.1 adds the Redis connection layer that Phase 28.2+ (BullMQ
queues, workers, caching) will build on. MongoDB Atlas remains the
permanent source of truth; Redis is infrastructure only.

In this phase **no business workflow depends on Redis**, so its
unavailability must never break the Mongo-backed HRMS.

## What was implemented

| File | Purpose |
| --- | --- |
| `Backend/src/config/redis.js` | Connection module: config parsing, option factory, lifecycle, state tracking, safe health, PING, bounded close |
| `Backend/scripts/redis-check.js` | `npm run redis:check` developer connectivity check |
| `Backend/test/redisFoundation.test.js` | Hermetic unit tests (no live Redis, no Mongo) |
| `Backend/src/server.js` | `initializeRedis()` after Mongo; shutdown extends the existing handler |
| `Backend/src/routes/index.js` | Existing `GET /api/health` extended with real service states |
| `Backend/.env.example` | Safe placeholders only (never real values) |
| `Backend/package.json` | `ioredis@^5.11.1` + `redis:check` / `test:redis` scripts |

## Dependency

- `ioredis@^5.11.1` — chosen because BullMQ (28.2) is built on ioredis,
  giving one client family for the whole Phase 28. ioredis 6.0.0 was
  deliberately NOT used (too new; BullMQ 5.x bundles ioredis 5.x,
  BullMQ 6.x accepts `ioredis >=5.0.0` as optional peer).

## Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `REDIS_ENABLED` | no | `false` | Parsed explicitly: `true/1/yes/on` → enabled; `false/0/no/off/empty` → disabled; invalid → warn + disabled |
| `REDIS_URL` | when enabled | — | **Secret.** `redis://` or `rediss://`. Never logged, never returned by APIs, never in error messages. Lives only in `Backend/.env` |
| `REDIS_CONNECT_TIMEOUT_MS` | no | `10000` | Startup connection timeout, clamped to 1000–60000 |

## Connection lifecycle

```
server.js startup
  → connectDB()                     (Mongo first, as before)
  → initializeRedis()               (never throws; optional)
      ├─ REDIS_ENABLED=false  → state DISABLED, return null
      ├─ enabled, no URL      → state DOWN (misconfigured), return null
      └─ enabled + URL        → ioredis client created, events attached,
                                wait for "ready" up to timeout
                                ├─ ready  → state READY
                                └─ timeout → state DOWN, background
                                             reconnect continues,
                                             API runs degraded
  → HTTP listen + existing workers (unchanged)
```

States: `DISABLED | CONNECTING | READY | RECONNECTING | DOWN | CLOSING | CLOSED`

`initializeRedis()` is idempotent — concurrent or repeated calls never
create uncontrolled connections.

## Reconnect strategy

- Bounded exponential backoff: 500ms → 1s → 2s → 4s → 5s (cap).
- One safe log line per attempt (capped interval = no log storm).
- **Auth failures** (NOAUTH / WRONGPASS / ERRNOAUTH): classified once,
  logged safely, and retries are **stopped** via `disconnect()` —
  bad credentials are never hammered in a loop.
- `error` events always have a listener (no unhandled-error crashes).
- With `enableOfflineQueue: false` the general client fails fast:
  commands issued while down reject immediately instead of queueing.

## Shutdown

The existing centralized handler in `server.js` is extended (no new
`process.on` registrations):

```
SIGTERM/SIGINT
  → server.close()          (stop accepting HTTP)
  → closeRedis()            (quit with 3s bound, then hard disconnect)
  → mongoose.disconnect()
  → exit(0)
  (10s hard-stop timer guarantees Ctrl+C never hangs)
```

`closeRedis()` is idempotent and safe when Redis is disabled, never
connected, or already closed. Note: with `enableOfflineQueue: false`,
`quit()` alone cannot cancel the background reconnect loop — the
explicit `disconnect()` after the bounded `quit()` is required and is
implemented.

## Health

Existing public `GET /api/health` (no duplicate route created):

```json
{
  "success": true,
  "message": "Crewly HRMS API is healthy",
  "status": "ok",
  "services": {
    "mongodb": "up",
    "redis": "up"
  },
  "timestamp": "..."
}
```

- `status`: `ok` | `degraded` (Mongo up, Redis enabled but down) |
  `unhealthy` (Mongo down)
- `redis`: `up` | `down` | `disabled` (+ safe `redisReason` such as
  `connection_refused`, `auth_failed`, `timeout`, `misconfigured`)
- `disabled` is intentional configuration, never a fault.
- Never contains: URLs, hosts, passwords, env var names, stack traces.
- No API can execute arbitrary Redis commands; only safe PING.

## Security rules (locked)

- `Backend/.env` stays git-ignored; `REDIS_URL` exists only there.
- `.env.example` holds placeholders only.
- `rediss://` TLS uses default certificate validation —
  `rejectUnauthorized: false` is forbidden.
- No `VITE_REDIS_URL`; the browser never talks to Redis.
- No tenant/session data in Redis in this phase. MongoDB stays
  source of truth. No business keys written.
- Future key convention (28.7+): `crewly:cache:company:<companyId>:...`
  — every tenant-scoped key MUST embed the trusted `companyId`
  (from `req.companyId`, never the frontend).

## Provider neutrality

The code only knows `REDIS_URL`. Redis Cloud (dev) → any managed Redis
(production) is an environment change, not a code change. No
provider-specific dashboard/API code. Production checklist (for
deployment time, not this phase): TLS, auth, private networking,
persistence appropriate for queues, monitoring/alerts, HA per
requirements.

## What was deliberately NOT done (non-goals)

No BullMQ, no queues, no workers, no jobs, no email/resume/ATS
migration, no caching, no rate-limit migration (Phase 22 limiter
remains process-local memory), no auth/session/RefreshToken/
SecuritySession/AdminSession migration, no HR role migration, no
Phase 27 behavior changes.

## Testing

Automated (hermetic, safe to run anywhere):

```powershell
cd Backend
npm run test:redis
```

Live connectivity (requires your private `REDIS_URL` in `Backend/.env`):

```powershell
cd Backend
npm run redis:check
# expected: Redis configuration detected. / Connecting... /
#           Redis ready. / PING -> PONG / Connection closed.
```

Exit codes: `0` = PONG; `1` = disabled / misconfigured / failed
(informative, by design — a check that could not complete is not a pass).

Full regression (needs local Mongo, run on your machine):

```powershell
cd Backend
npm run test:rms
cd ..\Frontend
npm run build
```

## Troubleshooting (safe — never needs credentials)

| Symptom (`npm run redis:check` / logs) | Meaning | Check |
| --- | --- | --- |
| `connection refused` | Endpoint/host/port wrong or service off | Verify the Redis Cloud endpoint is active; confirm port |
| `DNS resolution failed` | Host name in URL wrong/unreachable | Verify host in `REDIS_URL` privately |
| `timed out` | Firewall/network/VPN blocking the endpoint | Test from the same network the backend runs on |
| `authentication error` | Username/password in URL wrong | Fix `REDIS_URL` privately; rotate if it was ever exposed |
| TLS errors with `rediss://` | Cert/chain issue (rare on Redis Cloud) | Keep validation ON; use the provider's documented endpoint; never `rejectUnauthorized: false` |
| `Redis is disabled` | `REDIS_ENABLED` not set to `true` (or invalid value) | Set `REDIS_ENABLED=true` in `Backend/.env` |
| `REDIS_URL is empty` | Enabled but URL missing | Add the URL privately to `Backend/.env` |

## Phase 28.2 handoff (BullMQ Foundation)

- Client: `ioredis@^5.11.1` (installed, in `package.json`/lockfile)
- Config module: `Backend/src/config/redis.js`
  - `initializeRedis()` — API-process client (general purpose)
  - `getRedisClient()` / `getRedisStatus()` / `getRedisHealth()`
  - `pingRedis()` / `closeRedis()`
- **Connection factory for 28.2**: `createRedisOptions(purpose)` with
  `purpose = 'bullmq-producer' | 'bullmq-worker'` — applies
  `maxRetriesPerRequest: null` (BullMQ requirement) and leaves the
  offline queue default. 28.2 creates DEDICATED Queue/Worker
  connections from `REDIS_URL` through this factory; never shares the
  general client's socket.
- Env: `REDIS_ENABLED`, `REDIS_URL`, `REDIS_CONNECT_TIMEOUT_MS`
- Health: `GET /api/health` → `services.redis`
- Worker policy (28.2): a Worker process should fail startup when
  Redis is unavailable (workers cannot function without it) — the API
  process keeps degraded mode.
- Tests: `npm run test:redis`; live: `npm run redis:check`
- Known limitations: no BullMQ yet; no queues; no caching; single
  general connection only; auth failure stops retries (restart needed
  after fixing credentials).
