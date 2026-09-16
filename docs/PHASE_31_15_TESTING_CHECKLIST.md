# Phase 31.15 — Localhost Testing Checklist

Backend: `npm run test:all` (1471 tests; the 11 no-Mongo baseline
file-failures — analytics, bgv×6, emailDelivery, fnf, payslip,
phase30Security — are pre-existing, not regressions).
Frontend: `npx vite build` must pass with no new dependencies.

## API (as HR manager + as manager + as employee)

1. `GET /analytics/overview?month=<open>` → `provisional: true`,
   per-month `provenance` with `finalized: false`.
2. Finalize a month (31.11 flow), re-request → `finalized: true`,
   `provenance[].version` = snapshot version; KPIs match the
   finalized snapshot exactly.
3. Reopen the month → overview flips back to LIVE.
4. `GET /analytics/trends?from&to` spanning 2 months → two buckets
   with per-month status; > 12 months → 400.
5. `GET /analytics/employees?sort=-attendanceRate` → desc order;
   `sort=hacker` → 400; pagination `page/pageSize` works.
6. `GET /analytics/mine?month=` as employee (READ_SELF only) → own
   totals only; as admin → still self-only.
7. `GET /analytics/payroll-reconciliation?month=<unsent>` → all
   NOT_FINALIZED or NOT_SYNCED; send to payroll → MATCH rows.
8. Tamper a stored `auto` block in DB → that row becomes MISMATCH
   with field-level diffs; HR `manual` edits never affect verdicts.
9. `GET /analytics/export?reportType=employees&format=csv` →
   BOM-headed CSV download; `format=xlsx` → valid workbook.
10. Export writes ONE audit row with metadata only (no names).
11. Manager sees TEAM scope only; `employeeId` outside subtree → 403.
12. `?companyId=` override attempt → 400.
13. Punch in/out → overview numbers move on next load (bump works);
    approve a leave/regularization/OT → same.

## UI (`/app/attendance/analytics`)

14. Sidebar shows "Attendance Analytics" for analytics/self holders
    only; direct URL without permission → friendly no-access card.
15. Overview: provenance banner (FINALIZED v / LIVE), KPI cards,
    day outcomes, modes, sources, OT/regs, locations, exports.
16. Trends: SVG bars + table; finalized vs live coloring + labels.
17. Employees: sortable headers (asc → desc → reset), pagination.
18. My summary as plain employee: own KPIs only, other tabs hidden.
19. Reconciliation: status chips, version columns, diff lists.
20. Filters (month/preset/department/shift/location/mode) narrow
    results; Clear resets.
