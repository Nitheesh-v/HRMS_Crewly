# Phase 38 — Localhost Acceptance (Windows PowerShell)

**What this covers:** Phase 38 (employee profile change requests) end to end, plus the
short Phase 37.8 presence re-check. Everything here runs against a **dedicated local
MongoDB** — never shared staging or production.

**Status:** these steps are written but **not yet run by the owner**. The hermetic
suites (`npm run test:all`, `npm test`) pass; live behaviour is what this document
establishes, and only the owner's run counts as acceptance.

---

## 0. What you need

| Item | Notes |
| --- | --- |
| Node.js 20+ | `node -v` |
| MongoDB running locally | `mongod` on `127.0.0.1:27017`, or a Docker container |
| Redis (optional) | only for the presence half (§5). Without it, leave `REDIS_ENABLED=false` |
| Two browser windows | the app authenticates with **cookies**, so HR and the employee need separate sessions: one normal window + one InPrivate/Incognito |

---

## 1. Backend environment (`Backend/.env`)

```powershell
Set-Location .\Backend
Copy-Item .env.example .env -ErrorAction SilentlyContinue   # only if .env does not exist yet
```

Set at least these values in `Backend/.env`:

```ini
NODE_ENV=development
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/crewly_phase38_acceptance
JWT_SECRET=local-only-dev-secret-change-me
REDIS_ENABLED=false
PRESENCE_SOCKET_ENABLED=false
REALTIME_ENABLED=false
```

Never commit `.env`, and never point `MONGO_URI` at a database someone else depends on.

---

## 2. Start the app

```powershell
# ── Terminal 1 — backend ─────────────────────────────────────
Set-Location .\Backend
npm install --no-audit --no-fund     # first run only
npm run dev
# expect: MongoDB connected + "API listening" style log, no repeated errors

# ── Terminal 2 — readiness probe ─────────────────────────────
Invoke-RestMethod -Uri 'http://localhost:5000/api/health/ready'
# expect HTTP 200 and a JSON body with success/status fields

# ── Terminal 3 — frontend ────────────────────────────────────
Set-Location .\Frontend
npm install --no-audit --no-fund     # first run only
npm run dev -- --host 127.0.0.1
# open http://127.0.0.1:5173
```

The frontend proxies `/api` and `/socket.io` to `localhost:5000` (`Frontend/vite.config.js`),
so the browser never needs a backend URL of its own.

---

## 3. Create the test data

### Option A — through the UI (recommended, exercises RBAC provisioning)

1. Open `http://127.0.0.1:5173/register` and create the company **Infolexus** with
   an admin account (password needs ≥ 10 characters with upper, lower, digit and symbol).
   Note the **company code** shown after registration — you need it to sign in.
2. Sign in as the admin → **User Management** → create:
   * `HRinfo` — role **HR_MANAGER**
   * `manikandan` — role **EMPLOYEE**, with an employee code (`IX-001`), a designation,
     a date of joining, a bank account (9–18 digits) and an IFSC (`HDFC0001234`).
     These payroll fields are what Phase 38 requests are about, so set them now.
3. If you also want the Agrihub tenant-isolation check (§4, scenario J), register a
   second company in a **separate** browser profile.

### Option B — through the API (scriptable, same result)

```powershell
function Call-Api {
  param([string]$Method, [string]$Path, $Body)
  $uri = "http://localhost:5000/api$Path"
  $headers = @{ 'X-Requested-With' = 'XMLHttpRequest' }
  if ($script:token) { $headers.Authorization = "Bearer $script:token" }
  try {
    if ($Body) {
      return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers `
        -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 6)
    }
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
  } catch {
    $code = [int]$_.Exception.Response.StatusCode
    Write-Host "HTTP $code : $($_.ErrorDetails.Message)" -ForegroundColor Yellow
    return $null
  }
}
```

The access token returned by login is accepted as `Authorization: Bearer …`, which is
why the helper sets `$script:token` — a bearer call does not need the CSRF header that
cookie-authenticated writes require.

```powershell
# 1. Register the tenant (returns the company code + an admin token)
$reg = Call-Api POST '/auth/register-company' @{
  companyName = 'Infolexus'
  adminName   = 'Aditi'
  email       = 'admin@infolexus.test'
  password    = 'Local#Acceptance1'
}
$companyCode = $reg.data.company.code
$script:token = $reg.data.token

# 2. Create HR + employee
$hr = Call-Api POST '/users' @{
  name = 'HRinfo'; email = 'hrinfo@infolexus.test'; password = 'Local#Acceptance1'; role = 'HR_MANAGER'
}
$emp = Call-Api POST '/users' @{
  name = 'Manikandan R'; email = 'manikandan@infolexus.test'
  password = 'Local#Acceptance1'; role = 'EMPLOYEE'
  employeeCode = 'IX-001'; designation = 'Software Engineer'; dateOfJoining = '2024-04-01'
  bankAccount = '123456789012'; ifsc = 'HDFC0001234'
}
$employeeId = $emp.data.user._id

# 3. Token for each principal (login needs companyCode)
$script:token = (Call-Api POST '/auth/login' @{
  companyCode = $companyCode; email = 'manikandan@infolexus.test'; password = 'Local#Acceptance1'
}).data.token
$employeeToken = $script:token
```

---

## 4. Phase 38 acceptance scenarios

Open `http://127.0.0.1:5173` in **window 1** as `manikandan` and in **window 2** (InPrivate)
as `HRinfo`.

| # | Scenario | Steps | Pass criteria |
| --- | --- | --- | --- |
| **A** | Direct lane still works | Employee → My Profile → change **Phone** and **Emergency Contact** → *Save Profile* | Toast “Profile saved”; values persist after F5 |
| **B** | Bank is approval-only in the UI | Employee → My Profile → *Bank Details* | No editable inputs — values render as text with a **Request change** button |
| **C** | Bank is approval-only in the API | `PUT /api/profile/me` with `{ "bankAccount": "999888777666" }` | Request succeeds but the value is **unchanged** afterwards (`GET /api/profile/me`) |
| **D** | Submit a request | *Request change* next to Account Number → new number → *Send for approval* | Toast “Request sent to HR for approval”; card appears under **My Change Requests** as `pending`; profile value unchanged |
| **E** | Duplicate guard | Submit a second request for the same field (UI and API) | Modal warns and disables; API answers **409** “You already have an open request…” |
| **F** | Reviewer queue | HR → People → **Profile Change Requests** | Row shows employee + code, `old → new` with the account **masked** (`••••••••7666`); `GET /pending` returns 200 for HR |
| **G** | Employee cannot review | As the employee: `GET /api/profile/change-requests/pending` | **403** |
| **H** | Approve applies the value | HR clicks **Approve** + note | Request becomes `approved` with `appliedAt`; employee record now has the new bank value; employee gets “Profile change approved”; `AuditLog` has `PROFILE_CHANGE_REQUEST_APPROVED` with **no account number** in `newValue` |
| **I** | Reject never writes | Submit a **designation** change → HR rejects with a reason | Request `rejected`; designation unchanged; the employee can submit again for that field |
| **J** | Rejection needs a reason | HR clicks Reject and confirms with an empty note | Button stays disabled; an API call with a blank note returns **400** |
| **K** | Drift is refused | Employee requests a **name** change → HR edits the name from **User Management** → HR approves the old request | **409** “changed after this request was submitted”; profile keeps HR's value; request is back in the queue as `pending` |
| **L** | Ownership | As the employee, `GET /api/profile/change-requests/<hr-request-id>` | **403** (and **404** if the id belongs to another company) |
| **M** | Cancel | Employee cancels a pending request → then tries to approve it | Cancel returns `cancelled`; the later approve returns **409** |
| **N** | Tenant isolation | In the Agrihub window, open the profile queue; then fetch an Infolexus request id | Queue is **empty**; the foreign id returns **404** |
| **O** | No side effects | Before/after the scenarios: attendance, leave and payroll data for `manikandan`; then `AuditLog` rows | No Attendance / Leave / Payroll document changed; audit rows exist for SUBMITTED / APPROVED / REJECTED / CANCELLED |

Useful probes (employee token in one shell, HR token in the other — re-run the login call
to switch principals):

```powershell
# employee: my requests
Call-Api GET '/profile/change-requests/me'

# verify the applied value without opening the UI (HR or admin):
$script:token = (Call-Api POST '/auth/login' @{
  companyCode = $companyCode; email = 'hrinfo@infolexus.test'; password = 'Local#Acceptance1'
}).data.token
Call-Api GET "/users/$employeeId"

# the queue, straight from the API
Call-Api GET '/profile/change-requests/pending'
```

---

## 5. Phase 37.8 re-check (presence) — optional, needs local Redis

Only if you are testing the presence half. Full steps and the A–I matrix live in
`docs/PHASE_37_8_LOCALHOST_ACCEPTANCE.md`; the short version:

```powershell
# Terminal 1 — backend with the presence flags
$env:MONGO_URI = 'mongodb://127.0.0.1:27017/crewly_phase38_acceptance'
$env:REDIS_ENABLED = 'true'
$env:REDIS_URL = 'redis://127.0.0.1:6379'
$env:PRESENCE_SOCKET_ENABLED = 'true'
$env:CHAT_ALLOW_LOCALHOST_ORIGINS = 'true'
Set-Location .\Backend
npm run dev
```

Then confirm: Available → Away on idle → Available on activity, Busy/DND precedence,
manual expiry, last tab closed → Offline, reconnect → Available, Redis stopped →
degraded **Unknown** (not a mass Offline) with HTTP still served, and no Attendance
writes. Stop the Redis service to simulate the outage, then start it again and wait for
the adapter to recover.

---

## 6. Verify the database directly (optional)

```powershell
mongosh "mongodb://127.0.0.1:27017/crewly_phase38_acceptance" --eval "
  db.profilechangerequests.find({}, { status:1, pendingFields:1, appliedAt:1, 'changes.field':1 }).pretty();
  db.users.find({ email: 'manikandan@infolexus.test' }, { name:1, designation:1, employeeCode:1, bankAccount:1, ifsc:1 }).pretty();
  db.auditlogs.find({ targetType: 'ProfileChangeRequest' }).sort({ createdAt: -1 }).limit(5).pretty();
"
```

What to look for: one document per proposal, `pendingFields` only on `pending` rows,
`appliedAt` set exactly when the value landed, and audit `newValue` carrying field names
and notes — never an account number.

---

## 7. Cleanup

```powershell
mongosh "mongodb://127.0.0.1:27017/crewly_phase38_acceptance" --eval "db.dropDatabase()"
```

The database name is dedicated to this run, so dropping it touches nothing else.

---

## 8. What still needs the owner

* Running scenarios **A–O** above on localhost (and 37.8's A–I if presence is in scope).
* Reporting anything that fails, with the request id and the HTTP status — the pipeline's
  answers are deliberately distinct (400 value, 403 permission/scope, 404 unknown or
  foreign tenant, 409 duplicate / already decided / drifted / code taken), so the status
  code alone usually names the cause.

The automated suites prove the rules, the tenant filters, the masking, the state machine
and the wiring. They do **not** prove live MongoDB behaviour, real cookie sessions, or
real Redis fan-out — that is exactly what this document is for.

`Phase 37.8 awaiting localhost acceptance.`
