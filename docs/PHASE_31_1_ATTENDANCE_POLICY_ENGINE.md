# Phase 31.1 — Attendance Foundation & Policy Engine

> Attendance programme: **31.1 Attendance Foundation & Policy Engine** →
> 31.2+ (daily evaluation, regularization, schedules, OT workflows).

The **tenant attendance-policy configuration layer**: one versioned,
audited rules document per company plus a pure evaluation foundation
that later phases will call. It records rules and facts — it never
pays anyone and never changes how punches are taken.

```
HR setup UI ──► Policy DRAFT ──► ACTIVATE ──► versioned ACTIVE + ARCHIVED history
                                              (31.2+ will read this to
                                               evaluate days and feed 29.5)
```

**What this phase deliberately does NOT do:**

| Not here | Owner |
|---|---|
| Punch capture / punch UI changes | Unchanged — punch flow untouched |
| Daily attendance evaluation / auto-marking | 31.2+ |
| Regularization requests / approvals | 31.2+ |
| Shifts, rosters, work schedules | Existing modules (31.1 only reads schedules as inputs) |
| Leave balances, holidays | Leave / Holiday modules (read-only boundary) |
| Payroll money maths, LOP amounts | 29.6 engine (29.5 `lopSource='ATTENDANCE'` contract preserved) |
| Location tracking, idle detection, scoring | Never — out of scope for the whole programme |

Nothing in 31.1 writes to `Attendance`, shifts, schedules, leave,
holidays, or any payroll collection. No migration is required.

---

## 1. Vocabulary (separate namespaces, never mixed)

| Namespace | Values | Meaning |
|---|---|---|
| Daily outcome | `PRESENT`, `ABSENT`, `HALF_DAY`, `NON_WORKING_DAY`, `UNRESOLVED` | What the day counts as |
| Work mode | `OFFICE`, `WFH`, `FIELD`, `CLIENT_SITE`, `BUSINESS_TRAVEL` | Where/how the work happened |
| Live state | `NOT_MARKED`, `IN`, `OUT`, `COMPLETED` | Transient punch-state only |
| Exception | `MISSED_IN`, `MISSED_OUT`, `LATE_IN`, `EARLY_OUT`, `SHORT_HOURS`, … | Flags needing attention |
| Event type | `CLOCK_IN`, `CLOCK_OUT`, `BREAK_START`, `BREAK_END` | Facts from devices |
| Source | `WEB`, `MOBILE`, `BIOMETRIC`, `BULK_IMPORT`, `ADMIN_CORRECTION`, `SYSTEM` | Where a fact came from |
| Policy status | `DRAFT`, `ACTIVE`, `ARCHIVED` | Lifecycle of the rules document |

Leave never implies presence: approved leave yields
`NON_WORKING_DAY`, never `PRESENT`. Partial punches yield
`UNRESOLVED` — 31.1 never invents missing time.

## 2. Policy lifecycle

One `DRAFT` per company, one `ACTIVE` (`isCurrent`), append-only
`ARCHIVED` history. Activation archives the previous active row and
promotes the draft as a new version number; activating twice is a
no-op. Old rows keep their own thresholds forever — activating a new
policy never reinterprets days evaluated under an old one.

Concurrent saves are guarded by optimistic `configVersion`: a stale
write gets HTTP 409 with the current version so the UI can reload.

Every create/update/activate writes an audit-log entry with
actor + before/after snapshot.

## 3. What a policy configures (9 sections)

Thresholds (full/half-day minutes), grace (late-in/early-out),
breaks (included vs excluded from worked time, daily cap),
missing-punch posture (stay unresolved, regularization allowed,
window), OT eligibility foundations (tracking, minimum extra
minutes, approval, weekend/holiday eligibility), weekly-off/holiday
work allowances, enabled work modes (office always on), and the
company timezone (IST default). Policy is **reporting-only** for
shift/schedule/leave/holiday inputs owned by other modules.

## 4. Access and tenancy

- Tenant authority is `req.companyId` only; a `companyId` in the
  request body is rejected, and draft input can never smuggle one.
- `ATTENDANCE_POLICY_READ` / `_MANAGE` / `_ACTIVATE`;
  `SYSTEM_PERMISSION_VERSION = 27`. HR reads and drafts;
  activation is Super Admin / Company Admin only.
- Cache key `t:{companyId}:attendance-policy:v1:current`,
  TTL 300 s (env `ATTENDANCE_POLICY_CACHE_TTL_SECONDS`, clamped
  10–3600), single-flight, fail-open: Redis failure degrades to
  Mongo with zero behaviour change. History reads bypass the cache.
- Rate limit: shared API limiter (60/min base).

## 5. Files

| Layer | Path |
|---|---|
| Model | `Backend/src/models/AttendancePolicy.js` |
| Pure engine | `Backend/src/services/attendance/attendancePolicyRules.js` |
| Service (DI) | `Backend/src/services/attendance/attendancePolicyService.js` |
| Validator | `Backend/src/validators/attendancePolicyValidator.js` |
| Controller | `Backend/src/controllers/attendancePolicyController.js` |
| Routes | `Backend/src/routes/attendancePolicyRoutes.js` (mounted before `/attendance`) |
| RBAC | `permissionRegistry.js` (`ATTENDANCE_POLICY_*`, HR matrix), `permissionService.js` (v27) |
| API client | `Frontend/src/services/attendancePolicyService.js` |
| UI | `Frontend/src/pages/attendance/AttendancePolicyPage.jsx` (`/app/attendance/policy`) |
| Wiring | `AppRoutes.jsx`, `AppLayout.jsx`, `SidebarNav.jsx` |
| Tests | `Backend/test/attendancePolicy.test.js` (33 hermetic tests) |

## 6. API

| Method | Path | Permission |
|---|---|---|
| GET | `/api/attendance/policy` | `ATTENDANCE_POLICY_READ` |
| GET | `/api/attendance/policy/history?limit=` | `ATTENDANCE_POLICY_READ` |
| POST | `/api/attendance/policy/draft` | `ATTENDANCE_POLICY_MANAGE` |
| POST | `/api/attendance/policy/activate` | `ATTENDANCE_POLICY_ACTIVATE` |

All responses share the service envelope
`{ success, policy | history, ... }`. Draft input is
section-granular (each supplied section replaces the whole
section); missing sections fall back to the active policy, then to
canonical defaults.
