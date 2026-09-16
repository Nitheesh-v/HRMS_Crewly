# Phase 31.14 — Kiosk, QR & Attendance Import

One attendance engine, three new doors. Kiosk stations, QR challenges,
and CSV imports all converge on `recordEvent` + the 31.2 state machine
with server-decided `ingest { source, provenance }`. The backend decides
the source from the endpoint + auth context — `req.body.source` is never
read, and client-supplied source/provenance/timestamp overrides are
refused by validators.

## 1. What was reused (no new infrastructure)

| Need | Reused | Notes |
|---|---|---|
| Punch engine | `recordEvent` + 31.2 transitions | Extended with `ingest` param only; WEB path untouched |
| Policy truth | 31.1 `getCurrentPolicy` + `enabledWorkModes` | Timezone, work-mode allowlist |
| Day math | 31.13 `dayKeyInZone` | Zone-aware session days |
| Backdating rules | `recordEvent(date)` | Import rides existing past/future rules |
| JWT | `jsonwebtoken` + shared `JWT_SECRET` | Kiosk sessions, `typ:'kiosk'` |
| Rate limiting | `securityRateLimit` factory | In-memory, per-IP+station keys |
| Uploads | `multer` memory storage | New `csvUpload` (2MB, CSV-only) |
| Audit | `recordAudit` | Station/challenge/import lifecycle |
| CSV parsing | 29.5 `splitCsvLine` pattern | Quote-aware, `""` escapes |
| Permissions | registry + `SYSTEM_PERMISSION_VERSION` | One new perm → v34 |
| QR rendering | `qrcode.react` (only new dep) | HR issue screen only |

There is deliberately NO new queue, worker, cron, policy toggle, or
vendor SDK. DEVICE is a pinned contract + docs only.

## 2. Kiosk (§5–§11)

Trust model: the station secret authenticates the SHARED DEVICE; the
employee code identifies the employee PER PUNCH. Secrets are 256-bit,
shown once, stored sha256. Sessions are 8-hour kiosk JWTs
(`typ/kiosk`, `stationId`, `companyId`, `sv`).

- Stations: HR registers (`POST /attendance/kiosks`), renames,
  relocates, deactivates, rotates. Names unique per tenant.
- `kioskAuth` re-checks ACTIVE + secret version per request, so
  rotation/deactivation kill sessions immediately. It mounts ONLY on
  `/api/kiosk/*`; employee JWTs are rejected there (no `typ:'kiosk'`),
  and kiosk JWTs reach nowhere else (no other router mounts it).
- Screen: `POST /kiosk/identify` returns the masked name
  (`Asha V.`), live state, and backend-derived allowed actions —
  never timelines, durations, or full names.
- Punch: `POST /kiosk/punch` → `recordEvent` with
  `source: KIOSK`, `workMode: OFFICE` (server-decided — the station
  IS the workplace), server time, station+location provenance.
  No browser GPS is collected or claimed.
- Rate limits: 5/min per IP+station on `/session`; 120/min per
  IP+station on identify/punch (single-instance semantics — see §9).

Honest limitation (no PIN in 31.14): a code alone cannot strongly
prove identity. Forgery needs physical access to a trusted ACTIVE
station plus the victim's code, and every punch carries immutable
station provenance. QR (authenticated session + challenge) is the
strong alternative for high-assurance workplaces.

## 3. QR challenges (§12–§18)

A challenge binds an AUTHENTICATED employee session to a PLACE for
five minutes. Token → sha256 at rest; TTL index deletes expired docs;
single-use atomic claim (`usedAt: null` + `expiresAt > now`).

- HR issues (`POST /attendance/qr/challenges`) bound to a location
  and/or ACTIVE station; the token is returned ONCE and rendered as
  an SPA URL (`/app/attendance/qr/:token`).
- Employees resolve (`POST /attendance/qr/resolve`) for the confirm
  screen — read-only, never consumes — then redeem
  (`POST /attendance/qr/redeem`) to punch once through `recordEvent`
  (`source: QR`, `workMode: OFFICE`, challenge+place provenance).
- Identity ALWAYS comes from the employee JWT. Cross-tenant tokens
  resolve as 404; expired/used tokens are 410 Gone. GET never punches
  (no GET route exists for resolve/redeem; the token never appears in
  a server access log as a page view).
- Audits log the challenge id only — never the token.

## 4. CSV import (§19–§24)

UPLOAD → PARSE → PREVIEW → VALIDATE → CONFIRM → IMPORT.

- Upload is multipart (memory only, 2MB, CSV-only) — the raw file is
  never persisted; only the CRLF/BOM-stable sha256 fingerprint.
- Parse: 5,000-row cap, unbalanced-quote hardening, zoned-ISO
  timestamps only, blank workMode = OFFICE, in-file dupes rejected.
- Preview (`POST /attendance/imports/preview`) is zero-write:
  employee resolution (bulk, case-insensitive, ACTIVE-only),
  12-month past-only window, work-mode allowlist, finalized-month
  refusal per row, and the pure session planner.
- The session planner (`planImportSessions`) merges file rows with
  recorded events per employee and simulates the 31.2 machine:
  imports extend open sessions and fill empty days; recorded facts
  always win (exact twins skip as ALREADY_RECORDED; competing or
  conflicting rows reject with regularization guidance; the live
  open-session seed is authoritative for its day; rows predating the
  recorded session reject instead of inverting history).
- Confirm (`POST /attendance/imports/confirm`) re-uploads the file —
  the server re-validates from bytes and ingests VALID_ROWS_ONLY
  through `recordEvent` with the per-event clock injected and
  `requestId = import:<batchId>:<line>`. An event-exists backstop
  plus fingerprint-unique batches make retries and reordered files
  converge. All-invalid files stop before recording a batch.
- Finalized months refuse with reopen guidance
  (reopen → import → refinalize). No skip flag exists, by design.
- History (`GET /attendance/imports`, `GET /attendance/imports/:id`)
  shows bounded per-row outcomes; the template
  (`GET /attendance/imports/template.csv`) round-trips the parser.

## 5. DEVICE contract (§26–§29)

`normalizeDeviceEvent` pins the normalized shape a future adapter must
produce (`employeeExternalRef`, `timestamp`, `eventType`,
`sourceReference`, `deviceReference`) and rejects unknown/oversize
fields. There is NO ingest path, route, credential, or vendor code —
`DEVICE` in `validateIngestContext` is rejected. Zero vendor SDKs, zero
vendor names in the codebase.

## 6. API + permissions + UI

Permissions: one new — `ATTENDANCE_CAPTURE_MANAGE` (HR/Admin; registry
v34). QR redemption reuses `ATTENDANCE_READ_SELF` /
`ATTENDANCE_CREATE_SELF`; employees gain nothing else.

| Endpoint | Auth | Permission |
|---|---|---|
| `POST /attendance/kiosks` (+GET, PATCH, rotate) | employee JWT | CAPTURE_MANAGE |
| `POST /kiosk/session` | public + strict limit | — |
| `POST /kiosk/identify`, `POST /kiosk/punch` | kiosk JWT | — |
| `POST /attendance/qr/challenges` | employee JWT | CAPTURE_MANAGE |
| `POST /attendance/qr/resolve` | employee JWT | READ_SELF |
| `POST /attendance/qr/redeem` | employee JWT | CREATE_SELF |
| `POST /attendance/imports/preview\|confirm` | employee JWT (multipart) | CAPTURE_MANAGE |
| `GET /attendance/imports[/:id\|/template.csv]` | employee JWT | CAPTURE_MANAGE |

UI: Kiosk Stations, QR Challenges, QR Punch (`/app/attendance/qr/:token`),
Attendance Import — all under Time & Leave, permission-gated.

## 7. Out of scope (explicit)

No biometrics, NFC/RFID, presence tracking, continuous location, PIN
management, vendor SDKs, DEVICE write path, MANUAL source, payroll
math, new policy toggles, or 31.15/31.16/32 scaffolding.

## 8. Integrity notes

- `recordEvent` change surface: `ingest` param + validation, two
  create sites (source/provenance), serializer passthrough. The 31.2
  suite passes unchanged (47/47).
- Kiosk rate limits are in-memory: correct per instance; a
  multi-instance deployment needs a shared store ( Redis-backed
  limiter) — flagged, not built (no new infrastructure).
- Kiosk/QR punches hardcode OFFICE (workplace presence by
  definition); disabling OFFICE in policy blocks them with the
  standard policy error.
- Import backdating rides `recordEvent(date)` rules — including any
  lookback limits the engine enforces for WEB.
