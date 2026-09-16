# Phase 31.4 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Work-mode requests (new)

| Area | Shipped |
|---|---|
| Models | `AttendanceWorkModeRequest` (tenant-scoped, zero middleware); `AttendanceEvent` gains optional `authorization` subdoc |
| Rules | Pure `attendanceWorkModeRules.js`: requestable modes, date/range/portion validation, overlap matrix, transitions, cancel/review eligibility, authorization matching |
| Service | `attendanceWorkModeService.js`: submit/mine/pending/get/decide/cancel, leave-conflict (read-only), org scope via reused helpers, notify+audit, clock-in matcher |
| Policy | `workModeApproval` per-mode flags (default true); explicit-true enforcement; legacy policies grandfathered |
| API | `/api/attendance/work-mode-requests`: submit, mine (+requestableModes), pending, get, cancel, approve, reject |
| RBAC | `ATTENDANCE_WORK_MODE_REQUEST` (self-service) / `_REVIEW` (scoped), catalog v29 |
| UI | `/app/attendance/work-modes` (My requests + Pending approvals); Today-card authorization hint; policy approval toggles |
| Tests | `test/attendanceWorkModeRequests.test.js`, 47 hermetic tests, registered in `test:all` |

## Untouched (verify still green)

31.1 policy dials, 31.2 punching/ledger/Today card, 31.3 geofence,
classic punch-in/out, report APIs + page, Shift, Work Schedule, Leave,
Holiday, dashboard, Payroll 29.x/29.5. No migration. No 31.5
regularization, no Who's Working board.

---

# PART 2 — Backend verification

```powershell
cd Backend

$env:MONGO_URI='mongodb://127.0.0.1:27017/crewly_test'
node --test test/attendanceWorkModeRequests.test.js  # expect: 47 pass, 0 fail
node --test test/attendanceLocations.test.js         # expect: 37 pass, 0 fail (frozen)
node --test test/attendanceEvents.test.js            # expect: 47 pass, 0 fail (frozen)
node --test test/attendancePolicy.test.js            # expect: 34 pass, 0 fail (frozen)
npm run test:all                                     # expect: 947 pass, 11 env-blocked, 0 real failures
```

The 11 `test:all` failures are the pre-existing MONGO_URI-blocked DB
suites — identical before and after 31.4.

```powershell
cd ..\Frontend
npm run build                                        # expect: built, no errors
```

---

# PART 3 — Manual UI verification (localhost)

1. HR: policy page → enable WFH (+ FIELD/CLIENT_SITE/TRAVEL) → keep
   "needs approval" ON → Save draft → Activate.
2. Employee: Work Mode Requests → New request → WFH tomorrow → Submit
   → PENDING; sidebar shows the one new item.
3. Manager: Pending approvals → employee row appears → Approve.
4. Employee: row shows APPROVED (no attendance created — check
   My Attendance still shows Clock In).
5. On the day: My Attendance → WFH → Clock In → no location prompt →
   works; timeline shows WFH.
6. Reject flow: submit another → manager Rejects with reason →
   employee sees the reason; mode clock-in without approval fails.
7. Cancel: employee cancels a PENDING request → gone from queue.
8. Each mode: repeat request/approve for FIELD, CLIENT_SITE,
   BUSINESS_TRAVEL (range for travel).
9. Disable WFH in policy → new WFH request refused (backend message).
10. Overlap: two FULL_DAY requests same day → second refused.
11. Unrelated manager: cannot see/approve another team's request.
12. OFFICE clock-in still follows the 31.3 geofence; WFH never asks
    for home coordinates.
