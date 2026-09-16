# Phase 31.4 — WFH, Field Work & On-Duty Workflows

Authorization workflow for non-office work on top of the 31.1 policy
engine, the 31.2 event ledger and the 31.3 office geofence. Approvals
authorize a later CLOCK_IN — they never create attendance, never mark
Present, never touch payroll or leave balances.

---

## 1. Goal

Employees request WFH / FIELD / CLIENT_SITE / BUSINESS_TRAVEL for a
day or range; the backend-resolved approver reviews; an APPROVED
request authorizes CLOCK_IN under that mode for its dates. OFFICE is
never requested and keeps its 31.3 geofence untouched.

## 2. Model

`AttendanceWorkModeRequest` (tenant-scoped, Leave-mirrored): `user`,
`mode` (4-value WORK_MODE subset), `startDate`/`endDate` day strings,
`dayPortion` (FULL_DAY/FIRST_HALF/SECOND_HALF — halves single-day
only), `reason` (≤300), `placeLabel` (≤120, neutral client/destination
display name — never an address, never coordinates), `status`,
`approver`, `reviewReason`, `decidedAt`, `cancelledBy/cancelledAt`.
Indexes `{companyId:1,status:1,createdAt:1}` (queue) and
`{companyId:1,user:1,startDate:1}` (mine/overlap/match). Zero
middleware. `AttendanceEvent` gains an additive optional
`authorization{requestId,mode,startDate,endDate,dayPortion}` subdoc.

## 3. State machine

`PENDING → APPROVED | REJECTED | CANCELLED`; `APPROVED → CANCELLED`
iff attendance-unused AND (own future-dated OR reviewer-scoped);
terminals frozen. Double-decide loses a CAS race and returns 409 —
never silent-success. No edit-in-place (cancel + resubmit).

## 4. Overlap, leave, policy

- Overlap (pure): active (PENDING/APPROVED) requests conflict when
  day ranges AND portions intersect; FULL collides with everything;
  FIRST+SECOND halves coexist. Checked at submit and revalidated at
  approve (exclude-self).
- Leave: any APPROVED leave sharing a day blocks submit and approve
  (Leave has no day portions, so any shared day conflicts). Leave is
  never written. No holiday/weekly-off gating (31.7 owns it).
- Policy: `workModes` enable modes (backend-enforced); new minimal
  `workModeApproval{wfh,field,clientSite,businessTravel}` (default
  true) controls whether CLOCK_IN needs an approved request.
  Enforcement needs an EXPLICIT true — pre-31.4 policies grandfather
  approval-free clock-in until re-saved (no surprise lockouts, no
  data migration).

## 5. Approver resolution & org scope

Backend-resolved via reused `resolveScopeIds`/`getSubtreeIds`
(`User.reportingTo` tree; admin/HR company-wide per the established
helper). Client `approverId`/`userId` refused. Self-review forbidden.
Notifications mirror Leave: direct manager when set, else Admin+HR,
fire-and-forget, category ATTENDANCE, payloads carry identity+period
only (reason text never in payloads/logs).

## 6. Clock-In integration

Gate inside `clockIn` after the mode-enabled check, before the
geofence: non-OFFICE + approval-required + no APPROVED cover for the
attendance date ⇒ 403 `Approved <Mode> request required for <date>`,
nothing written. Match attaches the minimal `authorization` snapshot
(read-only — the request is never mutated by matching). Live snapshot
gains best-effort `workModeAuthorization{WFH,FIELD,CLIENT_SITE,
BUSINESS_TRAVEL}` for the today card (null when unreadable).

## 7. Geofence interaction

Zero 31.3 changes. OFFICE keeps REQUIRED/OPTIONAL/DISABLED behavior;
approved non-office modes already map to NONE in the matrix, so WFH
CLOCK_IN never asks for position. No home coordinates collected
anywhere; no client-site/travel geofence; no continuous GPS.

## 8. RBAC

`ATTENDANCE_WORK_MODE_REQUEST` (self-service: own requests only) and
`ATTENDANCE_WORK_MODE_REVIEW` (scoped queue). Grants: every employee
REQUEST; MANAGER + HR_MANAGER REVIEW; Company Admin via all-permissions.
Catalog **v28 → v29** (atomic `$addToSet` migration, no role loops).

## 9. API

`/api/attendance/work-mode-requests` (mounted before the generic
router): `POST /`, `GET /mine` (+ server-computed `requestableModes`),
`GET /pending`, `GET /:requestId` (owner-or-scoped-reviewer),
`POST /:requestId/cancel`, `POST /:requestId/approve|reject`. GET never
mutates. Rejection requires a reason (min 3 chars).

## 10. UI

One surface `/app/attendance/work-modes` (single sidebar item): My
requests tab (list + create form + cancel + rejection reasons) and
Pending approvals tab (team-only cards, Approve/Reject-with-reason).
Today card shows `Approved <Mode> request required for today` when the
server map says unauthorized (hint-only; the button stays live and the
backend is authoritative). Policy page gains per-mode approval toggles.

## 11. Tests

`test/attendanceWorkModeRequests.test.js` — 47 hermetic tests: pure
rules/overlap/transitions, policy gates, spoof-proofing, tenancy,
injected org scope, approve/reject/cancel flows, CLOCK_IN integration
(snapshot, replay, used-blocks-cancel end-to-end), leave-conflict with
no-mutation assert, 31.2/31.3 regression slices, no-payroll static
guard. 31.1/31.2/31.3 suites frozen.

## 12. Limitations

- Halves authorize the whole day's CLOCK_IN (attendance has no
  time-portion concept); portions govern overlap/leave only.
- Legacy ACTIVE policies enforce approval only after re-save.
- No request edit, no balances, no holiday gating, no regularization
  (31.5), no reconciliation (31.7), no payroll finalization (31.11).
