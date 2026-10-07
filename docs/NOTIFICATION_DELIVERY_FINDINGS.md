# NOTIFICATION DELIVERY — FINDINGS (audit only, nothing fixed, nothing authorized)

Raised while fixing the Meetings page: that controller called
`notifyUser(userId, payload)`, which is the wrong shape for
`utils/notify.js` (`notifyUser(companyId, user, { type, title, message, link })`).
The third argument destructured `undefined`, threw **before** `notifyUser`'s own
try/catch, and the caller's catch swallowed it — every meeting invite, update,
cancellation and reminder was silently dropped. That one file is fixed and
pushed (`adef7eb`).

This note records what the same sweep found **elsewhere**, because the same two
shapes are used by ~30 more files.

---

## 1. `notifySmart` — 31 call sites, all falling through to a cross-tenant clone

`utils/notifyPref.js` exports `notifySmart(userId, { title, message, link, category })`,
used by 30 files (leave, payroll, attendance, assets, expenses, performance,
documents, announcements, chat mentions, shift, lifecycle, subscription
lifecycle/watchdog, and **`services/profile/profileChangeService.js` from
Phase 38**).

Its in-app ladder is:

1. `notifyUser(userId, { type, title, message, link })` — **wrong arity**, throws.
2. `notifyUser({ user: userId, type, ... })` — **also wrong arity**, throws.
3. Stage C `writeViaTemplate()` — clone the newest `Notification` in the
   **entire database** and overwrite only user/title/message/link/read.

Step 3 "works" only because the bell feed is read with `{ user }` alone.

**Proven, not asserted.** Hermetic harness (`Notification.findOne` returning a
row that belongs to another tenant, `Notification.create` capturing the write):

```
📣 [notifySmart] in-app ✔  → EMPLOYEE_USER_ID "Your leave was approved"  (template-clone ⚠️)

{
  "companyId": "OTHER_TENANT_COMPANY_ID",   ← another tenant's company
  "user": "EMPLOYEE_USER_ID",
  "type": "RECRUITMENT",                    ← the sample's category, not "LEAVE"
  "title": "Your leave was approved",
  "message": "2 days approved",
  "link": "/app/leaves",
  "eventKey": "interview-reminder:2026-10-07:someoneElse"   ← another tenant's, another user's
}
```

### Consequences

| # | Consequence | Why it matters |
|---|---|---|
| 1 | Every `notifySmart` notification is stamped with **another tenant's `companyId`** | The model indexes `{ companyId, eventKey }` (unique, partial) and any tenant-scoped read/report/preference path is now wrong. It is invisible only because the bell reads by `user`. |
| 2 | The clone keeps the sample's **`eventKey`** | The partial unique index `{ companyId, eventKey }` can now **reject a legitimate notification** (duplicate key → `create` throws → `notifySmart` logs "in-app ✖" → dropped). Deliverability depends on unrelated tenants' rows. |
| 3 | The clone keeps the sample's **`type`** and every other field | Wrong icon/category in the bell, and any tenant data present on the sample row is copied into another tenant's document. |
| 4 | If the newest `Notification` row is deleted, or the DB has none, `writeViaTemplate` returns false | **All** `notifySmart` in-app notifications stop entirely — 31 call sites, no error surfaced to the API caller. |
| 5 | Correct-arity writes were never exercised | Which is why nobody noticed: the fallback produced a plausible-looking row. |

**Zero tests** cover `notifySmart` / `notifyPref` / `writeViaTemplate`.

## 2. `notifyUser` with two arguments — same bug, no fallback, dead

| File | Call | Effect |
|---|---|---|
| `controllers/projectController.js:23` | `notifyUser(userId, payload)` | Every project notification is dropped: PM assigned, team lead added, member added (`:265`, `:269`, `:272`) |
| `controllers/taskController.js:32` | `notifyUser(userId, payload)` | Every task notification is dropped: task assigned, reassigned, submitted for review, status change, comment (`:200`, `:235`, `:280`, `:288`, `:311`, `:313`) |

Both files import from `utils/notify.js`, both wrap the call in a `try/catch`, so
the `TypeError` is swallowed and **nothing is written at all** — no clone, no
log, no bell. These are the two features where the notification *is* the
feature: assigning work is how people find out they have work.

## 3. What is NOT affected

* `controllers/meetingController.js` — fixed in `adef7eb`.
* `fnfService.js`, `statutoryService.js` — they define their own local
  `notifyUser({ userId, type, payload })` wrapper and do not touch
  `utils/notify.js`. (Whether that wrapper delivers correctly is a separate
  question for the repair unit.)
* The direct-arity callers (`userController` welcome, `exitController`,
  `billingController`, chat mentions, the recruitment services) pass three
  arguments and are structurally correct.

## 4. A repair unit would have to

1. Give `notifySmart` a **first-class write path**: resolve the recipient's
   `companyId` (they are the same tenant as the caller) and call
   `notifyUser(companyId, userId, payload)` — the ladder's stages 1–2 disappear.
2. Delete `writeViaTemplate` and its "clone any row" strategy: it is
   cross-tenant by construction and cannot be made safe.
3. Fix the two `notifyUser(userId, payload)` call sites.
4. Attempt the real write **without swallowing** the reason (log at warn with
   the recipient and category), so a future arity break is visible in one line.
5. Pin it: hermetic tests that (a) a `notifySmart` write carries the recipient's
   own `companyId`, (b) `eventKey` is never inherited, (c) a mute preference
   still suppresses, (d) project/task assignment writes exactly one row.
6. Decide, with the owner, what to do about rows already written with a foreign
   `companyId` (a one-off backfill or `eventKey: null` reset).

## 5. Status

**Not authorized, no code changed for anything in this note.** It exists so the
finding is not lost between sessions. Repair, if chosen, needs its own single
build plan (A–E) and the owner's go-ahead.
