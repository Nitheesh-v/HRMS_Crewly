# MEETINGS PAGE — FIX PLAN (owner report: "editing was not working" + "the meeting link opens as localhost/…")

Status: **implemented, tested, pushed.** No phase number: this is a defect unit
on an existing feature (Meetings, Phase 9/10 era), not new scope.

Owner's report, verbatim:

> there is an error in meeting page , editing was not working, and if we opening
> the meeting link it opens with localhost with /meeting link so it does not
> opening ,fix that

Two symptoms, one page: `Frontend/src/pages/meetings/MeetingsPage.jsx` driving
`Backend/src/controllers/meetingController.js`.

---

## A. REPOSITORY FINDINGS

Audited before touching anything:

| # | Finding | Evidence |
|---|---|---|
| A1 | The **Join Meeting** anchor renders the stored link **raw**: `<a href={selected.link}>`. A link typed without a scheme (`meet.google.com/abc-defg-hij`) is resolved by the browser as a **relative path** against the app origin → `http://localhost:5173/meet.google.com/abc-defg-hij` (in the deployed build: `https://<host>/meet.google.com/…`). Nothing rejects it, so the meeting never opens. | `MeetingsPage.jsx` detail modal |
| A2 | The backend stores `link` **verbatim** (`meeting.link = link`, no normalisation), so every client re-inherits the same broken value. `link` has no model validation beyond `type: String`. | `meetingController.js` create + update; `models/Meeting.js` |
| A3 | **Every meeting notification is silently dropped.** The controller's helper calls `notifyUser(userId, payload)` but the real signature is `notifyUser(companyId, user, { type, title, message, link })`. The third argument destructures to `undefined` → `TypeError`, thrown *before* `notifyUser`'s own `try`, swallowed by the controller's `notify()` catch. Invites, updates, cancellations and reminders have therefore never rung the bell. | `controllers/meetingController.js` vs `utils/notify.js` |
| A4 | `updateMeeting` **does not validate the title**, unlike `createMeeting`. `meeting.title = ''.trim()` reaches `save()`, where `title: required` + `trim` raises a Mongoose `ValidationError` → **500** to the client. An all-whitespace edit is the worst case: the request looks correct, the save explodes, and the UI can only show "Could not save meeting". | `updateMeeting` vs `createMeeting` |
| A5 | `updateMeeting` does `participantIds.map(String)` with only a `!== undefined` guard. A non-array body → `TypeError` → **500**. Unknown `type` / `recurrence` values are also written straight through to a stricter enum at `save()`. | `updateMeeting` |
| A6 | **Type escalation is not enforced.** `type: 'COMPANY'` is hidden in the UI for non-admins, but the API accepts it in both create and update — a MANAGER or TEAM_LEAD can schedule a **company-wide** meeting by API. This file's own comments ("API-bypass proof", "Guaranteed here, not in the UI") promise the opposite. | `createMeeting` / `updateMeeting` |
| A7 | The edit modal prefills the date/time from the **occurrence** (`initial.occStart`). Saving a recurring meeting therefore rewrites the series anchor (`startAt`) to that occurrence's date: the series jumps, and **every earlier occurrence disappears from the calendar**. From the user's side: "I edited it and the meeting broke". | `MeetingFormModal` initial state |
| A8 | Changing type PRIVATE → TEAM in the edit modal does not re-derive the team unless participants were also edited, while the modal says "Your whole team is added automatically". | `updateMeeting` participant branch |
| A9 | Failed list load sets `msg`, but a later successful load never clears it (stale red banner). | `MeetingsPage` `load()` |
| A10 | `Frontend/src/services/selfService.js` still exports a dead `meetingService` whose `my()` calls `GET /meetings/my` — **no such route exists** — and whose `cancel()` does `DELETE /meetings/:id` (delete, not cancel). Unused today; removed so the next person cannot wire it up. | `selfService.js` usage grep |
| A11 | HR_MANAGER holds **no** `MEETING_*` permission at all (not even `MEETING_READ_SELF`), while the controller comment claims "HR joins meetings when INVITED". Flagged for the owner — an RBAC change needs a `SYSTEM_PERMISSION_VERSION` bump, so it is **not** silently included here. | `permissionRegistry.js` HR_MANAGER block |

Measured state: the Meetings feature has **zero tests** — `grep -rl Meeting Backend/test Frontend/test` returns nothing
meeting-specific, which is why A3/A4/A6 survived. That is fixed in §D.

## B. SECURITY / DATA BOUNDARIES

* **Link is the only user-authored string that becomes an `href`.** Raw pass-through allows `javascript:` / `data:` payloads to reach a rendered anchor (stored XSS one click deep). Normalisation is therefore a *validation* concern, not a cosmetic one: allow `http`/`https` only, reject anything else with 400, and normalise on the server so every client inherits a safe value.
* **Tenant boundary unchanged**: every meeting query keeps `company: req.companyId`; the visibility filter is asserted in tests.
* **Role boundary**: A6 is an authorization gap (company-wide broadcast by a non-admin). The fix is server-side (403) and keeps the admin-only UI option.
* **No new dependencies**, no Redis/Mongo requirement in tests, no secrets touched.

## C. IMPLEMENTATION

1. **`Backend/src/utils/meetingLink.js` (new)** — `parseMeetingLink(raw) → { link, error }`:
   scheme-less host (`meet.google.com/x`) → `https://…`; explicit `http(s)` kept; `javascript:`/`data:`/`vbscript:`/`file:`/`blob:` or any non-http scheme → `{ link: '', error }`; blank → empty.
2. **Controller** (`meetingController.js`):
   * `notify(companyId, userId, payload)` — A3 fixed at all four call sites (create, update, cancel, reminder scheduler, which also starts selecting `company`).
   * link normalised on create **and** update; unsafe → `400`.
   * update validation mirrored from create: non-empty title, array participants, enum-checked type/recurrence, bounded `reminderMinutes`, parseable `recurrenceEnd`.
   * `type: 'COMPANY'` requires COMPANY_ADMIN (create + update).
   * TEAM re-derives the team whenever the resulting type is TEAM (A8).
   * Repository three-comment convention (`// Data from frontend …` / `// DB Logic …` / `// Data to frontend …`) preserved.
3. **`Frontend/src/utils/meetingLink.js` (new)** — the same parser for the client (defence in depth + honest inline feedback).
4. **`MeetingsPage.jsx`**:
   * Join button renders the normalised link; an unusable value shows the reason instead of a dead anchor (A1).
   * The form blocks submit on a bad link and says why.
   * Editing a recurring meeting prefills the **series anchor** and the modal says the change applies to the whole series (A7).
   * `load()` clears `msg` on success (A9).
5. **`selfService.js`**: delete the dead `meetingService` (A10).

## D. TEST PLAN

* **`Backend/test/meetingManagement.test.js` (new, hermetic)** — controller-level with `Object.defineProperty` stubs on `Meeting`/`User`/`Notification` (the repo's existing pattern in `presenceController.test.js`), `global.__crewlyMeetingReminders = true` so the 60s timer never starts. Pins: link normalisation + unsafe-scheme 400, empty-title 400 (regression for the 500), non-array participants 400, COMPANY-type escalation 403, TEAM re-derivation, notification company-id (regression for A3), visibility filter tenancy, 403 for a non-organizer, 404 cross-tenant.
* **`Frontend/test/meetingsPage.test.js` (new)** — pure parser cases plus source pins: Join uses the parser, the modal blocks on a bad link, the recurring-series note exists, `msg` is cleared.
* **`Backend/package.json`** — register the new file in `test:all` and add `test:meetings`.
* Full gate re-run: `test:all`, `test:presence`, `test:presence-realtime`, `test:profile-changes`, frontend `npm test`, `npm run build`.

## E. ENVIRONMENT / DEPENDENCIES

No new packages. Tests stay hermetic (no live Mongo/Redis; every model call stubbed). Owner verification is a UI click-path on localhost — Phase 38's acceptance guide stays untouched and still unrun.

**Honest limit:** the owner's *exact* edit error was not reproducible here (no MongoDB/Redis in this sandbox). A1/A3/A4/A6/A7 are proven by reading the code and fixed; if the symptom survives on their machine, the remaining candidates are RBAC (A11) and plan gating, and I will need the exact message text.


---

## F. RESULTS (what actually changed, and the evidence)

### Files

| File | Change |
|---|---|
| `Backend/src/utils/meetingLink.js` | **new** — `parseMeetingLink(raw) → { link, error }`; scheme-less host → `https://…`; non-http schemes refused |
| `Frontend/src/utils/meetingLink.js` | **new** — the client mirror (render + pre-save feedback) |
| `Backend/src/controllers/meetingController.js` | notify signature fixed at all four call sites (A3); link normalised on create + update (A1/A2); update validation mirrored from create (A4/A5); COMPANY type restricted to Company Admin (A6); TEAM roster re-derived on any edit (A8) |
| `Frontend/src/pages/meetings/MeetingsPage.jsx` | Join anchor uses the parser (A1); the form blocks an unusable link and says why; recurring edits prefill the series anchor with a visible note (A7); a good load clears the stale error banner (A9) |
| `Frontend/src/services/selfService.js` | dead `meetingService` removed (A10) |
| `Backend/test/meetingManagement.test.js` | **new** — 24 hermetic controller tests (the feature had none) |
| `Frontend/test/meetingsPage.test.js` | **new** — 13 parser + source pins |
| `Backend/package.json` | `test:meetings` script; the new file joined `test:all` |

### Evidence

* **The new pins bite.** Run against the pre-fix controller, **14 of 24** backend
  tests fail (link storage, unsafe link, COMPANY escalation, notification
  company-id, empty title, non-array participants, TEAM roster, repeat-until…);
  run against the pre-fix page, **6 assertions** fail (raw `href`, missing
  parser, occurrence-only prefill, stale banner). Both suites are green on the
  fixed tree.
* **No regression elsewhere.** Backend `test:all` → **3331 tests / 173 suites /
  0 fail** (3307 + 24). Frontend `npm test` → **397 / 0 fail** (384 + 13).
  `npm run build` clean. `git diff --check` clean.
* Both new suites are hermetic (every model call stubbed; the reminder interval
  is switched off before the controller import so the process drains).

### Honest limits

* The owner's **exact** edit error was never reproduced here (no MongoDB or
  Redis in the agent sandbox, and no network to install them). A1–A9 are proven
  by code reading and pinned by tests; if "editing" still misbehaves on the
  owner's machine the remaining candidates are the ones this unit deliberately
  did **not** change: **A11 (HR_MANAGER holds no `MEETING_*` permission at all,
  so HR cannot even open the page)** and subscription **plan gating**
  (`403 FEATURE_NOT_AVAILABLE` on meeting writes). Both need the exact message
  text to confirm, and A11 needs an RBAC version bump — owner sign-off first.
* Owner-side verification is unrun, as always. Nothing here is owner-accepted.

### Owner check (Windows PowerShell)

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly
git pull origin arena/379846ae-hrms-crewly

# restart the backend, then hard reload the browser (Ctrl + Shift + R)
cd Backend
npm run dev
```

1. Meetings → New Meeting → paste `meet.google.com/abc-defg-hij` (no `https://`) → create.
2. Open it → **Join Meeting** must open `https://meet.google.com/abc-defg-hij` — not `localhost/meet.google.com/...`.
3. Paste `javascript:alert(1)` as a link → the form refuses it with a message; nothing is saved.
4. Edit that meeting → change the title only → save → the list shows the new title (no error banner).
5. Clear the title and save → "Meeting title is required" (not "Could not save meeting").
6. Create a **weekly** meeting starting today; open a *later* occurrence → Edit → the date field reads "Series starts" and the note says the change applies to the whole series; save → the earlier occurrences are still on the calendar.
7. Edit a meeting and check the bell of another participant → a "✏️ Meeting updated" notification now actually arrives (it never did before this unit).
