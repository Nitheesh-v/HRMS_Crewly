# Phase 29.11 — Final Settlement (F&F), Resignation Recovery & Exit Payroll

**Status:** complete · **Branch:** `arena/01a05672-hrms-crewly`
**Tests:** 36 hermetic (`npm run test:fnf`) · **Full suite:** 741/741 (`npm run test:all`)
**Frontend:** `vite build` clean.
**Preview:** `npm run fnf:preview` — 7 checks, all passing.

One settlement per exit, computed from facts Crewly already owns: the
resignation's last working day, the 29.6 payroll snapshot, the leave ledger and
the asset register. Nobody types a payable-day count, and nobody types the net
amount.

```
Resignation approved ──▶ HR creates settlement ──▶ Calculate
        │                                              │
        │                                              ▼
        │                                     ┌──── CALCULATED ────┐
        │                                     │  exit data frozen  │
        │                                     └────────┬───────────┘
        │                              HR checklist ◀──┘
        │                                     │ complete
        │                                     ▼
        │                              HR_REVIEWED ──▶ Finance approve
        │                                     ▲              │
        │                                     └── reject ────┤
        │                                                    ▼
        │                                          FINANCE_APPROVED
        │                                                    │
        └───────────────────────────────────────────── PAID ─┤
                                                             ▼
                                                   CLOSED  (immutable)
                                                     └──▶ REOPENED
```

---

## 1. Spec corrections applied

The brief is not authoritative where it conflicts with existing architecture —
the standing rule from 29.5 onward.

| § | Brief says | What was built and why |
|---|---|---|
| 4 | Role names (HR Manager, Payroll Admin, Finance Manager) | Permission + 29.1 payroll scope + `requireFeature('payroll')`, as in 29.7–29.10. Seven new verbs: `FINAL_SETTLEMENT_READ / _CALCULATE / _REVIEW / _APPROVE / _PAY / _CLOSE / _REOPEN`, plus `FINAL_SETTLEMENT_READ_SELF` for §18. `SYSTEM_PERMISSION_VERSION` 24 → 25. There is **no** `FINAL_SETTLEMENT_CREATE`: opening a settlement *is* calculating it, so `_CALCULATE` owns both. |
| 6 | "Exit data is read from the Resignation module" | Read once at creation and **copied into `FinalSettlement.exit`**, then frozen. A later edit to the resignation cannot retroactively move a settlement that Finance has already approved. |
| 7 | Prorated salary | Payable days = `min(period working days, day-of-LWD) − lopDays`, from the 29.5 `PayrollPeriod` and the 29.6 snapshot. HR never enters a payable-day count. |
| 12 | Notice recovery | Three decisions, one rule set: `COMPLETED` (no recovery), `BUYOUT` (shortfall × daily rate recovered) and `WAIVED` (shortfall computed and shown, then zeroed — the waiver is visible on the statement instead of silently vanishing). |
| 13 | Asset clearance | Read from the **existing** Asset module at calculation time and stored as a snapshot. Crewly shows what is outstanding; it does not manage assets. |
| 14 | `CLOSED` immutable | Terminal. The only way out is an audited `REOPEN` carrying a reason, which lands the settlement in `REOPENED` and re-opens editing. |
| 16 | "Rejection returns to HR Review" | **Reversed during testing.** `HR_REVIEWED` is read-only for `updateItems`, so a rejected settlement would have had no legal way to be corrected. Rejection returns to `CALCULATED`: `SETTLEMENT_TRANSITIONS.FINANCE_APPROVED = ['PAID', 'CALCULATED']`. |
| 17 | F&F statement PDF | Its own renderer (`utils/fnfPdf.js`) and its own document — **not** a re-skinned 29.9 payslip. It carries exit details, the arithmetic behind every figure, recoveries separate from salary, the net, and the approval trail. |
| 20 | `payroll:fnf:{companyId}` | `buildTenantCacheKey({ namespace: 'payroll-fnf', version: 1 })` — the 28.7 factory already emits exactly that shape, as 29.5–29.10 did. |
| 21 | BullMQ | Two jobs (`fnf-statement`, `fnf-register`) on the **existing** `payroll` queue, **references-only** payloads, with an inline fallback so a dead Redis delays a download rather than breaking it. No payroll arithmetic ever runs in a worker. |
| 25 | Navigation | One sidebar entry (**Payroll → Final Settlement**) with four tabs, plus **My Final Settlement** for §18. Standing constraint: full features, small sidebar. |

### The one design decision worth arguing about

**The exit record is copied, not joined.**

§6 asks that exit data never be duplicated as editable fields. The naive
reading is a live join to `Resignation`. That is wrong for payroll: if someone
amends a resignation after Finance has approved the settlement, a live join
silently rewrites a document that two people have already signed off on, and the
PDF in the employee's hands stops matching the record.

So the settlement takes a **snapshot at creation** and thereafter treats it as
fact. Re-deriving it is an explicit, audited act (recalculate), never a side
effect of someone else's edit. The fields remain non-editable — Crewly copies
them, HR does not.

### A defect the tests could not see

`fnfDispatcher` originally validated `payload.format` through `normaliseFormat`,
which lowercases and defaults. A payload saying `PDF` was silently accepted as
`CSV`, and the register arrived in the wrong shape. A validator must **reject**
what it does not understand, never coerce it into something it does: the
dispatcher now checks `String(payload.format || '').toUpperCase()` against the
allowed set.

---

## 2. Backend files

| File | Lines | Role |
|---|---|---|
| `src/services/payroll/fnfRules.js` | 828 | Pure: statuses, transitions, the checklist, `FNF_RULES` (policy as data), payable days, pending salary, leave encashment, gratuity, notice recovery, totals, the register, both projections. |
| `src/services/payroll/fnfService.js` | 1674 | Orchestration. Models, cache, audit, notify, dispatch, PDF and the writers are all **injected**, so the phase is testable with no MongoDB, Redis, BullMQ or SMTP. |
| `src/services/payroll/fnfCache.js` | — | `payroll-fnf` namespace, version 1, suffixes `['dashboard', 'employee', 'approvals']`. |
| `src/services/payroll/fnfDispatcher.js` | — | Two jobs on the `payroll` queue. References-only payloads; `FORBIDDEN_KEYS` rejects any payload smuggling a figure. |
| `src/models/FinalSettlement.js` | 227 | One row per exit, unique on `{companyId, exit.resignationId}`. Carries the frozen exit snapshot, earnings, recoveries, checklist, approval, payment and history. |
| `src/models/FinalSettlementFile.js` | 60 | Queued statement / register files. `binary` is `select: false`. |
| `src/utils/fnfPdf.js` | 425 | The F&F statement renderer — draws only, shares the 29.9/29.10 PDF design language. |
| `src/controllers/fnfController.js`, `src/routes/fnfRoutes.js`, `src/validators/fnfValidator.js`, `src/middlewares/fnfScope.js` | 413 / — / 152 / 29 | HTTP layer. Thin controllers; every rule lives in `fnfRules.js` or `fnfService.js`. |
| `src/workers/payrollProcessor.js`, `src/config/queueConfig.js` | — | `FNF_STATEMENT`, `FNF_REGISTER` processors registered on the existing payroll worker. |
| `scripts/fnfPreview.js` | 621 | `npm run fnf:preview` — real artefacts, no database. |
| `test/fnf.test.js` | 1278 | 36 hermetic tests. |

### Route table — 21 routes at `/api/payroll/fnf`

| Method | Path | Gate | § |
|---|---|---|---|
| GET | `/mine` | `FINAL_SETTLEMENT_READ_SELF` | 18 |
| GET | `/mine/statement` | `FINAL_SETTLEMENT_READ_SELF` | 18 |
| GET | `/dashboard` | read | 19 |
| GET | `/` | read | 19 |
| GET | `/register` | read | 21 |
| POST | `/register/export` | `FINAL_SETTLEMENT_READ` + write access | 21 |
| GET | `/files` | read | 21 |
| GET | `/files/:fileId` | read | 21 |
| POST | `/` | `FINAL_SETTLEMENT_CALCULATE` | 5 |
| GET | `/:settlementId` | read | 25 |
| POST | `/:settlementId/calculate` | `FINAL_SETTLEMENT_CALCULATE` | 7–12 |
| PATCH | `/:settlementId/items` | `FINAL_SETTLEMENT_CALCULATE` | 9, 10 |
| PATCH | `/:settlementId/notice` | `FINAL_SETTLEMENT_CALCULATE` | 12 |
| POST | `/:settlementId/hr-review` | `FINAL_SETTLEMENT_REVIEW` | 15 |
| POST | `/:settlementId/finance` | `FINAL_SETTLEMENT_APPROVE` | 16 |
| POST | `/:settlementId/pay` | `FINAL_SETTLEMENT_PAY` | 5 |
| POST | `/:settlementId/statement` | `FINAL_SETTLEMENT_CALCULATE` | 17, 21 |
| GET | `/:settlementId/statement/download` | read | 17 |
| POST | `/:settlementId/close` | `FINAL_SETTLEMENT_CLOSE` | 14 |
| POST | `/:settlementId/reopen` | `FINAL_SETTLEMENT_REOPEN` | 14 |

`read` = any of the seven settlement verbs + `requireFeature('payroll')` +
`fnfScope`. Every write path also passes `checkWriteAccess`.

`/mine` deliberately does **not** run the scope middleware: the employee id
comes from the JWT, so there is no id in the request to narrow — the strongest
form of tenant isolation there is.

### The workflow, and who may move it

| From | To | Permission | Guard |
|---|---|---|---|
| `DRAFT` | `CALCULATED` | `FINAL_SETTLEMENT_CALCULATE` | exit record present |
| `CALCULATED` | `HR_REVIEWED` | `FINAL_SETTLEMENT_REVIEW` | **checklist complete** (§15) |
| `HR_REVIEWED` | `FINANCE_APPROVED` | `FINAL_SETTLEMENT_APPROVE` | — |
| `FINANCE_APPROVED` | `PAID` | `FINAL_SETTLEMENT_PAY` | — |
| `FINANCE_APPROVED` | `CALCULATED` | `FINAL_SETTLEMENT_APPROVE` | **remarks required** (§16) |
| `PAID` | `CLOSED` | `FINAL_SETTLEMENT_CLOSE` | — |
| `CLOSED` | `REOPENED` | `FINAL_SETTLEMENT_REOPEN` | reason required |

Editing (`updateItems`, `setNoticeDecision`) is allowed in `DRAFT`,
`CALCULATED` and `REOPENED` only. `CLOSED` is locked.

---

## 3. The arithmetic

Every rule is **data** in `FNF_RULES`, not a constant in a React file or a
branch in a controller. When policy differs, finance changes a number in one
place.

| Figure | Rule | § |
|---|---|---|
| Payable days | `min(period.workingDays, day-of-LWD) − lopDays` | 7 |
| Daily rate | `snapshot gross ÷ workingDays` (fallback 30 days) | 7 |
| Pending salary | `payableDays × dailyRate` | 7 |
| Leave encashment | `min(unused EARNED days, cap) × dailyRate` — days, rate and cap all printed | 8 |
| Gratuity | `15/26 × last basic × credited years`, 5-year minimum, 6-month part-year rounding | 10 |
| Notice recovery | `shortfallDays × dailyRate`, zeroed when `WAIVED`, printed either way | 12 |
| Net settlement | `totalEarnings − totalRecoveries`; a negative is labelled *amount recoverable from the employee* rather than shown as a negative payment | 11 |

Gratuity here is **not** 29.10's gratuity. 29.10 provisions the *employer's*
monthly 4.81%; 29.11 pays the *employee's* statutory entitlement on exit. They
are different numbers and neither reads the other.

Settlement numbers are `FNF-YYYYMM-NNNN`, sequential per company per month.
Statement filenames are `<settlementNumber>-<Safe-Name>.pdf`.

---

## 4. Frontend

| File | Role |
|---|---|
| `src/pages/payroll/FinalSettlementPage.jsx` | Four tabs: **Dashboard** (six KPI cards that deep-link into the filtered list), **Settlements** (search + status + department), **Settlement Detail**, **Downloads**. |
| `src/pages/payroll/MyFinalSettlementPage.jsx` | §18 — the employee's own settlement: status in plain language, exit details, every earning and recovery with its arithmetic, the net, and the statement once paid. Read-only, no editing control anywhere. |
| `src/services/fnfService.js` | API client. No figure is ever computed in the browser. |
| `src/routes/AppRoutes.jsx`, `src/layout/AppLayout.jsx` | `/app/payroll/final-settlement` and `/app/payroll/my-final-settlement`, both permission-driven nav entries. |
| `src/pages/payroll/MyPayslipsPortalPage.jsx` | A pointer card on **My Payroll** when the signed-in employee has a settlement. |

Three things the admin page never does: it never computes a rupee, it never
lets HR approve a payment or Finance recalculate one (buttons are permission-
gated *and* re-checked server-side), and it never edits a closed settlement.

The create dialog is a **picker, not a text box**: it lists the resignations the
Exit module has already approved, and the last working day comes from that
record (§6). "Manual exit" is an explicit escape hatch for the case where no
resignation exists, and it asks for the date rather than pretending one.

---

## 5. Security (§3 / §24)

- **Tenant isolation** — `companyId` from the tenant context only; every query
  company-first; the unique index is `{companyId, exit.resignationId}`. A
  cross-tenant read is asserted to return nothing.
- **`employeeId` is never trusted from the browser** — §18 reads it from the
  JWT, so the employee portal cannot even express "someone else's settlement".
- **RBAC + scope** — seven verbs, 29.1 visibility resolution,
  `requireFeature('payroll')`, `checkWriteAccess` on every mutation.
- **Separation of duties** — the calculator does not approve, the approver does
  not calculate, and neither closes. `SEPARATION_OF_DUTIES_RULES` is asserted.
- **Queue payloads** — references only; `FORBIDDEN_KEYS` rejects a payload
  carrying `rows`, `totals`, `amount`, `netSettlement`…
- **Audit (§23)** — ten actions, each recording previous status, new status,
  actor and remarks: created, calculated, recalculated, HR reviewed, finance
  approved, finance rejected, paid, closed, reopened, statement downloaded.
- **Cache (§20)** — invalidated on calculate, HR review, finance decision,
  payment, close and reopen, including the employee's own key, so the portal
  cannot keep showing "HR Reviewed" after Finance has approved. Redis stays
  fail-open; MongoDB stays the source of truth.
- **PDF footer** — states in print that the document is computer-generated from
  payroll records.

---

## 6. Tests — 36 hermetic

`npm run test:fnf` (also in `test:payroll` and `test:all`).

Coverage: payable days follow the last working day and not a typed number; the
pending-salary arithmetic; leave encashment shown transparently **and** capped;
gratuity's five-year gate and its explanation when it does not apply; net
settlement including the negative case; all three notice decisions; every
recovery carrying an amount, a reason and an approver; the full transition table
with `CLOSED` terminal; the HR checklist gating Finance approval; rejection
requiring remarks; the settlement number and the filesystem-safe filename; the
six KPIs; search and department filters; the employee projection's exact key
set (and that it leaks nothing); `canDownload` only after payment; cache
invalidation on every status change; queue payload rejection; a real PDF's
rendered text; the register row shape; the audit trail's twenty entries; the
payment notification; and **cross-tenant denial**.

---

## 7. Seeing it without a database

```powershell
cd Backend
npm run fnf:preview
```

Real rules, real CSV/XLSX/PDF writers, fake in-memory models — no MongoDB,
Redis, SMTP or worker. Writes to `Backend/.preview/fnf/` (gitignored):

- three F&F statements as **PDF** (a standard exit, a negative settlement, and
  a long-service exit with gratuity)
- the settlement register as **CSV** and **XLSX**

…then prints seven checks: payable days, the three figures, gratuity's gate,
the net for all three employees, cross-tenant isolation, the audit tally and
the payment notifications.

Current figures: **Meera Rs 1,77,192.31**, **Vikram Rs −44,257.96** (rendered
"amount recoverable from the employee"), **Asha Rs 4,56,455.20**.

**Run it after any change to a figure, a formula or the PDF.** In 29.9, 29.10
and again here, the preview generator caught defects every unit test passed
straight over.

---

## 8. Manual testing checklist

See `docs/PHASE_29_11_TESTING_CHECKLIST.md`.

---

## 9. Fences (§26) — deliberately not built

Bank API integration, government gratuity portal, digital signatures, legal
document generation, **experience letter**, **relieving letter**.

The F&F statement is an accounting document produced from payroll records. It is
not a relieving letter, and Crewly does not issue one.
