# Phase 31.14 — Testing Checklist (localhost acceptance)

Backend suites: `attendanceKiosk` (37), `attendanceQr` (15),
`attendanceImport` (19) — 71 hermetic tests. Neighbors re-verified
via `npm run test:phase31`. Frontend `npm run build` green.

## Kiosk

- [ ] HR registers a station → secret shown ONCE with copy; refresh →
      secret gone (never retrievable).
- [ ] Station list shows location binding, status, last-used.
- [ ] Rotate → new secret shown once; old kiosk session stops working.
- [ ] Deactivate → kiosk sign-in fails exactly like a wrong secret.
- [ ] `POST /kiosk/session` with wrong secret ×6 in a minute → 429.
- [ ] Identify with valid code + PIN → masked name (`Asha V.`), allowed actions only.
- [ ] Identify with unknown code / wrong PIN / unset PIN → ONE generic 401 (no oracle).
- [ ] Punch CLOCK_IN → event `source: KIOSK`, workMode OFFICE, station provenance.
- [ ] Punch in a FINALIZED month → 409 with reopen guidance.
- [ ] Employee JWT on `/kiosk/*` → 401; kiosk JWT on `/attendance/*` → 401/403.

## Kiosk completion (direct terminal)

- [ ] My Attendance → set Kiosk PIN → confirm mismatch + short PIN refused locally.
- [ ] Change PIN needs the current PIN; wrong current → 401.
- [ ] Open `/kiosk` → no sidebar/nav; provision with station ID + secret.
- [ ] Code + PIN → first-name greeting + backend-derived actions only.
- [ ] Clock In → KIOSK event; screen auto-clears in ~8s.
- [ ] Wrong PIN ×11 in 10 min for one code → 429; other codes still work.
- [ ] Company B code on company A terminal → generic 401.
- [ ] Verified screen idle 60s → employee wiped; Done/Clear wipes instantly.
- [ ] Rotate secret → terminal drops to provisioning on next action.
- [ ] Deactivate → terminal stops; reactivate + reprovision works.
- [ ] `POST /kiosk/punch` with `employeeCode` instead of context → 400 refused.
- [ ] Analytics Capture Source: KIOSK +1, QR unchanged; QR punch still `source: QR`.

## QR

- [ ] HR issues a challenge → QR renders, 5:00 countdown ticks.
- [ ] Employee scans → confirm screen shows place + allowed actions.
- [ ] Confirm → punch recorded once; rescan/retry → 410 Gone.
- [ ] After 5 minutes → resolve returns 410; issue a fresh code works.
- [ ] Challenge for company A redeemed with company B session → 404.
- [ ] No GET route punches: `GET /attendance/qr/*` → 404/405.
- [ ] Audits contain challenge ids, never tokens.

## Import

- [ ] Download template → fill 2 employees × IN/OUT → preview: 4 valid, 0 invalid.
- [ ] Preview shows months + session days; NOTHING is written (no batch in history).
- [ ] Confirm → 4 IMPORTED with per-row outcomes; events carry IMPORT provenance.
- [ ] Re-upload same file (even CRLF) → duplicate replay, no new events.
- [ ] Unknown code / bad mode / zoneless time / dupe row → invalid with clear messages.
- [ ] Orphan OUT → NO_OPEN_SESSION guidance; competing IN on a recorded day → DAY_CONFLICT.
- [ ] Rows in a FINALIZED month → refused with reopen guidance; reopen → import → refinalize works.
- [ ] All-invalid file → confirm refused, no batch recorded.
- [ ] 5,001-row file → truncation notice; only first 5,000 read.
- [ ] History lists batches; detail shows per-row IMPORTED/SKIPPED/REJECTED.

## Cross-cutting

- [ ] `req.body.source/provenance/ingest` on kiosk/QR endpoints → 400 refused.
- [ ] Manager/employee without CAPTURE_MANAGE → no nav items, API 403s.
- [ ] Permission version reads 34; HR template holds ATTENDANCE_CAPTURE_MANAGE.
- [ ] Full `npm test` green; no 31.1–31.13 regressions.
