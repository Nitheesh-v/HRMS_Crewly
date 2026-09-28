# Phase 35.7 — A large import must survive its own duration

**Status:** 35.7 implemented and verified locally — **awaiting localhost acceptance.**

The user imported a real file — **156 valid rows, 0 rejected** (`attendance-august-2026-emp001-emp003.csv`)
— and got two symptoms:

1. a **"timeout of 25000ms exceeded"** toast, and
2. afterwards, **"This file is already being imported — please wait, then refresh"**, with the batch
   stuck on **CONFIRMING** and `0 imported · 0 skipped · 0 rejected`.

Nothing was wrong with the file: 156 rows simply cannot be imported inside one HTTP request on a
remote database.

---

## 1. What was wrong

`confirmImport` ran the **whole** file inside a single request, and the request only reported at the
end. Each row is an `recordEvent` call — policy read, schedule resolution, authorization, session
lookup, CAS, event write, reconciliation: roughly a dozen round trips per row, so a 156-row file is
on the order of **two thousand** database round trips. With the 35.2 client timeout at 25 s, the
browser gave up while the server was still working:

* the UI reported a **timeout**, and nothing was written to the batch yet (counts and outcomes were
  only saved at the very end);
* the batch stayed **CONFIRMING**;
* every further attempt hit the concurrency guard — *"already being imported — please wait"* —
  which was designed to prevent double-imports but had turned into a **lock**, exactly like the
  fingerprint lock fixed in 35.6.

## 2. The fix: bounded chunks, resumable, and no locks left anywhere

**Each confirm call now does bounded work and is resumable.**

| | before | after |
| --- | --- | --- |
| work per request | the whole file | rows until a **12 s budget** is spent (always ≥ 1 row) |
| progress | written only at the end | **persisted every chunk** (outcomes + counts) |
| interrupted request | batch stuck CONFIRMING, retries refused | next call **continues** from the stored outcomes |
| status while running | CONFIRMING (indistinguishable from wedged) | CONFIRMING **+ `done`, `processedCount`, `totalCount`, `remainingCount`** |
| client | one request, one timeout | loops the chunks, shows `Importing… 48/156` |

* The batch becomes `CONFIRMED` **only when every row has an outcome**.
* Outcomes **merge by line** and the counts are **derived from the merged set** — so even two
  concurrent continuations converge on the same ledger instead of double counting.
* **Rows already answered are never re-attempted** (`isPending` guard): a continued chunk processes
  only rows with no outcome yet.
* The old lock is gone: a `CONFIRMING` batch is continued (never refused), and even the
  two-tabs-same-instant race now resolves into a continuation. The state machine only allows this
  with explicit evidence (`{ continuation: true }`).
* **Every row still carries its own idempotency key** (`import:<batchId>:<line>`) plus the
  exists-backstop, so re-processing a row can only ever replay it. That is what makes the whole
  resumable design safe — *no parallel double-apply*, the guarantee the old conflict test protected,
  now enforced per row instead of per batch.
* A **retry** of a batch that finished having recorded nothing starts from scratch (stale refusals
  are not progress — the 35.6 contract); a **continuation** keeps its outcomes (that is what makes
  the chunked run resumable). The two cases are explicitly separated in code.

### The client

`runConfirmChunks()` calls confirm until the server says `done` (or the batch is no longer
CONFIRMING), with a 400-call ceiling and up to 2 retries on **transient** failures (no HTTP
response = timeout/offline). A timeout is therefore no longer a failed import: the server keeps
what it stored and the next call continues. The button shows `Importing… 48/156` and a progress line
explains that the import continues in the background and can be resumed.

## 3. What this means for the 156-row file

Pressing **Confirm** once keeps the tab working through the chunks. If anything interrupts it —
closed tab, backend restart, network drop — the batch is visible in history with its real progress,
and **Confirm continues it in place**. It can no longer wedge, and the file can no longer be
refused as "already being imported".

## 4. Files changed

* `Backend/src/services/attendance/attendanceImportService.js` — chunked `confirmImport`,
  per-chunk persistence, merge-by-line outcomes, progress in the response, retry/continuation split.
* `Backend/src/services/attendance/attendanceImportRules.js` — the evidence-gated
  `CONFIRMING → CONFIRMING` continuation edge.
* `Backend/src/controllers/attendance/attendanceImportController.js` — the response reports
  progress (`Import in progress — 48 of 156 rows saved`, `meta.inProgress`).
* `Frontend/src/pages/attendance/AttendanceImportPage.jsx` — the chunk loop, progress state,
  progress line, transient retry.
* `Backend/test/attendanceImportIngest.test.js` — 6 new pins (17 total).
* `Backend/test/attendanceCloseout.test.js` — the old "confirm in flight conflicts" test is
  replaced by the new contract (no lock; per-row idempotency is the guarantee).
* this document.

## 5. Pins (and proof they bite)

In `Backend/test/attendanceImportIngest.test.js` (a 6-row file, one row per chunk via `budgetMs: 0`):

* a chunk **returns inside its budget** and reports `done: false` with progress **persisted**;
* continuing finishes the import, and **no row is ever written twice** — every row keeps exactly one
  idempotency key across all chunks;
* an interrupted batch (`CONFIRMING`) is **continued, never refused** — same batch id, resuming where
  the stored outcomes ended;
* the continuation edge needs **explicit evidence**;
* a run that finished having recorded nothing is **retried from scratch**, and a run that recorded
  something **replays** instead of re-importing.

**Bite check:** removing the continuation edge fails 3 pins; ignoring the budget (single-shot
behaviour) fails 3 pins. Both pass with the fix.

Also `attendanceCloseout.test.js` now pins the absence of the lock: no
`ApiError.conflict('This file is already being imported…')`, and a raced `CONFIRMING` batch is
continued; the source pins the one-key-per-row rule and the `isPending` guard.

## 6. Real results

* `test:attendance-import-ingest` → **17/17**; `attendanceImport` 19/19; `attendanceCloseout` 7/7.
* `test:all` → **2689 tests / 98 suites / 0 fail**.
* Frontend build **✓ 1.30 s**; eslint **127 (108 errors / 19 warnings) — 0 new** (the error inside the
  import page's file is the pre-existing `set-state-in-effect` on its history effect).

## 7. Limitations (honest)

* Wall-clock time is **not** reduced. The same ~2,000 round trips still happen — the import is now
  *survivable and visible* instead of fatal. A per-row cost reduction (reusing the policy read and
  the per-day schedule resolution inside one import run) is the natural next unit if it still feels
  slow.
* Each chunk re-validates the file server-side (a few queries) before ingesting. That is deliberate:
  the client is never trusted, and the validation is what produces the reasons you read on screen.
* A retried chunk can re-report a row as SKIPPED if it landed in an earlier attempt — correct by
  design (the row is already in the ledger), and it never duplicates the fact.
* The 12 s chunk budget is a constant in the service (`DEFAULT_CONFIRM_BUDGET_MS`), injectable per
  call/deps; there is no configuration endpoint for it.
* A 5,000-row file still takes many chunk calls (the client ceiling is 400 calls, i.e. hours of
  database time). If a file is that large on a slow database, a background job is the better
  architecture; that is a bigger unit and is not attempted here.

## 8. Localhost verification (PowerShell)

**Restart the backend** (the running process still has the old code, which is why the batch is stuck):

```powershell
cd Backend
npm run dev
```

```powershell
cd Frontend
npm run dev
```

1. Open **Attendance → Attendance Import** and choose `attendance-august-2026-emp001-emp003.csv`
   again → **Preview** (156 valid / 0 rejected).
2. Press **Confirm — import 156 rows**. Expected: the button shows **`Importing… 20/156`,
   `40/156`, …** and a progress line appears. The toast arrives when it finishes — no timeout, no
   "already being imported".
3. The history row (the one that is stuck on **CONFIRMING** right now) is the **same batch** — the
   retry fills it in place. When it completes it reads **156 imported · 0 skipped · 0 rejected**.
4. Interrupt it on purpose: press Confirm, then **close the tab** mid-import. Reopen the page —
   the batch shows the rows saved so far, and pressing **Confirm** continues from there.
5. Open the employee's August 2026 attendance/timesheet: EMP001/EMP002/EMP003 punches must be there
   for every day in the file.

Sign-off line for the unit: **Phase 35.7 awaiting localhost acceptance.**
