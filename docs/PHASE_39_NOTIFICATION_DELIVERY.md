# PHASE 39 — NOTIFICATION DELIVERY & TENANCY REPAIR

Status: **implemented, tested, pushed.**
Owner authorisation: "ok start phase 39" (2026-10-07), after
`docs/NOTIFICATION_DELIVERY_FINDINGS.md` (commit `be8bdec`).

The bell is the only channel that tells an employee something happened to their
leave, payroll, task, expense, document, appraisal, attendance or profile
request. Phase 39 makes that channel write the truth: the **recipient's own
tenant**, the **caller's category**, and **nothing borrowed from another row**.

---

## A. REPOSITORY FINDINGS

| # | Finding | Evidence |
|---|---|---|
| A1 | `notifySmart` (31 call sites / 30 files, including Phase 38's `profileChangeService`) can **never** succeed on its two correct-arity attempts. Both call `notifyUser` with the wrong shape, throw inside, and the ladder falls through. | `utils/notifyPref.js` stages 1–2 |
| A2 | Stage 3 `writeViaTemplate()` clones **the newest `Notification` row in the whole database** and overwrites only user/title/message/link/read. **Proven**: a `LEAVE` notification written for an employee came out with `companyId = OTHER_TENANT_COMPANY_ID`, `type = RECRUITMENT`, and another user's `eventKey`. | reproduction harness, recorded in the findings doc |
| A3 | Consequences: (a) every `notifySmart` row carries a **foreign tenant id**, (b) the inherited `eventKey` can trip the unique `{ companyId, eventKey }` partial index and silently drop a legitimate notification, (c) the inherited `type` mislabels the bell, (d) with no rows in the collection, **all 31 call sites go silent**. | `models/Notification.js` index; `notifyPref.js` stage C |
| A4 | `projectController` and `taskController` call `notifyUser(userId, payload)` directly — same arity bug, **no fallback at all**. Project creation/management and every task assignment, reassignment, review and comment notification has never been delivered. | `projectController.js:23` (+ 5 sites), `taskController.js:32` (+ 7 sites) |
| A5 | `notifyUser` / `notifyUsers` / `notifyRoles` themselves are **correct** (3-arg, tenant-scoped, `notifyRoles` filters `status: 'ACTIVE'`) and are used correctly by 12 other files. The bug lives in the callers and in `notifyPref`, not in `utils/notify.js`. | call-site sweep (all 41 sites reviewed) |
| A6 | The bell reads by `user` alone (`myNotifications`, `unreadCount`), which is why A3 was invisible. Tenant-scoping the read **now** would hide every already-mis-stamped row until the backfill runs — so the read stays as-is in this phase (documented decision, §C7). | `platform/systemController.js` |
| A7 | **Zero tests** cover `notifySmart` / `notifyPref` / `writeViaTemplate`; nothing guards the bell's write path at all. | `grep -rl notifySmart test/` → empty |
| A8 | Rows already written by the clone carry a foreign `companyId` in the live database. They need a **one-off, opt-in repair** — this is data, not code, so it ships as a script the owner runs, not as a migration that fires on boot. | new script, §C4 |
| A9 | `fnfService.js` / `statutoryService.js` / `analyticsService.js` define their **own** local `notifyUser` / `notifyRoles` helpers (different signatures, different delivery path). Out of scope here; they are not broken by this change and are not touched. | `grep -n "const notifyUser" src/services/payroll/*.js` |

## B. SECURITY / DATA BOUNDARIES

* **Tenant integrity is the whole point of this phase.** A notification must be
  stamped with the tenant of its **recipient**, never with a value copied from
  an unrelated document. Before this phase, cross-tenant copying was the
  *normal* path.
* **No PII in logs**: the repair script prints counts and document ids only —
  never titles, names, emails or message bodies.
* **Least surprise on mute**: a muted category still writes nothing (existing,
  correct behaviour, pinned).
* **No new dependencies.** No Redis/Mongo needed by the tests. No change to
  `utils/notify.js`'s public contract, so the 12 correct callers keep working
  untouched.
* **Not touched:** Attendance, Leave, Payroll, AI logic, the bell's read API,
  the notification preferences UI, and the local payroll/analytics helpers (A9).

## C. IMPLEMENTATION

1. **`utils/notifyPref.js` — a real write path.**
   Resolve the recipient **once** (`User.findById(...).select('name email companyId')`)
   and use that `companyId` for the write. Delete the three-stage ladder and
   `writeViaTemplate()` entirely (it is cross-tenant by construction and cannot
   be made safe). A recipient with no resolvable company is skipped with a warn —
   never written with a guess. Keep both laws: it **never throws**, and it still
   queues email in the background when the email preference is on.
2. **`projectController.js`** — helper becomes `notify(companyId, userId, payload)`;
   its 5 call sites pass `req.companyId`.
3. **`taskController.js`** — same shape; its 7 call sites pass `req.companyId`.
4. **`scripts/notifications-repair.js` (new, owner-run).** Dry-run by default:
   aggregating `Notification` × `User` to find rows whose `companyId` differs
   from the recipient's, plus orphaned rows (recipient deleted). `--apply`
   rewrites the mismatched rows to the recipient's tenant and **clears the
   inherited `eventKey`** (it belonged to a different logical event, and leaving
   it risks a duplicate-key drop once rows share a tenant). Idempotent, no
   deletes, exit 1 on dry-run findings so it can gate a checklist.
   `npm run notifications:repair`.
5. **`test/notificationDelivery.test.js` (new, hermetic).** Pins the primitives
   (`notifyUser` / `notifyUsers` / `notifyRoles`), the regression (a
   `notifySmart` write carries the **recipient's** tenant, never a sample row's),
   the absence of the clone, mute behaviour, the unknown-recipient skip, the
   email queue, the two controllers' writes, and a source pin that
   `writeViaTemplate` cannot come back.
6. **`package.json`** — `test:notifications`, and the new file joins `test:all`.
7. **Deliberate non-change:** the bell's read stays `{ user }` (A6). Scoping it
   to a tenant before the backfill would make every mis-stamped row disappear
   from people's bells. Recorded as a follow-up the owner can take after the
   repair, together with the `{ user, companyId }` index that would serve it.

## D. TEST PLAN

* Every model call stubbed; no Mongo, no Redis, no timers left running.
* The regression test must fail on the pre-Phase-39 tree — verified by running
  the new suite against the old `notifyPref.js` (expect the cross-tenant and
  clone assertions to fail).
* Full gate: backend `test:all` (expect **+N** tests, 0 fail), frontend
  `npm test`, `npm run build`, `git diff --check`.
* The repair script is exercised **hermetically** against a stubbed model layer
  (no live database): finding rows, and what `--apply` writes.

## E. ENVIRONMENT / DEPENDENCIES

No new packages. The tests need nothing installed beyond the repo's existing
`node --test`. The repair script needs the owner's MongoDB only when **they**
run it, against their own `MONGO_URI`, and defaults to a dry run.
**Nothing about acceptance is claimed**: the owner's click-path verification is
listed at the end of the phase doc.


---

## F. RESULTS

### Files

| File | Change |
|---|---|
| `Backend/src/utils/notifyPref.js` | **rewritten write path.** The three-stage cascade and `writeViaTemplate()` are gone. The recipient is resolved once (`name`, `email`, `companyId`) and the bell row is written through `utils/notify.js` with **that** tenant. A recipient with no resolvable company is skipped with a warn — never written with a guess. Both laws kept: never throws, still queues email in the background. |
| `Backend/src/utils/notify.js` | `notifyUsers` trims ids and drops uncastable ones. One whitespace id used to make `insertMany` throw, and the catch then dropped the **whole batch** — every recipient lost the notification. |
| `Backend/src/controllers/projectController.js` | helper is `notify(companyId, userId, payload)`; 4 call sites pass `req.companyId` |
| `Backend/src/controllers/taskController.js` | same; 6 call sites pass `req.companyId` |
| `Backend/src/utils/notificationRepair.js` | **new** — the repair's decision rules as pure functions (classification + the update it writes) |
| `Backend/scripts/notifications-repair.js` | **new** — owner-run, idempotent, dry-run by default, `--apply` to write, no deletes, counts and ids only (no titles/emails) |
| `Backend/test/notificationDelivery.test.js` | **new** — 20 hermetic tests |
| `Backend/package.json` | `test:notifications`, `notifications:repair`; the test file joined `test:all` |

### Evidence

* **The pins bite.** Run against the pre-Phase-39 tree, **8 of 20** tests fail,
  including the regression itself ("the in-app row carries the recipient's own
  companyId, not a sample row's"), both controller tests, and the two source
  pins. Green on the fixed tree.
* Backend `test:all` → **3351 tests / 178 suites / 0 fail** (3331 + 20).
  Focused: `test:notifications` 20, `test:meetings` 24, `test:profile-changes` 31.
  Frontend `npm test` → **397 / 0 fail**; `npm run build` clean; `git diff --check` clean.
* The repair script exits **2** with a clear message when `MONGO_URI` is missing
  or the database is unreachable (fail-fast at 8s, not a 30s stare), and writes
  nothing in a dry run. Its decision rules are unit-tested.

### One trap worth knowing (found while testing)

`utils/emailQueue.js` starts a 5-second `setInterval` the first time anything is
queued, and a running interval keeps a Node process alive — so a test that hands
`notifySmart` an email address AND leaves email enabled will hang
`node --test` forever. The test file documents this and pins the email decision
through the pure `buildEmailJob()` helper instead of the transport. Left as-is
in production (the API server keeps the loop alive anyway); changing it is a
separate decision.

### Deliberately NOT done

* The bell's read is still `{ user }` (`systemController`). Scoping it to a
  tenant *before* the backfill would make every already-mis-stamped row vanish
  from people's bells. After the owner runs the repair, this becomes safe and
  worth doing — together with a `{ user: 1, companyId: 1, createdAt: -1 }` index.
* `fnfService` / `statutoryService` / `analyticsService` keep their own local
  notify helpers (different signatures, different delivery path). Untouched.

## G. OWNER STEPS (Windows PowerShell)

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly
git pull origin arena/379846ae-hrms-crewly

# restart the backend, then hard reload the browser (Ctrl + Shift + R)
cd Backend
npm run dev
```

1. **New notifications now arrive.** Assign a task to an employee → their bell
   shows "📝 New task assigned". Create a project with someone else as manager →
   "📁 You are the Project Manager". Neither has ever worked.
2. **Existing notifications still show.** A leave/expense/payroll approval still
   rings the bell exactly once, unchanged from your point of view.
3. **Repair the history** (safe, dry run first):

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run notifications:repair                 # dry run — counts only, writes nothing
npm run notifications:repair -- --apply      # rewrite the mismatched rows
npm run notifications:repair                 # now reports nothing to repair
```

Exit code 1 on the dry run means "there is something to repair" — that is the
expected result on a database used before today. Exit 0 means nothing to do.
Nothing is ever deleted; rows whose recipient no longer exists are reported and
left alone.

**Not owner-accepted.** Everything above is hermetic test evidence plus a
verification checklist; the clicks are yours.
