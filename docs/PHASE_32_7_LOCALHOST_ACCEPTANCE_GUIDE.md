# PHASE 32.7 — LOCALHOST ACCEPTANCE GUIDE (Beginner, PowerShell)

Status: guide for **32.7 implemented** (awaiting localhost acceptance).
Everything here runs on YOUR machine (localhost) with your `.env`.
No command below ever reads secret values. PowerShell only.

---

## 0. WHAT YOU ARE PROVING (plain words)

Phase 32.7 made the existing background-job system safe to run as
**MORE THAN ONE worker process at the same time**. You will start the
backend once, then start **TWO worker terminals** and prove:

1. Both workers come up, each with a **unique heartbeat identity**
   (each process generates its own id like `worker-3f2a…`).
2. A **safe test job** sent through the queue is picked up by exactly
   one worker and completes normally.
3. A **duplicate job** (same deterministic job id) collapses to a
   single execution — no double work.
4. A **retrying job** fails once on purpose and then succeeds on the
   next attempt.
5. Stopping a worker with **Ctrl+C** shuts it down GRACEFULLY
   (Ctrl+C = SIGINT here; the worker also handles SIGTERM for
   server-style stops — it stops accepting new jobs, finishes the
   current one, then exits).

**Delivery is AT-LEAST-ONCE, never exactly-once.** That is normal and
correct. What keeps business data safe is MongoDB idempotency (atomic
claims, unique constraints), not delivery promises. The tests in this
guide only use jobs that are harmless by construction.

## 1. WHAT YOU NEED (one time check)

- Node.js installed, project folder `HRMS_Crewly` on disk.
- `Backend/.env` already working for normal development (it must
  contain your `MONGO_URI`, and Redis enabled/reachable — the same
  values you already use every day). **Never paste secrets into chat.**
- MongoDB running locally.
- Redis running locally (workers and queues require it).

Open **three** PowerShell terminals (Terminal A, B, C). In each one,
go to the backend folder first:

```powershell
cd C:\path\to\HRMS_Crewly\Backend
```

(Replace the path with YOUR project path.)

## 2. TERMINAL A — START THE BACKEND (as usual)

```powershell
npm run dev
```

Wait for your normal "server started" style log line. Leave this
terminal running.

## 3. TERMINAL B — START WORKER #1

```powershell
npm run worker
```

Expected (exact wording can vary slightly):

- `[Worker] Starting workers (prefix=crewly:<env>, system concurrency=2, email concurrency=2, …)`
  — one line listing each queue's concurrency.
- Eight `[Worker] <label> ready (queue=…, concurrency=…)` lines —
  system, email, resume, ats, scheduled, documents, bgv, payroll.
  (There is deliberately NO analytics worker — that queue is reserved.)
- `[Worker] Workers online (prefix=…, registered jobs=40)` —
  **40** is the full job registry.
- A heartbeat id (looks like `worker-` followed by random characters)
  appears in the startup logs. **Each worker process gets its OWN
  unique id** — this is the multi-worker identity this phase protects.

## 4. TERMINAL C — START WORKER #2 (the multi-worker proof)

```powershell
npm run worker
```

Same expected lines as Terminal B — but the heartbeat id is
**DIFFERENT** (unique per process). Both terminals finishing startup
with no errors IS the first acceptance point: two full workers
coexist on the same queues without fighting.

> Why two workers is safe: jobs are claimed through MongoDB atomic
> updates (first process to claim wins; the other sees the new state),
> and every business write is idempotent. Redis never decides who did
> the work — Mongo does.

## 5. SEE THE TWO HEARTBEATS (exact-key read only)

The worker heartbeat writes one short-lived Redis key per process:

- key: `crewly:ops:worker:<env>:<workerId>` (TTL 60 s, refreshed
  every 15 s)
- a small set `crewly:ops:workers:<env>` lists the live worker ids.

With Redis running locally, read them by their EXACT names:

```powershell
redis-cli SMEMBERS "crewly:ops:workers:local"
redis-cli GET    "crewly:ops:worker:local:PASTE-ONE-WORKER-ID-HERE"
```

(If your `QUEUE_PREFIX`/env differs, use your env label in place of
`local` — it is the part after `crewly:` in the prefix the workers
print at startup.)

Expected: the set shows **two** `worker-…` ids right now, and the GET
returns that worker's tiny status value (it disappears by itself ~60 s
after a worker stops — ephemeral by design).

> HARD RULE (all phases): NEVER run `KEYS`, `SCAN`, `FLUSHALL`,
> `FLUSHDB`, and never wildcard-delete `crewly:*` keys. Always exact
> key names, like above. These commands can destroy live jobs/caches.

## 6. SAFE JOB TEST #1 — HEALTH CHECK THROUGH THE QUEUE

From `Backend`, with backend + BOTH workers running:

```powershell
npm run queue:check
```

This uses ONLY the system queue (`system-health-check`): harmless by
construction — no DB writes, no side effects, no business data.
Expected: the script reports success; ONE of your two worker
terminals logs:

- `[Worker] active: system-health-check (id=…, attempt=1)`
- `[Worker] completed: system-health-check (id=…, attempts=1)`

Only ONE of the two terminals processes the job (a job goes to one
worker). Run it a few times — you may see the work land on either
terminal. That is normal load sharing.

## 7. SAFE JOB TEST #2 — CONTROLLED RETRY

```powershell
npm run queue:check:retry
```

Still system-queue-only. The job is built to FAIL ONCE on attempt 1
and succeed afterwards — proving retries work with backoff and that a
retry lands cleanly even with two workers listening. Expected: script
reports the retry success; a worker terminal shows
`attempt=1` failing, then a later attempt completing.

## 8. SAFE JOB TEST #3 — DUPLICATE JOB COLLAPSE

```powershell
npm run queue:check:duplicate
```

Still system-queue-only: the same logical job (same deterministic job
id) is enqueued twice. Expected: the script proves only ONE execution
happened — the second enqueue collapses on the job id. This is the
same mechanism that protects real business jobs (email, BGV,
documents, payroll) from double work when two API instances or a
reconcile pass race to enqueue the same logical job.

## 9. GRACEFUL STOP (Ctrl+C = SIGINT)

In Terminal C (worker #2), press **Ctrl+C** once.

Expected: `[Worker] … closing (stopping acceptance, finishing active
jobs)` — the worker stops taking NEW jobs, finishes any active job,
closes its own Redis connections, and exits. The backend (Terminal A)
and worker #1 (Terminal B) keep running untouched. Wait ~60–75 s and
re-run the exact-key read from §5: the stopped worker's id is gone
from the set (removed on graceful stop; its TTL key expires on its
own). Jobs continue flowing through worker #1 — re-run
`npm run queue:check` to confirm.

To restart worker #2 later: `npm run worker` again in Terminal C.

Startup reconciliation (automatic helpers, run anytime from
`Backend` — safe, idempotent, deterministic job ids make re-runs
no-ops):

```powershell
npm run queue:reconcile
npm run processing:reconcile
npm run scheduled:reconcile
```

## 10. WHAT **NOT** TO DO DURING THIS ACCEPTANCE

This acceptance is about WORKER SAFETY, not business flows. Do NOT:

- **No payroll payment / bank file runs** (29.8 flows).
- **No candidate decisions** (advance/reject/offer moves) as part of
  this test.
- **No BGV terminal actions** (submit/verify/decision endpoints).
- **No destructive attendance operations** (finalization, closeout,
  delete/regularize bulk actions).
- No new queues, no new dependencies, no config edits during
  acceptance.

Real business queues (email/resume/ats/documents/bgv/payroll/
scheduled) were verified by the automated suites listed in the phase
docs (`test/multiWorkerSafety.test.js` and friends, full
`npm run test:all` green). Localhost only needs to prove the living
system behaves as documented.

## 11. OPTIONAL: HERMETIC AUDITOR + TESTS (no Redis needed)

These run without touching your live Redis/queues (safe anywhere):

```powershell
npm run worker:scale-check
npm run test:worker-safety
npm run test:all
```

`worker:scale-check` prints a one-line verdict that the registry is
complete, dispatch is safe, and the references-only payload law is
enforced — and reminds that delivery remains AT-LEAST-ONCE with
business idempotency living in Mongo claims.

## 12. ACCEPTANCE CHECKLIST (leave UNCHECKED until you have seen it)

- [ ] Terminal A backend starts normally.
- [ ] Terminal B `npm run worker`: 8 queues ready, `registered jobs=40`, unique `worker-…` id.
- [ ] Terminal C `npm run worker`: same, with a DIFFERENT `worker-…` id.
- [ ] §5: `SMEMBERS` shows BOTH worker ids; exact-key GET works; no `KEYS`/`SCAN`/`FLUSHALL` used anywhere.
- [ ] §6 `queue:check`: completed by exactly one worker terminal.
- [ ] §7 `queue:check:retry`: fails attempt 1, succeeds on retry.
- [ ] §8 `queue:check:duplicate`: two enqueues, ONE execution.
- [ ] §9 Ctrl+C in Terminal C: graceful closing line, other terminals unaffected, heartbeat disappears ~60 s, `queue:check` still works via worker #1.
- [ ] No forbidden operations from §10 were performed.

---

*Phase 32.7 awaiting localhost acceptance.*
