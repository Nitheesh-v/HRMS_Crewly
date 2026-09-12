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
| 31.3+ | — | Not started. No code, no scaffolding, no plan in repo. |

## Vocabulary (owned by 31.1, binding on all later phases)

Daily outcome (`PRESENT / ABSENT / HALF_DAY / NON_WORKING_DAY / UNRESOLVED`),
work mode (`OFFICE / WFH / FIELD / CLIENT_SITE / BUSINESS_TRAVEL`), live
state (`NOT_IN / WORKING / ON_BREAK / COMPLETED`), exceptions, event types
(`CLOCK_IN / BREAK_START / BREAK_END / CLOCK_OUT`) and sources
(`WEB / KIOSK / QR / IMPORT / DEVICE / MANUAL`) are separate namespaces
and must never be overloaded into one `status` field.
