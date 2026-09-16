# Phase 31.15 — Attendance Reports & Analytics

Read-only reporting over the resolved-daily layer (§31.10) and finalized
snapshots (§31.11). Six GET endpoints, one frontend surface
(`/app/attendance/analytics`, five tabs), one new permission
(`ATTENDANCE_ANALYTICS_READ`), zero new infrastructure.

## 1. What was reused (no new infrastructure)

- Day facts: 31.10 `deriveMonths` for open months, 31.11 `isCurrent`
  snapshots for finalized months. No v1+v2 double-count: snapshot
  reads pin `isCurrent: true` (asserted in tests).
- Payroll reconciliation compares via the REAL 31.11
  `buildAutoFromSnapshot(snapshot, otPolicy: null)` — never a copy.
- FY preset reuses `payroll/analyticsRules.js` (`financialYearMonths`,
  April anchor); XLSX reuses the dep-free payroll writer; CSV cells
  ride the guarded 31.10 `csvCell` (formula-injection safe).
- Cache rides the 28.7 `getOrSetCache` + `analyticsCacheInvalidation`
  generation pattern (new `attendance:analytics` namespace, TTL env
  `ATTENDANCE_ANALYTICS_CACHE_TTL_SECONDS`, default 60, 0 = bypass).
- Trends render as dependency-free inline SVG (no chart library —
  none exists in the repo, and §30 forbids new installs).

## 2. Source of truth per month (§4)

`loadMonthProvenance` labels every covered month: `FINALIZED`
(snapshot version = payroll-grade truth) or `OPEN` (live
resolved-daily projection). Mixed ranges merge both; the UI shows a
per-month provenance banner above every tab. Bare calls default to
the current month.

## 3. KPI formulas (§6, documented in code)

- `attendanceRate = worked units / scheduled units` (`{ratio, pct}`)
- `absenceRate = absent units / scheduled units`
- Leave shrinks the scheduled denominator (`1 − leave`); holidays /
  weekly-off / FUTURE days never enter denominators. Zero scheduled
  days yields `null` (never 0%).
- `effective worked = Σ workedMinutes` (session-derived; no
  last−first derivation over breaks — breaks stay excluded).
- Outcomes and work modes are orthogonal: a WFH present day
  increments BOTH the present count and the WFH count.

## 4. Endpoints, scope, permissions (§9)

| GET | Permission | Notes |
|---|---|---|
| `/analytics/overview` | ANALYTICS_READ | KPIs + outcomes + modes + sources + OT/regs + locations |
| `/analytics/trends` | ANALYTICS_READ | Monthly buckets, ≤ 12 months |
| `/analytics/employees` | ANALYTICS_READ | Paginated, allowlisted `sort` (`-field` = desc) |
| `/analytics/mine` | READ_SELF | Self-only; no analytics permission needed |
| `/analytics/payroll-reconciliation` | ANALYTICS_READ | MATCH/MISMATCH/NOT_SYNCED/NOT_FINALIZED |
| `/analytics/export` | ANALYTICS_READ | `reportType` × `csv/xlsx`, metadata-only audit |

Scope mirrors 31.10: COMPANY for admin/HR-manager, else TEAM
(subtree + self). Department/employee filters intersect — they never
expand. Employees outside scope → 403 (`mine` is identity-bound).

## 5. Cache invalidation (§19)

Fire-and-forget generation bumps (never awaited, never fail the
workflow) on: `recordEvent` create (both sites), regularization
review decision, OT approve + reject, finalization finalize / send /
reopen, leave approve / reject / cancel.

## 6. Frontend (§24–§27)

`AttendanceAnalyticsPage.jsx`: Overview / Trends / Employees / My
summary / Payroll reconciliation tabs, month + preset (single /
quarter / FY) + department / shift / location / work-mode filters,
CSV/XLSX export buttons. Route is permission-gated inside the page
(managers + self-service included); sidebar entry is permission-
driven. No rankings, no scores, no predictions — the employee table
default-orders by name. `topLate/topEarly`-style leaderboards are
deliberately NOT rendered (§27).

## 7. Out of scope (explicit)

Leaderboards/scores/predictions, Teams presence, BullMQ analytics
queue, payroll math duplication, money anywhere, 31.16/32 work.

## 8. Integrity notes

- Recon is read-only: zero mutations; HR-owned payroll entries are
  never compared (only the `auto` block vs the rebuilt expectation).
- Exports audit one metadata row (`reportType/format/scope/rows`) —
  never row contents. Audit loss never fails the download.
- Tenant authority stays `req.companyId`; a client `companyId`
  query param is refused outright.
