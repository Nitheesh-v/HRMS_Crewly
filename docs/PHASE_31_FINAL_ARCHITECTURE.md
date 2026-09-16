# Phase 31 — Final Architecture: Advanced Attendance & Workforce Time

Close-out document (31.16). Describes ACTUAL repository code at
Phase 31 close. Programme index: `PHASE_31_ADVANCED_ATTENDANCE.md`;
per-phase docs: `PHASE_31_1_*` … `PHASE_31_15_*`.

## 1. Executive Summary

Phase 31 layers Advanced Attendance on top of Crewly's classic
Punch/Shift/Leave/Payroll foundations without replacing them. One
immutable event engine (`AttendanceEvent`) ingests WEB/KIOSK/QR/
IMPORT punches; a regularization overlay holds approved corrections;
policy + schedule + leave/holiday resolution produces effective
attendance; timesheets, presence, operations and analytics read it;
monthly finalization freezes versioned snapshots and syncs
attendance-owned facts into `EmployeeMonthlyInput.auto` for the
29.x payroll engine. 685 hermetic Phase-31 tests, RBAC v35, zero new
infrastructure beyond one justified frontend QR-rendering package.

## 2. Phase 31.1–31.16 Map

| Phase | Delivered |
|---|---|
| 31.1 | Policy engine (versioned policy, timezone, breaks, modes) |
| 31.2 | Advanced punching: `recordEvent` state machine, live states |
| 31.3 | Office locations + CLOCK_IN-only OFFICE geofence |
| 31.4 | Work-mode requests (authorization, not attendance) |
| 31.5 | Regularization overlay + exception center |
| 31.6 | Shift/roster intelligence, overnight anchoring, snapshots |
| 31.7 | Leave/holiday/weekly-off reconciliation engine |
| 31.8 | Overtime (TIME-only) + comp-off (approved entitlements) |
| 31.9 | Who's Working live presence board (batched) |
| 31.10 | Calendar/timesheets + scoped CSV export |
| 31.11 | Finalization lifecycle + versioned snapshots + payroll sync |
| 31.12 | HR operations dashboard (read-only) |
| 31.13 | Reminders (observe, never act) on the established queue |
| 31.14 | Kiosk sessions, QR challenges, CSV import — one engine |
| 31.15 | Reports & analytics (finalized-vs-live provenance) |
| 31.16 | Close-out: audit, 2 defects fixed, adversarial tests, this doc |

## 3. Entity Map

`AttendancePolicy` (versioned, company) · `AttendanceEvent`
(immutable facts) · `Attendance` (legacy daily projection, kept
compatible) · `AttendanceLocation` (office geofence) ·
`AttendanceWorkModeRequest` · `AttendanceRegularization` ·
`Shift` / `ShiftAssignment` / `WorkSchedule` (+ resolved schedule
snapshots) · `AttendanceOvertimeRequest` · `AttendancePeriod`
(month lifecycle) · `AttendancePayrollSnapshot` (versioned, one
current) · `AttendanceKiosk` (stations, secret hash only) ·
`AttendanceQrChallenge` (token hash only, TTL) ·
`AttendanceImport` (batches, fingerprint idempotency).

## 4. Attendance Event Architecture

Append-only `AttendanceEvent(companyId, user, date, seq, type, at,
source, provenance)` with unique `(companyId, user, date, seq)` and
sparse-unique `(companyId, user, requestId)` indexes. Zero update/
delete paths exist in services or controllers (31.16 verified).
Effective attendance = raw events + approved regularization
overlay, resolved by policy/schedule/leave rules. Replay via
`requestId` returns the stored event instead of duplicating.

## 5. Policy Engine

Versioned `AttendancePolicy` per company: timezone (business-date
authority), break treatment, enabled work modes, geofence
requirement, notification toggles. Draft → activate lifecycle;
HR reads/manages, admin activates. All day boundaries resolve in
policy timezone; no server-local date logic in attendance paths.

## 6. Work Modes

`OFFICE / WFH / FIELD / CLIENT_SITE / BUSINESS_TRAVEL` are
orthogonal to outcomes: approving WFH authorizes clock-in context,
it never fabricates presence. Disabled policy modes are
backend-rejected; non-office modes never become geofence bypasses.

## 7. Location/Geofence

CLOCK_IN-only, OFFICE-only, policy-gated. The backend computes
haversine distance server-side; client verdicts (`insideGeofence`,
`distanceMeters`, `verified`, …) are refused outright by the
validator, never trusted, never stored. Tenant-owned, active-only
locations; failed evidence stays failed and regularization cannot
rewrite it to VERIFIED.

## 8. Regularization

Overlay-only: original events immutable; proposed → approved/
rejected correction with reviewer, reason, audit. PENDING/REJECTED
never affects effective attendance; approval applies once (CAS +
`appliedAt`, retry-safe completion); double-approve is rejected by
the state machine, never double-applied.

## 9. Shift/Overnight

Dated shift resolution with immutable resolved-schedule context:
changing today's shift never rewrites history. Overnight shifts
(22:00→06:00) anchor to the clock-in business date as ONE session
across midnight (tested at event, timesheet and schedule level).

## 10. Leave/Holiday/Weekly-Off Reconciliation

Deterministic daily resolution: approved full leave + no punch →
Leave; pending leave ≠ approved; half-day fractions; punch +
approved leave → visible conflict (neither source deleted); weekly
off / holiday ≠ absent; work on non-working days retained. Never
mutates Leave.

## 11. OT/Comp-Off

Recorded ≠ eligible ≠ requested ≠ approved ≠ payroll-OT. Only
APPROVED time minutes reach payroll (`auto.otMinutes`); no money is
computed in attendance (verified: only time variables and comments
match money strings). Comp-off requires human approval, credits
idempotently (no double credit), creates no wallet, no auto-leave.

## 12. Who's Working

Batched live board (`$in` queries over scope, no N+1): WORKING /
ON_BREAK / COMPLETED / NOT_IN / leave / holiday states. COMPANY
scope for admin/HR, TEAM (subtree+self) otherwise. No map, no
tracking, no scores.

## 13. Calendar/Timesheets

`deriveMonths` resolves every day to recorded-vs-effective detail
(my / team / employee views + day drawer). Scoped CSV export with
guarded cells. Team views enforce org scope; employee filters
intersect, never expand.

## 14. Finalization/Payroll Boundary

OPEN → FINALIZING → FINALIZED → SENT_TO_PAYROLL, with gated
REOPENED. Readiness is backend-derived; blockers enforced
server-side; no force/skip; snapshots immutable + versioned with
one current; concurrency-safe claims; retry-safe; truthful sync
reporting; reopen requires a reason + passes payroll gates (paid
salaries / released payslips block reopen — service-tested).
Sync writes ONLY `EmployeeMonthlyInput.auto` (+ period link);
HR `entries` are never touched.

## 15. Operations

Read-only HR command center: today's workforce KPIs, live
attendance, mode/department/shift/location breakdowns,
needs-attention queue linking to owner workflows. Nothing mutates.

## 16. Notifications/Scheduled Jobs

Reminders reuse the established scheduler (`attendance-reminder`
jobs + `email-attendance-reminder` email jobs — no new queue).
References-only payloads (ids/date/type/anchor, zero PII/coords/
salary); the worker re-fetches from Mongo, revalidates companyId,
and SKIPs stale jobs. Attendance survives Redis outage; reminders
never create attendance; unknown jobs fail safely.

## 17. Kiosk/QR/Import

One `recordEvent` engine, server-decided ingest. Kiosk: tenant-
scoped stations, secret hash + `timingSafeEqual`, generic errors
(no oracle), rate-limited public session, masked names, revoked/
disabled stations cannot punch, employee-code resolution is
tenant-scoped. QR: crypto-random tokens, sha256-hash-only
persistence (`select:false`), purpose isolation, short expiry + TTL
reaping, atomic single-use claim (replay loses), POST-only redeem
(GET never clocks in), no raw tokens in logs/audit/queues, redeem
is identity-bound (cannot punch as someone else). Import: 5000-row
/ 2M-char caps, real CSV parsing, preview mutates nothing, confirm
needs CAPTURE_MANAGE, fingerprint idempotency (duplicate confirm
replays the stored summary), finalized months refused, no payroll
writes, summary audit only.

## 18. Analytics/Reports

Read-only KPIs/trends/employee table/my-summary/payroll-recon over
resolved-daily (open) or CURRENT-snapshot (finalized) days —
`isCurrent` pinned, current version only, never double-counted.
Documented formulas; null (not 0%) on empty denominators;
bounded ranges (trends ≤ 12 months); paginated, allowlisted sorts
(default: unranked name order); COMPANY/TEAM/SELF scope; no
scores, leaderboards, or predictions. Exports are CSV/XLSX with
formula-injection defense, safe filenames, metadata-only audit,
and no GPS/salary/secrets/narrative reasons.

## 19. Tenant/RBAC Architecture

Tenant authority ONLY `req.companyId`; client companyId refused.
All review/mutation reads scope `{_id, companyId}` (login-style
credential checks excepted: kiosk session derives tenant from the
verified station). 26 attendance permissions, RBAC v35; HR_MANAGER
holds the full set, MANAGER holds scoped review + team reads
(analytics/operations are default-deny, admin-grantable), employees
hold self-service only. HR_HEAD/HR_EXECUTIVE remain deferred.
Migrations are atomic `$addToSet`, no save loops.

## 20. Privacy/Security

No continuous/background GPS (one-shot `getCurrentPosition` at
punch only, documented); no employee coordinates in logs, queues,
exports, or storage; no WFH home tracking; no Who's-Working map;
no computer-activity monitoring of any kind (verified by
repository string search); no `dangerouslySetInnerHTML` or web
storage in attendance UI; secrets scan clean; QR/kiosk secrets are
hash-only with no oracles.

## 21. Redis/BullMQ Usage

Redis: 28.7 cache (`attendance-policy`, `attendance:analytics`
namespaces, generation invalidation, TTL envs, fail-open, Mongo
truth, auth-before-cache, tenant-scoped keys) + the established
job scheduler. No FLUSH*, no KEYS scans, no `rejectUnauthorized`
weakening, no attendance-owned queue, no coord/PII/salary payloads.

## 22. Payroll Integration Diagram

```
                    ┌─────────────────┐
WEB ───────────────→│                 │
KIOSK ─────────────→│ AttendanceEvent │  (immutable facts)
QR ─────────────────→│                 │
IMPORT ─────────────→│                 │
                    └────────┬────────┘
                             ▼
              Regularization Overlay (approved only)
                             │
Shift/Schedule ───→ Effective Attendance (policy TZ)
Policy ───────────→          │
Leave/Holiday/WO ─→          │
                             ▼
                    Daily Attendance
                             │
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
      Live Presence    Timesheets      Operations
     (+ Reminders observe only, Analytics read-only)
                             │
                             ▼
                  Monthly Finalization
                   (blockers enforced)
                             │
                             ▼
            Immutable Attendance Snapshot (vN, current)
                             │
                             ▼
              EmployeeMonthlyInput.auto (+source/version)
               (HR entries untouched)
                             │
                             ▼
                  Phase 29.6 Payroll Engine
                             │
                             ▼
                 Immutable PayrollResult
              (attendance NEVER rewrites)
```

## 23. API Inventory

Mounted under `/api`: `attendance/policy/*`,
`attendance/locations/*`, `attendance/work-mode-requests/*`,
`attendance/regularizations/*`, `attendance/overtime/*`,
`attendance/*` (self punch, events, today, presence, operations,
timesheets, finalization, kiosks, qr, imports, analytics), and
public rate-limited `/kiosk/*` (session, identify, punch).
Ordering: static routes precede `:params` in every router;
middleware order is protect → tenant → subscription → permission →
validator → controller; scope enforced in services.

## 24. Permission Inventory (v35)

`ATTENDANCE_READ / READ_SELF / CREATE_SELF`;
`POLICY_{READ,MANAGE,ACTIVATE}`; `LOCATION_{READ,MANAGE}`;
`WORK_MODE_{REQUEST,REVIEW}`; `REGULARIZATION_{REQUEST,REVIEW}`;
`OVERTIME_{REQUEST,REVIEW}`; `FINALIZATION_{READ,MANAGE,REOPEN}`;
`OPERATIONS_READ`; `CAPTURE_MANAGE`; `ANALYTICS_READ`.
Finalization MANAGE/REOPEN are company-level (admin + HR manager);
review permissions are subtree-scoped in services, never
company-wide by possession alone.

## 25. Cache Inventory

`attendance-policy` (policy reads) and `attendance:analytics`
(KPI reads) via 28.7 `getOrSetCache`; per-company generation keys
with fire-and-forget bumps on every attendance-affecting write
(events, regularization, OT, finalization, leave verdicts).
TTL envs with 0 = bypass; Redis outage bypasses to Mongo.

## 26. Test Inventory

19 hermetic suites, `npm run test:phase31` (685 tests, all green):
policy, events, locations, work-mode, regularization, schedule,
reconciliation, overtime, presence, timesheet, finalization,
operations, reminders, kiosk, qr, import, analytics-rules,
analytics-service, closeout (31.16 adversarial). Full
`npm run test:all`: 1478 total; the only failures are the 11
pre-existing no-Mongo sandbox baseline files (analytics, bgv×6,
emailDelivery, fnf, payslip, phase30Security) — zero Phase-31
regressions.

## 27. Production Checklist

- Mongo + Redis healthy; envs set (`MONGO_URI`, JWT, TTLs).
- RBAC migration to v35 applied (`ensureCompanyRoles`).
- Indexes built (unique event/snapshot/period/challenge/import
  constraints — see §3 models; no destructive dedupe without the
  §51 preview procedure).
- Public `/kiosk/*` behind rate limits + TLS; QR TTL reaping
  active (Mongo TTL monitor on).
- No attendance env leaks into client bundles; secrets in vault.

## 28. Operational Runbook

- Punch/source incident → inspect `AttendanceEvent` (immutable
  ground truth); correct via regularization, never by editing.
- Month close → validate → preview → finalize → send; on sync
  failure read `lastSyncError`, fix cause, re-send (idempotent).
- Paid month is immutable from attendance: reopen is refused
  while salaries are paid or payslips released.
- Reminder storms → check scheduler + policy toggles; jobs are
  references-only and safe to drain (stale SKIP on re-fetch).
- Kiosk compromise → deactivate/rotate the station (revocation
  is immediate: session validation checks status + secretVersion).
- Analytics looks stale → check Redis + generation bumps (writes
  bump fire-and-forget; TTL bounds staleness regardless).

## 29. Known Limitations

- Geolocation is not spoof-proof (client positions are
  unverifiable assertions; the server only measures them).
- QR/kiosk prove token/secret possession, not biometric identity.
- Queues/jobs are at-least-once with idempotent handlers — never
  exactly-once (no such claim is made anywhere).
- Legacy pre-31 history keeps its original meaning; no snapshots
  are fabricated for it (some old rows lack provenance fields).
- The deferred standalone payroll error observed in 31.7 testing
  remains deferred per developer direction (out of Phase 31).

## 30. NOT IMPLEMENTED / FUTURE

Vendor-specific biometric devices; fingerprint biometrics;
face-recognition attendance; continuous GPS; employee
surveillance of any kind; Teams-like AVAILABLE/AWAY app activity;
click/mouse/keyboard presence; payroll arrears from historical
attendance corrections; automatic disciplinary action; predictive
absence/productivity scoring; Teams-like Presence & Availability
(future enhancement — no code or scaffolding in repo); Phase 32
(does not exist).

## 31. Final Memory Capsule Section

Phase 31 ran as sixteen gated localhost-first increments
(31.1–31.16), each ending STOP until explicit developer
acceptance. Binding laws that survived all sixteen: attendance
records TIME, payroll calculates MONEY; tenant = `req.companyId`;
raw events immutable, corrections overlay-only; leave/holiday
never silently deleted; geofence server-measured, client
untrusted; reminders observe, never act; analytics read-only with
finalized-vs-live provenance; no surveillance, no scores, no
predictions; hermetic tests preferred; additive evolution only.
The payroll error seen in 31.7 localhost testing stays deferred
until after Phase 31 by explicit developer order. HR_HEAD and
HR_EXECUTIVE stay deferred. Future presence work, if ever
authorized, starts from a blank slate — nothing in 31.x presumes it.
