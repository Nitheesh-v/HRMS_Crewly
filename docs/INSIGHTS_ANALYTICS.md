# Insights Analytics Backend (Analytics Hub + Report Builder)

Fixes localhost "Route not found" on `/app/analytics` and `/app/reports`.
The frontend pages existed on `main`, but the backend was never built
(Report Builder's controller existed yet was mounted nowhere). This adds
the missing read-only backend; no frontend file was changed.

## Endpoints

Analytics Hub (`insightsAnalyticsRoutes.js`, all GET, `?preset=` validated):

- `/api/analytics/overview` — headcount KPIs, 12-month trend, by-dept/designation
- `/api/analytics/attendance` — status counts, absence estimate, daily trend
- `/api/analytics/leaves` — request counts, days-by-type, monthly trend, top users
- `/api/analytics/payroll` — HR only; totals, 6-month net trend, cost-by-department
- `/api/analytics/work` — tasks/projects/expenses/performance
- `/api/analytics/recruitment` — HR only; jobs + candidate funnel + source split
- `/api/analytics/my` — any member; own attendance/tasks/leaves, shift, holidays
- `/api/saas/overview` — SUPER_ADMIN only; companies/users/MRR platform stats

Report Builder (`reportBuilderRoutes.js`, previously dead controller):

- `GET /api/report-builder/meta` — whitelisted modules + fields (payroll hidden from non-HR)
- `POST /api/report-builder/run` — paged rows (capped 5000, audited `REPORT_RUN`)
- `POST /api/report-builder/export?format=csv|xls` — file download (audited `REPORT_EXPORT`)

## Scope & guards

- Role-based `authorize()` (systemRoutes precedent), deliberately NOT
  DB-backed `requirePermission`, so the hub works on databases where the
  permission seed never ran.
- COMPANY_ADMIN/HR_MANAGER → whole company; MANAGER/TEAM_LEAD → self +
  org subtree (`getSubtreeIds`); payroll/recruitment tabs + payroll report
  module → HR only; `/my` → requester only; `/saas/overview` → SUPER_ADMIN.
- Tenant authority is `req.companyId`; `companyId` query/body overrides refused.
- Every metric is wrapped in `core.safe()`: one failing aggregation shows
  "—", never a broken page. No new collections, queues, or caches.

## Data notes (read-only, no business logic duplicated)

- Absence = working days (Sundays excluded) × scoped active headcount −
  marked records; Attendance stores no ABSENT rows.
- Payroll prefers Payslip snapshots, falls back to legacy Payroll rows
  when a company has no payslips; the two sources are never mixed.
- `mrrGrowthPct` is 0 (no revenue history exists); `goalCompletion` is 0
  (no goals model exists); if the Candidate model ever goes missing, the
  recruitment tab still returns jobs (frontend handles the gap).

## Tests

`npm run test:insights` (9 hermetic tests in `test/insightsAnalytics.test.js`):
preset/range toolbox, route-registration lock for all 11 endpoints,
registry + model-import wiring, validator accept/reject. Full `test:all`
shows zero regressions (only the pre-existing no-Mongo baseline fails).
