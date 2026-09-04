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

The hermetic suite is step 1's bigger sibling: `npm run test:all` must pass
with Redis switched **off** *and* with your real `REDIS_URL` in `Backend/.env`,
in the same time (about 25 seconds, 855 tests, 0 failures). It is listed last
on purpose — if it ever stops finishing, that is a test-hygiene bug in this
repo (see §9), not a problem with your Redis.

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
  `volatile-*` is required. Managed hosts usually refuse `CONFIG GET`, so this
  check falls back to `INFO` — the same field BullMQ reads — and says
  "read via INFO"; `SKIP` means the host hides *both*.
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
| `eviction` | `WARN - maxmemory-policy=... - read via INFO` (a managed host that blocks `CONFIG GET` is *still* diagnosed) | set the policy in the console per §5b: Upstash Settings > "Max memory policy"; Redis Cloud: database > Advanced; ElastiCache: parameter group `maxmemory-policy` |
| `commands` | `SKIP - COMMAND INFO not permitted`, or destructive commands listed as blocked | Upstash: Settings > Redis commands; Redis Cloud: disabled-commands list; Azure: Redis commands policy |
| `latency` | `WARN - remote link` (20-80 ms is normal) | pick a region near your app/worker, not near your laptop |
| `eviction` | `WARN - maxmemory-policy=volatile-lru` (the usual cloud default) | set it to `noeviction` - see §5b |
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

## 5b. `IMPORTANT! Eviction policy is volatile-lru. It should be "noeviction"`

If that line (or the `allkeys-*` variant) scrolls past when the worker starts,
it is **BullMQ's own check**, not ours - `node_modules/bullmq` prints it once
per Redis connection, so a Crewly worker with 9 queues repeats it ~20 times.
It is a warning, not an error: the queues work. Managed tiers default to
`volatile-lru`, which is why almost everyone sees it.

Why Crewly still wants it changed:

- `volatile-*` only evicts keys that have a TTL. BullMQ's queue keys
  (lists/streams/zsets) have no TTL, so jobs are not evicted - but BullMQ's
  own TTL-bearing bookkeeping keys (per-queue rate limiter, events/metrics
  retention, `removeOnComplete/removeOnFail` ageing) become eviction victims.
- The dangerous moment is a **full instance with a `maxmemory` cap**: once the
  TTL keys are gone, Redis refuses every write with `-OOM command not allowed
  when used memory > 'maxmemory'` - which is a queue outage, not a slowdown.
- `allkeys-lru`/`allkeys-random` are worse: there, queue keys themselves are
  candidates, so a job can disappear silently. `npm run redis:doctor` reports
  that as a FAIL.

Change it in the provider configuration (the setting is called "Eviction
policy", "Max memory policy", or `maxmemory-policy` depending on the tier) and
pick **no eviction / noeviction**. No code change, no data migration, nothing
to re-seed: restart `npm run worker:dev` afterwards and the warning lines are
gone. Free/prototyping tiers that refuse the change are fine for development -
just keep an eye on the `memory` line (`used` vs `max`) and on `evicted_keys`.

Re-run `npm run redis:doctor` to confirm: `eviction` should read
`maxmemory-policy=noeviction - matches the BullMQ requirement`.

## 5c. Managed Redis (Redis Cloud as the example): four lines to read

A managed database is not a Redis you administer, and the doctor is built to
say that precisely instead of crying failure. A real Redis Cloud run of
`npm run redis:doctor` looked like this:

```
[ OK ] server       version=8.6.2 mode=standalone os=Linux
[ OK ] role         role=master (writable)
[ OK ] latency      PING avg 51.6 ms (max 51.9 ms), pingRedis()=true
[WARN] url          scheme=redis db=0 credentials=yes password=yes length=88
                   host=<redacted> port=10959
[SKIP] eviction     CONFIG GET maxmemory-policy is not permitted here
Summary: 12 ok, 1 warning(s), 1 skipped, 0 failed
```

**`[WARN] url` on a plain `redis://` endpoint with an unusual port.** Redis
Cloud gives every database two endpoints: an unencrypted one on its own port
(here `10959`) and a TLS one on `10055` with `rediss://`. The WARN exists
because a `redis://` URL carries your password across the internet in plain
text: fine for a throwaway development database, not fine for real tenant
data. To clear it deliberately: enable TLS in the provider's Security
settings, paste the `rediss://` URL into `Backend/.env`, confirm with
`npm run redis:ping`. Do not "fix" the warning by moving the URL into
`.env.example`, the compose file or source code to make it go away —
`Backend/.env` is git-ignored, everything else is committed.

**`[SKIP] eviction` is now rare.** The provider blocks `CONFIG GET`, but the
same value is published in `INFO`, and `INFO` is exactly where BullMQ reads it
from. So the doctor reads `INFO` when `CONFIG` is refused and gives a real
verdict (`WARN — maxmemory-policy=volatile-lru - read via INFO, the same field
BullMQ reads`) plus the fix in §5b, instead of shrugging. `SKIP` now only
happens when both sources are hidden.

**`[ OK ] latency` at 50 ms is normal, and is a design constraint.** That run
was a laptop in India against a database in another region, so every command
costs about 50 ms. Nothing in this phase assumes sub-millisecond round trips:
a cache read is one `GET`, the heartbeat runs on a 15-second cadence, and the
live suite skips its op-budget test on managed hosts (a 50 ms link makes the
old "200 commands in 150 ms" assertion meaningless, which is why that test
measures localhost only). `latency` FAILs above 1000 ms, or above 50 ms when
the host is *localhost*, where a slow reply means something local is wrong.

**`[WARN] workers` listing a pile of `offline (stale member)` ids is not a
worker failure.** Only a graceful `SIGTERM`/`SIGINT` shutdown removes a worker
from `crewly:ops:workers:<env>`; a killed or crashed process (a nodemon
restart, a container kill, a closed laptop lid) leaves its id behind, because
a set member cannot expire the way a key with a TTL does. The ghosts were
always reported OFFLINE, so nothing broke — but every discovery read had to
walk them. The heartbeat now sweeps them itself: a beat occasionally does one
`SMEMBERS` plus one `MGET` and removes ids whose heartbeat key is gone — never
its own id, never a live peer's, at most 25 per pass, best-effort so a Redis
blip can never affect job processing. The cadence is
`OPS_WORKER_HEARTBEAT_PRUNE_EVERY_N_BEATS` (default `10`, about 150 seconds);
set it to `1` for one run to watch the list collapse to the live workers.

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
| `workers` | `WARN` with `offline (stale member)` ids | ids left behind by killed/crashed processes; the heartbeat prunes them (§5c), `OPS_WORKER_HEARTBEAT_PRUNE_EVERY_N_BEATS=1` forces a sweep now |
| `latency` | `WARN - remote link` at 20-100 ms | the provider's region, not your code: pick a region near the app/worker, or accept it and keep Redis usage to single commands (which Crewly does) |
| `url` | `WARN` — `redis://` to a managed endpoint | a deliberate decision, not a bug: plain endpoint for local dev, `rediss://` + TLS port for anything real (§5c) |
| any check | `[SKIP] ... CONFIG GET ... not permitted` on `eviction` | only if the host also hides `INFO`; read the policy in the console and still set `noeviction` (§5b) |
| `[Ops] Audit write failed for ... (audit_write_timeout)` in app logs | the audit write did not finish within 1 s (Mongo is slow or down); the operator's action is already done and stays done | no action if it is transient and clears with the database; if it is constant, check `MONGO_URI` and the replica set |
| `[Ops] Audit write failed for ... (invalid_audit_payload)` in app logs | the audit document was rejected (missing `path`, non-hex `actor` id, missing `action`) — the write is fail-open, so the operation itself succeeded and only the row is lost | fix the caller; `buildOpsAuditDoc()` now defends against both cases (§9) |
| `[FAIL] connect … auth_failed` | server rejected the credentials | re-copy the URL from the provider dashboard (never paste it into chat or a commit) |
| `Redis is not configured (REDIS_ENABLED/REDIS_URL …)` from a live test | the opt-in test is refusing to fake success | run `npm run redis:doctor` first, then re-run |
| `[WARN] workers … no worker heartbeat key found` | queue jobs will never drain | `npm run worker:dev` (separate tab), then re-run the doctor |
| `[WARN] queues … waiting and no worker ONLINE` | jobs are piling up | same fix; a single leftover dev job is harmless |
| `[WARN] eviction maxmemory-policy=allkeys-lru` | queue keys can be evicted | set the policy to `noeviction` in the provider config, or use a dedicated Redis |
| `[SKIP] CONFIG GET … not permitted` | managed tier hides `CONFIG` | not a fault; check the policy in the dashboard instead |
| health shows `redis: "down"` after you started Redis | the API snapshots config at boot | restart `npm run dev` |
| `npm error Missing script: "redis:doctor"` | your clone predates this phase | `git pull origin arena/01a066f5-hrms-crewly` then re-run |
| live test says `Redis is not configured` although `redis:check` says PONG | pre-30.1.2 bug: those suites looked for `<repo>/.env` instead of `Backend/.env` (log line `injected env (0) from ..\.env`) | pull this branch - the suites now use `src/config/loadEnv.js` |
| `IMPORTANT! Eviction policy is volatile-lru` x20 in the worker log | provider default, BullMQ's own warning | set `noeviction` in the provider console (§5b) |
| `injected env (0) from .env` printed right after `injected env (54)` | benign: the second dotenv call counts only NEW variables | nothing |

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

**Cloud follow-up 2 (from your live log).** Two more defects surfaced the
moment a real machine ran the ladder:

1. **The opt-in live tests could never see your `Backend/.env`.**
   `bullmqLive`, `opsQueueOpsLive` (and the new `redisLive`, copied from them)
   built the path by hand as `resolve(testDir, '..', '..') + '.env'`, which is
   the *repo root*, so dotenv loaded nothing (`injected env (0) from ..\.env`)
   and the suites failed their own "Redis is not configured" gate even though
   `npm run redis:check` answered `PONG`. All three now import
   `src/config/loadEnv.js` - the single loader the API itself uses - so any
   future entry point inherits the same correct path. Side effect: step 5 of
   `test:ops:live` (reconciliation) never saw `MONGO_URI` either, which is why
   it always reported the missing-Mongo error on a correctly configured box.
2. **The eviction advice was too soft.** BullMQ warns on every connection that
   the policy should be `noeviction`, and managed tiers default to
   `volatile-lru`. The doctor now says exactly that (with the `maxmemory` cap
   it is protecting), explains the ~20 repeated lines, and §5b documents the
   blast radius: TTL-bearing BullMQ bookkeeping keys are evictable, and a
   capped-plus-full instance turns into `-OOM` on every write. `allkeys-*`
   stays a FAIL.

Lesson recorded for later phases: hermetic suites prove *logic*; only a live
run proves *semantics against the installed dependency version*. Any opt-in
live test must (a) fail loudly when its dependency is missing, (b) derive
counts from the registry rather than literals, and (c) poll bounded instead of
sleeping.

- **A fail-open log line that said "connection_error" was a bad document, not a
  dead database.** The live ops log showed `[Ops] Audit write failed for
  ops.queue.job.retry (connection_error)` five times while all five tests
  passed. `AuditLog.actor` is an `ObjectId` ref, the test had passed the literal
  `'live-test'`, Mongoose threw a `CastError`, and the audit writer's fail-open
  handler classified any unrecognised error as a connection problem. Two fixes:
  the live test now passes a real-shaped id so the row is actually written (that
  is the point of testing the flow), and `opsQueueService` labels audit failures
  through `classifyAuditFailure()` — `invalid_audit_payload` for a rejected
  document, `db_unavailable` for a model with no connection, otherwise the safe
  socket label. A log line that sends you to the wrong subsystem is worse than
  no log line.

- **The honest label then exposed two silent defects in the audit write itself.**
  With the mislabelling gone, a passing sandbox run still printed
  `Audit write failed for QUEUE_JOB_REMOVED (invalid_audit_payload)` — and this
  one was real, in the service, not in a test. `AuditLog.path` is `required`, and
  Mongoose treats `''` as missing, so **every ops action from a caller without an
  HTTP request** (the worker-side reconciler, a script, a test) produced a
  rejected document: because the writer is fail-open, the operator got a success
  response and no audit row, forever. Second: `AuditLog.actor` is an `ObjectId`
  ref, so any caller passing a UUID-shaped session id threw a `CastError` and
  lost the same way. `recordOpsAudit` now builds its document through
  `buildOpsAuditDoc()`, which always yields a non-empty `path`
  (`internal:ops` for a non-HTTP caller) and nulls the `actor` ref when the id is
  not a 24-char hex, keeping `actorName`/`actorRole`/`metadata` as the trace. The
  rule: **a fail-open writer must be validated against the real schema, not a
  mock** — hermetic tests now run `new AuditLog(doc).validate()` against the model
  itself, and that assertion is the one that would have caught this years ago.
- **A fail-open write must also be *bounded*.** Making the document valid
  revealed the next thing: `AuditLog.create()` on a Mongoose model with no
  connection does not fail fast — it buffers for `bufferTimeoutMS` (10 seconds)
  and then errors. So with MongoDB briefly down, an operator's "Retry job" click
  would hang for 10 seconds and *still* return success. `recordOpsAudit` now
  races the write against a 1-second deadline (label `audit_write_timeout`),
  which also made the hermetic suite fast again (it had gone from 0.8 s to
  190 s while these tests were hitting a disconnected model). Two rules for any
  later phase: never let a best-effort write inherit a driver's default timeout,
  and never let a best-effort write reach a real model from a hermetic test —
  stub it, or the test becomes an accidental integration test with a 10-second
  timer.

- **`npm run test:all` stopped *finishing* the moment Redis was enabled — and
  it was not Redis.** With `REDIS_ENABLED=true` in `Backend/.env`, two hermetic
  files (`test/bgvQueue.test.js`, `test/candidateApplication.test.js`) printed
  every check as ✔ and then hung forever, so the whole command looked like a
  hang. Cause: those tests drive real services, a service that enqueues goes
  through `queueFactory`, and `queueFactory` caches a live BullMQ connection per
  queue. Nothing closed it, so the event loop stayed alive and `node --test`
  never exited. With Redis disabled the connection is never opened, which is
  why CI never saw it — enabling the feature silently changed the test
  environment. Fix: an `after()` hook in each file that calls `closeAllQueues()`
  plus `closeRedis()` (both no-ops when Redis is off, so the usual run is
  unchanged). Rule for every suite that touches a service with a side connection:
  close what you opened, or the process outlives the tests.
- **Two follow-on findings from that same fix.** (a) `recordOpsAudit` inherited
  the driver's 10-second buffering timeout; it is now bounded at 1 second
  (label `audit_write_timeout`), because "fail-open" must not mean "make the
  operator wait for a dead database". (b) That bound exposed a racy assertion in
  the live ops suite — `transientCalls === 1` right after `retryJob()` assumed
  the in-process worker had not yet picked the job up, which is not a
  guarantee; the test now asserts the deterministic end state (exactly two
  executions: one failure, one success) instead of a snapshot taken while a
  best-effort write is in flight.

## 10. Rules this phase keeps (and that later phases must keep too)

- Never add `FLUSHALL` / `FLUSHDB` / `KEYS` / `SCAN` to anything that runs
  against a shared Redis — clean up exact keys you created, or obliterate
  your own prefixed queue.
- A `SKIP` is only honest when every source is blocked. `CONFIG GET` is denied on
  managed hosts but `INFO` is not — read the value from `INFO` (which is what
  BullMQ reads) and give a verdict instead of a shrug.
- A "best-effort"/"fail-open" side write has to be both *validated* against the
  real schema and *bounded* in time. Otherwise it silently drops data (required
  field, cast error) or silently adds the driver's buffering timeout (10 s) to a
  user-facing request — and it must be stubbed in hermetic tests so neither
  behaviour hides there.
- Never print or log `REDIS_URL`; report safe categories only
  (`classifySafeReason`).
- Any opt-in live test must fail loudly when its dependency is missing —
  never silently skip.
- Anything age/window related must be computed from `Date.now()` inside the
  test, never a hard-coded calendar date (the Phase 30.1.1 `bgvQueue`
  clock-bomb: a fixture pinned to `2026-08-28` crossed a 7-day guard 16
  minutes later and looked like a production bug).
