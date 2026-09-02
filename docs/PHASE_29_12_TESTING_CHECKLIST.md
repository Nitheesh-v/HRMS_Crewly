# Phase 29.12 — Payroll Analytics: manual testing checklist

Automated: `npm run test:analytics` (42 tests), `npm run test:all` (786 tests),
`npm run analytics:preview` (36 artefacts). This checklist is what a human
still has to look at — the things a unit test cannot see.

Run the stack first:

```powershell
# terminal 1
cd Backend; npm run dev
# terminal 2
cd Frontend; npm run dev
```

Analytics reads data every earlier phase owns. Work through the list top to
bottom.

---

## 0. Before you start

- [ ] `npm run test:all` in `Backend` reports **777 pass / 0 fail**.
- [ ] `npm run analytics:preview` completes and leaves 36 files in
      `Backend/.preview/analytics/`.
- [ ] `npm run build` in `Frontend` completes with no error.
- [ ] Open three preview artefacts (one CSV, one XLSX, one PDF). Confirm the
      figures agree **across formats** — they are built from the same table.
- [ ] Open a preview PDF. Confirm the company header, the report title, a
      repeating table header across pages, and a row count in the footer.

---

## 1. Permissions (§4)

- [ ] Log in as a **Company Admin**. Settings → Roles & Permissions shows
      `PAYROLL_ANALYTICS_FINANCIAL` and `PAYROLL_ANALYTICS_SCHEDULE`.
- [ ] The permission version auto-upgraded (25 → 26); no manual migration step
      was needed.
- [ ] Confirm **Finance Manager** has both new verbs and **HR Manager** has
      neither (HR keeps `PAYROLL_REPORT_READ` / `_EXPORT`).
- [ ] Log in as an **Employee**. Payroll → **Analytics & Reports** does not
      appear in the sidebar.
- [ ] As an employee, open `/app/payroll/analytics` directly. The page shows
      the access-denied card, and the network tab shows a 403 — not an empty
      dashboard.

---

## 2. Executive Dashboard (§5 / §6)

- [ ] Open Payroll → **Analytics & Reports**. The eight KPI cards render:
      total payroll cost, net salary paid, gross salary, employer contribution,
      employees paid, average salary, highest department cost, total statutory
      liability.
- [ ] Switch the month. Every card changes together — no card keeps last
      month's number.
- [ ] The "highest department cost" card names the department you expect from
      the payroll register.
- [ ] Press **Refresh**. A banner confirms either "refreshed" or "queued".
- [ ] Compare "Total payroll cost" against **Run Payroll → Review** for the
      same month. They must match.
- [ ] Pick a month that has overtime or variable pay. **Gross salary must be
      bigger than net salary paid** — if net sits above gross, the totals are
      being mixed (structure earnings against a net that includes overtime).
- [ ] "Average salary" is gross ÷ employees paid. Sanity-check it against the
      gross card, not against take-home.
- [ ] Read the Headcount & Cost card: active / joined / exited are real counts
      from the employee and exit records. In a month with no joiners and no
      leavers all three should still show the *active* headcount, never zero.

---

## 3. Reports (§6 – §17)

For each report page, confirm the month switcher, the department filter and
the export menu behave identically.

- [ ] **Payroll Overview** — gross, net, deductions, employer cost, paid
      employees, settlements and payroll accuracy.
- [ ] **Department Analytics** — departments are sorted by the **highest**
      payroll cost, and the total row ties to the dashboard.
- [ ] **Salary Distribution** — the five bands appear even when empty; the
      shares add up to 100%; an employee on exactly 25,000 sits in the 25–50K
      band and one on 62,000 in the 50–75K band.
- [ ] **Payroll Trends** — switch Monthly / Quarterly / Yearly. Each quarterly
      bar equals the three months it covers.
- [ ] **Bonus Report** — only employees who actually drew variable pay appear;
      no rows of zeroes.
- [ ] **Overtime Report** — hours and cost match the payroll snapshot. Widen
      the month and confirm a month with no overtime shows the empty state, not
      an error.
- [ ] **Statutory Summary** — PF, ESI, PT, TDS, LWF. **PT and TDS show no
      employer share.** Gratuity appears as a provision, outside the total
      liability.
- [ ] **Payroll Register** — every employee appears **once**. An employee
      whose transfer failed and was retried shows the successful payment date.
- [ ] Switch to a month with **no payroll**. Every page shows an empty state,
      never a crash and never a table of zeroes.

---

## 4. Cost to Company (§16) — Finance only

- [ ] As **Finance Manager**, Payroll Overview shows the CTC block with gross,
      employer PF, employer ESI, gratuity, other benefits and a total.
- [ ] The total equals **gross + employer contribution** from the dashboard.
- [ ] As **HR Manager**, the CTC block is replaced by a message saying it is
      restricted to Finance.
- [ ] As HR Manager, open the browser console and try
      `GET /api/payroll/analytics/CTC`. The server answers **403** — the gate is
      server-side, not a hidden tab.

---

## 5. Exports (§19)

- [ ] Export **Department** to CSV, XLSX and PDF. All three open, all three
      carry the same rows, and the filename names the month.
- [ ] Open an XLSX in Excel/LibreOffice — it is a real workbook, not a renamed
      CSV.
- [ ] On the **Payroll Register**, press Export → **Queue large export**. A row
      appears under "Generated files" and its **Download** button works.
- [ ] Try an unsupported format (`?format=WORD`). The API answers **400**; it
      does not silently fall back to CSV.
- [ ] Export the **Payroll Register** for a company big enough to run to three
      pages. Every page repeats the column header — page 2 must not be a wall
      of unlabelled numbers — and the footer says how many rows the register
      holds.
- [ ] Export **Bonus & Incentive** for a month with a festival or performance
      bonus. The `Bonus` column is populated, and `Bonus + Other Variable +
      Overtime + Reimbursements` equals `Total Variable`.
- [ ] Export **Headcount & Cost**. "Active Employees" is not 0.

---

## 6. Scheduled reports (§20)

- [ ] As **Company Admin** or **Finance**, open **Scheduled Reports**.
- [ ] Create "Monthly payroll summary", monthly on day 3, XLSX, notifying
      everyone who can read payroll reports.
- [ ] The new row shows a **next run** date in the future — a schedule created
      on the 2nd for the 3rd arms for **tomorrow**, not next month.
- [ ] Wait for the scheduled time (or run the worker with a shortened delay).
      Confirm: the run count becomes 1, the last-run status is SUCCESS, and
      **Download** returns the file.
- [ ] The next-run date moved forward **one period**, never back onto the day
      it just ran.
- [ ] The notification arrived for **every current** holder of the chosen
      permission. Remove the permission from one user, run again, and confirm
      they are no longer notified — the audience is resolved at run time.
- [ ] Pause a schedule. Resume it. Delete one.
- [ ] **Restart the backend** with a schedule already due. The worker sweeps
      it on startup and runs it — a Redis restart does not silently stop a
      CFO's report.
- [ ] As **HR Manager**, the Scheduled Reports page shows the access-denied
      card.

---

## 6b. Notifications (§23)

- [ ] Queue a large register export. When it finishes, the requester gets an
      in-app notification: "Payroll report ready", naming the report and the
      format, linking to the analytics dashboard.
- [ ] Trigger a scheduled report. Every current holder of the chosen
      permission receives "Scheduled report generated".
- [ ] Remove the permission from one of those users, run the schedule again,
      and confirm they are **not** notified — the audience is resolved at run
      time, never frozen at creation.
- [ ] Refresh the executive dashboard from the worker. Company Admin and
      Finance receive "Executive dashboard updated", naming the month.

## 7. Cache correctness (§21)

- [ ] Load the dashboard for a month. Note "Total payroll cost".
- [ ] Approve or recalculate payroll for that month in another tab.
- [ ] Reload the dashboard. The figure **changed** — the analytics cache was
      dropped with the payroll cache.
- [ ] Repeat with a final settlement, then with a statutory update.
- [ ] Load the dashboard unfiltered, then filter it to one department, then
      clear the filter. The unfiltered figures are unchanged — a filtered read
      gets its own cache entry and must not overwrite the whole-company one.

---

## 8. Security spot-checks (§25)

- [ ] Create two companies with payroll. In company A, confirm no report, file
      or schedule from company B ever appears.
- [ ] Copy a file id from company A and request it while logged into company B.
      The API answers **404**.
- [ ] As a manager scoped to two departments, the dashboard totals only those
      departments — not the whole company.
- [ ] Settings → Audit log shows: report generated, report exported, scheduled
      report created, scheduled report executed, dashboard refreshed — each
      with company, user, report type, timestamp and format.

---

## 9. Known deviations

- [ ] **§18 cost centre and location filters are not implemented.** `User`
      carries no `costCenter` or `location` field. Recorded, needs a schema
      change.
- [ ] **§9 headcount, §14 leave impact and §16 CTC share pages** with the
      Executive Dashboard and Payroll Overview, because §26 lists ten pages and
      these three are not among them.

---

## 10. Fences (§27) — nothing here on purpose

- [ ] No AI salary prediction.
- [ ] No market salary benchmark API.
- [ ] No Power BI integration.
- [ ] No government BI portal integration.
- [ ] No external accounting sync.
