# Phase 28.9 — Final Redis + BullMQ Hardening (Recovery / Load / Failure / Security)

This phase **audited and hardened** the complete Phase 28 infrastructure.
No major features were added. Every acceptance area was verified against
the actual code; only materially-improving fixes were implemented.

---

## 1. Risk report (pre-coding)

### CRITICAL
None found. (The worker-startup import bug was found and fixed in 28.8.)

### HIGH
| # | File | Function | Failure scenario | Impact | Correction (implemented) |
|---|---|---|---|---|---|
| H1 | `src/workers/index.js` | `attachEventHandlers` `error` handler | Sustained Redis/provider outage emits repeated `error` events (bounded ioredis retry cadence × 7 workers) | Log storm; operators lose the signal in noise | Per-worker throttle: first error logged, then one summary line per 30s with suppressed count; state reset on `ready` |
| H2 | `src/workers/workerHeartbeat.js` | `beat()` catch | Same outage | Repeated heartbeat-failure warns (4/min/worker) | Throttled to first + one line per 5 minutes |
| H3 | ops reconcile surface | — | Recovery runbook (§79) needs "reconcile email, then resume/ATS, then scheduled, then documents/BGV" but only 6 separate runs existed | Slow manual recovery; no single bounded "run everything" | New `opsReconcileCoordinator.reconcileBackgroundWork({domains, limit, dryRun})` — thin coordinator over the EXISTING runners, per-domain error isolation, same RBAC/rate limits/audit; `area: 'all'` on the existing reconcile endpoint + UI "Run all (bounded)" |

### MEDIUM
| # | Where | Gap | Correction (implemented) |
|---|---|---|---|
| M1 | §50 ops auth | No hermetic proof that a validly-signed customer token is denied at the platform gate; `protect` anonymous/malformed paths untested | New tests: signed tenant JWT → 403 **before any DB access** (measured < 2s, no Mongo buffering); anonymous → 401; malformed → 401 |
| M2 | §90 scripts | No grouped Phase 28 / all-suites scripts | Added `test:cache`, `test:operations`, `test:background-jobs`, `test:phase28`, `test:all` (explicit file lists — Windows-safe, no shell tricks) |
| M3 | §60–64 load/backpressure/memory | No controlled observation tool | New opt-in `scripts/ops-load-check.js` (`npm run ops:load-check -- --jobs 100 --concurrency 4`): isolated prefix, safe system jobs only, measures drain time / failures / peak backlog / approximate RSS Δ, scoped obliterate, never FLUSH, explicit "not a production benchmark" note |
| M4 | §91 test safety | The opt-in ops live ladder is the only live test writing to Mongo (one EmailDelivery fixture) | Documented: opt-in only, exact-`_id` cleanup in `after()`, isolated queue prefix; hermetic suites never connect |

### LOW (documented, no code change — verified already correct)
- Job schema versioning: `parserVersion` / `processingVersion` / versioned deterministic ids already exist; strict payload whitelists reject unknown shapes safely (unknown future version = safe failure, never misinterpretation).
- Queue names: no renames planned; versioning policy documented (new queue only on breaking schema change).
- Worker splitting: one process for all 7 queues is correct at current scale (§85: do not split prematurely).
- Managed free-tier Redis: not a production benchmark; eviction/HA/persistence recommendations documented.

## 2. Audit findings (the "already correct" verification)

**Payload security (§46/§94):** grep across all enqueue sites for
`secureToken|resetToken|offerToken|setupToken|portalToken|token` — the only
hits are **comments** documenting the token-free design. Payloads are
reference-only (ids, versions, epochs, correlation ids). No resume text, no
binary, no document content, no provider responses, no SMTP/Redis/
provider credentials.

**Job-id security (§47):** all builders use ObjectId segments +
version/epoch slugs (`buildJobId`, `buildResumeJobId`, `buildATSJobId`,
`buildDocumentProcessJobId`, `buildBgv*JobId`, `buildEmailJobId`). No
emails/phones/names/tokens.

**Result + log security (§48/§49):** processors return skip-reasons or
small operational metadata (verified per processor); zero payload logging
(grep: the only `job.data` mention is a comment forbidding it).

**Tenant safety (§45/§88):** every processor re-fetches Mongo by
`{_id, companyId}` and revalidates status + version before acting — a
cross-tenant id simply yields NOT_FOUND. Cross-tenant tests exist in
bgvQueue/atsMatching/candidatePipeline/interviewEvaluation/preOnboarding.

**Idempotency (§16–22):**
- Email: atomic `claimEmailDelivery` (2nd run → `ALREADY_FINAL`) + eventKey dedupe.
- Resume: lease claim + versioned deterministic id → one parse result/version.
- ATS: versioned result upsert → one authoritative result; no auto-reject.
- Offer expiry: `expireOfferIfDue` atomic `findOneAndUpdate`; ACCEPTED never expires (tested).
- BGV: atomic set-if-empty `providerSubmission` claim; failure releases claim (tested).
- Documents: version-scoped lease; stale version skips; V1 never touches V2.

**Stale jobs (§23–28):** STALE_SCHEDULE / TERMINAL_STATE / STALE_EXPIRY /
version-mismatch / stale-poll — all SKIP (tested in scheduledJobs,
documentProcessing, bgvQueue).

**Failure behavior (§29–37):** Mongo down → retryable throw (BullMQ
retries, no success marking); SMTP auth = non-retryable vs
connection/timeout = retryable (`classifyEmailSendFailure`); corrupt resume
= terminal UNSUPPORTED on attempt 1; scanned/image-only = REVIEW_REQUIRED;
BGV provider down = backoff 5→15→30→60m within 7d window →
UNABLE_TO_VERIFY/REVIEW_REQUIRED, never auto-reject.

**Cache (§38–42):** fail-open Mongo fallback; generation invalidation on
mutation; tenant-scoped keys with cross-tenant proof; equivalent normalized
filters share a key; malformed value → exact-key delete + MISS.

**Reconciliation (§12):** all six runners Mongo-authoritative, bounded,
idempotent, no Redis scans, no FLUSH. `prepareJobSlot` clears only FAILED
slots — the single idempotency primitive.

**Shutdown (§69/§70):** API: HTTP → Redis → Mongo → exit (hard-stop 10s).
Worker: SHUTTING_DOWN heartbeat → close workers → disconnect → exit
(hard-stop 10s).

**Redis client (§76, API side):** bounded exponential reconnect (capped),
state-change-only logging (no per-error spam) — already correct in 28.1.

## 3. What was changed

| File | Change |
|---|---|
| `Backend/src/services/opsReconcileCoordinator.js` (new) | Master coordinator: validates domains, clamps limit 1–100 per domain, dryRun→preview, sequential run with per-domain error isolation, reuses existing audit |
| `Backend/src/controllers/superAdminQueueOpsController.js` | reconcile endpoint accepts `area: 'all'` / `domains[]` / `dryRun` (same permission + rate limit) |
| `Backend/src/workers/index.js` | Error-log throttle (30s) in worker event handlers; reset on ready |
| `Backend/src/workers/workerHeartbeat.js` | Heartbeat-failure log throttle (5 min) |
| `Backend/scripts/ops-load-check.js` (new) | Opt-in controlled load/backpressure/RSS check (isolated prefix) |
| `Backend/package.json` | §90 script grouping + `ops:load-check` |
| `Backend/test/opsQueueOps.test.js` | +7 hermetic tests (coordinator ×5, auth gate ×2) |
| `Frontend/.../SuperAdminBackgroundOperationsPage.jsx` | "Run all (bounded)" + runbook hint + per-domain error display |

## 4. Verification results

| Check | Result |
|---|---|
| Full non-live backend suite (`npm run test:all`, 24 suites) | **366 / 366 passed, 0 failed** (was 359 at 28.8) |
| Syntax (`node --check` all changed/new JS) | all OK |
| `npm audit` Backend / Frontend | **0 / 0 vulnerabilities** |
| Frontend `npm run build` | ✓ built (pre-existing chunk-size warning only) |
| `git diff --check` | clean |
| Conflict markers / `.js.js` traps | 0 / 0 |
| Secrets scan (tracked files) | clean (only a format comment in `.env.example`; `.env` untracked) |
| FLUSHALL/FLUSHDB in src | none (only prohibitive comments) |
| Frontend Redis references | none |

## 5. Live verification (developer, opt-in — run in this order)

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run worker:dev          # Terminal 1 — worker (heartbeat visible in ops UI)
npm run test:ops:live       # Terminal 2 — 28.8 ladder (retry / non-retryable /
                            # reconcile idempotency / worker-down visibility)
npm run test:bullmq:live    # 28.2 ladder (round-trip / retry proof)
npm run ops:load-check -- --jobs 100 --concurrency 4   # drain time, backlog, RSS
```

Outage drill (manual, dev machine): stop the worker → ops UI shows
OFFLINE within the heartbeat TTL while queues stay visible → restart →
ONLINE → run "Run all (bounded)" from the ops page.

## 6. See also

`docs/PHASE_28_FINAL_ARCHITECTURE.md` — the complete Phase 28 reference:
architecture diagram, queue/worker/job inventory, payload rules, failure
behavior, recovery runbooks, production topology + checklist, monitoring
recommendations, known limitations, and the final memory capsule.
