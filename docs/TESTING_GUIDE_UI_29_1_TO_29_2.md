# Browser-only testing guide — Phase 29.1 → 29.2

No API calls, no curl. Everything below is clicking in the app.

---

## What you can test from the website

| Area | Testable in the browser? |
|---|---|
| Company registration + login | Yes |
| 29.1 Payroll Setup wizard (5 steps) + activation | Yes |
| Role templates (HR Head, Payroll Admin, Payroll Executive, HR Executive, Finance Manager, Finance Executive) | Yes |
| Creating those roles | Yes |
| Assigning a role to a user | Yes (on the Roles page, **not** the Users page — see the note) |
| Salary Components — list, filters, search, create, edit, preview | Yes |
| Deactivate / reactivate / duplicate | Yes |
| Validation errors (duplicate code, self-dependency, circular dependency) | Yes |
| Permission differences between roles | Yes — log in as each user |
| Tenant isolation | Yes — register a second company |
| Employee cannot see payroll | Yes |
| Redis down / audit rows | No — needs a terminal |

---

# STEP 1 — Start the app

Terminal 1:
```powershell
cd Backend; npm run dev
```
Terminal 2:
```powershell
cd Frontend; npm run dev
```
Open **http://localhost:5173**

---

# STEP 2 — Create your company (this is your Company Admin account)

Go to **http://localhost:5173/register**

Fill in:

| Field | Example |
|---|---|
| Company name | `Acme Test` |
| Your name | `Acme Admin` |
| Email | `admin@acme-test.com` |
| Password | `Test@12345` (8+ characters) |

Click register. **Write down the company code it shows you** — you need it to log in.

Log in at **http://localhost:5173/login** with the company code, email and password.

---

# STEP 3 — Turn on payroll (one terminal command, cannot be done in the UI)

New companies start on **TRIAL**, and TRIAL has payroll switched off. Until you
do this, every payroll page says *not available on your current plan*.

```powershell
mongosh
```
```javascript
db.subscriptions.updateOne({}, { $set: { plan: "ENTERPRISE" } })
```
Type `exit`.

> Use **ENTERPRISE** — payroll needs BASIC or higher, and creating roles from
> templates needs ENTERPRISE only.

Log out and log back in so the app picks up the new plan.

---

# STEP 4 — Complete Payroll Setup (Phase 29.1)

Go to **Payroll → Payroll Setup** and work through the wizard:

1. **Company & Legal Information** — legal name, PAN (`AABCA1234A`), TAN, address
2. **Statutory Configuration** — switch **PF ON** (enter establishment number), leave **ESI OFF**
3. **Payroll Policy** — Monthly, pay day 1
4. **Company Bank Account** — bank name, account number, IFSC
5. **Review & Activation** — click **Activate**

**Expect:** status becomes **Active**.

This proves 29.1 works. (It is permission-gated: `Activate Payroll Setup`, not
"you are Company Admin".)

---

# STEP 5 — Create the HR Head / Payroll roles

> **The Roles page has no sidebar link.** Type the URL directly:
> **http://localhost:5173/app/roles-permissions**
> (Company Admin only.)

1. Click **＋ Template**
2. Pick **HR Head** → review → create
3. Repeat for **Payroll Admin** and **Payroll Executive**

**Expect:** each one appears in the role list as a normal editable role
(`isSystemRole: false`). Nothing was seeded — you created them, which is the
whole point of the multi-tenant design.

---

# STEP 6 — Create the user accounts

Go to **User Management** (`/app/users`) → create three users:

| Name | Email | Password | Role (temporary) |
|---|---|---|---|
| Priya | `hrhead@acme-test.com` | `Test@12345` | Employee |
| Rahul | `payroll@acme-test.com` | `Test@12345` | Employee |
| Meera | `payrollexec@acme-test.com` | `Test@12345` | Employee |

> The role dropdown now includes the roles you created in STEP 5 (HR Head,
> Payroll Admin, Payroll Executive), so you can assign them straight away and
> skip STEP 7. Only Company Admin and HR Manager see those extra options.

---

# STEP 7 — Assign the roles (optional — may already be done)

If you picked the role while creating each user in STEP 6, skip this.

Otherwise, on **http://localhost:5173/app/roles-permissions**:

1. Open the **Users** section (the user picker)
2. Select **Priya** → choose role **HR Head** → save
3. Select **Rahul** → choose role **Payroll Admin** → save
4. Select **Meera** → choose role **Payroll Executive** → save

---

# STEP 8 — Verify each account (log in as each)

Log out, then log in as each user and check the sidebar and the pages.

### HR Head (`hrhead@acme-test.com`)

| Check | Expected |
|---|---|
| Sidebar | **Payroll Setup** and **Salary Components** visible |
| Payroll Setup | Can view, cannot activate (no Activate Payroll Setup permission) |
| Salary Components | **Create Component** button visible — can create and edit |
| Components | Cannot switch them on/off (no `SALARY_COMPONENT_ACTIVATE`) |

### Payroll Admin (`payroll@acme-test.com`)

| Check | Expected |
|---|---|
| Salary Components | Can create, edit **and** deactivate/reactivate |
| Payroll Setup | Can view and edit (template includes `PAYROLL_SETUP_UPDATE`) |

### Payroll Executive (`payrollexec@acme-test.com`)

| Check | Expected |
|---|---|
| Salary Components | List is visible |
| **Create Component** button | **Hidden** (READ only) |
| Direct URL `/app/payroll/components` | Page opens, no create button |

### Employee (any employee account)

| Check | Expected |
|---|---|
| Sidebar | No Payroll Setup, no Salary Components |
| Direct URL `/app/payroll/components` | *"You don't have permission to manage salary components. Contact your Company Admin or Payroll Administrator."* |

---

# STEP 9 — Test Salary Components in the browser (as Company Admin)

Go to **Payroll → Salary Components**.

### 9a — Empty state
Before creating anything you should see **"No Salary Components Yet"** with the
suggested defaults hint (which follows your STEP 4 statutory choices — PF on, ESI off).

### 9b — Create Basic
**Create Component** →

| Field | Value |
|---|---|
| Name | `Basic Salary` |
| Code | `BASIC` |
| Type | Earning |
| Calculation | Fixed Amount, `30000` |
| PF / ESI | both ticked |

Watch the **preview** change as you type. Save.

### 9c — Create HRA (percentage of another component)
| Field | Value |
|---|---|
| Name | `House Rent Allowance` |
| Code | `HRA` |
| Type | Earning |
| Calculation | Percentage, `40`, Calculated From → **Another Component** → **Basic Salary** |

**Expect:** the preview reads **"40% of Basic Salary"**, and the table's
Calculation column shows the same.

### 9d — Try the invalid things (these must fail)

| Do this | Expected message |
|---|---|
| Create another component with code `BASIC` | *"This component code is already in use. Please choose another code."* |
| Create `HRA2` as percentage of component, Depends On = `HRA2` | *"This component cannot depend on itself"* |
| **Edit Basic**, change it to percentage of **HRA** | *"This configuration creates a circular salary dependency."* (HRA already depends on Basic) |

### 9e — Lifecycle
- **Deactivate** HRA → confirmation explains history is preserved → confirm → status becomes **Inactive**, row stays.
- Filter **Status → Inactive** → HRA shows. Filter **Active** → it doesn't.
- **Activate** it again.
- **Duplicate** Basic → creates `Basic Salary Copy` with a fresh code.

### 9f — Filters and search
Type `hra` in search → only HRA. Use the type/status/calculation/taxability
dropdowns. Create 30+ components to see pagination appear.

### 9g — Detail view
Click a component name → drawer with overview, calculation, PF/ESI/TDS,
effective date, version and **Usage**.

> Usage shows **0 structures** — correct, because Phase 29.3 (Salary Structure
> Builder) does not exist yet.

---

# STEP 10 — Tenant isolation in the browser

1. Open a **private/incognito window**
2. Go to **http://localhost:5173/register** and create a second company:
   `Beta Test`, `admin@beta-test.com`, `Test@12345`
3. Repeat STEP 3 for it (set the plan to ENTERPRISE in mongosh)
4. Log in to **Beta** → **Payroll → Salary Components**

**Expect:**
- The list is **empty** — none of Acme's components appear.
- You **can** create your own `BASIC` (codes are unique per company, not global).
- There is no way to see or reach Acme's data.

---

# STEP 11 — Super Admin view (optional)

**http://localhost:5173/super-admin/login** → `admin@crewly.com` / `Admin@123`
(after `npm run seed`).

You can see both companies, their plans and subscriptions.

---

## Cheat sheet: what each role should see

| | Payroll Setup | Components: view | create | activate |
|---|:--:|:--:|:--:|:--:|
| Company Admin | view + edit + activate | Yes | Yes | Yes |
| HR Manager | view + edit | Yes | Yes | No |
| **HR Head** (template) | view | Yes | Yes | No |
| **Payroll Admin** (template) | view + edit | Yes | Yes | Yes |
| **Payroll Executive** (template) | — | Yes | No | No |
| HR Executive (template) | — | Yes | No | No |
| Finance Manager / Executive (template) | — | Yes | No | No |
| Manager / Team Lead | — | No | No | No |
| Employee | — | No | No | No |

---

## Known limitations

1. **The plan cannot be changed from the UI** — STEP 3 needs mongosh.

Fixed since this guide was written:

- **`/app/roles-permissions` now has a sidebar link** (*Roles & Permissions*,
  under the Company Admin menu).
- **The role dropdown on the Users page is dynamic** — roles you create from
  templates (HR Head, Payroll Admin, Payroll Executive) appear there, so STEP 6
  and STEP 7 can be done in one place. The Users page filter also lists them.
  Only Company Admin and HR Manager may assign a company role; Managers are
  unchanged.
