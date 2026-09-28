# Phase 35.6 — A failed import must not lock its own file

**Status:** 35.6 implemented and verified locally — **awaiting localhost acceptance.**

35.5 fixed the import (rows now import, and a refused row carries its reason). The user pressed
**Confirm** again on the same file and got:

> "This file was already imported — showing the stored result."

…with **0 imported · 0 skipped** in the history. The file was never imported, the data was still
missing, and the app refused to try again: the fingerprint that makes the import idempotent had
also made a *nothing-happened* import **permanent**. The only way out was to edit the CSV so its
fingerprint changed.

---

## 1. What was wrong

`confirmImport` ended like this:

```js
const prior = await BatchModel.findOne({ companyId, fingerprint }).lean();
if (prior?.status === IMPORT_STATUS.CONFIRMED) {
  return { ...safeBatch(prior), duplicate: true };   // ← "already imported", forever
}
```

and the state machine agreed: `IMPORT_TRANSITIONS.CONFIRMED = []`, so a batch whose every row was
refused could never be re-claimed. Two consequences:

* the person could not re-import the same export even after fixing the *attendance* problem that
  caused the refusals (an open session, a finalized month);
* every batch that predates the 35.5 schema fix is in exactly this state — the two batches in the
  reporter's history included.

## 2. The fix: a narrow, evidence-based retry edge

**Idempotency is about not importing the same data twice.** A batch that recorded nothing has no
such guarantee to protect, so it is no longer treated as finished.

* `canTransitionImport(from, to, evidence)` gains one edge: `CONFIRMED → CONFIRMING`, allowed
  **only** when the caller supplies the stored counts and both are zero —
  `{ importedCount: 0, skippedCount: 0 }`.
  *Callers that pass no evidence get the old strict answer*, so the edge can never be satisfied by
  accident (pinned).
* `confirmImport` replays the stored result only when the batch actually recorded something
  (`importedCount + skippedCount > 0`). A skipped row counts: "everything was already in the
  ledger" is a completed import, not a failure.
* The atomic claim now matches the batch's real state and, for a retry, is additionally guarded on
  `importedCount: 0, skippedCount: 0` — so a retry can never race a completed import into being
  overwritten, and exactly one confirmer still wins.
* The retry happens **in place**: same batch `_id`, same history row, `createdAt` preserved,
  `confirmedAt` updated. The unique `(companyId, fingerprint)` index is respected without any
  index change, and outcomes/counts are rewritten rather than appended — so a retried row stops
  showing `UNKNOWN`.

Nothing about writing changes: the per-row idempotency key (`import:<batchId>:<line>`) and the
"exact fact already exists" backstop are the same guards that make a retry safe.

## 3. Also in this unit

* The result header and the history row printed a **dangling word** when a count had never been
  stored: `0 imported, 0 skipped, rejected`. Both now default to `0`
  (`0 imported · 0 skipped · 0 rejected`), so the sentence is always complete.

## 4. Files changed

* `Backend/src/services/attendance/attendanceImportRules.js` — the evidenced retry edge, documented.
* `Backend/src/services/attendance/attendanceImportService.js` — replay only when something was
  recorded; the in-place retry; the count-guarded atomic claim.
* `Frontend/src/pages/attendance/AttendanceImportPage.jsx` — counts default to 0.
* `Backend/test/attendanceImportIngest.test.js` — pins for this unit added (11 total).
* this document.

## 5. Pins (and proof they bite)

In `Backend/test/attendanceImportIngest.test.js`:

* a confirm that imported **nothing** can be retried with the **same file** — same batch id, the
  rows then import, the stale rejection counts and UNKNOWN outcomes are replaced;
* an import that **did** land stays final and replays its stored summary **without re-running the
  ingest** (the adapter is spied: zero calls);
* a batch whose rows were all already recorded is final too (skips are a completed import);
* the retry edge is narrow: no evidence → refused; `importedCount > 0` → refused;
  `skippedCount > 0` → refused; half-answered evidence → refused;
* `CONFIRMED → DRAFT` and `FAILED → CONFIRMING` stay impossible;
* the page never prints a bare count word.

**With the two 35.6 fixes temporarily reverted, 2 of the 11 fail** (the retry and the edge) and
they pass with the fixes.

## 6. Real results

* `test:attendance-import-ingest` → **11/11**; `attendanceImport` → **19/19** (30 together).
* Attendance engine suites (events, kiosk, QR, presence, reconciliation, operations) → **223/223**.
* `test:all` → **2683 tests / 98 suites / 0 fail**.
* Frontend build **✓ 1.19 s**; eslint **127 (108 errors / 19 warnings) — 0 new** (the single error
  reported inside the import page's file is the pre-existing `set-state-in-effect` on its history
  effect, part of the baseline).

## 7. Limitations (honest)

* A retry re-runs the **whole** confirm. Rows that did land on a previous *failure* (a partial
  import: some imported, some refused) are protected by the idempotency key and the exists-backstop,
  so they are reported as SKIPPED — never duplicated. But a partial import is **not** retryable in
  place (it has `importedCount > 0`), so it replays its stored result. Correcting it means moving
  those rows with regularization, which is the intended mechanism.
* The `FAILED` status is still unreachable (nothing sets it) and stays terminal; the retry edge is
  deliberately only `CONFIRMED → CONFIRMING`.
* The two historical batches are only retryable **after** this deploys: press **Confirm** once on
  the same file and it will fill them in place.
* No change to the fingerprint algorithm, the unique index, the CSV parser, or to who may import
  (`ATTENDANCE_CAPTURE_MANAGE`).

## 8. Localhost verification (PowerShell)

Restart the backend so the fix is loaded:

```powershell
cd Backend
npm run dev
```

```powershell
cd Frontend
npm run dev
```

1. Open **Attendance → Attendance Import** and choose **the same** `attendance-import-corrected.csv`
   again, then **Preview** (still 4 valid / 1 rejected).
2. Click **Confirm — import 4 rows**. Expected: **no** "already imported" notice any more. The
   toast reports the real outcome, and the result table shows **IMPORTED** for the four rows and
   **REJECTED with its reason** for line 4.
3. **Import history**: `attendance-import-corrected.csv` now reads
   **4 imported · 0 skipped · 1 rejected** — the same row as before (the retry filled it in place,
   no duplicate entry).
4. Press **Confirm** again on that same file now: *that* is a real replay — you get the amber
   **"already imported — showing the stored result"** notice and the import does not run twice.
5. The second, older history row (`attendance_import_final.csv`, 0 imported) is the same story:
   confirming it retries it in place instead of refusing.
6. Check **Attendance** for September 2026 — the imported events are present.

Sign-off line for the unit: **Phase 35.6 awaiting localhost acceptance.**
