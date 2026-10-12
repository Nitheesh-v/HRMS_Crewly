# CREWLY — AI HANDOFF CAPSULE (2026-10-12)

> **For a fresh AI chat continuing work on this repo.** Read this file top to bottom,
> then consult `docs/CREWLY_MASTER_MEMORY_CAPSULE.md` for deep phase history (§3 = the
> law, §5 = Phase-36 laws, §9 = the pitfall museum, §12 = owner's exact commands).
> This capsule is the current-state layer on top of that document: everything the
> master capsule predates (Phases 37–39, the 2026-10 session) plus the branch truth.

---

## 0. CURRENT STATE — THE ONE PARAGRAPH

Repo: `Nitheesh-v/HRMS_Crewly` — **Crewly**, a multi-tenant HRMS SaaS (MERN:
Express + Mongoose + Socket.IO + BullMQ, React 18 + Vite 8 + Tailwind v4 + Redux
Toolkit). Default branch **`main` = `4750849`**, a merge commit the owner made on
their own machine: it contains the entire session branch `arena/379846ae-hrms-crewly`
(tip `a114b4c`) **plus** the owner's chat-socket CORS fixes (`chatSocketClient.js`
`withCredentials:false`, `chatSocketUrl.test.js`, extra `chatSocketFoundation`
pins, a master-capsule addendum). All AI work happens on the session branch
`arena/379846ae-hrms-crewly`; the **owner personally merges it into `main`**
(newest merge needed after every push — expect to remind them). Gates at the
arena tip: **backend `npm run test:all` 3386 tests / 178 files / 0 fail · frontend
`npm test` 436/0 · `vite build` clean**. The owner's side of the merge (chat fixes)
has NOT been re-gated in the AI sandbox — first continuation task may be to fetch
`main`, reconcile the session branch with it, and re-run gates.

---

## 1. WHAT THE PRODUCT IS

Crewly = "HR, payroll and attendance in one workspace". Multi-tenant: every record
carries `companyId`; every query is tenant-scoped (a cross-tenant leak is a tested
bug class, not a setting).

**20 real modules** (the home page's module list is derived from
`SidebarNav.jsx` + the permission registry — never invent modules): Core HR,
Documents, Lifecycle & Exit, Profile change requests · Attendance, Work location,
Presence, Leave · Payroll, Statutory, Expenses, Assets · Recruitment, Background
checks, Offers & onboarding, Performance · Chat Hub, Meetings, Announcements,
AI Assistant. Plus: Referrals, Timesheets, Kiosk/QR punch, Support tickets,
Audit logs, Security/sessions.

**Plans** (`Backend/src/utils/platformPlans.js`, mirrored truth-checked onto the
home page by test): Free ₹0 · Trial ₹0 · Basic ₹999/₹9,990 · Professional
₹2,499/₹24,990 · Enterprise ₹4,999/₹49,990 (INR, monthly/yearly; yearly = exactly
10 months ⇒ "2 months free"). `TRIAL_DAYS = 14`, signup has no payment step.
Lapsed subscription ⇒ writes 403 `SUBSCRIPTION_READ_ONLY`, workspace goes
read-only, never deleted.

---

## 2. ARCHITECTURE MAP

| Layer | Truth |
|---|---|
| Backend | `Backend/src/server.js` (Express, port 5000). 61 route files under `src/routes`. 135 models under `src/models`. Controllers are thin; rules live in `src/services/**/*Rules.js` (pure) beside `*Service.js` (I/O shell). |
| Frontend | `Frontend/` — Vite 8 + Tailwind v4, React 18, Redux Toolkit, react-router. Entry `src/routes/AppRoutes.jsx` (163 route paths, pages lazy-loaded). App shell `src/layout/AppLayout.jsx` + `SidebarNav.jsx` (`NAV_BY_ROLE`, five role blocks: COMPANY_ADMIN, HR_MANAGER, MANAGER, TEAM_LEAD, EMPLOYEE). |
| Realtime | Socket.IO. The handshake authenticates from `auth.token` (60s ticket) — **never a cookie** (33.1). Client sends `withCredentials: false` (36.9 CORS law). Socket origin allowlist and REST CORS allowlist are the same `CLIENT_URL` (comma-separated, slash-stripped). |
| Presence (Phase 37) | Redis-backed bus (`presenceBus`), live store, expiry observer, team service, tenant config, work-location requests. Laws: config-driven attach (exactly-once, nonblocking); heartbeat = liveness only; away via bounded/shared observation; offline needs the scalable observer; duplicates acceptable/idempotent; HTTP authoritative; Redis outage ⇒ Unknown/degraded, **never everyone Offline**; no local-memory distributed truth; no Mongo heartbeat writes; **no NATS**. |
| Attendance chain | Policy engine (`attendancePolicyRules/Service`, draft→activate with `configVersion` OCC) → punch ingest (`attendanceEventService`, `eventSeq` CAS) → timesheet derivation (`attendanceTimesheetService.deriveMonths` + `buildDay`) → finalization (`attendanceFinalizationService/Rules`, `effectiveBucket`: UNRESOLVED→ABSENT only when `!hasScheduleSetup`) → payroll monthly inputs (`monthlyInputService.makeMonthlyInputService`, full DI, `monthlyInputRules.computeAutomaticSummary`). **There are no ABSENT attendance rows** — absence is derived. `overtimeMinutes` is approved-only (31.8): readers may sum, only OT approval writes. |
| Weekly-hours flexi (2026-10) | `attendanceWeeklyTargetRules.js` (pure) + `attendanceWeeklyTargetService.js`. Mon→Sun company-local week, strictly-before qualification, no cross-week carry. Rest rows materialized idempotently (E11000 = peer won). Seams: punch checkout fires `onControlDayFinalized` fire-and-forget (crossing nudge exactly-once via Notification `{companyId, eventKey}` partial-unique index, key `WEEKLY_TARGET_MET:<userId>:<weekStart>`); payroll `buildAutoSummary` materializes before reading (fail-open); timesheet `buildDay` parity override (rest day ⇒ WEEKLY_OFF bucket, zero fractions, `weeklyTarget` meta on the day); `monthlyInputRules` counts `WEEKLY_TARGET_OFF` as paid so absent→LOP math cannot see it. Endpoint `GET /api/attendance/weekly-target`. |
| Notifications | `Notification` model; `notifyUser`/`notifyUsers` in `src/utils/notify.js` NEVER throw; `eventKey` enables exactly-once. Phase 39 added prefs (`notifyPref`) + repair script (`scripts/notifications-repair.js`). |
| AI (Phase 36) | Provider-agnostic via `openai` SDK; owner runs Groq `openai/gpt-oss-120b`. Route order in `src/routes/ai.js`: `/chat` → `/chatbot` → `/languages` (no RBAC) → `/config` → `/context/preview` → `/usage` LAST. Groq decommissioned `llama-3.3-70b` + `llama-3.1-8b` on 2026-08-16; no embeddings (`embed()` → `UNSUPPORTED`). |
| Auth | HttpOnly-cookie sessions with CSRF header (33.14); `/auth/refresh` with 409 race retry. **`publicUser` (authController.js) returns `{ id, name, email, role, companyId, roleRef, avatarUrl, twoFactorEnabled, mfaEnabled }` — `id`, NOT `_id`.** Any frontend code reading `user._id` is a bug (paid for twice: RequisitionsPage, MeetingsPage). Platform portal (super-admin/support/billing) still uses bearer `AdminSession` in localStorage — known deferred work. |

---

## 3. COMMANDS & GATES

```bash
# Backend (from Backend/)
npm install
npm run dev            # nodemon, port 5000
npm run test:all       # 3386 tests / 178 files / 0 fail at arena tip a114b4c — HERMETIC (no Mongo/Redis/network)
npm start              # production start

# Frontend (from Frontend/)
npm install
npm run dev            # vite, port 5173
npm test               # 436/0 at arena tip — node:test, source-pin convention
npm run build          # vite build — the syntax gate
npm run lint           # baseline 128 problems (109 err / 19 warn) — a hard gate, do not grow it
```

- New backend test files MUST be registered in `package.json → scripts["test:all"]`
  (explicit list, not a glob).
- Frontend tests are `test/*.test.js` (glob) + `test/loaders/register.mjs`; the
  convention is **source pins** (read the file, assert the contract) — not DOM tests.
- Backend test convention: **hermetic DI** — every model/collaborator injected;
  chainable stubs (`find().select().lean()`); env `REDIS_ENABLED=false`,
  `MONGO_URI` dummy; no email; no live Redis, no FLUSHALL/FLUSHDB.
- Sandbox `.env` (recreate when wiped): `NODE_ENV=development, PORT=5000,
  MONGO_URI=mongodb://127.0.0.1:27017/crewly_sandbox_test,
  CLIENT_URL=http://localhost:5173, JWT_SECRET=sandbox-only-not-a-real-secret,
  JWT_EXPIRES_IN=1d, REDIS_ENABLED=false`.

---

## 4. THE LAW — STANDING RULES (never violate)

1. **Audit before coding.** Read the actual repo files, not assumptions. Produce
   **exactly one** build plan (A–E sections) and get the owner's "go" before
   implementing. No second plan.
2. **Zero unapproved npm dependencies.** Total added since project start: 3
   (`sonner`, `socket.io-client`, `openai`). Nothing in the 2026-10 session.
3. **Backend three-comment convention** in controllers (per
   `employeePayrollController.listPayrollProfiles`): `// Data from frontend - requests from frontend`
   → `// DB Logic - DB logics` → `// Data to frontend - response to frontend`.
4. **Truthful docs & copy.** No invented customers/testimonials/usage numbers/
   certifications ("ISO 27001", "SOC 2", "bank-grade" are test-banned on the
   landing page). Prices on `/` are test-pinned against `platformPlans.js`;
   the 14-day claim against `TRIAL_DAYS`.
5. **No `git reset --hard`, no force-push, no branch switching, no PR unless asked.**
   Session contract: commit to `arena/379846ae-hrms-crewly` only, push only to it.
6. **Git discipline after a mid-turn re-clone** (this sandbox re-clones and wipes
   `node_modules` + `.env` near-every turn; it has also produced rogue commits):
   if `git status` ballooned or HEAD is unknown → `git fetch origin &&
   git reset --mixed origin/arena/379846ae-hrms-crewly`, verify status lists ONLY
   intended files, **commit explicit paths, never `git add -A`**.
7. **Tests hermetic**; PowerShell-first acceptance instructions for the owner;
   **never claim owner acceptance** — the owner clicks things on his machine.
8. Do not alter Attendance/Leave/Payroll/AI semantics without an explicit owner
   unit; no presence history/productivity tracking; no Redis/NATS in frontend;
   no secrets in logs/docs.
9. **Phase-38 explanation format (16 sections)** stands for future explanations;
   no code changes while explaining.
10. Before distributed-presence work: prove single-instance A–I first (37.8
    authorization context).

---

## 5. THE 2026-10 SESSION — WHAT SHIPPED (newest first, all on both branches)

| Commit | What |
|---|---|
| `a114b4c` | **Home page professional redesign** — pure presentation on `/` (public landing). Hero: dot grid + aurora glows, staggered entrance, browser-chrome product preview with a floating weekly-hours-goal card; modules/workflow/security/pricing/FAQ/CTA all re-skinned; header/footer polish; motion layer in `style.css` gated by `prefers-reduced-motion`. `landingData.js` untouched ⇒ all truth pins intact (20/20). Frontend 436/0, build ✓. |
| `711d397` | Weekly-flexi plan doc §F (shipped record). |
| `38ce41e` | **Weekly-hours flexi target** (owner: "finish the weekly goal early → remaining days are paid rest"). `weeklyTarget` block on AttendancePolicy {enabled:false, targetMinutes 60–10080 default 2400 (=40h), restDayMode AUTO_MARK\|SUGGEST_ONLY, includeApprovedOvertime:false}; additive Attendance status `WEEKLY_TARGET_OFF` + why-subdoc; rules+service+4 seams; `GET /weekly-target`; policy editor section; dashboard chip; timesheet "Earned off (weekly target)" labels. Backend 3386/178/0. **Locked decisions (owner "go"): rest 100% paid, never LOP, never a leave deduction, never leave; regular punch minutes only; AUTO_MARK; leave stays leave; weekly offs/holidays don't participate; disable mid-week stops future marking; punching on a rest day = normal worked day (normal OT).** |
| `b226273` | The one weekly-flexi build plan (A–E + 3 decisions). |
| `d90aa6b` | Creator identity fix — `publicUser` returns `id` not `_id`; RequisitionsPage `personId` + MeetingsPage `me` dual-shape. Owner screenshots proved DRAFTS now show Edit/Submit. |
| `c6e4a74` | Job Referrals in EMPLOYEE menu (was MANAGER-only by an anchor collision). Pinned **exactly 1 per role block** — per-block assertions, whole-file counts forbidden. |
| `ea034ec` | Approve ≠ auto-create: approvals page banner/toast branching ("Create job posting" vs "Open job posting"). |
| `362a261` | Requisition→job title validator (owner's "Invalid value" toast = 2-char "HR" title; ≥3 chars required). |
| `fe142b6` | Post-requisition UX: no dead-end toasts, next action surfaced. |
| `bd72554` | Employee Referrals feature end-to-end (posted jobs visible to every employee; refer flow). |
| Earlier (already in master-capsule era or before): boot-log batch (`8e224ba`,`131a0d4`…), Home `9436375`, Meetings `adef7eb`, Phases 37.x–39 (presence realtime, team availability, work-location requests, profile change requests, meeting management, notification delivery) — **all present on the branch and merged into main**. |

---

## 6. FEATURE STATES & EXACT FACTS A CONTINUATION NEEDS

- **Requisitions:** drawer shows Edit + Submit-to-HR when status ∈ {DRAFT, SENT_BACK}
  AND `canManageRecord` (full access || requester match). DRAFT→PENDING_HR → HR
  approvals tab (Sarjana S, HR_MANAGER). Approve (comment optional; required only
  for Reject/Send back) → toast → "Create job posting" banner → pre-filled job form
  (rename "HR" → e.g. "HR Executive", ≥3 chars) → Published → careers portal +
  referrals. **Live state: JR-0002 PENDING_HR awaiting the owner's HR approval click;
  JR-0001 APPROVED, "hr", still awaiting Create-job-posting.**
- **Careers portal gating:** exact lowercase `careerSlug` + `careerPortalEnabled:true`
  (default false) + ACTIVE company + plan containing `recruitment` (Trial/Basic false).
  Enable at /app/company; mongosh fallback:
  `db.companies.updateOne({careerSlug:"<slug>"},{$set:{careerPortalEnabled:true}})`.
  Referrals list ignores the portal toggle (keys off `publicVisibilityFilter`).
- **Pipeline stages** (`pipelineStages.js`): APPLIED, ATS_SCREENING, HR_SCREENING,
  SHORTLISTED, INTERVIEW_1–3, MANAGER_ROUND, HR_FINAL, FINAL_REVIEW, SELECTED,
  OFFER, OFFER_ACCEPTED, PRE_ONBOARDING, JOINED; dispositions REJECTED/HOLD/WITHDRAWN.
- **Owner's live tenant languages: `en, ta` only — intentional, must survive UI work.**
  Full catalogue: `en, ta, tanglish, hi, te, kn, ml, mr, gu, pa, bn, or, as, ur`;
  tenant defaults `en, ta, tanglish, hi, te`. `RULE_COUNT=15`.
- **Deep links:** `leaves` (553), `attendance` (418, NOT attendance/my-attendance),
  `payroll/my-payslips` (611), `documents` (879).
- **`SYSTEM_PERMISSION_VERSION = 38`** (`permissionService.js`); COMPANY_ADMIN
  inherits the whole catalogue; ATTENDANCE_POLICY_READ/MANAGE/ACTIVATE exist.
- **Sidebar truth:** `NAV_BY_ROLE`; referrals exactly 1 in all five role blocks,
  EMPLOYEE's directly after Meetings; "Time Tracking (soon)" exists in BOTH
  MANAGER and EMPLOYEE blocks — per-block anchors required for edits.

---

## 7. OWNER ACCEPTANCE — PENDING, NEVER CLAIM DONE

1. Weekly-flexi full flow (enable policy → punch a week → nudge → earned-rest days
   → payroll shows paid, no LOP).
2. Home page professional redesign (`a114b4c`) — shipped this session, not yet
   reviewed by owner.
3. JR-0002 HR approval → create job posting → careers + referral end-to-end.
4. Referral feature acceptance (menu visibility + refer flow).
5. Invalid-value rename+save on requisition→job.
6. Careers-portal enabling (portal toggle + slug + plan gate).
7. Meetings 7-step acceptance; boot-log §F; earlier Home/Meetings deliveries.
8. Gates on **`main` after the owner's merge** (the chat-fix delta has not been
   re-run in the sandbox).

---

## 8. DEFERRED BACKLOG (each needs explicit owner authorization + a phase number)

| # | Item | Size |
|---|---|---|
| 40 | Session hardening (refresh flow hardening) | Medium |
| 41 | Phase-38 follow-on (profile change requests polish) | Small |
| 42 | Meeting RBAC | Small |
| 43 | Loans / Advances & Employee Recovery (reversed at 29.11; real payroll-ledger gap) | Large — needs re-authorization |
| — | Master-capsule refresh (fold Phases 37–39 + 2026-10 session into `CREWLY_MASTER_MEMORY_CAPSULE.md`) | Small |
| — | Platform portal cookie migration (super-admin/support/billing bearer tokens → HttpOnly) | Separate unit |
| — | `refreshRateLimit` 429 handling on `/auth/refresh` (currently same path as expiry; race retry only handles 409) | Small |
| — | Hub §22.5 doc label fix (`chat:message:edited` → `chat:message:updated`) if PHASE_33 doc is touched | Trivial |

---

## 9. PITFALLS PAID FOR (top hits — full museum in master capsule §9)

1. **Re-clone wipe:** `node_modules` + `.env` vanish; guard with
   `ls node_modules/.package-lock.json || npm ci`; recreate `.env` from §3.
   A missing `.env` once failed 16 unrelated backend test files (JWT/cookie gates).
2. **`edit_file` on large files:** has reported success while mangling (duplicate
   tail after `export default`) and has silently no-op'd. Rule: ≥3 edits into a big
   file → assertion-checked python patch (`assert s.count(old)==1`) + rerun the
   build; always read the exact file text before editing (copy exact strings into pins).
3. **Exact-enum compat pins:** adding an enum value (e.g. `WEEKLY_TARGET_OFF`)
   breaks `assert.deepEqual` compat pins in `attendanceEvents`/`attendancePolicy`
   tests — update them deliberately with a comment, never by deleting.
4. **Role-block menu edits:** anchors exist in multiple role blocks — replace-first
   hits the wrong block; per-block EXACT count pins required.
5. **`grep -c` exact-pattern false alarms** — verify broadly; `grep -i` for filenames.
6. **Timezone honesty:** "today" must be computed in the POLICY timezone
   (`dayKeyInZone(new Date(), policy.timezone)`), not server UTC.
7. **Date arithmetic:** `new Date(Date.UTC(y, m, d))` — the month is 0-based;
   `em` without `-1` once ballooned every leave span by a month. Caught by tests.
8. **This sandbox is a shallow-ish clone:** `git merge-base` / `--is-ancestor` can
   return empty/false answers ("not a valid commit name" right after `ls-remote`
   without fetch). `git fetch` first; distrust ancestor checks that look wrong.
9. **Stale vim swap on the owner machine** (`~megal/Desktop/HRMS/.git/.MERGE_MSG.swp`,
   Sep 18 crash): press `D` (Delete) then `:wq`, or avoid entirely with
   `git merge --no-edit`.
10. Never `git checkout --` uncommitted work; never parallelize file creation with
    a commit; truthful-copy scans strip comments (a ban must not trip on the
    comment that documents the ban).

---

## 10. OWNER'S MACHINE (Windows PowerShell — `C:\Users\megal\Desktop\HRMS`)

```powershell
git fetch origin
git pull origin main            # after the AI pushes to the session branch, the owner merges it:
git merge --no-edit arena/379846ae-hrms-crewly
git push origin main

# app
cd Backend  ; npm install ; npm run dev        # terminal 1 (port 5000)
cd Frontend ; npm install ; npm run dev        # terminal 2 (port 5173)
# browser hard refresh: Ctrl + Shift + R

# tests (no Mongo/Redis needed)
cd Backend  ; npm run test:all
cd Frontend ; npm test
```

Working loop (master §13): audit → one plan → "go" → implement + hermetic tests →
gates → commit explicit paths → push session branch → give the owner the merge +
PowerShell acceptance steps → the owner merges to `main` and clicks through.

---

## 11. KEY FILE MAP (the seams a continuation will touch)

| File | Why |
|---|---|
| `Backend/src/models/Attendance.js` | status enum incl. `WEEKLY_TARGET_OFF`; `weeklyTarget` why-subdoc; `overtimeMinutes` 31.8 contract |
| `Backend/src/models/AttendancePolicy.js` | `thresholds`, `overtime`, `weeklyTarget` blocks; draft/activate lifecycle |
| `Backend/src/services/attendance/attendanceWeeklyTargetRules.js` | pure week-window / crossing / rest-decision math (hermetic tests live here) |
| `Backend/src/services/attendance/attendanceWeeklyTargetService.js` | materializeRestDays / getWeekContext / onControlDayFinalized |
| `Backend/src/services/attendance/attendanceTimesheetService.js` | `deriveMonths` :~420, `buildDay` parity override + `weeklyTarget` day meta |
| `Backend/src/services/payroll/monthlyInputRules.js` | `computeAutomaticSummary` — `weeklyTargetOffDays` in the counted/absent/LOP math |
| `Backend/src/services/payroll/monthlyInputService.js` | `makeMonthlyInputService` DI factory; `WeeklyTargetMaterializer` seam; real instance wires `materializeRestDays` |
| `Backend/src/services/attendance/attendanceEventService.js` | punch CAS (`eventSeq`); checkout seam fires the crossing nudge fire-and-forget |
| `Backend/src/services/attendance/attendancePolicyRules.js` / `attendancePolicyService.js` | `validateWeeklyTarget` + draft whitelist/serializer round-trip |
| `Backend/src/controllers/attendance/attendanceEventController.js` | `getMyWeeklyTarget` (GET /weekly-target) |
| `Backend/src/utils/notify.js` | notifyUser/notifyUsers — never throw |
| `Backend/src/utils/permissionService.js` | `SYSTEM_PERMISSION_VERSION = 38` |
| `Frontend/src/pages/landing/*` | public home page; `landingData.js` is the test-checked content source |
| `Frontend/src/pages/dashboard/DashboardPage.jsx` | weekly-goal chip (silent-failure additive) |
| `Frontend/src/pages/attendance/AttendancePolicyPage.jsx` | weeklyTarget section (hours goal ↔ minutes payload) |
| `Frontend/src/components/attendance/TimesheetMonthView.jsx` | `dayOutcomeLabel` — earned-rest truthful labels |
| `Frontend/src/layout/AppLayout.jsx` / `SidebarNav.jsx` | `NAV_BY_ROLE`, per-block menu pins |
| `Frontend/src/services/attendanceWeeklyTargetService.js` | frontend client for /weekly-target (envelope unwrap) |
| `docs/CREWLY_MASTER_MEMORY_CAPSULE.md` | the deep-history master doc (§0 paste-prompt, §3 law, §9 pitfalls, §12 owner commands) |

---

## 12. QUICK-REFERENCE EXACT VALUES

| Thing | Value |
|---|---|
| Branch contract | AI works on `arena/379846ae-hrms-crewly`; owner merges into `main` (currently `4750849`) |
| Gates @ `a114b4c` | Backend 3386/178/0 · Frontend 436/0 · vite build ✓ · lint baseline 128 (hard) |
| Ports | Backend 5000 · Frontend dev 5173 |
| New npm packages total | 3 (`sonner`, `socket.io-client`, `openai`) — none since 36.1 |
| Weekly flexi defaults | enabled:false · 2400 min (40h) · min 60 / max 10080 · AUTO_MARK · includeApprovedOvertime:false |
| Rest-day nudge eventKey | `WEEKLY_TARGET_MET:<userId>:<weekStart>` (Notification {companyId, eventKey} partial-unique) |
| Auth user shape | `{ id, name, email, role, companyId, roleRef, avatarUrl, twoFactorEnabled, mfaEnabled }` — no `_id` |
| Trial | 14 days, no card; lapse ⇒ read-only, never deleted |
| Owner AI config | AI_ENABLED=true · groq · openai/gpt-oss-120b · AI_MAX_TOKENS 1024 · quota 100000 |
| Owner tenant languages | `en, ta` only |
| LOP flow | absent (workingDays − present − 0.5×half − weeklyTargetOff) → lopDays unless a LOP leave type exists |

---

*Capsule written 2026-10-12 from a full repo analysis at arena tip `a114b4c` /
main `4750849`. Commit it on the session branch and merge it to `main` with the
next unit.*
