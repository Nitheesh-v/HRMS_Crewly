# Phase 37 — Operational Runbooks

DETECT / IMPACT / DO / DO NOT / VERIFY / ESCALATE — same shape as the
Phase 36 / Phase 33 runbooks.

---

## Phase 37.1 Acceptance

### Self-service smoke

```powershell
# log in via browser, capture the access cookie
$cookies = "C:\Users\megal\Desktop\HRMS\crewmly_cookies.txt"

# 1. read your own state (should be unknown, livePresenceAvailable=false)
curl.exe -s -b $cookies http://localhost:5000/api/presence/me

# 2. set Busy
curl.exe -s -b $cookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/me/status `
  -d '{"status":"busy"}'

# 3. read again — presence: busy, presenceSource: manual
curl.exe -s -b $cookies http://localhost:5000/api/presence/me

# 4. set a status message
curl.exe -s -b $cookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/me/status-message `
  -d '{"message":"Client call until 3 PM"}'

# 5. set Office
curl.exe -s -b $cookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/me/work-location `
  -d '{"location":"office"}'

# 6. clear
curl.exe -s -b $cookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/me/status `
  -d '{"status":null}'
```

### Forbidden manual values

```powershell
# Away / On Leave / Offline MUST be rejected with 400 INVALID_PRESENCE_VALUE
curl.exe -s -b $cookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/me/status `
  -d '{"status":"away"}'
```

### Identity-override protection

```powershell
# All of companyId / company / userId / user / employeeId / employee MUST be rejected
curl.exe -s -b $cookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/me/status `
  -d '{"status":"busy","companyId":"507f1f77bcf86cd799439011"}'
```

### WFH policy gates

```powershell
# admin cookies (SETTINGS_MANAGE)
$adminCookies = "C:\Users\megal\Desktop\HRMS\crewmly_admin_cookies.txt"

# flip to approval_required
curl.exe -s -b $adminCookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/config `
  -d '{"wfhMode":"approval_required"}'

# as the employee, WFH now refused
curl.exe -s -b $cookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/me/work-location `
  -d '{"location":"wfh"}'
# expected: 409 WFH_APPROVAL_REQUIRED

# flip to disabled
curl.exe -s -b $adminCookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/config `
  -d '{"wfhMode":"disabled"}'

# WFH now refused with 403 WFH_DISABLED
curl.exe -s -b $cookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/me/work-location `
  -d '{"location":"wfh"}'

# reset
curl.exe -s -b $adminCookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/config `
  -d '{"wfhMode":"self_declare"}'
```

### Tenant-config invalid timeout relationship

```powershell
curl.exe -s -b $adminCookies -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -X PUT http://localhost:5000/api/presence/config `
  -d '{"awayAfterMinutes":10,"offlineAfterMinutes":5}'
# expected: 400 INVALID_TIMEOUT_RELATIONSHIP
```

### Boundaries (the §3 / §14 / §15 checks)

After every presence mutation, run:

```powershell
# in a mongo shell
db.leaves.countDocuments({})
db.attendances.countDocuments({})
db.payrollresults.countDocuments({})
```

These counts MUST NOT increase after a presence / status / WFH call.
Any increase is a §3 / §14 / §15 violation. STOP and report.

### Hard reload

After all changes:

```powershell
# restart backend
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev
```

Hard reload the browser: **Ctrl + Shift + R**.

---

## Runbook style (every later Phase 37 unit uses this same skeleton)

For Phase 37.4 / 37.5 / 37.6 / 37.7 each new behaviour adds a new
incident entry. The Phase 37.1 entry above is the template.
---

## Phase 37.2 Acceptance

### Self-service surface

1. Restart the backend (`cd Backend` and `npm run dev`).
2. Hard reload the browser: **Ctrl + Shift + R**.
3. Open the **header avatar** area in the tenant app — a new "Set presence"
   button appears next to the notification bell.
4. Click it: a small popover opens with three sections (Status / Status
   message / Work location).
5. Select **Busy**: the section shows a Save button. Choose "1 hour" in
   the expiry selector. Click Save. The popover reflects the server
   response — the radio shows a green check next to Busy.
6. Type "Client call until 3 PM" in the message field. Click Save.
7. Click **Office** in Work location. Confirm "Office" appears next to
   the indicator dot in the popover header.

### Disabled / approval copy

8. As an admin (cookies with COMPANY_ADMIN), flip `wfhMode` to
   `approval_required`:
   ```powershell
   curl.exe -s -b $adminCookies -H "Content-Type: application/json" `
     -H "X-Requested-With: XMLHttpRequest" `
     -X PUT http://localhost:5000/api/presence/config `
     -d '{"wfhMode":"approval_required"}'
   ```
9. As the employee, open the menu and look at the Work location section.
   The WFH option is now disabled with the copy **"WFH requires approval
   for your company. (Request flow ships in a later update.)"**
10. Clicking WFH does nothing — no request is sent. Refresh the page and
    confirm WFH remains grey. There is NO "Request" button (37.5 owns that).
11. Flip `wfhMode` back to `self_declare`.

### Unknown is not Offline

12. Open DevTools → Network → set the Backend offline briefly. Refresh.
    The header indicator shows "Presence unavailable", never "Offline".

### Test commands

```powershell
cd Frontend
npm test          # 260 / 260
npm run build     # clean
npm run lint      # 128 problems (baseline)

cd ../Backend
npm run test:presence
node --test test/phase36Closeout.test.js
```

# Phase 37.3 — Team Availability runbook

## Symptoms that point here

- "I see myself but not my teammates."
- "WFH count is zero but I know three people are at home."
- "Team availability returns 500 on bad filter."
- "Fetching /presence/team hangs forever."

## 1. "I see myself but not my teammates"

Cause: the caller's role did not produce a populated scope.

Check:

```bash
# As the caller's auth context, what does scope return?
node --eval '
import("./src/utils/scope.js").then(async (m) => {
  const req = { companyId: "<co>", user: { _id: "<uid>", role: "<role>", department: "<dept>" } };
  const ids = await m.getScopedUserIds(req);
  console.log("scope:", ids);
});
'
```

Expected:

| Role         | Scope result                                       |
| ------------ | -------------------------------------------------- |
| EMPLOYEE     | `[<self>]`                                        |
| TEAM_LEAD   | `[<self>, ...<direct reports>]`                |
| MANAGER    | dept members + self                             |
| HR / ADMIN | `null` (unrestricted)                          |

If the result is `[<self>]` and the caller is not EMPLOYEE, the role on
`req.user.role` is wrong. Fix upstream; do NOT relax
`getScopedUserIds`.

## 2. "WFH count is zero but I know three people are at home"

Cause: the tenant's `allowedWorkLocations` does not include `wfh`.

Check:

```bash
# As the caller's company
curl http://localhost:5000/api/presence/config
```

If `allowedWorkLocations` is `["office"]` then WFH rows that exist in
`UserPresence` are stripped by the resolver (37.1 §32 — the policy
allowlist is the final say). Re-add `wfh` to the allowlist if the
tenant policy says WFH is supported.

## 3. "Team availability returns 500 on bad filter"

Cause: the filter param is not in the allowlist and the controller path
is throwing a `PresenceError` whose `code` is leaking.

Run the unit tests:

```bash
node --test test/presenceTeamService.test.js
```

If the unknown-filter assertion fails, the service's
`PRESENCE_TEAM_ALLOWED_FILTERS` allowlist or the validator's allowlist was
mutated. Revert; both must match.

## 4. "Fetching /presence/team hangs forever"

Cause: an N+1 query was reintroduced. The pipeline MUST be one batched
`UserPresence.find({ companyId, userId: { $in: ids } })`.

Check:

```bash
grep -c "UserPresenceModel.find" Backend/src/services/presence/presenceTeamService.js
# Expected: 1
```

If > 1, someone added a second find. Revert.

## 5. Acceptance checklist

- [ ] `node --test test/presenceFoundation.test.js test/presenceTeamService.test.js` is green (105/105).
- [ ] `Frontend` `node --test test/teamAvailability.test.js` is green (24/24).
- [ ] `GET /api/presence/team?presence=offline` returns 400 (unknown filter).
- [ ] `GET /api/presence/team?companyId=co-other` returns 400 (identity override).
- [ ] EMPLOYEE auth → only self in `items`.
- [ ] MANAGER auth → only department members in `items`.
- [ ] No item contains `password` / `phone` / `email` / `salary` / `Aadhaar` / `PAN`.
- [ ] No `getUser` presence stored anywhere — team view is read-only.

---

# Phase 37.7 Closeout Runbook

This runbook extends the 37.1–37.6 incidents with the closeout
class and pins the **cross-instance realtime** status that the
37.7 spec requires us to surface rather than hide.

---

## INCIDENT 1 — Presence appears unavailable / Unknown for everyone

**DETECT**
- Team page renders the Unknown tile and personal PresenceMenu shows
  the "presence" badge as "unknown" for every user, including the
  operator's own.

**IMPACT**
- The whole tenant looks offline. Employees cannot tell if the team
  page is broken or if the load balancer is the cause.

**DO**
- Check `PRESENCE_SOCKET_ENABLED` in `.env`. If it is `true`, the
  socket has been auto-attached to the HTTP server (`server.js:134`).
  Comment that line back out OR set `PRESENCE_SOCKET_ENABLED=false`
  and restart.
- Check `REDIS_URL` and that the Redis instance is reachable. The
  live store degrades to `unknown` if Redis is down.
- Check `GET /api/presence/config` as a COMPANY_ADMIN — a
  config-side `enabled=false` flips every UI to "presence is off".

**DO NOT**
- Mark every employee as Offline just because the resolver could not
  see a live connection. The 37.1 / 37.4 contract is `unknown` until
  the resolver can prove absence.
- Increase the heartbeat TTL or the offline threshold to "make the
  warning go away" — that hides the underlying problem.

**VERIFY**
- `GET /api/presence/me` returns
  `presence: 'unknown' | 'available' | 'away'` and
  `livePresenceAvailable: true|false`.
- The team page tile reads the same shape.

**ESCALATE**
- Tenant-level: open a P1 with the platform team if the live store
  is down for >5 minutes.

---

## INCIDENT 2 — Presence makes the application slow

**DETECT**
- Authenticated home page TTFB > 1.5s. DevTools Network tab shows
  presence APIs being called from pages that do not display presence.

**IMPACT**
- The whole HRMS feels slow, not just the presence surface.

**DO**
- Check `server.js:134` — the `await getPresenceSocketServer().attach(server);`
  line is **deliberately commented out** by 37.4 perf stop-gate. If
  the line has been uncommented, comment it back out. The socket is
  opt-in and the comment block explains why.
- Check that the topbar `PresenceMenu` does not start a socket
  lifecycle on mount (37.4 contract). The `presenceRuntime.js`
  module has no callers in 37.4 by design.
- Check the team page does not re-fetch on every heartbeat. The
  page listens to `state.presence.teamBumpedAt`, which the runtime
  bumps at most once per N seconds, not per socket message.

**DO NOT**
- Increase server timeouts. The performance budget is fixed.
- Switch the `presenceService.js` to a polling loop. The endpoint
  is REST-on-demand; 37.4's transport is opt-in.

**VERIFY**
- `npm run dev` + open the authenticated home → no presence GETs
  fire until the operator opens the `PresenceMenu` popover.
- `Backend/test/apiPerformanceBounds.test.js` is still green.

**ESCALATE**
- Open a P1 with the platform team if the request storm recurs.

---

## INCIDENT 3 — Employee appears Offline incorrectly

**DETECT**
- The team page shows an employee as `offline` but they are
  actively working.

**IMPACT**
- Manager sees a green "online" employee as offline, may page
  someone unnecessarily.

**DO**
- Check the live store: `redis-cli SCARD crewly:<env>:presence:conn:<companyId>:<userId>`.
  If the count is 0, the user has no live connection (browser tab
  closed, socket dropped, or an instance restart in flight).
- Check the live key TTL: `redis-cli TTL crewly:<env>:presence:live:<companyId>:<userId>`.
  If the TTL is below 30s, the heartbeat is being missed (network
  jitter, NAT, or the user really is idle).

**DO NOT**
- Mark them as `available` manually. Presence is derived; the
  operator cannot edit a coworker.

**VERIFY**
- Ask the user to refresh the browser. The connection count should
  return to 1 and the resolver should bump them to `available` on
  the next GET.

**ESCALATE**
- If many users show Offline simultaneously, this is Incident 1
  (Redis / socket) — escalate per that runbook.

---

## INCIDENT 4 — Employee remains Away / Busy / DND

**DETECT**
- The user explicitly cleared their status but the team page
  continues to show `busy` or `dnd` for them.

**IMPACT**
- Misleading. The user's intent was lost.

**DO**
- Check `state.current.expiresAt` in the user's own slice. The
  expiry might be in the future; the user thinks "clear" but the
  backend's view is the persistence layer.
- Check that `PUT /api/presence/me/status` returned 200 with
  `presence: 'unknown', presenceSource: 'none'`. If the request
  returned 200 but the slice still shows the old value, the
  `updateMyStatus.fulfilled` reducer was not run; reload the page.

**DO NOT**
- Patch the database directly. The presence snapshot is derivable
  from the next read.

**VERIFY**
- After clearing, the next `GET /api/presence/me` returns
  `presence: 'unknown'`.

**ESCALATE**
- If the resolver is NOT respecting the user's manual clear, this
  is a bug in the precedence table — escalate to the platform team
  with the request / response trace.

---

## INCIDENT 5 — WFH request cannot be submitted

**DETECT**
- The WFH dialog's "Submit" button is disabled, or the request
  returns 400.

**IMPACT**
- Employee cannot change their work location for the day.

**DO**
- Check `GET /api/presence/config` (admin): `wfhMode` must be
  `self_declare` (button enabled) or `approval_required` (button
  enabled, request goes to the review queue). If `disabled`, the
  employee genuinely cannot submit a WFH — point them at the
  operator to enable the policy.
- Check the allowed locations. If `wfh` is not in
  `allowedWorkLocations`, the request will be refused.
- Check for an overlapping open request. The service refuses a
  second pending request for the same date.

**DO NOT**
- Approve on the user's behalf from the backend. Approval is
  human-only.

**VERIFY**
- The new request appears in `state.presence.workLocationRequests.myRequests`
  with `status: 'PENDING'`.

**ESCALATE**
- If the backend is refusing valid input, capture the request /
  response and open a P2.

---

## INCIDENT 6 — Wrong manager can see / approve WFH

**DETECT**
- A manager opens `team/availability` or
  `presence/work-location-requests/review` and sees a department
  they do not own.

**IMPACT**
- **Authorization / security incident**. Treat as P0.

**DO**
- Pull the request / response and capture the manager's user id
  and the WFH row's `companyId` / `departmentId`.
- Verify the role-scope helper at
  `Backend/src/utils/orgHelpers.js` and the route's
  `RequireRole roles={HR}` or `SENIORS` guard.

**DO NOT**
- Fix it by hiding the UI. The API MUST also enforce.

**VERIFY**
- The same request with a non-privileged user returns 403.

**ESCALATE**
- **Immediate** — treat as a tenant data leak.

---

## INCIDENT 7 — Approved WFH not reflected

**DETECT**
- A reviewer approved a WFH request. The employee still shows
  `office` on the team page.

**IMPACT**
- Approved work location not visible. The employee may be
  challenged for being "out of office".

**DO**
- Check the request's `applicableDate` and the tenant's timezone.
  The resolver applies the work location for the business date in
  the tenant's tz, not the server's tz.
- Check the request's `status` — only `APPROVED` applies; `PENDING`
  is non-effective.
- Check that the live store has a recent heartbeat. An "approved
  WFH" without a live connection still shows the previous
  snapshot.

**DO NOT**
- Edit Attendance to "fix" the discrepancy. Approved WFH is
  presentation-only, never attendance.

**VERIFY**
- The next `GET /api/presence/me` returns
  `workLocation: 'wfh'`.

**ESCALATE**
- If the approved request is not flowing into the snapshot after
  the next refresh, this is a bug — open a P2.

---

## INCIDENT 8 — Employee shows Available while approved Leave active

**DETECT**
- Team page shows an employee as `available` even though HR
  approved a leave for today.

**IMPACT**
- HR may be paged unnecessarily. The user's intent (not to be
  disturbed) is not respected.

**DO**
- Check the leave row: `status === 'APPROVED'`, `startDate <= today <= endDate`
  in the tenant's timezone. Only those rows produce `on_leave`.
- Check the resolver precedence. `on_leave` is the highest value
  in 37.6; the resolver cannot fall through to `available` if
  `hrContext.onLeave === true`.

**DO NOT**
- Mutate Leave to "fix" Presence. The integration is read-only.

**VERIFY**
- The next `GET /api/presence/me` returns
  `presence: 'on_leave', presenceSource: 'leave'`.

**ESCALATE**
- If the precedence is broken, open a P1 — this is the
  37.6 closeout guarantee.

---

## INCIDENT 9 — Outside Working Hours appears incorrect

**DETECT**
- A user inside their shift window shows
  `outsideWorkingHours: true`, or a user on a weekly off shows
  `outsideWorkingHours: false`.

**IMPACT**
- Context flag is wrong. The team page can show the
  "Outside Working Hours" tile with a misleading count.

**DO**
- Check `ShiftAssignment` for the user on today's date. The
  resolver reads via `resolveEmployeeSchedule` + `summarizeSchedule`.
- Check the tenant's timezone. `dayKeyInZone` uses
  `Intl.DateTimeFormat` with the tenant's IANA zone, not the
  server's.
- Check for an overnight shift (e.g. 22:00 → 06:00). The
  `phase` field on the working-hours context should still be
  `IN_WINDOW` at 02:00.

**DO NOT**
- Synthesise a 9-to-5 schedule when no shift is assigned. The
  contract is `null` (unknown) or a real shift, not a guess.

**VERIFY**
- `GET /api/presence/me` returns `outsideWorkingHours: false`
  for a user inside their shift, and `null` for a user with
  no shift.

**ESCALATE**
- If the timezone math is wrong, open a P2 — DST / overnight
  shifts are the canonical edge cases.

---

## INCIDENT 10 — Cross-tenant presence observed

**DETECT**
- The team page shows rows from another tenant. A user from
  Tenant A appears in Tenant B's team list.

**IMPACT**
- **Authorization / security incident**. Treat as P0.

**DO**
- Pull the request / response and the caller's `req.companyId`.
- Verify the validator on `/api/presence/team` refused any
  `?companyId=` override. The validator must refuse
  `companyId` / `userId` / `employeeId` query keys.
- Verify the team service filters by `req.companyId` BEFORE
  the Mongo query.

**DO NOT**
- Patch it by hiding the data on the page. The API MUST enforce.

**VERIFY**
- The same request with a Tenant A caller returns only Tenant A
  users. A Tenant B caller's request with `?companyId=co-A`
  returns 400.

**ESCALATE**
- **Immediate** — this is a cross-tenant data leak. Page the
  security on-call.

---

## INCIDENT 11 — Multi-backend realtime inconsistency

**DETECT**
- A user updates their status on Tab A (instance X). Tab B
  (instance Y) does not pick up the change without a refresh.

**IMPACT**
- Cross-tab / cross-instance realtime is not guaranteed.

**STATUS (37.7)**

The 37.4 socket `attach()` is **deliberately commented out** in
`Backend/src/server.js` (`db177d9` perf stop-gate). The
`presenceSocket` namespace IS wired; an operator can opt in
via `PRESENCE_SOCKET_ENABLED=true`, `REDIS_ENABLED=true`, and
`REDIS_URL` set. When opted in, the cross-instance fan-out
relies on the existing `presenceBus.js` (the 32.11 SSE gateway
re-pointed at the in-process bus, not a NATS client).

**Until an operator opts in to the socket:**
- The team page reads on demand. A tab that does not re-fetch
  in the polling window will show stale data. There is NO
  cross-instance realtime delivery.
- This is a **known limitation**, not a bug. It is reported
  here and in the memory capsule as a 37.8 candidate.

**DO**
- If the operator needs cross-instance realtime, set the
  three env vars and restart. Verify that the request path does
  not become slow (Incident 2).
- If the operator does not need it, the REST polling at the
  team-page interval is sufficient and the slower path is
  intentional.

**DO NOT**
- Add NATS during a 37.7 incident. NATS would be a separate
  architecture change.
- Bypass the perf stop-gate to "fix" the inconsistency. The
  stop-gate exists for a reason.

**VERIFY**
- With `PRESENCE_SOCKET_ENABLED=true`, two tabs across two
  instances update within the heartbeat window. With the env
  var unset, no socket connection is created.

**ESCALATE**
- Multi-instance realtime hardening belongs to
  **Phase 37.8 — Multi-Instance Realtime Hardening**. Open a
  P1 only if the operator cannot opt in.
