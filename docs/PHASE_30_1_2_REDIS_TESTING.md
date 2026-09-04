# Phase 30.1.2 — Testing Redis for real (Windows / PowerShell)

Everything here is **developer tooling and documentation**. No production
route, model, permission or UI changed in this phase — the only source
edits are two new dev files (`scripts/redis-doctor.js`,
`test/redisLive.test.js`), two npm scripts, one `.env.example` key and a
stale assertion fix in `test/bullmqLive.test.js`.

## 1. What Redis actually does in Crewly

| Redis is used for | Code | If Redis is down |
| --- | --- | --- |
| Analytics/response caching (payroll + recruitment + BGV ops stats) | `src/services/redisCacheService.js` | every read falls through to MongoDB (fail-open), requests still succeed |
| BullMQ queues (email, resume, ATS, scheduled, documents, BGV, payroll, analytics, system) | `src/queues/queueFactory.js`, `src/config/queueConfig.js` | the API keeps queueing-safe behaviour; **the worker cannot run at all** |
| Worker heartbeat / ops page "ONLINE" state | `src/workers/workerHeartbeat.js` | ops page shows OFFLINE |
| `/api/health` services map | `src/routes/index.js` | `status: "degraded"`, `services.redis: "down"` |

Important: `REDIS_ENABLED=false` is a **supported configuration** for the
API. It is only the background worker (`npm run worker:dev`) that hard
requires Redis. That is why your earlier full-suite run printed
`ECONNREFUSED 127.0.0.1:6379` and still passed **845/845** — the tests are
hermetic, and the app is fail-open by design.

## 2. Get a Redis on your machine (pick ONE)

Already using a managed Redis (Redis Cloud, Upstash, ElastiCache, Azure)?
Skip this section - your URL comes from the provider console, see §3.

Open PowerShell and run one of these. All three give you
`redis://127.0.0.1:6379`.

**Option A — Docker Desktop (recommended, least fuss)**

```powershell
docker run -d --name crewly-redis -p 6379:6379 --restart unless-stopped redis:7-alpine
```

Stop/start later: `docker stop crewly-redis` / `docker start crewly-redis`.

**Option B — WSL2 (Ubuntu)**

```powershell
wsl --install -d Ubuntu      # first time only, then restart
```
```powershell
wsl
sudo apt-get update && sudo apt-get install -y redis-server
sudo service redis-server start
exit
```

**Option C — Memurai (native Windows service, no Docker/WSL)**

Install the free Developer edition from https://www.memurai.com/get-memurai.
It registers `Memurai` as a Windows service listening on 6379.

**Verify the port is answering (no Redis client needed):**

```powershell
Test-NetConnection localhost -Port 6379
```

`TcpTestSucceeded : True` means something is listening. If it is `False`,
fix that first — no Crewly command can help you before this is True.

## 3. Tell the backend where it is

Open `Backend/.env` in an editor (Notepad is fine) - never build the URL in
the terminal, because a command line lands in your PowerShell history:

```powershell
notepad .env
```

**Cloud / managed Redis** - paste the provider's own connection string as
`REDIS_URL`, then save. It must start with `rediss://` (TLS):

```env
REDIS_ENABLED=true
REDIS_URL=rediss://default:YOUR_TOKEN@YOUR_ENDPOINT:YOUR_TLS_PORT
```

The exact shape per provider (copy the value from the console, do not
retype it):

| Provider | Where | Shape |
| --- | --- | --- |
| Redis Cloud (Redis Inc.) | database page > "General" > Public endpoint + Default user password | `rediss://default:<password>@redis-<id>.c<n>.<region>.ec2.cloud.redislabs.com:<tls-port>` (newer DBs: `<words>-<id>.db.redis.io`) |
| Upstash | console > your database > "Redis" connect box (TCP, not REST/HTTP) | `rediss://default:<token>@<region>.upstash.io:6380` |
| AWS ElastiCache | cluster endpoint, TLS in transit enabled | `rediss://:<password>@<name>.<region>.cache.amazonaws.com:6379` (in-VPC only: you need a tunnel from your laptop) |
| Azure Cache for Redis | Access keys > hostname | `rediss://:<key>@<name>.redis.cache.windows.net:6380` |

Four cloud rules that save hours:

1. **Escape the password.** In a URL, `@ : / # [ ] %` inside the credential
   are *separators*. If your token contains one, percent-encode it
   (`@` -> `%40`, `:` -> `%3A`, `/` -> `%2F`, `#` -> `%23`, `%` -> `%25`).
   `npm run redis:doctor` checks this for you before it even connects.
2. **Username matters.** Upstash and ACL-enabled Redis Cloud users need
   `default:` before the token. If you enabled the Upstash *read-only* token,
   the username is `default_ro` and every write fails - Crewly needs writes.
3. **TLS port, not the plain port.** `rediss://` + the plain-text port (or
   `redis://` + the TLS port) shows up as a handshake timeout, not a clear
   error. The doctor flags the mismatch.
4. **No quotes, no spaces, no `\r`.** One line, exactly
   `REDIS_URL=rediss://...` - `redis:check` and `redis:doctor` both detect a
   stray space or a Windows line break in the value.

**Local Redis instead?** Use:

```env
REDIS_ENABLED=true
REDIS_URL=redis://127.0.0.1:6379
```

Both cases use the same code path; TLS certificate verification always stays
on (`rejectUnauthorized: false` is not used anywhere in this repo), and the
URL is never printed by any Crewly command, log line or API response.

Optional, all providers:

```env
# Startup connect budget for a remote endpoint (default 10000, 1000-60000)
REDIS_CONNECT_TIMEOUT_MS=10000
# Per-command budget for the analytics cache (default 500, 100-2000).
# A slower cache is abandoned and the read comes from MongoDB instead.
REDIS_CACHE_OP_TIMEOUT_MS=500
```

On a remote Redis, 20-80 ms round trips are normal. That is why the cache
budget is small and fail-open - do not raise it to "fix" a miss.

## 4. The verification ladder (run in this order)

Run all commands from `HRMS_Crewly/Backend`.

```powershell
cd C:\path\to\HRMS_Crewly\Backend
```

| # | Command | Proves | Needs |
| --- | --- | --- | --- |
| 1 | `npm run test:redis` | config parsing, health mapping, fail-open, secret hygiene — hermetic | nothing |
| 2 | `npm run redis:check` | `REDIS_URL` connects and answers `PONG` | Redis up |
| 3 | `npm run redis:doctor` | **everything** — see §5 | Redis up |
| 4 | `npm run test:redis:live` | the 28.7 caching abstraction really works | Redis up |
| 5 | `npm run queue:check` | a job survives Queue → Redis → Worker | worker running (§6) |
| 6 | `npm run test:bullmq:live` | queue round trip + retry/backoff with an in-process worker | Redis up |
| 7 | `npm run test:ops:live` | heartbeat, retry/removal/reconciliation ladder | Redis **and** MongoDB (skip step 5 locally with `node --test --test-name-pattern="heartbeat|retry|tenant|overview" test/opsQueueOpsLive.test.js`) |
| 8 | `curl http://localhost:5000/api/health` | the running API reports `services.redis: "up"` | API running |

Steps 4, 6 and 7 are **opt-in live** tests: they are deliberately *not* in
`npm run test:all`, and they **fail loudly** when Redis is not configured
(a silent skip would hide exactly the misconfiguration you are hunting).

## 5. `npm run redis:doctor` — read the ladder

```
Crewly HRMS — Redis doctor (read-only)

1/6 Configuration
[ OK ] config       REDIS_ENABLED=true, REDIS_URL present (length=64 scheme=rediss:// (TLS))
[ OK ] url          scheme=rediss host=<hidden, 46 chars> port=12346 credentials=yes (18 chars) (managed endpoint)

2/6 Connection
[ OK ] connect      connected and ready in 410 ms - health "up"

3/6 Server capabilities
[ OK ] latency      PING avg 34.1 ms (max 51.0 ms), pingRedis()=true
[ OK ] server       version=7.2.7 mode=standalone os=Linux
[ OK ] scripting    EVAL (Lua) available - required by BullMQ
[ OK ] commands     14/14 queue-critical commands available; destructive commands blocked by policy: keys, flushdb, flushall, scan

4/6 Operational limits
[ OK ] role         role=master (writable)
[ OK ] eviction     maxmemory-policy=noeviction
[ OK ] memory       used=41.2M max=100M evicted_keys=0
[ OK ] probe        SET/GET/TTL/DEL clean on crewly:ops:doctor:9a1c... (ttl=30s, removed=true)

5/6 Crewly queues and workers
[ OK ] workers      1 worker process(es) ONLINE
  system     waiting=0 active=0 delayed=0 failed=0
  ...
[ OK ] queues       9 queues under prefix "crewly:development": waiting=0 delayed=0 - no failures, no stuck backlog

6/6 Keyspace
[ OK ] keyspace     db0 keys=16; db0:keys=16,expires=1,avg_ttl=48699

Summary: 12 ok, 0 warning(s), 0 skipped, 0 failed
Verdict: Redis is ready for Crewly (caching, BullMQ queues, worker heartbeat).
```

Exit code is `0` when nothing FAILED and `1` on any FAIL (so it also works
in CI). It is read-only apart from one ephemeral probe key it deletes
itself — it never runs `FLUSHDB`, `KEYS` or `SCAN`, and it never prints the
URL, host or credentials.

What the checks that have no obvious "ping" equivalent are actually for:

- **`scripting`** — BullMQ is 100% Lua scripts. A provider plan that blocks
  `EVAL` looks perfectly healthy to `PING` and is useless to the queues.
- **`eviction`** — `allkeys-lru`/`allkeys-random` may delete **queue and job
  keys** under memory pressure (jobs silently vanish). `noeviction` or
  `volatile-*` is required.
- **`memory`** — `evicted_keys > 0` means eviction has *already* happened.
- **`url`** — pure parsing, no network: it catches the four classic cloud
  paste errors (quotes, trailing space/`\r`, unescaped `@` in the password,
  TLS scheme against the plain port) *before* you wait 10 seconds for a
  timeout. It prints the length of the secret, never the secret.
- **`commands`** — one `COMMAND INFO` call that answers "can this instance
  actually host BullMQ?". Blocked `KEYS`/`FLUSHDB`/`SCAN` are reported as a
  **good** thing (Crewly never uses them); a blocked `eval`/`xadd`/`subscribe`
  is a real FAIL for the queues.
- **`role`** — managed tiers hand out a read-only replica endpoint by
  mistake; every queue write then fails with `-READONLY`.
- **`workers`** — the heartbeat key's own TTL is the authority: after a
  worker is killed, this flips to OFFLINE within 60 seconds.

### What looks different on a managed/cloud Redis

Nothing is broken when a line says SKIP there - those tiers hide
introspection on purpose. Read the console field instead:

| Doctor line | Typical managed output | Where the real answer lives |
| --- | --- | --- |
| `server` / `role` / `memory` / `keyspace` | `SKIP - INFO ... not permitted` | provider console (Upstash: Statistics; Redis Cloud: database diagnostics; ElastiCache: CloudWatch) |
| `eviction` | `SKIP - CONFIG GET ... not permitted` | Upstash: Settings > "Max memory policy"; Redis Cloud: database > Advanced; ElastiCache: parameter group `maxmemory-policy` |
| `commands` | `SKIP - COMMAND INFO not permitted`, or destructive commands listed as blocked | Upstash: Settings > Redis commands; Redis Cloud: disabled-commands list; Azure: Redis commands policy |
| `latency` | `WARN - remote link` (20-80 ms is normal) | pick a region near your app/worker, not near your laptop |
| `connect` | may print `Skipping the ready check because INFO command fails: "...NOPERM..."` | benign: ioredis treats a NOPERM `INFO` as "no ready check needed" and continues. No action |

Two cloud settings that matter more than any code change:

- **Eviction policy must never be `allkeys-*`.** Under memory pressure Redis
  would evict BullMQ queue and job keys and jobs vanish silently.
  `noeviction` is correct (then a full instance *errors* instead of losing
  jobs - visible, recoverable). Free/prototyping tiers are tiny: watch
  `evicted_keys` and the `-OOM` error text.
- **Upstash REST/HTTP endpoints are not usable here.** Crewly speaks the
  RESP protocol (ioredis + BullMQ), so use the TCP/`rediss://` connection
  string, not the REST URL or the "upstash/redis" SDK.

## 6. Testing the queue side properly

Queues need a consumer. Open **two** PowerShell tabs:

```powershell
# tab 1 - the worker process (Ctrl+C stops it)
cd C:\path\to\HRMS_Crewly\Backend
npm run worker:dev
```

```powershell
# tab 2
cd C:\path\to\HRMS_Crewly\Backend
npm run queue:check
```

Expected: `system-health-check COMPLETED (id=…, attempts=1)`. Then also:

```powershell
npm run queue:check:retry        # fail-once job completes on attempt 2
npm run queue:check:duplicate    # same jobId collapses, no duplicate work
```

`npm run test:bullmq:live` does the same two proofs with its own in-process
worker, so it needs no second tab. It runs under a throw-away
`crewly:test:live-<random>` prefix and obliterates only that queue — your
`crewly:development` keys are untouched.

## 7. What `npm run test:redis:live` proves (16 tests)

`test:redis` (hermetic) could only assert the *logic*; this file asserts the
*behaviour* on a real server, using the production modules unmodified:

1. `initializeRedis()` reaches READY and `/api/health` maps to `up`.
2. The endpoint is writable, standalone and Lua-capable.
3. Tenant keys: a value written for company A is never readable as company B.
4. Invalid tenant ids are rejected by the key builder (no unscoped keys).
5. JSON types survive the round trip.
6. TTL expiry really removes the entry.
7. A corrupt value self-heals (exact key deleted, served as a miss).
8. Values over 256 KB are not cached, and the source result is still returned.
9. `getOrSetCache` is MISS then HIT, with hit/miss/write counters moving.
10. Single-flight: six simultaneous reads = one loader run (followers share
    the leader's outcome — by design, so no duplicate stampede).
11. An old envelope version is never served (generation semantics).
12. Analytics generation bumps increment and keep their ~24h TTL.
13. A stalling Redis is abandoned at `REDIS_CACHE_OP_TIMEOUT_MS` — the caller
    never waits for the cache.
14. Fail-open with the connection closed: reads/writes no-op, the loader still
    answers, no exception reaches the request.
15. Recovery: once Redis returns, health flips back to `up` and the cache serves.
16. Cleanup: every key the run created is deleted (no residue on a shared box).

Test 13 proves the op budget by freezing the whole Redis instance for ~0.3s
(`CLIENT PAUSE`). Because that is rude on a shared box, it is **skipped
automatically when the host looks managed** (Redis Cloud / Upstash /
ElastiCache / Azure). To force it anyway:

```powershell
$env:REDIS_LIVE_ALLOW_PAUSE = "1"
npm run test:redis:live
Remove-Item Env:\REDIS_LIVE_ALLOW_PAUSE
```

To skip it even on a local Redis:

```powershell
$env:REDIS_LIVE_SKIP_PAUSE = "1"
npm run test:redis:live
Remove-Item Env:\REDIS_LIVE_SKIP_PAUSE
```

## 8. Troubleshooting

| What you see | Meaning | Do this |
| --- | --- | --- |
| `[FAIL] config … REDIS_ENABLED is not true` | Redis is switched off in `Backend/.env` | set `REDIS_ENABLED=true`, save, re-run |
| `[FAIL] config … REDIS_URL is empty` | enabled but no URL | add `REDIS_URL=redis://127.0.0.1:6379` |
| `[FAIL] connect … connection_refused` | nothing listening on that host:port | start Docker/WSL/Memurai (§2); confirm with `Test-NetConnection localhost -Port 6379` |
| `[FAIL] connect … dns_resolution_failed` | host cannot be resolved | typo in the host, or you are offline / not on the VPN |
| `[FAIL] url … the password contains "@"` | the credential is not URL-encoded | percent-encode it (`@` becomes %40, `:` %3A, `/` %2F, `#` %23, `%` %25) - do not add quotes |
| `[FAIL] url … wrapped in quotes / whitespace` | paste artifact in `.env` | one bare line: `REDIS_URL=rediss://...` |
| `[WARN] url … managed endpoint with no credentials` | the password/token is missing | copy the full string from the console, not just the host |
| `connect … timeout` on a cloud host | IP allowlist, VPC-only endpoint, or wrong TLS port | add your public IP in the provider firewall; ElastiCache needs an SSH tunnel from a laptop; re-check `rediss://` vs the port |
| `probe … SET was rejected (-OOM)` | the plan is out of memory | raise maxmemory / the plan tier; never switch to `allkeys-*` to "fix" it |
| `probe … SET was rejected (READONLY)` | replica or read-only token | Upstash read-only tokens use `default_ro` - Crewly needs a read-write user |
| `WRONGPASS invalid username-password pair` | wrong ACL user | use `default:<token>` (or the exact ACL user the provider shows) |
| `read ECONNRESET` right after connect | server expects TLS | the URL must be `rediss://`, not `redis://` |
| `Skipping the ready check because INFO command fails` | provider blocks `INFO` with NOPERM | benign warning from ioredis; no action |
| `[FAIL] connect … auth_failed` | server rejected the credentials | re-copy the URL from the provider dashboard (never paste it into chat or a commit) |
| `Redis is not configured (REDIS_ENABLED/REDIS_URL …)` from a live test | the opt-in test is refusing to fake success | run `npm run redis:doctor` first, then re-run |
| `[WARN] workers … no worker heartbeat key found` | queue jobs will never drain | `npm run worker:dev` (separate tab), then re-run the doctor |
| `[WARN] queues … waiting and no worker ONLINE` | jobs are piling up | same fix; a single leftover dev job is harmless |
| `[WARN] eviction maxmemory-policy=allkeys-lru` | queue keys can be evicted | set the policy to `noeviction` in the provider config, or use a dedicated Redis |
| `[SKIP] CONFIG GET … not permitted` | managed tier hides `CONFIG` | not a fault; check the policy in the dashboard instead |
| health shows `redis: "down"` after you started Redis | the API snapshots config at boot | restart `npm run dev` |

## 9. What this phase found (RCA + QA)

Running the queue layer against a **real Redis 7.2.5** for the first time in
a while exposed three defects that every hermetic suite had happily missed.
All three were **test-side**; no production file changed in this phase.

**Finding 1 — `test:bullmq:live` failed the retry proof (1/2 green).**
`bullmqLive.test.js` asserted `attemptsMade === 1` for a job that fails once
and succeeds on attempt 2. Since BullMQ 5.12 the successful attempt is also
counted in `attemptsMade` (measured: `2`), while `attemptsStarted` is the
exact "how many attempts ran" counter. Fix: assert `attemptsStarted === 2`
plus the processor-reported attempt number, and keep `attemptsMade >= 2` as a
soft bound. Result: **2/2 green**.

**Finding 2 — `test:ops:live` was 0/4.** Two independent causes:
- Its controlled failures were produced by calling `job.moveToFailed()` *from
  inside the processor*. On BullMQ 6.3.1 that releases the job lock under the
  worker, which then re-delays and re-runs the processor until `maxAttempts`
  is exhausted (observed: `active → delayed → failed`, 3 processor calls,
  `attemptsMade = 3`). Both the "ran exactly once" and the retryability
  assertions depend on the opposite. Fix: throw `new UnrecoverableError(...)`
  instead — it fails the current attempt immediately and preserves
  `attemptsMade = 1 < maxAttempts = 3`, which is exactly what the ops retry
  policy requires.
- `assert.equal(overview.queues.length, 7)` was a literal that went stale when
  Phase 29.6 added the payroll queue (the ops allowlist now has 8). Fix:
  compare against `OPS_QUEUES.length` so the registry is the source of truth.

**Finding 3 — the same suite was flaky even after that (2 of ~7 runs).**
It read the heartbeat key after a fixed `sleep(300)` and read
`getOpsOverview()` exactly once. `getOpsOverview` is *fail-safe by design*:
under load it returns `queues: 'unavailable'` instead of throwing, so a live
assertion must wait for a real snapshot rather than race it. Fix: a bounded
`pollUntil` helper (≤ 20 × 150–250 ms) around the heartbeat and overview
reads, plus a clearer message when `MONGO_URI` is set but MongoDB is
unreachable (previously a raw mongoose timeout). Result: **4/4 stable over
repeated runs**, with step 5 requiring a live MongoDB by design.

**Cloud follow-up (same phase).** Because the target deployment is a managed
Redis, the doctor gained a pre-flight `url` check (quotes, stray
space/`\r`, unescaped `@`/`:`/`/`/`#` in the token, `redis://` vs the TLS
port, non-zero DB, credentials without an ACL username) and a `commands`
capability probe, and every introspection SKIP now names the console field to
read instead (Upstash Statistics / Settings, Redis Cloud database > Advanced,
Elasticache parameter group). The live cache suite no longer runs
`CLIENT PAUSE` against a managed host by default. Verified by feeding the
doctor deliberately broken URLs: each one fails on the `url` line with the fix,
before a 10-second connect timeout.

Lesson recorded for later phases: hermetic suites prove *logic*; only a live
run proves *semantics against the installed dependency version*. Any opt-in
live test must (a) fail loudly when its dependency is missing, (b) derive
counts from the registry rather than literals, and (c) poll bounded instead of
sleeping.

## 10. Rules this phase keeps (and that later phases must keep too)

- Never add `FLUSHALL` / `FLUSHDB` / `KEYS` / `SCAN` to anything that runs
  against a shared Redis — clean up exact keys you created, or obliterate
  your own prefixed queue.
- Never print or log `REDIS_URL`; report safe categories only
  (`classifySafeReason`).
- Any opt-in live test must fail loudly when its dependency is missing —
  never silently skip.
- Anything age/window related must be computed from `Date.now()` inside the
  test, never a hard-coded calendar date (the Phase 30.1.1 `bgvQueue`
  clock-bomb: a fixture pinned to `2026-08-28` crossed a 7-day guard 16
  minutes later and looked like a production bug).
