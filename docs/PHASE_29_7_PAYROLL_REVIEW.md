# Phase 29.7 — Payroll Review & Approval

> Payroll programme: 29.1 Company Payroll Setup → 29.2 Salary Components →
> 29.3 Salary Structures → 29.4 Employee Payroll Profile → 29.5 Variable Pay &
> Monthly Inputs → 29.6 Payroll Calculation Engine → **29.7 Payroll Review &
> Approval** → 29.8 Bank Transfer File & Salary Payment Preparation.

Where the money is **checked and signed off**, never produced:

```
Snapshot (29.6)  ─►  Review (29.7)  ─►  Lock  ─►  Finance approval  ─►  29.8 Bank file
                        │                              │
                        │  errors, checklist,          │  approve / reject
                        │  remarks, differences        │  (reason required)
                        └──────────────────────────────┘
```

**What this phase deliberately does NOT do (§26 / §31):**

| Not here | Owner |
|---|---|
| Bank transfer file | 29.8 |
| Salary payment / payment confirmation | 29.8+ |
| Payslip PDF, email payslips | later |
| Direct bank API integration | later |
| Full & final settlement | later |
| **Any salary calculation** | 29.6 — every figure on this page is read from the snapshot |

---

## 1. Spec corrections applied

Same standing rule as every earlier phase: **the spec is the requirement, the
architecture is the authority.**

| § | Spec said | Built instead | Why |
|---|---|---|---|
| §4 | Role names — *Company Admin / Payroll Admin / HR Manager / Finance Manager* | The payroll-run permissions the 29.1 catalogue already declared: `PAYROLL_RUN_READ` / `_PREPARE` / `_REVIEW` / `_LOCK` / `_REOPEN` / `_APPROVE` / `_REJECT`, plus `requireFeature('payroll')` and the 29.1 payroll scope | The platform has never gated on role names. Envoy-like delegated payroll roles (`PAYROLL_ADMIN`, `FINANCE_MANAGER` templates) would be locked out by a role-name gate. **One permission was genuinely missing and was added (see §2).** |
| §12 / §13 | "Monthly inputs become read-only" on lock; "payroll editable" after reopen | Locking sets the 29.5 `PayrollPeriod` to `SENT_TO_PAYROLL`; an authorized reopen returns it to **`COLLECTING_INPUTS`** | Reuses the 29.5 state machine instead of inventing a second, parallel lock flag. `COLLECTING_INPUTS` is the only writable state — 29.5 refuses input writes in both `LOCKED` *and* `SENT_TO_PAYROLL`, so any other target would leave HR with a "reopened" month they still could not edit. |
| §19 | Excel / XLSX reports | **CSV** through pure builders | Matches 29.5's CSV template decision: no new npm dependency, and the files open in Excel anyway. |
| §20 | Cache key `payroll:review:{companyId}:{month}` | `buildTenantCacheKey({ namespace: 'payroll-review', version: 1, segments: [month, suffix] })` | Phase 28.7 helper is the single convention. |
| §21 | BullMQ for background reports | **Implemented for real** on the existing `payroll` queue (`payroll-export`), with a synchronous inline path when Redis is off | Same discipline as 29.6: the queue is real, the degraded mode is declared in the response (`meta.queued`) and the UI says so. No new queue was added. |
| §6 | Status list | `CALCULATED → UNDER_REVIEW → LOCKED → PENDING_FINANCE_APPROVAL → APPROVED / REJECTED → REOPENED` | The review starts when HR first touches the month (a checklist tick, an employee review, a bulk action) — there is no pointless "start review" button, and locking therefore always happens from `UNDER_REVIEW`. |

---

## 2. The one permission change

`FINANCE_MANAGER` held `PAYROLL_RUN_APPROVE` but **not** `PAYROLL_RUN_REJECT`.
§14 gives finance both sides of the decision, so a manager who can approve must
also be able to say no with a reason — otherwise the only way to reject is to
walk away and leave the month stuck in `PENDING_FINANCE_APPROVAL`.

```
src/utils/roleTemplates.js      FINANCE_MANAGER += PAYROLL_RUN_REJECT
src/utils/permissionService.js  SYSTEM_PERMISSION_VERSION 20 → 21
```

`SYSTEM_PERMISSION_VERSION` was bumped so every company's cached permission set
is rebuilt on next login.

---

## 3. Backend files

| File | Role |
|---|---|
| `src/services/payroll/payrollReviewRules.js` | **Pure.** Statuses + transition table, checklist, the §10 error catalogue, KPIs, summary report, difference report, CSV builders. No mongoose, no redis, no req. |
| `src/models/PayrollReview.js` | One document per company + month: status, run reference, checklist, per-employee review rows, append-only remarks, lock/submit/approve/reject/reopen stamps and reasons, cached KPIs. |
| `src/models/PayrollExport.js` | One per generated report: status (`QUEUED`/`PROCESSING`/`READY`/`FAILED`), CSV content, row count, queue job id. |
| `src/services/payroll/payrollReviewService.js` | The workflow. `makePayrollReviewService(deps)` factory (hermetic testing) plus a wired default export. |
| `src/services/payroll/payrollExportDispatcher.js` | Payload validation + `enqueueJob(QUEUE_NAMES.PAYROLL, 'payroll-export', …)` with a deterministic job id. |
| `src/workers/payrollProcessor.js` | `payrollExportProcessor` — revalidates the payload and **rebuilds the report from Mongo**, never from the payload. |
| `src/controllers/payrollReviewController.js` | Thin: `// Data from frontend` → `// DB Logic` → `// Data to frontend`. |
| `src/validators/payrollReviewValidator.js` | express-validator chains: month, month param, employee param/body, checklist, remark, reason, bulk, export. |
| `src/middlewares/payrollReviewScope.js` | `payrollReviewScope` resolves visibility (29.1); `assertEmployeeInReviewScope` 403s an out-of-scope single read. |
| `src/routes/payrollReviewRoutes.js` | Mounted at `/api/payroll/review` in `src/routes/index.js`. |

### Route table

| Method | Path | Permission |
|---|---|---|
| GET | `/api/payroll/review/:month` | `PAYROLL_RUN_READ` (cached dashboard) |
| GET | `/api/payroll/review/:month/employees` | `PAYROLL_RUN_READ` |
| GET | `/api/payroll/review/:month/errors` | `PAYROLL_RUN_READ` |
| GET | `/api/payroll/review/:month/differences` | `PAYROLL_RUN_READ` |
| GET | `/api/payroll/review/:month/employees/:employeeId` | `PAYROLL_RUN_READ` + in-scope assertion |
| PATCH | `/api/payroll/review/:month/checklist/:item` | `PAYROLL_RUN_PREPARE` |
| POST | `/api/payroll/review/:month/remarks` | any of PREPARE / REVIEW / APPROVE / REJECT / LOCK |
| PATCH | `/api/payroll/review/:month/employees/:employeeId` | `PAYROLL_RUN_PREPARE` |
| POST | `/api/payroll/review/:month/bulk` | `PAYROLL_RUN_PREPARE` |
| POST | `/api/payroll/review/:month/lock` | `PAYROLL_RUN_LOCK` |
| POST | `/api/payroll/review/:month/reopen` | `PAYROLL_RUN_REOPEN` (reason required) |
| POST | `/api/payroll/review/:month/submit` | `PAYROLL_RUN_REVIEW` |
| POST | `/api/payroll/review/:month/approve` | `PAYROLL_RUN_APPROVE` |
| POST | `/api/payroll/review/:month/reject` | `PAYROLL_RUN_REJECT` (reason required) |
| POST | `/api/payroll/review/:month/exports` | `PAYROLL_RUN_READ` |
| GET | `/api/payroll/review/exports/:exportId` | `PAYROLL_RUN_READ` |

Every route also runs `protect`, `tenantContext`, `checkSubscriptionStatus`,
`requireFeature('payroll')` and — for reads — the payroll scope middleware.

---

## 4. The workflow

```
CALCULATED ──first HR touch──► UNDER_REVIEW ──lock──► LOCKED ──submit──► PENDING_FINANCE_APPROVAL
                                    ▲                   │                      │         │
                                    │                   │                 approve      reject (reason)
                                    │                   │                      │         │
                                    └──── REOPENED ◄────┴──── reopen (reason) ─┴─────────┘
```

* **Lock (§12)** requires a complete checklist **and** zero critical errors.
  It sets the 29.5 period to `SENT_TO_PAYROLL` — the month's inputs are frozen.
* **Submit (§14)** hands the month to finance.
* **Approve / Reject (§14)** — a rejection without a reason is refused, and the
  reason is shown to HR on the review page and stored in the audit trail.
* **Reopen (§13)** requires authorisation **and** a reason, and returns the
  period to `LOCKED` so HR can edit and recalculate.
* `LOCKED`, `PENDING_FINANCE_APPROVAL` and `APPROVED` are **read-only**:
  checklist, per-employee review and bulk actions are all refused.

### Validation catalogue (§10)

| Severity | Codes |
|---|---|
| CRITICAL (blocks locking) | `MISSING_BANK_ACCOUNT`, `MISSING_PAN`, `MISSING_SALARY_STRUCTURE`, `INVALID_PAYROLL_PROFILE`, `NEGATIVE_SALARY`, `DUPLICATE_PAYROLL_RECORD` |
| WARNING | `ATTENDANCE_MISSING`, `MISSING_IFSC`, `ZERO_NET_SALARY` |

The checklist box "Error count is zero" is **derived** — the UI shows it as
`auto` and the API refuses a manual tick.

---

## 5. Frontend

| File | Role |
|---|---|
| `src/services/payrollReviewService.js` | One call per endpoint, no company id in the browser. |
| `src/pages/payroll/ReviewPayrollPage.jsx` | Month + status badge, the seven §7 KPI cards, the checklist, a five-tab workspace (Employees / Errors / Differences / Remarks / Reports), the workflow action bar, and the employee breakdown drawer. |
| `src/routes/AppRoutes.jsx` | `payroll/review` → `ReviewPayrollPage`. |
| `src/layout/AppLayout.jsx` | "Review Payroll" appears for whoever holds any payroll-run permission — never by role name. |
| `src/layout/SidebarNav.jsx` | Icon + payroll group membership (the group already folds `/app/payroll/*`). |

Buttons are permission-driven: HR sees *Lock* only with `PAYROLL_RUN_LOCK`,
finance sees *Approve* / *Reject* only with `PAYROLL_RUN_APPROVE` /
`PAYROLL_RUN_REJECT`, and every control is disabled while the month is
read-only. Reports download as CSV; when the queue is configured the UI says
the report is being generated in the background.

---

## 6. Security, tenancy and performance

* Every query is scoped by `req.companyId`; a payload from another tenant
  cannot reach a document.
* `resolvePayrollVisibility` (29.1) narrows a manager to their own subtree —
  the review, the employee list, the KPIs and bulk actions all honour it, and a
  narrowed scope can never widen a result.
* Queue payloads carry **references only** (company, month, export id, report
  key, actor) — no salary figures, no PII — and the worker validates them again
  before use. The worker rebuilds the report from Mongo, so a stale or tampered
  payload cannot leak another month's numbers.
* Redis: namespace `payroll-review`, version 1, TTL
  `PAYROLL_REVIEW_CACHE_TTL_SECONDS` (default 300s, clamped 10–3600). The
  **employee list is never cached** — it is the big object. Every workflow
  action invalidates the key.
* **A recalculation invalidates the review cache too.** The key shape lives in
  one module (`services/payroll/payrollReviewCache.js`) that both the review
  service and the 29.6 engine import, so the engine drops the dashboard
  whenever it writes new figures (§20: invalidate after recalculation).
  Without it, a 300-second cache could show finance numbers HR had already
  replaced — exactly the §17 "never hide a revision" hazard.
* Export content is capped (4 MiB) so a queue payload or Mongo document cannot
  grow without bound.
* Every transition writes an audit record (previous status → new status, with
  the reason) and notifies the people who can act next.
* **Notifications are addressed by permission, not by role name (§22).**
  `payrollReviewRules.NOTIFICATION_AUDIENCE` maps each event to the
  permissions of the people who should hear about it — "notify finance" means
  "notify everyone holding `PAYROLL_RUN_APPROVE`". The resolver
  (`resolveAudience`) walks Permission → CompanyRole → User, so a delegated
  approver or a custom Finance Executive role is included automatically. The
  actor is filtered out, so you are never notified of your own action, and a
  notification failure never rolls back an approval.
  Per-user ALLOW overrides are honoured for authorization but are not
  enumerated here — fan-out is best-effort by design.

---

## 7. Tests

```
node --test test/payrollReview.test.js   →  29 tests,  29 pass  (new, hermetic)
node --test test/payrollEngine.test.js   →  29 tests,  29 pass  (29.6 + 2 new)
npm run test:payroll                     → 238 tests, 238 pass
npm run test:phase28                     → 242 tests, 242 pass
npm run test:payroll-rbac                →  27 tests,  27 pass
npm run test:all                         → 604 tests, 604 pass
```

`test:payroll-review` was added to `package.json` and to `test:payroll`
and `test:all`.

The suite is hermetic — fake models, fake cache, fake audit/notifier/dispatcher,
no MongoDB, no Redis, no BullMQ. It covers: the transition table, read-only
statuses, the checklist gate, every §10 error code with its severity, KPIs and
the summary report, CSV exports, the difference report, lock/reopen/submit/
approve/reject (including every refusal path), append-only remarks, bulk
actions proving no salary value changes, queue dispatch with a references-only
payload, worker rebuild from Mongo, scope narrowing, and the §4 permission
matrix.
- §22: notifications are fanned out by permission (submit reaches the
  approvers), the actor is not notified of their own action, a rejection
  carries its reason, and a notification that throws never rolls back the
  approval.
- §18: `EXPORT_ERROR_LIST` and `DOWNLOAD_PAYROLL_SUMMARY` return a report and
  touch no review row, and still work on a locked month.
- §20: one cache key shape is shared with the engine, and a recalculation
  invalidates the review dashboard.
- §23: a remark is audited with the author and their role.

---

## 8. A live bug from 29.6 that this phase found and fixed

Building the review dashboard re-read the cache seam — and found that 29.6's
`getRunSummary` called it with **positional arguments**:

```js
cache.getOrSet(key, ttlSeconds, async () => { … })   // ✗
```

The house contract (29.2, 29.3, 29.4) is an options object returning an
envelope:

```js
const { value } = await cache.getOrSet(key, { ttlSeconds, version, loader });
```

With Redis configured or not, `getOrSetCache` receives a number where it
expects `{ loader }`, finds no loader, and then calls it —
`TypeError: loader is not a function` — so **every call to
`GET /api/payroll/runs/:month` would have failed**. It never showed up in the
hermetic suites because their fake cache implemented only `buildKey` and `del`,
so the service took the "no cache" branch.

Fixed in both services with the shared `readThrough(key, loader)` helper
(bypass when there is no key or no cache, bypass on any cache error), and
locked down with a regression test in each suite: the fake cache now asserts
that `getOrSet` receives `{ ttlSeconds, version, loader }` and the caller gets
the unwrapped value.

New tallies: **payroll engine 29**, **payroll review 29**,
**`test:all` 604/604**.

---

## 9. What 29.8 gets

An approved month whose figures are frozen, whose inputs are locked, whose
errors are zero, and whose decision trail (who locked, who submitted, who
approved or why it was rejected) is audited. 29.8 can build the bank transfer
file and prepare salary payment on top of it.
