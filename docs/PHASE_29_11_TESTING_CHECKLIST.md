# Phase 29.11 — Final Settlement: manual testing checklist

Automated: `npm run test:fnf` (36 tests), `npm run test:all` (741 tests),
`npm run fnf:preview` (7 checks). This checklist is what a human still has to
look at — the things a unit test cannot see.

Run the stack first:

```powershell
# terminal 1
cd Backend; npm run dev
# terminal 2
cd Frontend; npm run dev
```

Seed order matters. Final settlement reads data the earlier phases own, so work
through this list top to bottom.

---

## 0. Before you start

- [ ] `npm run test:all` in `Backend` reports **741 pass / 0 fail**.
- [ ] `npm run fnf:preview` reports **All checks passed** and leaves five files
      in `Backend/.preview/fnf/`.
- [ ] `npm run build` in `Frontend` completes with no error.
- [ ] Open the three preview PDFs. Confirm: employee details, exit details, the
      arithmetic under every earning, recoveries listed **separately** from
      salary, the net strip, and the approval trail.

---

## 1. Permissions (§4)

- [ ] Log in as a **Company Admin**. Settings → Roles & Permissions shows the
      seven `FINAL_SETTLEMENT_*` verbs plus `FINAL_SETTLEMENT_READ_SELF`.
- [ ] The permission version auto-upgraded (24 → 25); no manual migration step
      was needed.
- [ ] Confirm the template grants:

| Role | Expect |
|---|---|
| HR Manager | READ, REVIEW |
| Payroll Admin | READ, CALCULATE, REVIEW |
| Finance Manager | READ, APPROVE, PAY |
| Finance Executive | READ only |
| Company Admin | all seven |
| Employee | READ_SELF |

- [ ] **Separation of duties:** as Payroll Admin, the Approve and Mark-paid
      buttons are absent. As Finance Manager, Calculate and the item editor are
      absent. As HR Manager, both are absent.
- [ ] Editing a role to remove `FINAL_SETTLEMENT_READ` makes the sidebar entry
      disappear on next load.

---

## 2. The exit exists first (§5 / §6)

- [ ] As an employee, resign (Exit module). As HR, approve it.
- [ ] Payroll → Final Settlement → **New settlement**. The approved resignation
      appears in the picker with its last working day shown.
- [ ] Pick it and create. The settlement opens in `DRAFT`.
- [ ] **The picker never asks you to type an employee id or a last working day**
      — that is the §6 rule made visible.
- [ ] Try creating the same settlement twice. The second attempt is refused with
      a readable message, not a stack trace.
- [ ] Try "Manual exit": pick an employee, enter a last working day, create.
      Confirm it also works and that the date you entered is the one used.

---

## 3. Calculation (§7 – §13)

- [ ] Click **Calculate**. Status becomes `CALCULATED`.
- [ ] **Payable days equals the day-of-month of the last working day**, minus
      any LOP days. Nobody typed it.
- [ ] Pending salary = payable days × daily rate, and the page prints the
      multiplication.
- [ ] Leave encashment prints days × rate, and is **capped** at the company's
      policy — with the cap stated when it bites.
- [ ] Gratuity:
  - [ ] under five years → not payable, with the reason on screen;
  - [ ] over five years → 15/26 × basic × credited years.
- [ ] Notice decision: try all three.
  - [ ] `COMPLETED` → no recovery, and the statement says the full notice was
        served.
  - [ ] `BUYOUT` → shortfall × daily rate recovered.
  - [ ] `WAIVED` → shortfall shown but the amount is zero, and it says the
        company waived it.
- [ ] Add a recovery (asset / cafeteria / advance / other). **Amount and reason
      are both enforced** — a recovery without a reason is refused.
- [ ] Add an additional payable (bonus / incentive / reimbursement / overtime).
- [ ] Remove an item and confirm the totals move with it.
- [ ] **Recoveries appear in their own section, never mixed into salary
      deductions.**
- [ ] Net settlement = total earnings − total recoveries.
- [ ] Construct a case where recoveries exceed earnings: the page and the PDF
      both say **"amount recoverable from the employee"** in red rather than
      showing a negative payment.
- [ ] Asset clearance shows what the employee still holds, read from the Asset
      module. Assets are **not** editable here.
- [ ] Cross-check the net against the preview generator's figure for the same
      fixture.

---

## 4. HR review (§15)

- [ ] With an incomplete checklist, "Send to Finance" is refused. Tick all four
      boxes and it succeeds.
- [ ] Status becomes `HR_REVIEWED`.
- [ ] As HR, "Save" without completing stores the checklist without moving the
      settlement.
- [ ] The reviewer's name and timestamp appear under the checklist.
- [ ] **As HR Manager, the Finance section is not visible** — no Approve, no
      Mark paid.

---

## 5. Finance (§16)

- [ ] As Finance Manager, approve. Status becomes `FINANCE_APPROVED`.
- [ ] Reject **without remarks** → refused.
- [ ] Reject with remarks → status returns to **`CALCULATED`** (not HR
      Reviewed), which is the only state where the figures can be corrected.
      The remarks are visible in the history.
- [ ] Correct the settlement, recalculate, re-review, re-approve — the full
      loop works and every step is in the history.

---

## 6. Payment and the statement (§5 / §17)

- [ ] Mark paid with a date and a reference. Status becomes `PAID`.
- [ ] The employee receives a notification linking to **My Final Settlement**.
- [ ] Generate the statement, then download it.
- [ ] The PDF shows: employee details, exit details, every earning with its
      arithmetic, recoveries separately, the net, and the approval trail.
- [ ] **It does not look like a monthly payslip** — no month's attendance grid,
      no YTD column.
- [ ] The footer states the document is computer-generated from payroll records.

---

## 7. Employee portal (§18)

- [ ] Log in as the exiting employee. **My Payroll** shows a Final Settlement
      card; clicking it opens **My Final Settlement**.
- [ ] The page shows status in plain language ("HR has completed the review…"),
      not just a status code.
- [ ] Exit details, earnings with their arithmetic, recoveries with their
      reasons, and the net are all present.
- [ ] **There is no editing control anywhere on the page.**
- [ ] Download is **disabled until the settlement is paid**, with a tooltip
      saying why.
- [ ] After payment the download enables and the PDF downloads.
- [ ] Log in as a *different* employee: they cannot see this settlement, and no
      request they can craft reaches it.

---

## 8. Dashboard, filters, exports (§19 / §21)

- [ ] Six KPI cards: Pending, HR Review, Finance Approval, Paid, Closed, Total
      Settlement Amount.
- [ ] Clicking a KPI card opens the Settlements tab **filtered to that status**.
- [ ] Search by name, employee code and settlement number.
- [ ] Filter by department — the dropdown only lists departments that actually
      have a settlement.
- [ ] Month filter defaults to **All months**, so no settlement is hidden.
- [ ] Download the register as CSV. Column order matches
      `docs/PHASE_29_11_FINAL_SETTLEMENT.md` §3 and the figures tie to the
      detail pages.
- [ ] Export XLSX: the job appears under **Downloads**, and the file downloads
      when ready.
- [ ] Stop Redis and export again: the export still completes (inline
      fallback). Start Redis and confirm it works queued again.

---

## 9. Close and reopen (§14)

- [ ] As Company Admin on a `PAID` settlement, close it. Status `CLOSED`.
- [ ] Every editing control disappears. Attempting an edit server-side returns
      "A closed settlement cannot be edited" — check the network tab, not just
      the UI.
- [ ] Reopen with a reason. Status `REOPENED`; editing works again.
- [ ] The history shows close and reopen **with the reason**, in order.

---

## 10. Cross-tenant and audit (§3 / §23)

- [ ] Company A cannot see, open, export or download Company B's settlement by
      any id.
- [ ] Company B's register is empty.
- [ ] Security / Audit log shows every action from this session with previous
      status, new status, actor and remarks.

---

## 11. Regression sweep

- [ ] Existing payroll pages still load: Setup, Components, Structures,
      Employee Salary, Monthly Inputs, Run Payroll, Review, Payment, Payslips,
      Statutory Compliance.
- [ ] The sidebar has not grown a new group — Final Settlement lives under
      **Payroll**.
- [ ] `npm run test:all` still reports 741 pass / 0 fail.

---

## Sign-off

| Area | Tester | Result |
|---|---|---|
| Permissions & RBAC | | |
| Calculation | | |
| HR + Finance workflow | | |
| Statement PDF | | |
| Employee portal | | |
| Exports | | |
| Close / reopen | | |
| Tenant isolation & audit | | |
