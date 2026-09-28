# Phase 35.9 — Make the import report readable (the reasons are the point)

**Status:** 35.9 implemented and verified locally — **awaiting localhost acceptance.**

The state after 35.8 is *good news*: the 156-row August file imported, with
**135 imported · 0 skipped · 21 rejected** — but the screenshot that came back showed only the
imported tail of the table (lines 147–157), because the rejected rows sit **above line 147**, mixed
into the list by line number. The header said 21 rejected; the reasons were effectively invisible.

That is the same defect shape as the earlier units, one layer up: **the information exists but the
screen does not surface it.** The reasons are the only record of what did not import (the raw CSV is
never persisted), so they must be one click away.

---

## 1. What this unit changes (frontend only)

| | before | after |
| --- | --- | --- |
| the result table | one flat list, all 156 rows | **filter chips**: `All 156 · REJECTED 21 · IMPORTED 135 · SKIPPED 0 · UNKNOWN 0` |
| what you see after a confirm | the top of the list (usually successes) | **opens ON the failures** when anything failed, so the reasons are the first thing on screen |
| getting the reasons out | screenshot by screenshot | **Download results CSV** — `line, employee, event, outcome, detail, at`, UTF-8 BOM so Excel shows it correctly |
| "showing X of Y" | not shown | shown whenever a filter is active |

The filter also opens on the failures when you click a **history** row, so an old batch explains
itself the same way. `UNKNOWN` (outcomes stored before the schema alignment) stays a first-class
bucket rather than a blank pill.

## 2. Why not "just fix the 21 rows"

The 21 reasons were not visible in the report, and nothing in the code refuses a row by itself:
the engine has **no** weekend/holiday gate, and every other refusal path was already accounted for
(`already clocked in today`, `no session for that date`, transition refusals such as
`You have not clocked in yet`, `This attendance session is already completed`, mode refusals).
Which of those fired — and for which 21 rows — is a data question, and the data is in the batch that
is now downloadable. This unit is the instrument; the diagnosis follows from what it prints.

## 3. Files changed

* `Frontend/src/pages/attendance/AttendanceImportPage.jsx` — outcome filter state + chips,
  filtered table, default-to-failures on result/detail, `downloadOutcomes()` CSV export.
* `Backend/test/attendanceImportIngest.test.js` — 7 new source pins (21 PIN TESTS total in the file;
  this unit added assertions to the existing page pin).
* this document.

## 4. Pins

The page pin now asserts:

* the filter state exists and **defaults to `REJECTED` when the server reports failures** (and to
  `ALL` otherwise) — for both a fresh confirm and a history row;
* all four outcome buckets are counted for the chips;
* the rendered rows come from `visibleOutcomes`, not the raw list;
* the CSV export exists, is named `attendance-import-<batchId>-outcomes.csv`, and carries a **BOM**
  so Excel reads the em dashes/UTF-8 correctly.

## 5. Real results

* `test:attendance-import-ingest` → **21/21**.
* `test:all` → **2693 tests / 98 suites / 0 fail**.
* Frontend build **✓ 1.63 s**; eslint **127 (108 errors / 19 warnings) — 0 new**.

## 6. Limitations (honest)

* The download contains only what is stored per row (line, employee, event, outcome, detail, at) —
  never the raw CSV, which is still deliberately not persisted.
* Filtering and export are client-side over the batch's stored outcomes; a batch with an enormous
  outcome list (5,000 rows) renders filtered, and the CSV is built in one string — fine at the
  5,000-row cap, not a streaming export.
* Nothing about *why* rows fail changed in this unit. If the 21 reasons turn out to be a code
  defect, that is the next unit and the reasons will say which one.

## 7. Localhost verification (PowerShell)

```powershell
cd Frontend
npm run dev
```

(The backend is unchanged in this unit — no restart needed.)

1. Open **Attendance → Attendance Import** and click the history row for
   `attendance-august-2026-emp001-emp003.csv` (the 135 / 0 / 21 batch).
2. The result table must **open on the failures**: the `REJECTED 21` chip active, `showing 21 of 156`
   next to it, and each row showing its **Detail** (the reason). Send me that screen — it is the
   whole diagnosis.
3. Click **Download results CSV** and open it in Excel: all 156 rows with their outcome and reason,
   accents/em dashes intact.
4. Click `IMPORTED 135` / `All 156` to move between the views; the download always contains the
   whole batch.

Sign-off line for the unit: **Phase 35.9 awaiting localhost acceptance.**
