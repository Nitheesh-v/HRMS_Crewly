# PRD → implementation coverage

Audit of the supplied PRD v1.0.0 against the tree (branch `arena/78ab7d33-hrms-crewly`).
Every row was checked in the source, not inferred from filenames. Line counts are
the page file at audit time.

Legend — **Shell**: `st-` = drawn to the Stitch exports, `crewly` = the app's own
palette, needs the re-fit. **Data**: what the page can actually read today.

---

## 1. Organization & Core People Operations

| PRD screen | route | file | lines | shell | notes |
| --- | --- | --- | --- | --- | --- |
| Org structure | `/app/org-chart` | `org-chart/OrgChartPage.jsx` | 634 | crewly | Exists with hierarchy + grid. Node metadata (EMP id, designation, report accordion) present. |
| User directory | `/app/users` | `users/UsersPage.jsx` | 451 | crewly | Exists. No KPI roster cards (Total / Active / Inactive / MFA) yet — that block is PRD-only so far. |
| Employee lifecycle | `/app/lifecycle` | `lifecycle/LifecyclePage.jsx` | 748 | crewly | 4-stage tracker + master-detail exist. |
| Employee files | `/app/employee-files` | `documents/EmployeeFilesPage.jsx` | 723 | crewly | Cabinet exists. Onboarding-readiness gauge not built. |
| Asset inventory | `/app/assets` | `assets/AssetsPage.jsx` | 887 | crewly | Inventory + provisioning exist. The "In My Hands" passport hero is not built. |
| Profile change requests | `/app/profile/change-requests` | `profile/ProfileChangeRequestsPage.jsx` | — | crewly | Queue exists; side-by-side diff is the missing centrepiece. |

## 2. Time, Attendance & Scheduling

| PRD screen | route | file | lines | shell | notes |
| --- | --- | --- | --- | --- | --- |
| Punch console | `/app/attendance` | `attendance/AttendancePage.jsx` | 1078 | crewly | Live clock, punch controls, session checkpoints all exist. |
| Attendance reports | `/app/attendance/report` | `attendance/AttendanceReportPage.jsx` | 1215 | crewly | Audit matrix + heatmap live in `AttendanceAnalyticsPage.jsx`. |
| Shifts & rosters | `/app/shifts` | `schedule/ShiftsPage.jsx` | — | **st-** | Rebuilt to `image-2.png`. |
| Work schedules | `/app/schedules` | `schedule/SchedulesPage.jsx` | — | **st-** | Rebuilt to `image-3.png`. |
| Holiday calendar | `/app/holidays` | `schedule/HolidaysPage.jsx` | — | **st-** | Rebuilt to `image-4.png`. |
| My leaves | `/app/leaves` | `leaves/LeavesPage.jsx` | — | **st-** | Rebuilt to `image-5.png`. |
| Leave approvals | `/app/leaves/approvals` | `leaves/LeaveApprovalsPage.jsx` | 829 | crewly | **No mock in the supplied export set** — still the earlier build. |

## 3. Talent & Governance

| PRD screen | route | file | lines | shell | notes |
| --- | --- | --- | --- | --- | --- |
| Performance reviews | `/app/performance` | `performance/PerformancePage.jsx` | 1414 | crewly | Cycles, methodologies and milestones exist. |
| Compliance / biometric policy | `/app/attendance/policy` | `attendance/AttendancePolicyPage.jsx` | — | crewly | Policy editor exists. |
| Kiosk security | `/app/attendance/kiosks` | `attendance/KioskStationsPage.jsx` | — | crewly | Station secrets + PIN path exist. |

**No PRD screen is missing.** All twelve routes resolve. The gap is not coverage,
it is the shell: nine of the twelve still render on the Crewly palette, and the
per-screen blocks the PRD names (KPI cards, diff view, readiness gauge) are only
built where a mock specified them.

---

## 4. Non-functional claims, checked

| PRD §5 claim | state in the code |
| --- | --- |
| RBAC across four roles | **Real.** `Backend/src/utils/permissionRegistry.js` is the single registry; `RequireRole` / `RequirePermission` gate the routes. |
| Audit trail immutability | **Real for the audited paths.** `auditRoutes.js` + `AuditLogsPage.jsx`; attendance and approval mutations write rows. |
| Biometric + geofence validation before a punch | **Partly, and not as described.** Kiosk punches carry a *station* identity with an optional `location` binding, and `AttendanceKiosk.js` states in a comment that this "is NOT browser-GPS geofence evidence (never claim otherwise)". There is no browser-GPS check. Pages must not advertise one. |
| Calendar feeds (`.ics`, Google/Apple/Outlook) | **Not built.** No feed route, no `.ics` generator. The Holiday Calendar renders the block disabled with that reason. |
| Slack / Teams notification bot (phase 3) | **Not built.** Notifications are in-app only. |
| Mobile PWA + kiosk badge scans (phase 4) | **Not built.** |

## 5. What the PRD does *not* settle

- **Canvas colour.** PRD §4.1 says `#FCF9EA`; the mocks measure `#f3fcf1`. See
  `docs/STITCH_SURFACES.md` §2 — one line flips it.
- **Half-days.** §3.2F asks for Full day / First half / Second half radio toggles.
  `Leave` has no half-day column and `applyLeave` rejects anything that is not a
  whole working-day range, so the chips are drawn inert with a reason attached.
- **Encashment rules** on the quota cards have no backing field; the cards state
  what is configured instead.
