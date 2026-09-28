# Phase 35.5 — Attendance CSV import: it now imports, and it now says why when it cannot

**Status:** 35.5 implemented and verified locally — **awaiting localhost acceptance.**

Reported with two screenshots of **Attendance → Attendance Import**:

1. Preview: **Valid rows — 4**, Rejected rows — 1 (line 4: *"An earlier session is still open —
   close or regularize it first"*), button reading **"Confirm — import 4 rows"**.
2. After confirming: **"Import result — 0 imported, 0 skipped, rejected"**, five rows listed with
   **empty outcome pills and no detail**, and the history showing the file **CONFIRMED** with
   **0 imported · 0 skipped**.

Nothing was imported, and nothing on screen said why. Two independent defects did that.

---

## 1. Every row was rejected by the engine — including the clock-in that creates the day

`recordEvent` (the single state machine every attendance source converges on) treats an explicit
`date` as "the session you mean must already exist":

```js
if (date !== null) {
  control = await AttendanceModel.findOne({ companyId, user: userId, date });
  if (!control) throw ApiError.notFound('No attendance session for that date');
}
```

That rule is **correct for a self-service punch**: a WEB request that names a past date must not be
able to fabricate a day of attendance. It was **fatal for the import**, whose entire job is
bulk-loading device exports for days that have no session yet — the CLOCK_IN row was refused
before it could open the session it was meant to create. So a "successful" confirm imported
nothing, every time.

### The fix: a trusted adapter may open the session, on the day the row names

```js
if (!control) {
  if (action === EVENT_TYPE.CLOCK_IN && ingest?.source === EVENT_SOURCE.IMPORT) {
    return clockIn({ ..., todayKey: date, ... });   // session created ON that day
  }
  throw ApiError.notFound('No attendance session for that date');
}
```

* Only a **CLOCK_IN** may open a session. A CLOCK_OUT/break row for a day with no session is still
  refused — a clock-out never invents the day it closes.
* Only a **server-decided ingest context** qualifies (`ingest.source === 'IMPORT'`, assembled by
  the adapter, never from `req.body`). A WEB punch with an explicit past date behaves exactly as
  before — pinned.
* The import has already validated the row (active employee, inside the 12-month window, not
  future, not a finalized month, no conflicting event, no open session elsewhere) and it names the
  session day, so the session lands on **that** day — never on the wall-clock day.

## 2. The reason a row failed was being destroyed on the way to the database

The per-row outcome is the **only** place the reason exists — the raw CSV is deliberately never
persisted. The service writes it as `status` / `message` / `at`, and the page renders exactly those
two names. The model declared something else:

| | service writes | model declared | Mongoose strict mode |
| --- | --- | --- | --- |
| outcome status | `status` | `outcome` | **dropped** |
| outcome reason | `message` | `reason` | **dropped** |
| outcome instant | `at` | `occurredAt` | **dropped** |
| rejected count | `rejectedCount` | *no such path* | **dropped** |

So the batch stored only line numbers, the page rendered five empty pills, and the header printed
`{importedCount} imported, {skippedCount} skipped, {rejectedCount} rejected` with the last number
missing — *"0 imported, 0 skipped, rejected"*, word for word what the screenshot shows. The
failure was invisible **by construction**.

### The fix

The outcome sub-schema now declares `status` (IMPORTED / SKIPPED / REJECTED), `message` and `at`,
and the batch schema has the missing `rejectedCount`. Nothing else read the old names, so no
migration is needed. Batches confirmed before the fix keep their (empty) stored outcomes; the page
now renders **UNKNOWN** for those instead of a blank pill.

## 3. The page also reported a working import as an error

A 35.1 conversion artifact had left `notify.error(...)` on the success path: a preview that worked
was announced in red, and so was a successful import. Now: preview ready → **info**, import
complete → **success**, import completed *with rejected rows* → **warning** naming the count and
pointing at the result table, already-imported file → **warning**. Real failures still use `error`.

## 4. Files changed

* `Backend/src/services/attendance/attendanceEventService.js` — the IMPORT clock-in may open its
  session (the `date !== null` branch).
* `Backend/src/models/AttendanceImport.js` — outcome `status`/`message`/`at`; `rejectedCount`.
* `Frontend/src/pages/attendance/AttendanceImportPage.jsx` — honest toast severities; `UNKNOWN`
  for legacy outcome rows.
* `Backend/test/attendanceImportIngest.test.js` — NEW pins (7).
* `Backend/package.json` — `test:attendance-import-ingest`; the file joined `test:all`.
* this document.

## 5. Pins (and proof they bite)

`Backend/test/attendanceImportIngest.test.js` runs the **real** `recordEvent` and the **real**
`confirmImport` against in-memory model fakes:

* an IMPORT clock-in with an explicit past date and no session **creates the session on that day**
  and writes one event with `source: IMPORT`, the batch provenance, the row instant and the row's
  idempotency key;
* the identical call **without** an ingest context still rejects with *"No attendance session for
  that date"* and writes nothing (self-service backdating stays impossible);
* an IMPORT **clock-out** for a day with no session is still rejected;
* **schema/writer agreement**: every field the service writes to the batch — and to each outcome —
  is checked against the real `AttendanceImport` schema, so a rename on either side fails the suite
  instead of silently deleting evidence;
* a rejected row reaches the caller with `status: 'REJECTED'`, its line and its **message**, and
  `rejectedCount` is a real number;
* the page keeps success on the success channel and never renders a blank pill;
* the adapter still passes the planned session day per row.

**Against the old code (both fixes temporarily reverted) pins 1 and 4 fail** — the import path and
the schema drift — and they pass with the fixes.

## 6. Real results

* `test:attendance-import-ingest` → **7/7**; existing `attendanceImport` suite → **19/19**;
  attendance engine suites (events, kiosk, QR, presence, reconciliation, finalization,
  regularization) → **278/278**.
* `test:all` → **2679 tests / 98 suites / 0 fail** (final run, verified after pushing). An earlier
  run of the same suite hit exactly one failure: `payslipBranding.test.js` compared two generated
  PDFs whose `/CreationDate` differed by a second (`…064244Z` vs `…064245Z`) — a pre-existing
  timing-boundary flake in a file this unit does not touch, which passes **7/7 in isolation twice**
  and passed in the next full run.
* Frontend build **✓ 1.39 s**; eslint **127 (108 errors / 19 warnings) — 0 new**.

## 7. Limitations (honest)

* The two batches already in the history keep `0 imported` — they really did import nothing. Their
  outcome rows now read **UNKNOWN** (the status was dropped before this fix, so it cannot be
  recovered). Re-importing the same file re-plays the stored batch (idempotent by fingerprint); a
  corrected file with new content imports normally.
* VALID_ROWS_ONLY is unchanged: rows the validator refuses are never silently skipped, they are
  counted and listed with their reason.
* Cross-midnight attribution still belongs to the engine: if a company's previous-day schedule
  crosses midnight, the CLOCK_IN of a backdated row can be attributed to the business date. A
  follow-up row that then points at a different session day is rejected per-row — and now you can
  read why.
* If an attendance policy carried no timezone, the import's fallback (`Asia/Kolkata`) and the
  engine's (company timezone, then the default) could differ by a day for rows near midnight. That
  produces a visible per-row rejection, never a silent wrong-day import.
* No backfill of historical outcomes, no change to kiosk/QR/self-service punch behaviour, no new
  dependency, no schema migration beyond the additive `rejectedCount` path.

## 8. Localhost verification (PowerShell)

```powershell
cd Backend
npm run dev
```

```powershell
cd Frontend
npm run dev
```

1. Open **Attendance → Attendance Import** and choose the same corrected CSV, then **Preview**.
   You should still see **4 valid / 1 rejected** (line 4, the open-session row).
2. Click **Confirm — import 4 rows**. Expected now:
   * the toast is **amber, not red**: *"Imported 4 events — 1 row(s) could not be imported. See the
     result table for the reason."*
   * the result table shows **IMPORTED** (green) for lines 2, 3, 5, 6 and **REJECTED** (red) for
     line 4 **with its reason in the Detail column**;
   * the header reads **"Imported 4 events (0 skipped, 1 rejected)"**-style numbers, all three
     present.
3. Open **Import history** → the new row reads **4 imported · 0 skipped · 1 rejected**; clicking it
   shows the same per-row outcomes. (The two older rows stay 0 imported and show **UNKNOWN** —
   they predate the fix.)
4. Open **Attendance** (or the employee's timesheet/report) for **September 2026** and confirm the
   imported clock-ins/clock-outs for EMP001/EMP002/EMP003 are there on 16 Sep 2026.
5. Integrity check: as an employee (or via the API), try to punch with an explicit past date —
   it must still be refused with *"No attendance session for that date"*. Only the import adapter
   can open a backdated day.

Command reference: `cd Backend; npm run test:attendance-import-ingest` runs this unit's pins;
`npm run test:all` runs the whole hermetic suite.

Sign-off line for the unit: **Phase 35.5 awaiting localhost acceptance.**
