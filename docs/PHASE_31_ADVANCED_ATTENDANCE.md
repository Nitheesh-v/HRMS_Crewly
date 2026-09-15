# Phase 31 — Advanced Attendance (programme index)

Crewly's attendance evolves additively: the classic Punch In / Punch Out,
Shift, Work Schedule, Leave, Holiday and Payroll 29.x foundations stay
intact while new capabilities layer on top. Each 31.x phase ships on
localhost, stops, and waits for explicit developer acceptance.

Programme laws (all phases):

- Attendance records time and facts; Payroll calculates money.
- Tenant authority is `req.companyId` only; granular RBAC + org-subtree scope.
- No surveillance: no tracking, no idle-as-absence, no scoring, no
  continuous location. Location only at policy-required punch actions.
- History is never reinterpreted or bulk-rewritten to fit a new model.

## Phases

| Phase | Document | Status |
|---|---|---|
| 31.1 Attendance Foundation & Policy Engine | `PHASE_31_1_ATTENDANCE_POLICY_ENGINE.md` (+ `PHASE_31_1_TESTING_CHECKLIST.md`) | Shipped |
| 31.2 Advanced Punching & Live Attendance | `PHASE_31_2_ADVANCED_PUNCHING.md` (+ `PHASE_31_2_TESTING_CHECKLIST.md`) | Shipped |
| 31.3 Office Locations & Geofencing | `PHASE_31_3_OFFICE_LOCATIONS_GEOFENCING.md` (+ `PHASE_31_3_TESTING_CHECKLIST.md`) | Shipped (CLOCK_IN-only OFFICE geofence, strict REQUIRED, RBAC v28) |
| 31.4 WFH, Field & On-Duty Workflows | `PHASE_31_4_WORK_MODE_REQUESTS.md` (+ `PHASE_31_4_TESTING_CHECKLIST.md`) | Shipped (request→approve→clock-in authorization, RBAC v29) |
| 31.5 Attendance Regularization & Exception Center | `PHASE_31_5_ATTENDANCE_REGULARIZATION.md` (+ `PHASE_31_5_TESTING_CHECKLIST.md`) | Shipped (correction overlay + exception explanations, RBAC v30) |
| 31.6 Shift / Roster Intelligence | `PHASE_31_6_SHIFT_ROSTER_INTELLIGENCE.md` (+ `PHASE_31_6_TESTING_CHECKLIST.md`) | Shipped (dated resolution, overnight anchoring, payroll verdict, snapshot versioning) |
| 31.7 Leave, Holiday & Weekly-Off Reconciliation | `PHASE_31_7_LEAVE_HOLIDAY_RECONCILIATION.md` | Shipped (deterministic daily resolution, conflicts, no payroll changes) |
| 31.8 Overtime, Weekend/Holiday Work & Comp-Off | `PHASE_31_8_OVERTIME_COMPOFF.md` | Shipped (human-approved OT/comp-off, approved-only payroll seam, RBAC v31) |
| 31.9 Teams-Style Who's Working & Live Team Attendance | `PHASE_31_9_WHOS_WORKING.md` | Shipped (live presence board, batched derivation, no new permission, RBAC v31) |
| 31.10 Attendance Calendar & Timesheets | `PHASE_31_10_ATTENDANCE_CALENDAR_TIMESHEETS.md` | Shipped (my/team timesheets, day drawer, scoped CSV export, no new permission, RBAC v31) |
| 31.11+ | — | Not started. No code, no scaffolding, no plan in repo. |

## Vocabulary (owned by 31.1, binding on all later phases)

Daily outcome (`PRESENT / ABSENT / HALF_DAY / NON_WORKING_DAY / UNRESOLVED`),
work mode (`OFFICE / WFH / FIELD / CLIENT_SITE / BUSINESS_TRAVEL`), live
state (`NOT_IN / WORKING / ON_BREAK / COMPLETED`), exceptions, event types
(`CLOCK_IN / BREAK_START / BREAK_END / CLOCK_OUT`) and sources
(`WEB / KIOSK / QR / IMPORT / DEVICE / MANUAL`) are separate namespaces
and must never be overloaded into one `status` field.
