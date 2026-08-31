# Step-by-step testing guide — Phase 29.1 → 29.2

Windows PowerShell, copy-paste ready. Follow the steps **in order** — each one
builds on the previous.

Everything tested here: **29.1 Company Payroll Setup**, **29.1 RBAC update**
(roles + permissions + scope), and **29.2 Salary Components**.

---

## STEP 0 — What you need installed

| Tool | Check command | Needed? |
|---|---|---|
| Node.js 18+ | `node -v` | Yes |
| MongoDB (running locally) | `mongosh --eval "db.runCommand({ping:1})"` | Yes |
| Redis | `redis-cli ping` | Optional — the app must work without it |

> **Redis is optional on purpose.** If it is not running the app still works;
> only caching is skipped.

---

## STEP 1 — Start the API

```powershell
cd Backend
npm install
npm run dev
```

Wait for: `Server running on port 5000` (and `MongoDB connected`).

Leave this window open.

---

## STEP 2 — Create the Super Admin (once)

Open a **second** PowerShell window:

```powershell
cd Backend
npm run seed
```

You get: `admin@crewly.com` / `Admin@123`.

---

## STEP 3 — Start the UI

Open a **third** PowerShell window:

```powershell
cd Frontend
npm install
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`).

---

## STEP 4 — Create a test company (important: choose the plan)

Register a company through the public signup so **you choose the password**:

```powershell
$body = @{
  companyName = "Acme Test"
  adminName   = "Acme Admin"
  email       = "admin@acme-test.com"
  password    = "Test@12345"
} | ConvertTo-Json

$reg = Invoke-RestMethod -Uri "http://localhost:5000/api/auth/register-company" -Method Post -Body $body -ContentType "application/json"
$reg.data.company.code        # <-- this is your company code
```

**Write that company code down** — you need it to log in.

### STEP 4b — Enable the payroll feature (do not skip)

New companies start on **TRIAL**, and TRIAL has `payroll: false`. Without this
every payroll call returns `403 FEATURE_NOT_AVAILABLE`.

```powershell
mongosh
```

```javascript
use crewly            // if your DB has a different name, check Backend/.env MONGO_URI
db.subscriptions.updateOne({}, { $set: { plan: "ENTERPRISE" } })
db.subscriptions.find({}, { plan: 1, status: 1 })
```

Type `exit` to leave mongosh.

> **Why ENTERPRISE?** Payroll needs `payroll: true` (BASIC, PRO or ENTERPRISE),
> and creating a custom role from a template needs `advancedRbac: true`, which
> is **ENTERPRISE only**.

---

## STEP 5 — Log in as Company Admin and save a token

```powershell
$body = @{
  companyCode = "acme-test"          # the code from STEP 4
  email       = "admin@acme-test.com"
  password    = "Test@12345"
} | ConvertTo-Json

$login = Invoke-RestMethod -Uri "http://localhost:5000/api/auth/login" -Method Post -Body $body -ContentType "application/json"
$token   = $login.data.token
$headers = @{ Authorization = "Bearer $token" }

$login.data.company.name   # confirms who you are logged in as
```

---

## STEP 6 — Test 29.1: Company Payroll Setup

### 6a — Start the setup

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/setup/start" -Method Post -Headers $headers
```

**Expect:** status `DRAFT`.

### 6b — Fill the four sections

```powershell
$legal = @{
  legalName      = "Acme Test Pvt Ltd"
  pan            = "AABCA1234A"
  tan            = "BLRA12345B"
  gstin          = "29AABCA1234A1Z5"
  registeredAddress = @{ line1 = "1 Test Street"; city = "Bengaluru"; state = "Karnataka"; pincode = "560001" }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/setup/LEGAL" -Method Patch -Headers $headers -Body $legal -ContentType "application/json"
```

```powershell
$statutory = @{
  pf  = @{ applicable = $true;  establishmentNumber = "KABAN1234567" }
  esi = @{ applicable = $false; registrationNumber  = "" }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/setup/STATUTORY" -Method Patch -Headers $headers -Body $statutory -ContentType "application/json"
```

```powershell
$policy = @{
  frequency     = "MONTHLY"
  cycleType     = "FIXED_MONTH_DAY"
  paymentDateType = "SPECIFIC_DAY"
  paymentDay    = 1
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/setup/POLICY" -Method Patch -Headers $headers -Body $policy -ContentType "application/json"
```

```powershell
$bank = @{
  bankName         = "Test Bank"
  accountHolderName = "Acme Test Pvt Ltd"
  accountNumber    = "123456789012"
  ifsc             = "TEST0001234"
  accountType      = "CURRENT"
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/setup/BANK" -Method Patch -Headers $headers -Body $bank -ContentType "application/json"
```

> If a section returns validation errors, the message names the exact field —
> fix that field and re-send. The UI wizard (Payroll → Payroll Setup) shows the
> same fields if you prefer clicking.

### 6c — Check readiness and activate

```powershell
$cfg = Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/setup" -Headers $headers
$cfg.data.summary          # section completion + warnings
$cfg.data.config.configVersion
```

```powershell
$act = @{ configVersion = $cfg.data.config.configVersion } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/setup/activate" -Method Post -Headers $headers -Body $act -ContentType "application/json"
```

**Expect:** status `ACTIVE`. This is permission-gated by
`PAYROLL_SETUP_ACTIVATE` — **not** by the Company Admin role.

---

## STEP 7 — Test the 29.1 rule: payroll is NOT Company-Admin-only

### 7a — See the role templates (nothing is seeded)

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/roles/templates" -Headers $headers
```

**Expect:** 6 templates — HR Head, HR Executive, Payroll Admin, Payroll
Executive, Finance Manager, Finance Executive.

### 7b — Confirm they were NOT force-created

```powershell
(Invoke-RestMethod -Uri "http://localhost:5000/api/roles" -Headers $headers).data | Select-Object name, code, isSystemRole
```

**Expect:** only the 5 system roles. Templates are **opt-in** — they appear only
after you create them.

### 7c — Create a Payroll Executive role from the template

```powershell
$role = @{
  name        = "Payroll Executive"
  template    = "PAYROLL_EXECUTIVE"
  description = "Runs payroll, cannot approve or pay"
} | ConvertTo-Json
$newRole = Invoke-RestMethod -Uri "http://localhost:5000/api/roles" -Method Post -Headers $headers -Body $role -ContentType "application/json"
$newRole.data._id          # save this
```

**Expect:** `201`, `isSystemRole: false` — an ordinary company role you can edit.

### 7d — Prove separation of duties

```powershell
$perms = (Invoke-RestMethod -Uri "http://localhost:5000/api/roles/$($newRole.data._id)/permissions" -Headers $headers).data
$perms -contains "SALARY_COMPONENT_READ"      # True
$perms -contains "SALARY_COMPONENT_MANAGE"    # False  <- cannot edit components
$perms -contains "SALARY_COMPONENT_ACTIVATE"  # False
```

---

## STEP 8 — Assign a user to that role and log in as them

1. In the UI: **User Management** → create a user (e.g. `payroll@acme-test.com`).
2. Find their id:

```powershell
$users = (Invoke-RestMethod -Uri "http://localhost:5000/api/users" -Headers $headers).data
$users | Select-Object _id, name, email
```

3. Assign the role:

```powershell
$assign = @{ roleId = $newRole.data._id } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5000/api/users/<USER_ID>/role" -Method Patch -Headers $headers -Body $assign -ContentType "application/json"
```

4. Log in as that user (new PowerShell window, new token) and check:

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components" -Headers $payrollHeaders
# Expect 200 - they hold SALARY_COMPONENT_READ

$bad = @{ name = "Test"; code = "TEST"; category = "EARNING"; calculationType = "FIXED_AMOUNT" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components" -Method Post -Headers $payrollHeaders -Body $bad -ContentType "application/json"
# Expect 403 - they do NOT hold SALARY_COMPONENT_MANAGE
```

**In the browser as that user:** the sidebar shows *Salary Components* (they have
READ), the **Create Component** button is hidden, and the page shows no
permission error. That is the 29.1 model working end to end.

---

## STEP 9 — Test 29.2: create components

```powershell
$basic = @{ name = "Basic Salary"; code = "BASIC"; category = "EARNING"; calculationType = "FIXED_AMOUNT"; defaultAmount = 30000; pfApplicable = $true; esiApplicable = $true } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components" -Method Post -Headers $headers -Body $basic -ContentType "application/json"
# Expect 201 "Salary component created successfully."
```

```powershell
$hra = @{ name = "House Rent Allowance"; code = "HRA"; category = "EARNING"; calculationType = "PERCENTAGE"; percentage = 40; calculationBase = "COMPONENT"; dependsOnCode = "BASIC"; taxability = "TAXABLE"; pfApplicable = $true } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components" -Method Post -Headers $headers -Body $hra -ContentType "application/json"
# Expect 201
```

List them and check the human-readable calculation text:

```powershell
$list = Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components" -Headers $headers
$list.data | Select-Object name, code, calculationLabel, status
# HRA -> "40% of Basic Salary"
```

---

## STEP 10 — Validation and dependency tests (do all four)

| # | Call | Expect |
|---|---|---|
| 1 | POST again with `code = "BASIC"` | 400 *"This component code is already in use. Please choose another code."* |
| 2 | POST `HRA` with `dependsOnCode = "HRA"` | 400 *"This component cannot depend on itself"* |
| 3 | PATCH `BASIC` to depend on `HRA` | 400 *"This configuration creates a circular salary dependency."* |
| 4 | POST `percentage = 5000` | 400 percentage out of range |

```powershell
# 3 - circular dependency
$idBASIC = ($list.data | Where-Object { $_.code -eq "BASIC" })._id
$cyclic = @{ calculationType = "PERCENTAGE"; percentage = 10; calculationBase = "COMPONENT"; dependsOnCode = "HRA" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components/$idBASIC" -Method Patch -Headers $headers -Body $cyclic -ContentType "application/json"
```

---

## STEP 11 — Lifecycle: deactivate (never delete), reactivate, duplicate

```powershell
$status = @{ status = "INACTIVE" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components/$idBASIC/status" -Method Post -Headers $headers -Body $status -ContentType "application/json"
# Expect 200 - and the row STILL exists:
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components/$idBASIC" -Headers $headers
```

```powershell
$dupe = @{ name = "Basic Copy"; code = "BASIC_COPY" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components/$idBASIC/duplicate" -Method Post -Headers $headers -Body $dupe -ContentType "application/json"
# Expect 201, version 1, no history copied
```

Reactivate:

```powershell
$on = @{ status = "ACTIVE" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components/$idBASIC/status" -Method Post -Headers $headers -Body $on -ContentType "application/json"
```

---

## STEP 12 — Defaults follow your Payroll Setup (29.1 → 29.2 integration)

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components/defaults" -Headers $headers
```

**Expect:** PF **is** in the list (you enabled PF in STEP 6b) and ESI is **not**
(you left it off). This is 29.1 staying the single source of truth.

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components/defaults" -Method Post -Headers $headers
# Creates only the ones you do not have yet
```

---

## STEP 13 — Tenant isolation (the most important test)

1. Repeat STEP 4 for a second company (`beta-test`, `admin@beta-test.com`) and
   repeat STEP 4b for it too.
2. Log in to company B and confirm it sees **no** Acme components:

```powershell
(Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components" -Headers $headersB).data
# Expect: empty
```

3. Company B **can** create its own `BASIC` (codes are unique per company, not
   globally) — this must succeed.
4. Company B tries to read Acme's component by id — **must be 404, never 200**:

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components/<ACME_COMPONENT_ID>" -Headers $headersB
```

---

## STEP 14 — Employee, Manager, Team Lead get nothing

Log in as an **Employee** of company A (or have one log in via the UI):

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components" -Headers $employeeHeaders
# Expect 403
```

**In the browser:** no *Salary Components* link in the sidebar; visiting
`/app/payroll/components` directly shows:
*"You don't have permission to manage salary components. Contact your Company
Admin or Payroll Administrator."*

---

## STEP 15 — Redis optional

```powershell
# With Redis running: create a component, list it -> appears immediately
# Then stop Redis and repeat:
Invoke-RestMethod -Uri "http://localhost:5000/api/payroll/components" -Headers $headers
# Expect 200 - MongoDB is the source of truth, the app must not fail
```

---

## STEP 16 — Audit trail

```powershell
mongosh
```

```javascript
db.auditlogs.find({ action: /SALARY_COMPONENT/ }).sort({ createdAt: -1 }).limit(10)
```

**Expect:** `SALARY_COMPONENT_CREATED`, `_DEACTIVATED`, `_ACTIVATED`,
`_DUPLICATED`, plus `Payroll permission granted` rows from STEP 7c — each with
actor, company, previous state and new state.

---

## STEP 17 — Run the automated suites

```powershell
cd Backend
npm run test:salary-components   # 24 tests
npm run test:payroll             # 29.1 setup + RBAC + components
npm run test:all                 # 188 hermetic tests
```

These need no MongoDB and no Redis — they must pass **before** and **after**
the manual walkthrough.

---

## Quick reference: errors you may hit

| Message | Cause | Fix |
|---|---|---|
| `403 FEATURE_NOT_AVAILABLE` | Plan has `payroll: false` | STEP 4b — set plan to ENTERPRISE |
| `403` on create role | Plan lacks `advancedRbac` | Plan must be ENTERPRISE |
| `401` | Token expired | Log in again (STEP 5) |
| `400 Unknown payroll setup section` | Section key typo | Use `LEGAL`, `STATUTORY`, `POLICY`, `BANK` |
| `404` on a component id you just saw | You are logged in as the other company | Expected — that is tenant isolation working |

## Expected behaviour that is NOT a bug

- **Usage shows 0 structures** — Phase 29.3 does not exist yet.
- **Editing a component with history creates a new version** — by design; the
  response message says so.
- **Only Company Admin / HR Manager see payroll links initially** — other roles
  see them only after someone grants the permission.
- **No formula calculator** — formulas are stored as a controlled operation
  list only.
