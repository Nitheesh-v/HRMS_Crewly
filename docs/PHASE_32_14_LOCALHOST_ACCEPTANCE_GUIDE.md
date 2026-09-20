# PHASE 32.14 — LOCALHOST ACCEPTANCE GUIDE (Beginner, PowerShell + Browser)

Status: guide for **32.14 implemented** (awaiting localhost acceptance).

> ⚠️ **SAFETY:** these tests are **localhost/development only**. Never
> intentionally break production Redis/Mongo/SMTP/storage/workers. This
> phase has NO production chaos mode and NO force switch — by design.

Requirements: Mongo required (baseline + failover). Redis required only
for the worker/backlog/realtime drills. Two backend terminals for the
failover drill. Frontend not required. No synthetic-data scripts (the
automated suite is fully hermetic). Automated suite command:
`npm run test:all` (or the targeted `node --test` command below). No new
environment variables — there are deliberately **no** `FAIL_*`/`CHAOS_*`
flags in this project.

---

## 0. WHAT CHANGED (plain words)

1. A new automated suite (`Backend/test/failureRecovery.test.js`, 23
   tests) **simulates failures safely**: an API dying mid-response, a
   worker dying mid-job and retrying, duplicate job deliveries, stale
   jobs, SMTP/network failure classification, cross-tenant write
   refusal, and "logs never contain secrets". All in-process/hermetic —
   nothing real is broken.
2. The results prove Crewly's laws: failures stay **bounded**
   (retries capped, no tight loops), **truthful** (never a fake success),
   and **recoverable** (state settles; reconcilers finish the job).
3. Preliminary recovery runbooks (Redis/Mongo/Worker/SMTP/Storage/
   Realtime) now live in `docs/PHASE_32_PRODUCTION_INFRASTRUCTURE.md`
   §32.14.

## 1. BASELINE FIRST (never test failure on an unhealthy system)

```powershell
# Terminal 1
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev
```

Verify, in order:
```powershell
Invoke-WebRequest -Uri "http://localhost:5000/api/health/live" -UseBasicParsing   # 200
Invoke-WebRequest -Uri "http://localhost:5000/api/health/ready" -UseBasicParsing  # 200
```
Then log in via the Frontend (or API) and open one ordinary page.

## 2. RUN THE AUTOMATED FAILURE SUITE (the primary evidence)

```powershell
# Terminal 2
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
$env:MONGO_URI="mongodb://127.0.0.1:27017/crewly_test"
node --test test/failureRecovery.test.js
Remove-Item Env:MONGO_URI
```

Expected: **23 pass, 0 fail**. This covers (safely, in-process): API
dying mid-response → client never sees a fake success; worker dying
mid-job → bounded retry commits the business result exactly once;
duplicate deliveries can't flip terminal states; stale reminders SKIP;
cross-tenant marks refused; failure logs contain no URIs/tokens; and
no chaos flags exist anywhere in runtime config.

## 3. GRACEFUL API FAILOVER (two instances, then stop #1)

```powershell
# Terminal 3 — second API instance
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
$env:PORT="5001"
npm run dev
```

Verify both: `/api/health/ready` on :5000 AND :5001 → 200.

Now press **Ctrl+C in Terminal 1** (API #1). Then immediately:
```powershell
Invoke-WebRequest -Uri "http://localhost:5001/api/health/live" -UseBasicParsing
```
Expected: **200** — API #2 serves; your existing login (JWT) keeps
working on it; nothing was sticky. Note: Ctrl+C is a GRACEFUL stop (the
32.2 drain runs). A hard crash is simulated by the automated child
harness in §2 — that is the honest difference, and on Windows the
automated test is the accurate tool for hard death.

Restart Terminal 1 afterwards (`npm run dev`) and clear the port var:
```powershell
Remove-Item Env:PORT
```

## 4. WORKER LOSS (Redis required)

```powershell
# Terminal 4
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run worker
```
Watch the Background Operations page show the worker ONLINE. Press
**Ctrl+C** — the worker shuts down cleanly (state SHUTTING_DOWN, queues
closed). Expected: no crashed jobs; the API keeps working; restarting
the worker resumes any pending work safely (at-least-once, proven by the
automated suite).

## 5. BOUNDED BACKLOG (isolated queue only — Redis required)

```powershell
npm run ops:load-check -- --jobs 200 --concurrency 4 --workers 1
```
Expected: 200 isolated system jobs enqueued on a `crewly:test:load-*`
prefix, drained fully, scoped cleanup, no failures. This is the safe
backlog drill — it NEVER touches your ordinary queues and never FLUSHes
anything.

## 6. PRODUCT RECOVERY CHECK (proves the harness broke nothing)

After all drills, on the restored single-instance setup:
```powershell
Invoke-WebRequest -Uri "http://localhost:5000/api/health/ready" -UseBasicParsing  # 200
```
Log in again; open Attendance, a Payroll read page, and (if authorized)
a Recruitment/BGV page. Start the worker if you stopped it. Everything
should behave exactly as before the failure drills.

## ACCEPTANCE CHECKLIST (leave unchecked — you check these)

- [ ] Baseline healthy before failure testing (§1)
- [ ] Automated failure suite: 23/23 pass (§2)
- [ ] API #2 remains usable after API #1 stops (§3)
- [ ] Existing JWT works on API #2 — no sticky session (§3)
- [ ] Graceful (Ctrl+C) vs hard death distinction understood (§2/§3)
- [ ] Worker #1 stops cleanly; restart resumes safely (§4)
- [ ] Backlog drill: bounded, isolated prefix, drains, auto-cleanup (§5)
- [ ] No Redis FLUSH / no collection drops anywhere (by tooling design)
- [ ] Failure logs carry requestId/classification, no secrets/PII (§2 + backend logs)
- [ ] No duplicate financial/business mutation observed (suite asserts)
- [ ] AttendanceEvent immutability untouched (no update/delete paths added)
- [ ] No chaos endpoint/flag exists in the app (pinned by tests)
- [ ] Product regression passes after recovery (§6)
- [ ] No Phase 1–31 regression observed (`npm run test:all`)

## ROLLBACK

Single commit: new test files + docs only. Product runtime code is
untouched by 32.14.
