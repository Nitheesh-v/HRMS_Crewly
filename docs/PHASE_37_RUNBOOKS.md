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
