# Attendance capture surfaces — Import, Validation, Kiosk Stations, QR Challenges

Three v3 surfaces (four screens) were re-cut against the Stitch exports in
`stitch-attendance/v3`. The mock is the visual and structural baseline; the
API is the only source of facts. Every block the mock draws still has a place
in the layout — but a block without an endpoint says what it lacks instead of
printing a plausible number.

| mock | route | file |
| --- | --- | --- |
| `code.html` (import upload + history) | `/app/attendance/imports` | `AttendanceImportPage.jsx` |
| `code (1).html` (batch review) | `/app/attendance/imports/validation` | `AttendanceImportValidationPage.jsx` |
| `code (3).html` (device registry) | `/app/attendance/kiosks` | `KioskStationsPage.jsx` |
| `code (5).html` (QR issuance) | `/app/attendance/qr` | `QrChallengesPage.jsx` |

Endpoints used (unchanged — **no backend work in this pass**):
`/attendance/imports/{preview,confirm,template.csv}`, `/attendance/imports`,
`/attendance/imports/:id`, `/attendance/kiosks`,
`/attendance/kiosks/:id`, `/attendance/kiosks/:id/rotate-secret`,
`/attendance/qr/challenges`, `/attendance/locations`,
`/attendance/analytics/overview` (capture mix only).

All four screens are behind `RequireRole roles={HR}`, and the pages
themselves check `ATTENDANCE_CAPTURE_MANAGE` (QR's capture mix additionally
needs `ATTENDANCE_ANALYTICS_READ`) so a permission gap renders a sentence
instead of an error toast. Palette, radii and type come from the `st-` token
set in `style.css`; `test/attendanceCaptureSurfaces.test.js` pins that.

---

## 1. Attendance Import (upload) — `/app/attendance/imports`

Hero, upload card with drag-drop, an honest fleet strip, the batch-engine
rules and the history ledger; right rail = the required schema (rendered from
the server's own template text), provenance and the "what this screen will
not claim" note.

- **Upload → staging hand-off.** A `.csv` is accepted client-side (extension
  only — the parser is the server's), `POST /attendance/imports/preview` runs,
  and the screen navigates to the validation route with
  `{ fileName, fileSize, file, preview }` in router state. The `File` object
  travels because the raw CSV is **never persisted server-side**: there is
  nothing to re-fetch. That page therefore cannot be bookmarked, and says so.
- **History ledger** = `GET /attendance/imports` (sorted `createdAt: -1`,
  limit 100, **outcomes stripped by the API**). Opening a row calls
  `GET /attendance/imports/:id` and the drawer renders the stored outcomes and
  exports them as CSV. Search (label / fingerprint / months) and a status
  filter are client-side over those ≤100 rows, and the footer says how many
  rows the filter is speaking for.
- **Schema rail** renders `GET /attendance/imports/template.csv` as text
  (`templateText()` in `attendanceCaptureService.js`), so the header and
  sample row can never drift from what the server accepts. Constants shown
  are the real ones: 5 000 rows / 2 000 000 characters / 12-month past window
  / no future timestamps / `workMode` on `CLOCK_IN` only /
  `CLOCK_IN, BREAK_START, BREAK_END, CLOCK_OUT` / 120-character
  `sourceReference`.

| mock element | rendered | why |
| --- | --- | --- |
| `Parser Engine 2.4` badge | the real limits (5 000 rows, 2 MB, 12 months) | there is no versioned parser to name |
| `Device Sync Trace` strip | ACTIVE station count + newest `lastUsedAt`, linking to Kiosk Stations | that is the only device fact the platform holds |
| Device-model / firmware / MDM chips | one sentence: no heartbeat, firmware or MDM state is claimed | no endpoint publishes them |
| `XLSX / TSV` upload hints | `.csv` only, stated | the parser reads CSV |
| "Bulk import 10 000 rows" | `MAX_IMPORT_ROWS = 5 000`, stated | the engine's own cap |

## 2. Attendance Import Validation — `/app/attendance/imports/validation`

Staging review of the file in memory: KPI row (total parsed / ready to commit
/ conflicts / impacted staff), a provenance strip (fingerprint, timezone,
months), a valid-rows table and a rejected-rows panel grouped by the
validator's own messages, then the commit strip. After the commit the same
page becomes the batch result with a row-outcome table and CSV export.

- **Every figure is a preview field**: `rowCount`, `validCount`,
  `invalidCount`, `valid[]`, `invalid[]`, `months`, `timeZone`, `fingerprint`,
  `truncated`. "Ready to commit" excludes `alreadyRecorded` rows, because the
  server will SKIP them — the button must not promise writes it refuses.
- **Conflict handling** groups `invalid[]` by `message`. There is no invented
  severity or category taxonomy: the chips are literally the sentences the
  validator returned, each with operator advice (`guidanceFor`) kept visually
  separate from the fact.
- **Commit** loops `POST /attendance/imports/confirm` while the response says
  `status === 'CONFIRMING' && !done`, up to `MAX_CHUNK_CALLS = 400`, retrying
  transient failures (`no status`, `>= 500`) `MAX_TRANSIENT_RETRIES = 2`
  times. Progress is the response's `processedCount`/`totalCount`. The loop is
  resumable by design — a closed tab can be continued by pressing Confirm
  again, because each row carries its own idempotency key.
- **Outcome** toasts `success` for a clean run, `warning` when rows were
  rejected or the file was a stored replay (`duplicate: true`). A commit that
  wrote rows is never announced as an error.

| mock element | rendered | why |
| --- | --- | --- |
| "Send to exception" / "Ignore row" per card | the validator's reason + guidance + links to the exception centre and roster audit | **no endpoint accepts a per-row override**; a rejected row is simply not written |
| Conflict taxonomy (AI / sequence / duplicate buckets) | grouped by the server's literal message | categories must not drift from the validator |
| "Telemetry diff comparator" | fingerprint + resolved timezone + touched months | that is the identity of the file |
| `N rows queued for retry` | "will not be written", plus a downloadable rejection log | nothing is queued |

## 3. Kiosk Stations — `/app/attendance/kiosks`

Four counters, register form, one-time secret panel, provisioning steps, and
the fleet table (name + ID, bound location, secret version, last used,
status, rotate / deactivate).

- Station fields are exactly what the API returns: `id`, `name`,
  `locationId`/`locationName`, `status`, `secretVersion`, `lastUsedAt`,
  `createdAt`, `updatedAt`. `POST /attendance/kiosks` returns `{station,
  secret}` **once**; rotate returns a new secret and invalidates every live
  station session (the copy says so before you press it).
- Deactivate/reactivate is `PATCH` with `{status}`, which also reproduces the
  backend's "immediate" semantics: the station JWT stops working at its next
  call.

| mock element | rendered | why |
| --- | --- | --- |
| Device model, IP, auth latency, heartbeat, MDM health | `—` tile + footer line: "No heartbeat or firmware state exists — 'last used' is the newest recorded call" | the station document holds none of it |
| "Terminal status: online" | ACTIVE / INACTIVE (the stored status) | a device cannot be pinged |
| Remote wipe / camera / screenshot actions | absent; the card states there is no remote wipe | no such capability |
| Biometric / NFC / IP allow-list config | one paragraph: employee code + Kiosk PIN, always | that is the only identification the kiosk accepts |

## 4. QR Challenges — `/app/attendance/qr`

Issue form (location binding, station binding, fixed TTL, what the server
verifies), the live challenge with a real QR of `punchPath` and a countdown to
the server's `expiresAt`, a **Scan evidence** card fed by
`/attendance/analytics/overview` (`sources.counts.QR` ÷ `sources.total`), and
three honesty cards.

- `POST /attendance/qr/challenges` requires a `locationId` **or** `stationId`
  — the submit button is disabled until one exists, matching the backend's
  binding rule.
- The token exists only in the response and the QR pixels; the copy states
  that the server keeps the sha-256 hash and that nothing logs the token.

| mock element | rendered | why |
| --- | --- | --- |
| Live scan telemetry feed (employee, GPS delta, BSSID, verdict) | "Scan telemetry feed — Not exposed", linking to Team Timesheets for the punches people actually received | no feed endpoint; a punch is written straight into the ledger |
| Daily session summary | "Capture telemetry" aggregate for the current month, from analytics overview | the real aggregate exists, per-scan rows do not |
| Challenge audit log | link to `/app/security/audit-logs`, naming `ATTENDANCE_QR_CHALLENGE_CREATED` | challenge documents are TTL-reaped; the audit ledger is the durable record |
| Expiry picker (2 / 5 / 10 min) | `TTL_MINUTES = 5`, labelled "Fixed server-side" | the window is a server constant |
| `HMAC` / `Wi-Fi BSSID` / liveness chips | refused chip labels: "No HMAC chip", "No Wi-Fi BSSID check", "No liveness capture" | not implemented |
| "Expire immediately" | absent; the note explains that revocation is not an endpoint | five minutes is the bound |

---

## What remains unbacked (and is labelled as such)

Parser/engine version, device sync trace, per-device model/IP/latency/
heartbeat/MDM posture, QR scan telemetry, QR daily summary, QR challenge
history, per-cause conflict taxonomy, per-row import override ("send to
exception", "ignore row"), and any "online/offline" device state. Each is
either rendered as an explicit absence or replaced by a real, narrower fact
with its source named in the copy.

## Verification

`npm test` → **678 passing** (18 new pins in
`test/attendanceCaptureSurfaces.test.js`), `npm run build` green,
`npx eslint src` → **118 problems (103 errors, 15 warnings)**, below the
121-problem baseline. There is no browser in this environment, so the screens
were verified by lint, build and copy-level pins — not by pixel comparison.
