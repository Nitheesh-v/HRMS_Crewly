# PHASE 32.13 — LOCALHOST ACCEPTANCE GUIDE (Beginner, PowerShell + Browser)

Status: guide for **32.13 implemented** (awaiting localhost acceptance).
Mongo required. Redis required ONLY for the worker scenario
(`ops:load-check`). Worker terminals only for that same scenario.
Frontend NOT required. Realtime NOT required (its own optional section).

> ⚠️ **SAFETY WARNING:** these commands are for **localhost/development
> only**. The tooling refuses non-loopback targets unless you explicitly
> declare an isolated staging host, and it refuses entirely inside
> production. Never point it at production — there is no override
> switch, by design.

---

## 0. WHAT CHANGED (plain words)

1. A new **read-only load runner** (`npm run load:api`) sends controlled
   bursts of GET requests to your local backend and reports requests/sec
   and latency percentiles (p50/p95/p99). It can only hit real routes,
   never mutates data, never retries silently, and stops itself if the
   backend looks unhealthy or errors spike.
2. `ops:load-check` (the Phase 28 queue drill) gained `--workers N` so
   you can compare 1 worker vs 2 on an ISOLATED test queue.
3. A new optional realtime harness (`npm run load:realtime`) opens
   ramped SSE connections using the 32.11 ticket flow — infrastructure
   only, no Chat/Presence (those products don't exist).
4. Results are observations of YOUR machine — never "Crewly supports N
   users" claims.

## 1. START (2 terminals)

```powershell
# Terminal 1 — Backend (Mongo running)
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev
```

Confirm health first:

```powershell
Invoke-WebRequest -Uri "http://localhost:5000/api/health/live" -UseBasicParsing
```

Expected: `200`. **Do not run load against an unhealthy backend.**

## 2. BASELINE RUN (low impact — do this FIRST)

```powershell
# Terminal 2
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run load:api -- --scenario health-read --requests 100 --concurrency 5 --warmup 10
```

Verify in the output banner: target says `http://localhost:5000`,
scenario `health-read`, `MUTATION: NONE`, and the summary shows
`Operations`, `RPS`, `p50/p95/p99`, `Run ID (git …)` and the
environment-only disclaimer. Expect zero errors. Backend Terminal 1:
you'll see the `http.request.complete` lines from 32.12 with matching
request IDs.

## 3. MEDIUM RUN (ramped)

```powershell
npm run load:api -- --scenario health-read --requests 2000 --ramp 10,25,50 --warmup 20 --json
```

Watch while it runs:
- **Terminal 1** — completion lines flowing, no error spam, no crashes.
- `GET /api/super-admin/diagnostics` (Super Admin login, or the
  Background Operations page) — memory, event-loop lag, counters.
- If errors exceed 20% of a stage, the runner STOPS ITSELF and says so.

`--json` writes a small result file under `Backend\logs\load-results\`
(gitignored). Cleanup: nothing to clean — read-only.

## 4. AUTHENTICATED READ (real page-load pattern)

Get a token from a normal browser login (DevTools → Application →
Local Storage/session → copy the access token value), then:

```powershell
$env:LOAD_TEST_TOKEN="<paste token>"
npm run load:api -- --scenario attendance-presence --requests 1000 --ramp 5,10,25 --warmup 15
Remove-Item Env:LOAD_TEST_TOKEN
```

The runner refuses this scenario without the token and prints only the
VARIABLE NAME — never paste tokens into chat, files, or screenshots.
Backend logs stay PII-safe (32.12 laws): route templates only.

## 5. PUBLIC CAREERS (rate-limited — 429 is an honest finding)

```powershell
npm run load:api -- --scenario careers-jobs --slug "<a real company slug>" --requests 100 --concurrency 5
```

Expect `http_429` failures at some point — the 32.4 public limiter is
working as designed. **That is the result; do not raise limits for
benchmarks.**

## 6. WORKER LOAD (1 vs 2 workers — Redis required)

```powershell
# One worker (in-process, isolated prefix, safe system jobs):
npm run ops:load-check -- --jobs 200 --concurrency 4 --workers 1
# Compare with two workers on the same machine:
npm run ops:load-check -- --jobs 200 --concurrency 4 --workers 2
```

Each run: enqueues 200 harmless health-check jobs on an ISOLATED
`crewly:test:load-*` prefix, drains them, reports drain time, peak
backlog, RSS delta — then deletes ONLY its own prefix queue. Compare
drain times; if 2 workers ≈ 1 worker, the bottleneck is shared (Mongo/
CPU), and the report says so honestly.

## 7. OPTIONAL — REALTIME INFRASTRUCTURE LOAD

Terminal 1 restart with `$env:REALTIME_ENABLED="true"` (Redis required).
Then:

```powershell
$env:LOAD_TEST_TOKEN="<token>"
npm run load:realtime -- --connections 20 --ramp-step 5 --hold-ms 15000
Remove-Item Env:LOAD_TEST_TOKEN
```

Start small (20), then try 50. Watch: connection readiness count,
establish latency, heartbeat counts, generator RSS. ALL connections are
closed at the end and on Ctrl+C. Neutral infrastructure events only —
no Chat/Presence exists (§26/§27).

## 8. STOP A RUN (Ctrl+C)

Press `Ctrl+C` in Terminal 2: the runner stops generating work, aborts
in-flight requests, prints the partial summary, and exits. Verify no
runaway `node` process remains (Task Manager) and the backend is still
healthy (`/api/health/live` → 200).

## ACCEPTANCE CHECKLIST (leave unchecked — you check these)

- [ ] Runner refuses an obviously unsafe target: try
      `npm run load:api -- --target https://prod.example.com --requests 5`
      → expect `✗ REFUSED` with the staging-declaration hint (§79; it
      never contacts that host)
- [ ] Default behavior is read-only/safe (banner says MUTATION: NONE)
- [ ] Baseline run completes with zero errors (§2)
- [ ] Concurrency/duration are visibly bounded (banner + clamps)
- [ ] p50/p95/p99 displayed and plausible (§2/§3)
- [ ] Errors are classified (e.g. `http_429`), never hidden (§5)
- [ ] No credentials/tokens in any output (§4 — token never printed)
- [ ] API remains healthy after every run (health/live 200)
- [ ] Worker drill uses the isolated prefix; ordinary queues untouched (§6)
- [ ] 1-worker vs 2-worker results recorded (§6)
- [ ] Realtime drill (if run) uses neutral events; sockets closed (§7)
- [ ] Ctrl+C stops cleanly with partial summary (§8)
- [ ] No Redis FLUSH ever (tooling has no such command)
- [ ] No tenant leak / no duplicate business mutation (read-only design)
- [ ] Results identify runId + git HEAD + targets
- [ ] Results are understood as environment-only observations
- [ ] No Phase 1–31 regression observed

## ROLLBACK

Single commit: new `scripts/load/` folder, `--workers` flag on
ops-load-check, two package scripts, one gitignore line, tests, docs.
Product runtime code is untouched.
