# CREWLY — MASTER MEMORY CAPSULE (START TO END)

> **Read this before touching anything.** This is the single consolidated
> capsule for the whole project, from Phase 1 to the current tip.
>
> It merges and supersedes, for handoff purposes, the four older capsules:
> `docs/PROJECT_MEMORY_CAPSULE.md` (Phases 1–30),
> `docs/PHASE_32_MEMORY_CAPSULE.md` (infrastructure laws),
> `docs/PHASE_33_MEMORY_CAPSULE.md` (chat hub + session/auth),
> `docs/PHASE_36_MEMORY_CAPSULE.md` (the AI suite).
> Those files stay on disk as the fuller record of their own eras — this file
> is the one you paste into a new chat.
>
> **The repository is always the source of truth.** If this file and the code
> disagree, the code is right and this file is a bug.

---

## 0. PASTE THIS INTO A NEW CHAT (opening prompt)

```text
You are continuing work on CREWLY, a multi-tenant SaaS HRMS + RMS/ATS +
AI assistant, at /home/user/HRMS_Crewly.

BRANCH: always arena/01a0e7a0-hrms-crewly. Never another branch.
Never commit to main. Never git reset --hard. Never git push --force.
Open a PR only when I ask.

STACK
  Backend:  Node.js ESM + Express 5 + MongoDB (Atlas, Mongoose) + Redis +
            BullMQ (jobs, cache) + Socket.IO (chat ONLY) + Cloudinary
            (private files) + Razorpay (billing) + SMTP + winston + helmet.
            Workers are a SEPARATE process (node src/workers/index.js).
  Frontend: Vite + React 19 + Redux Toolkit + react-router 7 + Tailwind v4
            + lucide-react icons.
  Tests:    node:test, FLAT in Backend/test/, explicit paths in package.json.
            Frontend tests are node:test too, run via a loader.

READ FIRST, IN THIS ORDER
  docs/CREWLY_MASTER_MEMORY_CAPSULE.md   (this file)
  README.md
  docs/PHASE_36_MEMORY_CAPSULE.md        (the AI suite, laws + pitfalls)
  docs/PHASE_36_HR_CHATBOT.md            (AI hub, unit map, close-out)
  docs/PHASE_36_7_ADMIN_LANGUAGES.md     (AI Settings page, §9 acceptance)
  docs/PHASE_33_MEMORY_CAPSULE.md        (chat hub + session/auth)
  docs/PROJECT_MEMORY_CAPSULE.md         (Phases 1-30 history)
Then inspect the real code before proposing anything.

HOW I WANT YOU TO WORK (non-negotiable)
  1. AUDIT FIRST. Grep the real call sites, read the tests that already pin
     the behaviour, check git log for why it is the way it is.
     Never propose a change from memory. Report what you found.
  2. ONE build plan after the audit: files, approach, risks, what stays
     unchanged. No option menus unless I ask.
  3. Implement. Small, surgical, in the repo's existing style: pure ESM,
     ES6+ (no var, no function declarations, no require/module.exports),
     thin controllers, the controller comment convention
     (// Data from frontend -> // DB Logic -> // Data to frontend).
  4. Test hermetically (fake models / DI - no Mongo, no Redis, no network).
     Then run the full suite.
  5. Docs are part of the work. If behaviour changed, the doc changes in the
     SAME commit.
  6. Commit + push to arena/01a0e7a0-hrms-crewly with a long explanatory
     message (why, not just what), then report.

REPORT FORMAT (every unit, no exceptions)
  - Why it happened (the real mechanism, with the code path)
  - Fix (what changed, what deliberately stayed the same)
  - FILES CHANGED - Added / Modified / Deleted (paths)
  - EXACT test results - ACTUAL totals. Never estimate, never carry an old
    number forward, never say "should pass". BLOCKED is not PASS.
  - Frontend build + lint if frontend changed
  - Docs updated (file list)
  - Honest flags (anything unverified, anything I must click myself)
  - End a completed unit with: Phase <n> <title> - pit rules locked in 🏁

HARD RULES (never violate)
  - ZERO new npm packages unless I explicitly authorize one. Stop and ask.
  - Never weaken security to make something work. Never print, log, commit
    or repeat a secret. Never print raw tokens or PII.
  - Multi-tenancy: every query scoped by companyId; tenant authority is
    req.companyId ONLY, never a client-supplied id.
  - Never claim exactly-once (queues are at-least-once), never claim
    malware scanning, never invent capacity/N-user numbers, never claim my
    localhost acceptance.
  - AI output is INFORMATIONAL and NAVIGATIONAL ONLY. It never approves,
    applies, punches, pays or decides. Human decisions stay human.
  - No emojis in new UI. lucide icons only.
  - PowerShell-first commands for me (I am a beginner on Windows
    PowerShell): exact copy-paste lines, no bash-only syntax, and name the
    restart-server / hard-reload step where needed.
  - Reply in Tanglish with short bullets and code blocks.
  - If something is genuinely ambiguous or security-sensitive, STOP and ask.

CURRENT STATE
  Remote tip: 08d0b73. Both sidebar units (HR Assistant entry + AI admin
  pages) are shipped, all four gates green, committed and pushed.
  I still owe you localhost acceptance clicks - see the OPEN ITEMS section.
```

---

## 1. WHAT THE PROJECT IS

**Crewly** — a multi-tenant SaaS **HRMS + Enterprise RMS/ATS**, with billing,
a platform super-admin, a public career portal, and (as of Phase 36) an
**HR conversational assistant**.

- **Backend/**: Node.js **ESM**, Express 5, MongoDB Atlas (Mongoose), Redis +
  BullMQ (jobs, scheduled work, cache), Socket.IO (**chat realtime only**),
  Cloudinary (private file storage), Razorpay (billing), SMTP (email),
  winston (logs), helmet, jsonwebtoken, bcryptjs, multer, pdfkit.
- **Frontend/**: Vite + React 19, Redux Toolkit, react-router 7, Tailwind v4,
  lucide-react. One SPA serves the tenant app (`/app/*`), the platform
  super-admin (`/super-admin/*`), the BGV verifier portal, the attendance
  kiosk, and the public career portal / candidate consent pages.
- **Workers**: `node src/workers/index.js` — a separate process from the API.
- **Tests**: `node --test`, files **FLAT** in `Backend/test/`, wired by
  explicit paths in `package.json` (`test:all` is an explicit file list, not
  a glob).
- **docs/**: phase hubs, runbooks, memory capsules.

**Non-negotiable structural facts**

- **Multi-tenancy is non-negotiable.** Every business document is scoped by
  `companyId`. Tenant authority comes ONLY from `req.companyId` (derived from
  the verified token + the Mongo user) — **never** a client-supplied id.
- **There is no separate Employee collection.** Employees are `User` records
  with payroll/profile fields.
- **Middleware order: auth → tenant → subscription → RBAC → cache.** The cache
  never authorizes.
- **Attendance is append-only** (regularization overlays, never mutation).
- **`PayrollResult` is immutable and versioned.** `PaymentStatus` is never
  manually set to PAID. **Payroll never moves money** — the platform builds
  the bank file; the company's finance team uploads it to their own bank.
- **Secrets are hash-only at rest** (reset tokens, kiosk device secrets/PIN,
  QR challenges) and `select: false`. `AI_API_KEY` is treated like
  `JWT_SECRET`.
- **Files are private**: no permanent public URLs, auth-gated download,
  `Cache-Control: private, no-store, max-age=0`.
- **Errors are generic** (no enumeration oracles); never raw user input into
  `$regex` (use `src/utils/searchInput.js`); never CORS `*`.
- **Redis/queue keys are namespaced `crewly:<env>::`.** No `FLUSHALL` /
  `FLUSHDB` / `KEYS` / wildcard `crewly:*` deletes. Redis down must **fail
  closed** (503 / FEATURE_UNAVAILABLE), never fail open.

---

## 2. REPO MAP, PORTS, COMMANDS

```
Backend/
  src/
    app.js  server.js           Express app + HTTP server (socket attach BEFORE listen)
    config/                     env.js, logger.js, redis.js, queueConfig.js, proxyTrust.js
    controllers/                flat + domain subdirs (attendance, bgv, chat, payroll, platform, recruitment)
    routes/                     flat + the same domain subdirs
    validators/                 flat + domain subdirs (incl. ai/)
    models/                    FLAT on purpose (incl. AITenantConfig.js, AIUsageLog.js)
    services/                  flat + ai/, attendance, bgv, chat, ops, payroll, recruitment
    middlewares/               protect/authMiddleware.js, tenantMiddleware.js, securityRateLimit.js
    utils/                     tokenService.js, securityPolicy.js, searchInput.js
    infrastructure/            observability/ realtime/ storage/
    socket/                    Socket.IO chat layer
    workers/                   BullMQ processors + registry
  test/                        FLAT node:test suites
  scripts/                     ops CLIs (config-check, load/, preview/)
Frontend/
  src/
    pages/<domain>/            incl. settings/AiSettingsPage.jsx, settings/AiUsagePage.jsx
    components/AIAssistant/    AiAssistantWidget.jsx, AiAssistantPanel.jsx
    layout/                    AppLayout.jsx (NAV_BY_ROLE), SidebarNav.jsx (the real renderer)
    routes/                    AppRoutes.jsx
    redux/slices/              aiChatSlice.js, chatSlice.js, AuthSlices.js
    services/                  api.js (axios), aiService.js, chatService.js
    utils/                     chatLanguages.js, speechSynthesis.js
    style.css                  the single stylesheet (there is NO index.css)
  test/                        node:test suites + loaders/register.mjs
docs/                          phase hubs, runbooks, capsules
```

| What | Command | Where |
|---|---|---|
| Backend API + socket | `npm run dev` (nodemon) — `PORT=5000` | `Backend/` |
| Frontend | `npm run dev` (Vite, **5173**) | `Frontend/` |
| Full backend suite | `npm run test:all` | `Backend/` |
| AI suites | `npm run test:ai-foundation` / `:ai-tenant-config` / `:ai-languages` / `:ai-context` / `:ai-chatbot` / `:ai-own-records` / `:phase36-closeout` | `Backend/` |
| Chat suites | `npm run test:chat` | `Backend/` |
| Session units | `npm run test:session`, `npm run test:cookie` | `Backend/` |
| Config truth | `npm run config:check` | `Backend/` |
| Frontend tests | `npm test` | `Frontend/` |
| Frontend build | `npm run build` | `Frontend/` |
| Frontend lint | `npm run lint` | `Frontend/` |

`Backend/src/config/env.js` defaults: `PORT=5000`, `NODE_ENV=development`,
`CLIENT_URL=http://localhost:5173`. In production `MONGO_URI` and a real
`JWT_SECRET` are required (`npm run config:check --production` enforces it;
config errors name **KEYS ONLY**, never values).

**Arena preview environment:** dev servers must bind `0.0.0.0`, must accept
the proxied preview host/origin (Vite `server.allowedHosts`, backend CORS
allowlist), and browser code must call the API through a **relative** path
(Vite `server.proxy`) — never `localhost` from the browser.

---

## 3. THE LAW — STANDING RULES (NEVER VIOLATE)

### 3.1 Process

1. **Audit before code.** Inspect the repo first; never propose from memory.
2. **Exactly ONE build plan** after the audit (files, approach, risks, what
   stays). No option menus unless the owner asks.
3. One unit at a time, on explicit authorization. Do not start the next unit
   because the previous one finished.
4. **Report ACTUAL totals.** Never carry an old number forward, never
   estimate, never say "should pass". `BLOCKED ≠ PASS`.
5. **Mandatory report fields:** cause · fix · **FILES CHANGED
   (Added/Modified/Deleted)** · **exact test results** · docs-updated list ·
   honest flags.
6. Handoff ends with the exact awaiting-acceptance line when a prompt demands
   one, then `Phase <n> <title> — pit rules locked in 🏁`.
7. **Never claim the owner's localhost acceptance** — he does that himself.
8. **PowerShell-first** instructions, beginner level, exact lines, plus the
   "restart the server / hard reload" step where needed.
9. Reply in **Tanglish** with short bullets and code blocks.

### 3.2 Scope & dependencies

10. **ZERO new npm packages** unless explicitly authorized. Authorized so
    far, and only these: `sonner` (35.1), `socket.io-client` (33.8),
    `openai` (36.1). Nothing since.
11. Test/documentation structure improvements only — no broad restructures,
    no moving production code for aesthetics.
12. Tests are **FLAT** in `Backend/test/` with clearly named files, never a
    nested `test/phaseNN/` folder.
13. No new `/metrics` endpoint, no APM vendor, no PII telemetry, no
    chaos/`FAIL_*` toggles, no Docker/K8s/PM2/CI-CD, no invented capacity
    numbers.
14. Stale test pins are **inverted, not deleted** — keep the guarantee,
    change the mechanism, with a comment saying why.

### 3.3 Security & data

15. Never weaken security to make something work. Security-sensitive
    discrepancies → STOP and report.
16. Never print, log, commit or repeat a secret. No raw tokens or PII in
    logs. The owner once leaked a Redis password in a screenshot; it was
    rotated — never store or echo one.
17. **Multi-tenancy: `req.companyId` only.** Never trust a client-supplied
    tenant id. A language preference is *presentation* and never widens what
    a caller may read.
18. Never `git reset --hard`; never force-push; never switch branches; PR
    only when he asks.
19. Never claim **exactly-once** (queues are at-least-once), never claim
    **malware scanning**, never **invent capacity claims**.
20. Admin/moderation audit rows carry **ids + a bounded reason, never
    message text**.
21. Human decisions stay human: ATS scores never auto-reject; BGV
    DISCREPANCY / UNABLE_TO_VERIFY go to a human HR decision; GET never
    finalizes; offer accept/reject only via POST on secure token routes.

### 3.4 Docs & truth

22. Docs must be truthful. Runbooks use **DETECT / IMPACT / DO / DO NOT /
    VERIFY / ESCALATE**. Live checks are **opt-in** and never run destructive
    Redis operations in hot paths.
23. Source-pin tests must stay **shape-tolerant** (whitespace / prettier
    proof).
24. Chat feature locks (Phase 33, still binding): SSE stays as 32.11 shipped
    it; Socket.IO is **chat-only**; **no presence / typing / last-seen**;
    read model **C1 only** (no per-message receipts); **no emojis in new
    UI**; metadata-only logging; payload caps early with
    `VALIDATION_ERROR`; Redis-down must never fail open.
25. "Chat enabled + Redis off" is a pre-flight **WARNING**, never a blocked
    deployment (pinned by `deploymentConfig.test.js`).

---

## 4. COMPLETED — START TO END

### Phases 1–26 — mainline HRMS (on `main`, closed)

Companies / roles / RBAC, users & profiles, attendance, leaves, shifts &
work schedules, payroll, performance & appraisals, assets, expenses,
projects & tasks, meetings, notifications (+ prefs), announcements, org
chart, documents & requests, exit management (resignation), billing &
subscriptions (Razorpay), support tickets, analytics, security (sessions,
security events, password reset, company security policy), platform
super-admin (subscriptions, platform settings/tokens), audit.

### Phase 27 — RMS + ATS, 27.1–27.16 (closed)

Full hiring lifecycle: Requisition → Approval → Job Posting → Career Portal
apply → Resume upload → Parse → ATS score → Pipeline → Interviews/Feedback →
Human final selection → Offer (approve → PDF → secure portal) → Accept →
Pre-Onboarding (doc verify) → BGV (optional policy) → READY_TO_JOIN →
Convert to Employee → Secure account setup → onboarding.
Reference: `docs/PHASE_27_RMS_ATS.md`.
Hotfix on record: `docs/HOTFIX_30_3_OFFER_ATS_SCORECARD.md`.

### Phase 28 — background infrastructure, 28.1–28.9 (closed)

Redis foundation · BullMQ foundation (7 queues) · email delivery queue ·
processing queues (resume/ATS/documents) · scheduled one-time jobs ·
pre-onboarding + BGV queues · Redis analytics cache · queue operations &
failure management · final hardening.
Reference: `docs/PHASE_28_FINAL_ARCHITECTURE.md` (diagram, inventory,
runbooks, production guidance, §15 capsule).

### Phase 29 — Payroll, 29.1–29.13 (closed)

29.1 Company Payroll Setup · 29.2 Salary Components · 29.3 Salary Structures
· 29.4 Employee Payroll Profile · 29.5 Variable Pay & Monthly Inputs ·
29.6 Payroll Engine · 29.7 Payroll Review · 29.8 Bank File & Payment ·
29.9 Payslips · 29.10 Statutory Compliance & Government Reports ·
29.11 **Final Settlement (F&F)** · 29.12 Payroll Analytics & Reports ·
29.13 Analytics extensions.

Deliberate reversal on record: Loans, Advances & Employee Recovery was the
roadmap item at 29.11 and was **rejected** ("there is no loan process in this
payroll, we can add it in future"). Consequence, not a bug: 29.11 F&F has
`ADVANCE_SALARY` / `LOAN_EMI` recovery lines with no ledger behind them,
typed by hand until a future module exists.

### Phase 30 — Internal BGV, 30.1–30.12 (all closed)

HR decision → priced catalogue → paid order → candidate consent → candidate
evidence collection → verifier accounts → assignment → verification
workbench → info requests → internal QA + final report → operations/SLA
dashboard → super-admin billing + stale-cancel.
Reference: `docs/PHASE_30_INTERNAL_BGV.md` + twelve per-step docs.

### Phase 31 — Attendance (closed)

Attendance policy, events, locations, work-mode requests, regularization,
schedule, reconciliation, overtime, presence, timesheets, calendar,
finalization, operations, reminders, kiosk, QR, import (+ ingest),
analytics rules & service, close-out.

### Phase 32 — infrastructure hardening (closed)

Multi-instance baseline, health & lifecycle, proxy readiness, distributed
rate limit, index coverage, cache multi-instance, multi-worker safety,
private storage services & file access, API performance bounds, realtime
foundation, observability foundation, load tooling, failure recovery,
deployment config, static delivery, security adversarial.
Reference: `docs/PHASE_32_MEMORY_CAPSULE.md`, `docs/PHASE_32_ARCHITECTURE.md`,
`docs/PHASE_32_RUNBOOKS.md`.

### Phase 33 — the chat hub, 33.1–33.12 (closed) + session/auth 33.13, 33.14

| Unit | Scope | Notable law |
|---|---|---|
| 33.1 | Socket.IO foundation + JWT handshake + Redis adapter + `FEATURE_UNAVAILABLE` gate | socket attaches BEFORE `listen()`; `io.close()` also closes the HTTP server; **`cookie:false` — no cookies on sockets**; auth payload is the ONLY token source |
| 33.2 | Chat models + indexes | Mongo is truth |
| 33.3 | Conversation REST | membership enforced on every read |
| 33.4 | History REST — keyset `seq` pagination, tombstone-safe | C1 read model only |
| 33.5 | Join + send over the socket (ACK + idempotency + broadcast) | per-socket write guard |
| 33.6 | Edits (`editVersion` concurrency) + tombstone delete | disabled conversation blocks writes, history stays readable |
| 33.7 | Read cursors + unread counts | no per-message receipts |
| 33.8 | Frontend chat UI + socket lifecycle + honest degraded states | `socket.io-client` added here — **the only new dep** |
| 33.9 | Moderation | moderators delete but never edit others'; audit = ids + bounded reason, never text |
| 33.10 | Attachments | private storage, no permanent public URLs, auth-gated download, `private, no-store, max-age=0`; **never claim malware scanning** |
| 33.11 | Hardening | reuses the 32.4 shared Redis limiter; Redis-down must NOT fail open; conservative payload caps + early `VALIDATION_ERROR` |
| 33.12 | Close-out | verification matrix rows 1–11; runbook format DETECT/IMPACT/DO/DO NOT/VERIFY/ESCALATE |

**33.13** — "session expired too fast" (`9170a60`). Three real mechanisms
fixed: a two-tab refresh rotation race read as theft (now a 60 s
`REFRESH_RACE_GRACE_MS` window → `409 REFRESH_IN_PROGRESS`, no family
revocation, no `tokenVersion` bump); any refresh failure burning the cookie
(now only 401/403 clear it); `clearRefreshCookie` not clearing (`if
(options.maxAge)` skips `0` — guard is now `!== undefined && !== null`).
Frontend takes a cross-tab **Web Lock** and retries 409.

**33.14** — the browser session is a cookie, the socket a ticket
(`43afd4d`). Access token moved from `localStorage` bearer to an HttpOnly
cookie `crewly_access` (`Path=/api`); the socket handshake uses a **60-second
chat ticket**; cookie-authenticated writes require
`X-Requested-With: XMLHttpRequest` else `403 CSRF_HEADER_REQUIRED`; platform
portal keeps its own bearer `AdminSession` token under
`infolexus_platform_token`.
Reference: `docs/COOKIE_SESSION.md`, `docs/SESSION_REFRESH_RESILIENCE.md`.

### Phase 34 — chat enhancements (closed)

`docs/PHASE_34_CHAT_ENHANCEMENTS.md`.

### Phase 35 — UI & import units (35.1–35.9, closed)

Toasts (`sonner` was added here — the 35.1 authorization), responsiveness,
permission payload & bootstrap, role counts & overrides, and the attendance
import rework (chunking, result view, retry, source gates).

> **⚠ Owner's framing, preserved on purpose.** The owner has stated that
> "only 34 completed" and rejected the framing that 35 was already done. The
> repository *does* contain 35.1–35.9 code, docs, tests and close-out pins.
> Treat the owner's statement as authoritative for **intent** — do not claim
> their localhost acceptance of any shipped unit, and do not tell them Phase
> 35 is done. When they say it is done, it is done.

### Phase 36 — THE HR CHATBOT SUITE (AI) — 36.1 through 36.7 + follow-ups

Strictly the HR Chatbot Suite. **Not** recruitment AI, not payroll pipeline
AI, not analytics AI.

| Unit | What it added | Commit |
|---|---|---|
| **36.1** | `aiProvider` (the single vendor choke point), `piiRedactor`, `aiUsageTracker`, `AIUsageLog`, quota, global + per-tenant kill switch, rate limit, opaque vendor errors, `POST /api/ai/chat` | — |
| **36.2** | `hrContextRetriever` (read-only, redacted, authorized), `AITenantConfig` + tenant service + cache, `allowedCategories` allowlist, config & preview endpoints | — |
| **36.3** | `hrChatbotService`, `POST /api/ai/chatbot`, the employee chat surface | — |
| **36.3b** | The surface became a **floating widget** — the `/app/ai-assistant` route and the sidebar entry were **removed** | — |
| **36.4** | Nine more own-record context categories, a static capability catalogue, role-aware aggregate counts, prompt rules 10–14, retry/copy UX | — |
| **36.5** | Voice (browser-native `SpeechRecognition` / `speechSynthesis`) and five reply languages. No new package. | `29ad469` |
| **36.6** | Progressive reveal, follow-up chips, deep-link navigation chips, structured answer cards, named payslip fields, onboarding empty state, transcript export, typing-stops-speech, admin usage dashboard | `6529cde` |
| **36.7** | Admin-configurable reply languages: a 14-language platform catalogue, `AITenantConfig.languages`, a new AI Settings page, a tenant-aware validator. No new package. | `90a8451` |
| — UI follow-up | panel polish + the language-selector `label === native` fix | `ddd1810` |
| — save fix | per-field save payload + the `\u2550` escape repair | `46dbd14` |
| — category lock | removed the "all off is allowed" copy, locked the last category | `bfd69cb` |
| — loading fix | `read()` → `load()` so the `loading` flag actually clears | `a11237e` |
| — non-modal | panel stopped dimming the whole page; duplicate welcome removed | `95bbe65` |
| — **sidebar entry** | the HR Assistant is reachable from the sidebar again (reverses 36.3b) | `d280cb4` |
| — **admin AI sidebar** | AI Settings + AI Usage are reachable from the sidebar | `08d0b73` |
| — **socket follows the API** | the chat socket stops connecting to the page origin, so realtime works when the SPA and API are different hosts | `—` (36.8, this unit) |

Reference docs: `docs/PHASE_36_1_FOUNDATION.md` …
`docs/PHASE_36_7_ADMIN_LANGUAGES.md`, hub `docs/PHASE_36_HR_CHATBOT.md`,
`docs/PHASE_36_RUNBOOKS.md`, `docs/PHASE_36_MEMORY_CAPSULE.md`.

---

## 5. PHASE 36 IN DETAIL — THE LAWS

### 5.1 The nine invariant laws

1. **PII redaction is mandatory.** `redactPII()` runs on the assembled
   context as the last step before the boundary, and again on every user
   turn. No per-request opt-out. Stripped: Aadhaar, PAN, UAN, Indian mobile,
   email, bank account, IFSC, and **salary-labelled amounts**.
   **Aadhaar and UAN share one row on purpose** — both are 12-digit numbers
   and no regex can tell them apart. Do not split this row.
2. **Privacy by absence.** `AIUsageLog` has **no** prompt, response, reply,
   text, message, content, body, input, output or PII field. Not encrypted —
   **absent**. It records counts and metadata only. There is also **no
   server-side chat persistence** and **no `localStorage` of chat content**.
   The conversation is React state for the life of the tab.
3. **Scoping is `req.companyId` and `req.user._id`, always.** The tenant
   authority is `req.companyId` and nothing else. The validator refuses
   `companyId`, `company`, `userId`, `user` and `feature` from a request body
   outright. `getUserHRContext({ companyId, userId, ... })` has **no
   alternate-identity parameter of any kind** — the signature *is* the
   authorisation.
4. **Informational only.** AI output is text shown to a human. It never
   approves, applies, punches, pays or decides. The retriever uses `find`,
   `findOne`, `findById`, `aggregate`, `countDocuments` — no `save`,
   `update`, `delete` or counter.
5. **The authorization ceiling.** Employee → own records only. Manager /
   Team lead → own records + team **counts**. HR / Admin → own records +
   company **counts**. Counts, never rows. An aggregate never carries an id,
   a name, a designation or a salary figure.
6. **Fail closed, always.** A quota read that throws is a refusal, never a
   bypass. A tenant-config read that throws is `503 AI_CONFIG_READ_FAILED`.
   Redis down fails closed (`503` / `FEATURE_UNAVAILABLE`) — never fail open,
   and never a silent persist-to-Mongo fallback for transient AI
   conversation state.
7. **Opaque vendor errors.** Every vendor failure becomes one generic
   `503 AI_VENDOR_ERROR` with one sentence. The browser never sees a vendor
   status, message, host or key. Logs carry metadata only:
   `{ feature, errorType, status, latencyMs }`.
8. **Two kinds of "nothing" — never let them look alike.**
   ```
   NONE         "none assigned to you" / "NO_RECORD - none recorded" /
                "none - you have no pending leave requests"
                -> the read SUCCEEDED and the answer IS that nothing exists.
                   State it plainly. It is an answer.

   UNAVAILABLE  "(attendance unavailable)"
                -> the read FAILED. Say it could not be retrieved, suggest HR.
   ```
   Conflating them is what made the assistant answer *"I do not have that
   information"* to a question it could answer. Prompt rules 8 and 9 encode
   the distinction.
9. **The money rule.** The redactor masks a **salary-labelled** number by
   design: `"net pay 45000"` → `"net pay [AMOUNT_REDACTED]"`. A bare business
   number is not salary: `"deductions 15000"` and `"amount 1200"` survive.
   So the payslip context carries **which months exist and their status**,
   never a figure, and the query is narrowed so `snapshot.salary.*` is never
   even selected from Mongo. `Total Deductions` is **NOT** a salary label in
   the redactor — which is exactly why the prompt's payslip format was
   refused.

### 5.2 The 13 context categories

`profile`, `payslips`, `expenses`, `tasks`, `projects`, `documents`,
`leave-requests`, `leaves`, `attendance`, `attendance-month`, `policies`,
`org-aggregates`, `capabilities`

- `performance` is **deliberately absent** — reading an appraisal runs its
  own access chain and a config flag must never switch it on.
- `capabilities` is static and needs no database read, which is why that
  category cannot fail.
- Labels shown to admins (each verified against its `render*` in
  `hrContextRetriever.js`): profile, payslips (month + status only — never a
  salary figure), expenses, tasks, projects, documents (own titles — never
  the files), leave-requests, leaves, attendance (today), attendance-month,
  policies (30-day lookahead), org-aggregates (counts only, role-scoped),
  capabilities.

### 5.3 The system-prompt rules

English → rules **1…15**, rule 16 absent. Tamil → **1…16**.
Follow-up is rule **15** (unconditional), language is rule **16**
(conditional — omitted entirely for English, so an English turn stays
byte-identical to a 36.3 turn). `RULE_COUNT = 15` at
`Backend/test/phase36Closeout.test.js:533`.

1. Answer concisely, plain language.
2. If the answer is in the context, give it directly.
3. If not, do **not** guess — and a bare refusal is not enough (rule 14).
4. **NEVER invent** leave balances, policies, holidays or employee data.
5. Never reveal or repeat identifiers; `[REDACTED]` is intentional.
6. Never offer to act on the employee's behalf.
7. Be polite and empathetic.
8. **"NONE" is an answer.** State it plainly.
9. **"UNAVAILABLE" is not an answer.** The read failed; say so.
10. "How do I…" questions come from the capability catalogue.
11. **Name your source.**
12. **Never state a salary figure.**
13. **You only know this employee.** A count is not a person.
14. **When you cannot answer, still be useful** — say what is missing, give
    the closest thing you do have, then say what to do next. Rule 4 still
    wins over rule 14.
15. (unconditional) follow-up rule.
16. (conditional) the language rule.

All are pinned verbatim by `Backend/test/hrChatbotService.test.js`. If you
change a rule, change the pin in the same commit.

### 5.4 The 36.5 laws (voice + multilingual)

1. **English carries no language rule at all.** `languageRule` is replaced
   with the empty string for `en`.
2. **The language rule is 16, and it is CONDITIONAL.** Follow-up stays 15 and
   unconditional.
3. **Language is a preference, never an authority.** Not in
   `chatbotIdentityOverride`, and a test asserts that.
4. **Validator refuses, service normalizes.** A 400 at the edge, a silent
   fallback to `en` inside the service. Both, on purpose.
5. **`sentViaVoice` lives on a ref.** A state flag would speak the reply
   twice under strict mode.
6. **No audio is persisted anywhere.** Neither voice module may reference
   `MediaRecorder`, `Blob`, `FileReader`, `createObjectURL`, `FormData`,
   `indexedDB` or `localStorage`.
7. **No network call of ours.** Neither voice module may import `api.js` or
   call `fetch`.
8. **`language` lives in Redux only.** No `localStorage`, ever.
9. **No server-side language detection and no backend auto-translation.**
10. **The frontend voice features are NOT hermetically tested.**
    `aiVoice.test.js` pins wiring only. The owner verifies in Chrome.

### 5.5 The 36.6 laws (advanced UX)

1. **The assistant NAVIGATES. It never ACTS.** `AI_DEEP_LINKS` is hardcoded in
   `aiConfig.js` and keyed by the category the retriever filled. Never taken
   from the model. No chip calls an API, dispatches or mutates.
2. **No chip path may contain `://`, `?` or `#`.** An absolute URL leaves the
   product; a query string can carry data. Pinned by test.
3. **`/app/attendance`, NOT `/app/attendance/my-attendance`.** The latter
   does not exist in `AppRoutes.jsx`. Every path in the map was verified.
4. **A card may RE-RENDER information. It may never REMOVE or CHANGE it.**
   `parseReplyBlocks` requires a run of ≥2 lines that ALL match
   `- Label: value`, renders label and value verbatim, and collapses the
   whole run back to text if any line fails. A misparse degrades to 36.3,
   never worse.
5. **A bullet with no colon is never a card.** `- none assigned to you` is
   an ANSWER (rule 8), and a card row would strip the prose.
6. **The money rule did not move.** `renderPayslips` still carries month and
   status only. 36.6 only NAMED the three withheld fields.
7. **`Total Deductions` is NOT a salary label in the redactor.**
8. **No SSE.** The reveal is client-side. An SSE path would have to reopen
   `aiProvider.js`'s guard ladder, which 68 tests pin.
9. **`prefers-reduced-motion` disables the reveal.** Checked per render.
10. **The transcript is never sent anywhere.** `buildTranscript` is a pure
    string function; `downloadTranscript` is the only function that touches a
    browser API, and it revokes its object URL.
11. **A message with no timestamp prints `[unknown time]`.** Never the export
    time.
12. **`getUsage` reads NOTHING from the request.** No body, no query, no
    params.
13. **`byStatus` is an OBJECT keyed by status, not an array.** `byFeature` is
    an ARRAY.
14. **`SETTINGS_MANAGE`, never `ai:admin`.** There is no `ai:admin`
    permission in this repo.
15. **`QuickPromptPills.jsx` was DELETED** in 36.6. The grouped onboarding
    chips replaced it.

### 5.6 The 36.7 laws (admin languages)

1. **The catalogue is the ceiling, the tenant list is the offer.**
   `AI_LANGUAGE_CATALOGUE` is 14 codes; `AI_TENANT_LANGUAGE_DEFAULT` is the
   36.5 five. The model's ENUM is the catalogue and its DEFAULT is the five.
   `AI_SUPPORTED_LANGUAGES` is an ALIAS of the default set, kept so 36.5
   imports still resolve. It is NOT the catalogue.
2. **No free-text language entry. Ever.** The owner decided this.
3. **English is mandatory per tenant**, enforced at the MODEL, in the
   validator chain, AND in the settings page. Three layers because the model
   is the one that cannot be bypassed.
4. **A language is PRESENTATION.** It never changes what a caller may read.
   `noIdentityOverride` still refuses it from a body.
5. **The validator checks the platform enum FIRST, the tenant list SECOND.**
6. **`getTenantLanguages` fails CLOSED to the default set and never throws.**
7. **`GET /ai/languages` has NO RBAC** — any authenticated user. It returns
   presentation preferences only. Reading the QUOTA still needs
   `SETTINGS_MANAGE`.
8. **Rule 16 is the language rule and it is CONDITIONAL.**
9. **The frontend keeps a copy of the catalogue, and a test imports the
   backend module and compares FIELD BY FIELD.** Never scrape the backend
   file as text.
10. **`chatLanguagesFor` keeps only codes that are actually on the
    platform.** Filtering by type is not filtering.
11. **Catalogue order, not arrival order.**

### 5.7 The assistant shell — the current shape

- **Non-modal corner panel**, since `95bbe65`. The page behind stays live
  and clickable. Closing is the X or Escape; **clicking the page does NOT
  close it**, because a panel that vanishes when you click your own work is
  a panel you stop trusting. `aria-modal` was removed too — there was never
  a focus trap.
  ```jsx
  <div className="fixed bottom-5 right-5 z-50 flex h-[calc(100vh-8rem)] max-h-[600px] w-[420px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-xl …">
  ```
- **The panel's open state is Redux, not local `useState`**, since `d280cb4`.
  `state.aiChat.panelOpen` plus `openAssistantPanel` / `closeAssistantPanel`
  / `toggleAssistantPanel` in `Frontend/src/redux/slices/aiChatSlice.js`.
  `panelOpen` is deliberately **NOT** in localStorage — a panel that reopens
  itself is a panel people ignore. The floating button, the sidebar entry and
  the panel's close control all drive the same flag, and the panel survives a
  route change.
- **The sidebar entry** is `renderAssistant(collapsed = false)` in
  `Frontend/src/layout/SidebarNav.jsx`, rendered as a **top-level sibling of
  `<nav>`** below the search box, in all three variants (mobile drawer,
  expanded rail, collapsed rail). It is a **`<button>`, not a `NavLink`**,
  because it does not navigate — `NAV_GROUPS` / `matchesGroup` would dump a
  non-navigating item in the `other` bucket. Collapsed variant is icon-only
  with `title="HR Assistant"`; expanded shows `<Bot/>`, "HR Assistant" and a
  small green `AI` badge. Click calls `handleNav()` (closes the mobile
  drawer) then `dispatch(openAssistantPanel())`.
- **The `/app/ai-assistant` route is NOT restored.** It was removed in 36.3b
  and stays removed.

### 5.8 The admin AI sidebar group

```js
{
  id: "ai-admin",     // NOT "ai" — that was the removed 36.3b group's id
  label: "AI",
  icon: Sparkles,
  paths: ["/app/settings/ai-settings", "/app/settings/ai-usage"],
  // no `more: true` — deliberately PRIMARY, not behind "More"
}
```

`/app/settings/ai-settings` (icon `SlidersHorizontal`) and
`/app/settings/ai-usage` (icon `Activity`) are in
`NAV_BY_ROLE[COMPANY_ADMIN]` and in **no other role**. Both are behind
`RequireRole(COMPANY_ADMIN)` in `AppRoutes.jsx` **and** a server-side
`SETTINGS_MANAGE` check. **Not** folded into "Administration" (behind "More",
collapsed) and **not** under "Me" — they configure the tenant's assistant for
everyone, they are not a personal preference.

### 5.9 The 36.8 laws (the socket follows the API, not the page)

1. **A socket with no URL connects to `window.location.origin`.** That is not
   a default to be tolerated — it is straight out of `engine.io-client`'s
   `url()`: `if (null == uri) uri = loc.protocol + "//" + loc.host;`. Behind
   the Vite proxy it is correct. Behind a static host it is a silent bug.
2. **The socket URL is DERIVED from `VITE_API_URL`'s ORIGIN, never configured
   twice.** One variable, two transports, no drift. A second variable is a
   second thing to forget, and forgetting it reproduces the bug exactly.
3. **An ORIGIN, not the API URL.** `VITE_API_URL` carries `/api` because it is
   the axios baseURL; the socket lives at `/socket.io` on the host root.
   Passing the whole URL requests `/api/socket.io`, which 404s and reads like
   a server fault.
4. **A relative `VITE_API_URL` (`/api`, the dev default) yields `''`.** There
   is no host in it, and inventing one connects to nothing. The caller then
   omits the URL argument and keeps same-origin behaviour.
5. **The parse is guarded AND wrapped.** `^https?://` is checked before
   `new URL()`, and the `new URL()` is inside `try/catch`. A module that
   throws at import time takes the chat page down instead of degrading.
6. **`VITE_SOCKET_URL` is the explicit override**, passed through verbatim —
   socket.io resolves both absolute and page-relative values. Empty (an unset
   `.env` var) falls through to the derived origin.
7. **The resolver is PURE** — `resolveSocketUrl(source = import.meta.env)`,
   the same shape as the backend's `getRedisConfig(source)` and
   `validateProductionConfig(source)`, so it is testable with no DOM.
8. **The client hard-codes no host.** A literal host works on one deploy and
   nowhere else, and it is the bug wearing a different hat. Pinned by test.
9. **`AI_ENABLED=false` is a 503, not a 404.** The AI routes are always
   mounted; the kill switch is `aiProvider`'s Guard 1, which throws
   `AIError.unavailable()`. A chatbot that "does not work" on a deploy is
   almost always `AI_ENABLED` not `true`, or a missing `AI_API_KEY` — and in
   production a missing key with `AI_ENABLED=true` **exits the process at
   boot** via `validateAIConfig`.
10. **A SAME-ORIGIN SOCKET HIDES EVERY CORS FAULT.** `withCredentials: true`
    on the client against a server whose Engine.IO `cors` is
    `credentials: false` makes the browser demand
    `Access-Control-Allow-Credentials: true`, the server refuse it, and every
    cross-origin polling response is dropped. Behind the Vite proxy the
    socket is same-origin, so it is never CORS-checked and the mismatch
    cannot surface. It appears the instant the SPA and the API are on
    different hosts — as a wall of `CORS error` on
    `/socket.io/?EIO=4&transport=polling` while every REST call beside it
    returns 200. **The handshake authenticates from `auth.token` (a
    60-second ticket), never from a cookie — 33.1's locked decision — so the
    client must send `withCredentials: false`.**
11. **The socket's allowlist and the REST CORS allowlist are the SAME
    `CLIENT_URL`.** Comma-separated, trailing slash stripped, in both places.
    So a REST call that succeeds proves the socket origin gate will admit the
    same origin — and a `CORS error` on `/socket.io` is never an origin
    problem once REST works. Pinned by
    `chatSocketFoundation.test.js` so the diagnosis is one lookup.

### 5.10 Deploying to Render (API + worker) and Vercel (SPA)

**Ready and test-pinned:** `Frontend/vercel.json` SPA rewrite · `api.js`
`baseURL = import.meta.env.VITE_API_URL || '/api'` · `npm start` and
`npm run worker` deterministic non-watch commands · `CLIENT_URL` is
**comma-separated** so the Vercel origin is allowlistable · cross-site cookies
already emit `SameSite=None; Secure` in production (`tokenService.js:104-106`)
· the backend serves **no** static assets, so the split is architecturally
correct.

**Required on Render (both the `web` and the `worker` service):**
`NODE_ENV=production` (this is what switches the cookie flags on),
`MONGO_URI`, `JWT_SECRET` (32+ chars), `FIELD_ENCRYPTION_KEY`,
`CLIENT_URL=https://<app>.vercel.app`, `REDIS_ENABLED=true`, `REDIS_URL`,
`AI_ENABLED=true` + `AI_API_KEY`, SMTP, Cloudinary, Razorpay, and
`TRUST_PROXY_MODE` (Phase 32.3 — wrong value breaks rate limiting and IP
logging behind Render's proxy). Verify with `npm run config:check
--production`, which names keys and never values.

**Required on Vercel:** `VITE_API_URL=https://<api>.onrender.com/api` and
`VITE_MAX_RESUME_SIZE_MB=5`. `VITE_SOCKET_URL` is left empty — it is derived.

**The BullMQ worker MUST run as its own service.** One service means email,
resume parsing, ATS, BGV and every scheduled job silently never drain.

---

## 6. QUICK REFERENCE — EXACT VALUES

| Thing | Value |
|---|---|
| Language catalogue order | `en, ta, tanglish, hi, te, kn, ml, mr, gu, pa, bn, or, as, ur` |
| Default tenant five | `en, ta, tanglish, hi, te` |
| Owner's live tenant languages | **`en, ta` only — intentional, must survive further UI work** |
| Owner's 36.3 AI config | `AI_ENABLED=true`, provider `groq`, model `openai/gpt-oss-120b`, `AI_MAX_TOKENS 1024`, quota 100000 |
| Local sandbox `.env` | `AI_ENABLED=false` (dummy values; no local `mongod`) |
| Shipped default model | `openai/gpt-oss-120b` (Groq) |
| Groq decommissioned | `llama-3.3-70b-versatile` + `llama-3.1-8b-instant`, free/developer tier, **2026-08-16** |
| Groq embeddings | **none** — `embed()` returns `UNSUPPORTED` |
| `AI_POLICY_LOOKAHEAD_DAYS` | 30 |
| Deep links | `leaves` (553), `attendance` (418, NOT `attendance/my-attendance`), `payroll/my-payslips` (611), `documents` (879) |
| `RULE_COUNT` | 15 (English 1–15; Tamil 1–16) |
| Field-name pair | `parseFollowUps(reply, categoriesUsed) -> { cleanReply, questions }`; `askHRAssistant(...) -> { reply, usage, categoriesUsed, followUpQuestions, deepLinks }` |
| `getUsage` | `byFeature` is an ARRAY; `byStatus` is an OBJECT |
| New npm packages total | 3 (`sonner`, `socket.io-client`, `openai`) — nothing since 36.1 |
| Lint baseline | **128 problems** (109 errors, 19 warnings) — a hard gate |

### Route order in `Backend/src/routes/ai.js`

`/chat` → `/chatbot` → **`/languages` (no RBAC)** → `/config` (GET + PUT,
`SETTINGS_MANAGE`) → `/context/preview` → **`/usage` LAST**
(`SETTINGS_MANAGE`).

### The AI service map

```
POST /api/ai/chat            -> aiController.chat          -> aiChat()
POST /api/ai/chatbot         -> aiController.chatbot       -> askHRAssistant()
GET  /api/ai/config          -> aiController.getConfig     -> getTenantConfig()
PUT  /api/ai/config          -> aiController.updateConfig  -> updateTenantConfig()
GET  /api/ai/context/preview -> aiController.previewContext -> getUserHRContext()
GET  /api/ai/languages       -> aiController.getChatLanguages  (NO RBAC)
GET  /api/ai/usage           -> aiController.getUsage       (SETTINGS_MANAGE)
```

| Module | The one thing to know |
|---|---|
| `aiProvider.js` | The **single** vendor choke point. Every guard runs here and nowhere else. |
| `aiConfig.js` | 56 exports, no `import` statements so plain Node loads it cleanly. `AI_CONTEXT_CATEGORIES` is the single source of truth. |
| `aiErrors.js` | `sendAIError` is the **one place** a code-bearing reply is produced — the shared `errorHandler` drops `err.code`. |
| `piiRedactor.js` | One row per identifier class, applied in array order. Idempotent. Aadhaar+UAN share a row. |
| `aiTenantConfigService.js` | Invalidation is a `DEL` of the exact key. Never a wildcard. |
| `hrContextRetriever.js` | Read-only. Signature is the authorisation. One `redactPII()` call, at the end. |
| `hrChatbotService.js` | Caps history FIRST, then fetches context, redacts user turns only, **one** vendor call. Logs and persists nothing. |
| `aiValidator.js` | `validate` **THROWS** an `ApiError` — a promise wrapper that only watches `next` never sees the refusal. |

### Reading a vendor failure

| `errorType` | Meaning |
|---|---|
| `auth` | bad or rotated `AI_API_KEY` |
| `rate_limit` | the vendor's own limit |
| `timeout` | network slow |
| `network` | no internet / DNS / firewall |
| `vendor` | dead model string, or payload too large |

Runbooks: `docs/PHASE_36_RUNBOOKS.md` (Incident 7 and the rest).

### Seeing exactly what the assistant sees

```powershell
curl.exe -s -b cookies.txt http://localhost:5000/api/ai/context/preview
```

Prints the whole redacted context, section by section. The fastest way to
answer *"why did it refuse?"* — `(x unavailable)` means the read failed,
`none` means the answer genuinely is nothing.

---

## 7. CURRENT STATE

**Branch:** `arena/01a0e7a0-hrms-crewly`
**`main` is at `bc91bb6` and is 22 commits behind** — it has Phases 1–35 but
**none of Phase 36**. Deploying `main` ships an app with no AI assistant at
all. The branch is the only place the AI suite exists.

**Remote tip:** `08d0b73985acfeb370a67765ac82d6d0f57554fb` (+ 36.8 uncommitted
at the time of writing)

**All four gates, all green:**

```
Backend   npm run test:all   → 3064 tests / 167 suites / 0 fail
Frontend  npm test           →  232 tests /  41 suites / 0 fail
Frontend  npm run build      → clean (Vite v8.1.5, 1.27 s)
Frontend  npm run lint       → 128 problems (baseline held)
```

**Backend test counts:** `aiProviderFoundation` 68, `hrContextRetriever` 54,
`hrChatbotService` 75, `hrChatbotOwnRecords` 39, `aiTenantConfig` 49,
`aiTenantLanguages` 35, `phase36Closeout` 49 (`RULE_COUNT=15`),
`chatSocketFoundation` 90.

**Frontend test files:** `chatLanguages` 21, `aiSettings` 60, `aiVoice` 22,
`aiChatPills`, `aiChatStore`, `aiChatWidget` (41, has the `code()`
comment-stripping helper and a `SIDEBAR` constant), `replyCards` 15,
`chatTranscript` 14, `aiChatUx` 21, **`chatSocketUrl` 21** (new in 36.8/36.9).
Runner: `node --import ./test/loaders/register.mjs --test test/*.test.js`.
`read()` reads raw, `code()` strips `/* */` then `//`; both rooted at
`Frontend/`.

**Shipped and pushed, awaiting the owner's localhost acceptance:**

1. **HR Assistant in the sidebar** (`d280cb4`) — a top-level entry opens the
   panel; the floating widget keeps working. **This reverses the 36.3b
   decision** that the floating widget replaces the sidebar entry. The
   removed route was NOT restored.
2. **AI Settings + AI Usage in the sidebar** (`08d0b73`) — both reachable
   without typing the URL, in a new top-level PRIMARY group `ai-admin`.
3. **The chat socket follows the API** (36.8) — the deploy blocker behind
   "everything works except chat". Needs `VITE_API_URL` set on the static
   host; nothing else to configure.
4. **The socket sends no cookies** (36.9) — the second half of the same
   blocker. `withCredentials: true` against a `credentials: false` server
   dropped every cross-origin polling response. Same-origin localhost hid
   it completely.
5. **The master memory capsule** (`adb6ba7`) — one consolidated handoff doc.

**Deploy status (owner-reported):** the app is already deployed and working
**except chat and the chatbot**. Chat was the socket-origin bug, now fixed.
The chatbot is env, not code: set `AI_ENABLED=true` and `AI_API_KEY` on the
API service — see §5.10 for the full variable list.

**Owner's next actions (PowerShell):**

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly
git pull origin arena/01a0e7a0-hrms-crewly

# restart the backend
cd Backend
npm run dev

# hard reload the browser:  Ctrl + Shift + R
```

Then verify: the sidebar **HR Assistant** entry opens the panel; sidebar →
**AI** → **AI Settings** reaches the page without typing the URL.

**Not verified by the agent:** the owner's localhost acceptance of 36.5,
36.6, 36.7, the UI follow-ups, the three "save not working" fixes, the
non-modal panel work, and both sidebar units. The owner has rejected the
framing that Phase 35 was already done — treat "only 34 completed" as
authoritative for intent.

---

## 8. OPEN ITEMS / CANDIDATE NEXT UNITS (NOT AUTHORIZED — ASK FIRST)

1. **Owner acceptance runs** for everything in §7 — his own localhost clicks.
2. **Platform portal cookie migration** — super-admin / support / billing
   still keep a bearer `AdminSession` token in localStorage; bring it to
   HttpOnly cookies with its own CSRF story. Different session model, so a
   separate unit.
3. **`refreshRateLimit` 429 handling** — a 429 on `/auth/refresh` currently
   takes the same path as an expired session; the race retry only handles
   409.
4. **Hub §22.5 label fix** (`chat:message:edited` → `chat:message:updated`)
   in `docs/PHASE_33_CHAT_HUB.md` if that doc is touched again. Harmless and
   unpinned.
5. **Loans / Advances & Employee Recovery** — deliberately reversed at 29.11,
   still a real gap in the payroll ledger.
6. **Later AI candidates, each needing its own phase number and laws:**
   chat-hub AI (summarise / translate / smart replies inside Phase 33
   conversations), document Q&A beyond policy, admin analytics NL queries.
7. Anything the owner names next.

---

## 9. MASTER PITFALL LIST — PAID FOR, DO NOT RE-BUY

### 9.1 The ones that reached the owner

- **🔴 A `loading` FLAG THAT STARTS `true` AND IS NEVER CLEARED KILLS THE
  PAGE WHILE IT LOOKS PERFECTLY HEALTHY.** `AiSettingsPage`'s mount effect
  called `read()`, which never touches the flag; only `load()` clears it.
  Every control was `disabled={... loading}` — Save, Discard, Enable all —
  all dead. **No test that only checks what is RENDERED will see it.** Pinned
  by asserting the effect calls the wrapper that clears the flag.
- **🔴 UI COPY THAT DESCRIBES A STATE THE SERVER REFUSES IS A TRAP, NOT A
  WARNING.** The category section said switching everything off was
  "ALLOWED"; both `updateConfigValidator` and the model refuse an empty
  `allowedCategories`. **Fixed by removing the state (last checkbox locked),
  not by guarding.**
- **🔴 A SOCKET WITH NO URL CONNECTS TO THE PAGE, NOT THE API.** `io()` called
  with no URL makes socket.io-client use `window.location.origin` — it says so
  in `engine.io-client`'s `url()`. Correct behind the Vite proxy, silently
  broken the moment the SPA and the API are different hosts: every handshake
  is refused, the banner says "realtime unavailable", chat degrades to
  read-only REST, and the rest of the app looks perfectly healthy. It reads
  like a Redis problem and it is a URL problem. The fix derives the socket
  origin from `VITE_API_URL` so one variable configures both transports.
- **🔴 SAME-ORIGIN HIDES EVERY CORS FAULT, AND THAT IS WHY IT SHIPS.** The
  second deploy blocker was a `withCredentials: true` on the socket client
  against a server whose Engine.IO `cors` is `credentials: false`. The
  browser then REQUIRES `Access-Control-Allow-Credentials: true`, the server
  deliberately refuses it (the handshake uses a ticket in the auth payload,
  never a cookie), and every cross-origin polling response is dropped.
  Behind the Vite proxy the socket is same-origin and is never CORS-checked,
  so the mismatch cannot surface at all — not in a test, not in a build, not
  in localhost. It appears only in the deployed split, as a wall of
  `CORS error` beside `200` REST calls. **A localhost-green transport is not
  a deployed-green transport.**
- **🔴 A `CORS error` BESIDE `200` REST CALLS IS NOT AN ORIGIN PROBLEM.** The
  socket's allowlist and the REST CORS allowlist are the same `CLIENT_URL`.
  If REST succeeds, the origin is allowlisted and the socket gate will admit
  it. So look at the credentials flag and the URL, not the allowlist.
- **🔴 A SECOND CONFIGURATION VARIABLE IS A SECOND THING TO FORGET.** The
  obvious fix for the socket URL is `VITE_SOCKET_URL`, and an owner who sets
  `VITE_API_URL` and not `VITE_SOCKET_URL` reproduces the bug exactly. Derive
  what you can; make the override the exception, not the rule.
- **🔴 AN API BASE URL IS NOT A SOCKET URL.** `VITE_API_URL` carries `/api`
  because it is the axios baseURL. Handing it to the socket requests
  `/api/socket.io`, which 404s — and a 404 on a handshake reads like a server
  fault, not like a misconfigured client.
- **🔴 `AI_ENABLED=false` IS A GENERIC 503, NOT A 404.** The AI routes are
  always mounted; the kill switch lives in `aiProvider`'s Guard 1. So "the
  chatbot does not work" on a deploy means the env, not the routing — check
  `AI_ENABLED` and `AI_API_KEY` first. And in production a missing key with
  `AI_ENABLED=true` **exits the process at boot** (`validateAIConfig`), which
  takes the whole API down and looks like a crash rather than a config error.
- **🔴 A MODULE THAT THROWS AT IMPORT TIME TAKES THE PAGE DOWN.**
  `new URL('/api')` throws, so the origin derivation must guard on `^https?://`
  before parsing and wrap the parse anyway. Degrading to `''` is free;
  throwing is not.
- **🔴 THE OWNER'S EXACT WORDING IS THE DIAGNOSTIC.** "save not working"
  twice did not localise the bug; "disabled la iruku" did. When a report is
  vague, ask for the precise symptom before guessing.
- **🔴 AN ERROR BANNER AT THE TOP OF A LONG PAGE IS INVISIBLE TO THE PERSON
  WHO CLICKED THE BUTTON AT THE BOTTOM.** Render save feedback inside the
  action surface.
- **🔴 A STICKY BOTTOM BAR CAN SIT UNDER A GLOBAL FIXED WIDGET.**
  `AiAssistantWidget` is `fixed bottom-5 right-5 z-40` app-wide. Fix with
  `pr-[76px]`, **not** by raising z above the widget.
- **🔴 A ROUTE THAT NOBODY CAN REACH IS NOT A FEATURE.**
  `/app/settings/ai-settings` and `/app/settings/ai-usage` shipped with a
  route guard, a server-side check, a page and tests — and **no sidebar
  entry**. The only way in was typing the URL. **Always check that a guarded
  page has a nav entry.**
- **🔴 A STATE THAT LIVES INSIDE ONE OF TWO AFFORDANCES CANNOT BE REACHED BY
  THE OTHER.** The panel's `open` flag was `useState` inside the widget, so
  the sidebar could not open it. Lift shared state above both controls.
- **🔴 A TAB OR SLICE THAT WORKS IN ISOLATION BUT WAS NEVER REGISTERED
  RENDERS A BLACK PAGE.** 36.3's slice was never added to `store.js`.
- **🔴 `errorHandler` DROPS A CUSTOM `err.code`.** Any code-bearing reply
  (`409 REFRESH_IN_PROGRESS`, `403 CSRF_HEADER_REQUIRED`) must be written
  directly with `res.status(...).json({...})`.
- **🔴 `Set-Cookie` VIA `setHeader` TWICE REPLACES.** Append (read
  `getHeader`, push, set). And `if (options.maxAge)` skips `0` — the exact
  value the cookie-delete path needs.
- **🔴 `io.close()` ALSO CLOSES THE UNDERLYING HTTP SERVER.** Never inside
  graceful shutdown. And `attach()` after `listen()` leaves `ws` dead while
  polling still "works".

### 9.2 Test and pin traps

- **🔴 A BAN ON A TOKEN MATCHES THE COMMENT THAT EXPLAINS THE BAN.** Hit at
  least four times: `fileUrl`, `inset-0`/`bg-black`, `allowedCategories: []`,
  and the bare string `"ai"`. **Strip comments before grepping** — the front
  tests have `code()` / `readCode()` helpers for exactly this.
- **🔴 A PIN AGAINST A PHRASE THAT ONLY EXISTS IN A COMMENT FAILS**, because
  `code()` strips comments. Pin the real control, not the vocabulary.
- **🔴 A SLICE TO "THE END OF THE FILE" SWEEPS UP EVERYTHING BELOW IT.** A
  pin that sliced the sidebar from `const renderAssistant` to EOF failed
  because every nav link lives below it. Bound it to the next function
  (`const renderItem`).
- **🔴 A SOURCE PIN SLICED TO "THE NEXT EXPORT" CAN BE EMPTY.**
  `chatbotValidator` is the LAST export in `aiValidator.js`.
- **🔴 A BAN ON A GROUP ID IS A BAN ON A NAME, NOT ON A THING.** Tightened to
  ban the ROUTE (`/app/ai-assistant`) instead.
- **🔴 A BAN PIN CAN BE TOO BROAD AND FAIL ON LEGITIMATE CODE.**
  `AiSettingsPage.jsx:212` is a legitimate empty `useState` default. Pin the
  removed control's *shape*, never the bare token.
- **🔴 A `describe` BLOCK DOES NOT SEE HELPERS FROM ANOTHER BLOCK** — each
  needs its own.
- **🔴 `await import()` INSIDE A `describe` CALLBACK IS ILLEGAL.** Hoist to
  the top of the file.
- **🔴 A FAKE MODEL MUST EXPOSE THE METHOD THE CODE ACTUALLY CALLS.**
  `loadFromMongo` uses `findOneAndUpdate`, NOT `findOne`.
- **🔴 A VALIDATOR CHAIN CAN THROW INSTEAD OF CALLING `next(error)`.**
  `validate` throws an `ApiError`.
- **🔴 A PYTHON RAW STRING TURNS `\n` INTO A LITERAL BACKSLASH-n**, and a
  backslash before a backtick survives a Python heredoc as two characters.
- **🔴 AN ASSERTION ON MULTILINE JSX MUST NOT INCLUDE THE SURROUNDING
  `>`/`<`.** Pins must tolerate newlines and whitespace.
- **🔴 `node --check` CANNOT PARSE `.jsx`** — `ERR_UNKNOWN_FILE_EXTENSION`.
  Use `npm run build`.
- **🔴 THE `read()`/`code()` TEST HELPERS ARE ROOTED AT `Frontend/`**, so
  backend files are `../Backend/...`.
- **🔴 `npm run test:<one-suite>` PRINTS A DESCRIBE-LEVEL FAILURE THAT A
  `# tests`/`# pass` GREP WILL HIDE.** Always read `# fail` too.
- **🔴 `grep` WITH ZERO MATCHES IN A `&&` CHAIN KILLS THE CHAIN.** Use
  `|| true`.

### 9.3 Frontend traps

- **🔴 A TAILWIND ARBITRARY VALUE IS NOT MISSING JUST BECAUSE YOUR GREP SAYS
  SO.** `max-w-[calc(100vw-2.5rem)]` appears in the built CSS as
  `calc(100vw - 2.5rem)` with `.` escaped as `\.`. Confirm against the
  escaped selector.
- **🔴 `{/* comment */}` IS ILLEGAL INSIDE A JSX OPENING TAG.** It parses as
  a spread. Put the comment above the element.
- **🔴 `react-hooks/set-state-in-effect` IS NOT AVOIDABLE BY REFACTORING** —
  ~66 instances, suppressed at file level in `AiSettingsPage.jsx`. Derive
  state instead of setting it in an effect where you can.
- **🔴 `useBlocker` ONLY WORKS WITH A DATA ROUTER.** `main.jsx` mounts
  `<BrowserRouter>`, so it silently does nothing. Use `beforeunload` and
  state the in-app limitation in the source.
- **🔴 RENAMING A STATE VARIABLE IS NOT THE SAME AS ADDING ONE.** A
  replace-instead-of-add patch left dangling uses; `no-undef` caught it.
- **🔴 THE FRONTEND'S CIRCULAR IMPORT IS REAL AND ORDER-DEPENDENT.**
  `aiChatSlice -> aiService -> api -> store -> aiChatSlice`. Import the
  **STORE** first in any test that touches the slice.
- **🔴 A `builder` CHAIN TERMINATED BY `;` CANNOT BE EXTENDED.** Appending
  `.addCase(...)` after the semicolon is a `SyntaxError` at the leading dot.
- **🔴 `.auth-*` CSS "MISSING"** — it never existed; it is defined once in
  `Frontend/src/style.css` (there is no `index.css`).
- **🔴 A HAND-COPIED UNICODE STRING WILL BE WRONG.** A Telugu native name
  arrived as an Odia character — visually near identical, wrong script.
  Regenerate the frontend copy from the backend module.

### 9.4 Backend traps

- **🔴 A UNICODE ESCAPE WRITTEN AS LITERAL TEXT LANDS IN THE FILE AS SIX
  CHARACTERS.** Comment banners built from `\u2550` / `\u2500` rendered as
  gibberish. Repair rule: only rewrite escapes on lines whose stripped form
  starts with `//`, `*` or `/*`.
- **🔴 THE AI RATE LIMIT IS ENFORCED IN EXACTLY ONE PLACE: THE CONTROLLER.**
  A second enforcement point means two stores with two windows.
- **🔴 MONGOOSE `upsert` + `setDefaultsOnInsert`** — read the model's
  `findOneAndUpdate` path, not `findOne`.
- **🔴 THE RESPONSE INTERCEPTOR ALREADY UNWRAPS.** `api.js` unwraps
  `body.data` when there is no `meta`. No PUT swallowing exists — do not add
  one.
- **🔴 `toSnapshot` AND `UPDATABLE_FIELDS` MUST BOTH BE UPDATED** or the
  field silently does nothing: one drops it on read, the other answers
  `Unsupported AI config field(s)` on write.
- **🔴 `AI_DEFAULT_LANGUAGE` MUST BE IMPORTED INTO THE VALIDATOR** before it
  is used in a `custom()`. Node reports `is not defined` from inside the
  chain, which reads like a product bug and is not.
- **🔴 IMPORTING `routes/index.js` UNDER `node --test` HANGS.** Smoke-test
  route modules with `MONGO_URI` set instead.
- **🔴 DOUBLE-COUNTING THE RATE LIMIT**, **a fake model that is not a
  document**, **a quick prompt that promises what the context cannot
  supply**, **nodemon never watching `.env`**, **the store import cycle** —
  all recorded in `docs/PHASE_36_MEMORY_CAPSULE.md` §4.

---

## 10. SANDBOX QUIRKS (ARENA) — RECOVERY PLAYBOOK

- **🔴 THE SANDBOX RE-CLONES THE REPO STALE ON SESSION RESTORE.** This has
  happened **seven times** this session. Local HEAD can land back at
  `bc91bb6` with all recent work showing as modified/untracked. Repair
  (**never `--hard`**):

  ```bash
  cd /home/user/HRMS_Crewly
  git fetch origin '+refs/heads/*:refs/remotes/origin/*'
  git ls-remote origin refs/heads/arena/01a0e7a0-hrms-crewly   # the real tip
  git update-ref refs/heads/arena/01a0e7a0-hrms-crewly <tip-sha>
  git reset --mixed <tip-sha>      # index/HEAD only, files untouched
  git status --short               # expect clean
  ```

  **The working tree survives even when `.git` does not**, so uncommitted
  edits are usually still there — always check before redoing work.
- **🔴 `node_modules` DISAPPEARS BETWEEN TURNS.** Expect to reinstall in BOTH
  `Frontend/` and `Backend/`:
  `npm install --no-audit --no-fund`.
- **🔴 `Backend/.env` DISAPPEARS.** Recreate a **gitignored** dev `.env` with
  synthetic values or ~14 suites exit on import-time guards. Never commit it;
  `.env.example` carries names/placeholders only. Known-good local content:
  `NODE_ENV=development`, `PORT=5000`,
  `MONGO_URI=mongodb://127.0.0.1:27017/crewly_dev`,
  `CLIENT_URL=http://localhost:5173`, `JWT_SECRET=local-dev-only-…`,
  `JWT_EXPIRES_IN=7d`, `FIELD_ENCRYPTION_KEY=local-dev-only-…`,
  `REDIS_ENABLED=false`, `REALTIME_ENABLED=false`,
  `CHAT_SOCKET_ENABLED=false`, **`AI_ENABLED=false`**, empty
  SMTP/Cloudinary.
- **No `mongod` or Redis binaries in the sandbox** → hermetic tests only
  (fake models via DI). Live Redis checks are opt-in and use the owner's
  cloud instance.
- **PUSH AUTH IS UNRELIABLE** — re-check `gh auth status` AND
  `git ls-remote` before retrying; never ask the user for a token.
- **The Arena diff panel counts from the BRANCH BASE COMMIT, not from the
  last push.** After a reset it can legitimately report a huge number. Check
  `git log` and `git ls-remote` first.
- **Harmless noise, not tampering:** `npm run config:check` prints a random
  line such as `◇ injected env (0) from .env // tip: ⌁ auth for agents
  [www.vestauth.com]`. Traced to `dotenv@17.4.2`'s own `TIPS` array in
  `Backend/node_modules/dotenv/lib/main.js`. It is the package's own ad
  banner.

---

## 11. DOC MAP

| File | What it is |
|---|---|
| `docs/CREWLY_MASTER_MEMORY_CAPSULE.md` | **this file** — the consolidated start-to-end capsule |
| `docs/PROJECT_MEMORY_CAPSULE.md` | full project capsule, Phases 1–30 |
| `docs/PHASE_32_MEMORY_CAPSULE.md` | infrastructure laws that still apply |
| `docs/PHASE_32_RUNBOOKS.md`, `docs/PHASE_32_ARCHITECTURE.md` | Phase-32 ops/architecture truth |
| `docs/PHASE_33_MEMORY_CAPSULE.md` | chat hub + session/auth, rules, strategy, commands |
| `docs/PHASE_33_CHAT_HUB.md` | the chat hub; **§22** close-out summary, §23 session/cookie |
| `docs/PHASE_33_CHAT_RUNBOOKS.md` | DETECT/IMPACT/DO/DO NOT/VERIFY/ESCALATE runbooks |
| `docs/COOKIE_SESSION.md` | the cookie session model, CSRF, socket ticket, incident table |
| `docs/SESSION_REFRESH_RESILIENCE.md` | the rotation race, the 60 s grace window |
| `docs/PHASE_36_HR_CHATBOT.md` | the AI hub — unit map, final state |
| `docs/PHASE_36_MEMORY_CAPSULE.md` | the AI capsule — laws §2, pitfalls §4, 36.5/36.6/36.7 §5b–§5f |
| `docs/PHASE_36_1_FOUNDATION.md` … `PHASE_36_7_ADMIN_LANGUAGES.md` | per-unit specs; 36.7 §9 has the localhost acceptance steps |
| `docs/PHASE_36_RUNBOOKS.md` | AI runbooks (Incident 7 and the rest) |
| `docs/PHASE_34_CHAT_ENHANCEMENTS.md` | Phase 34 |
| `docs/PHASE_35_*.md` | toasts, responsiveness, permission payload, attendance import |
| `docs/PHASE_27_RMS_ATS.md`, `docs/PHASE_28_FINAL_ARCHITECTURE.md`, `docs/PHASE_30_INTERNAL_BGV.md` | the big phase hubs |
| `docs/PHASE_29_*.md` | the payroll series (setup → F&F → analytics) |

---

## 12. OWNER'S MACHINE — EXACT COMMANDS (Windows PowerShell)

```powershell
# --- get the latest code --------------------------------------------------
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly
git pull origin arena/01a0e7a0-hrms-crewly

# --- run the app (two terminals) ------------------------------------------
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev                     # API + socket on :5000

cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm run dev                     # UI on :5173  →  open http://localhost:5173

# --- run the tests (no Redis/Mongo needed) --------------------------------
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run test:all                # everything
npm run test:phase36-closeout   # the 14 AI guarantees + the language validator
npm run test:ai-languages       # the tenant language unit
npm run test:chat               # Phase 33 chat + realtime
npm run test:cookie             # the cookie session unit
npm run test:session            # the refresh-race unit
npm run config:check            # configuration truth

cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm test                        # the frontend suites
npm run build
npm run lint

# --- if npm says a command/module is missing -------------------------------
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm install

cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm install
```

**Browser habits that matter after a session/auth change:** hard reload
(`Ctrl+Shift+R`) after pulling, and check **F12 → Application → Local Storage
/ Cookies** — there should be **no** `infolexus_token`; `crewly_access` and
`crewly_refresh` should both be marked `HttpOnly`.

---

## 13. THE WORKING LOOP (the one that keeps working)

```
1. AUDIT      grep the real call sites; read the tests that already pin the
              behaviour; check git log for why it is the way it is.
2. PLAN       one plan, with "what does NOT change" stated.
3. BUILD      smallest correct change; follow local conventions (ESM/ES6+,
              thin controllers, the controller comment convention).
4. TEST       hermetic suite first (fake models via DI), then npm run test:all.
5. BUILD UI   Frontend: npm run build (+ eslint on the touched files).
6. DOCS       hub/runbook/capsule update in the SAME commit.
7. COMMIT     long message: symptom → root cause → mechanism → tests → docs.
8. REPORT     FILES CHANGED + exact totals + honest flags. Then STOP.
```

Notes that keep paying off:

- Every non-trivial unit gets its **own hermetic test file** whose comments
  explain *why each assertion exists* (the repo's house style).
- Source-pin tests are used to stop regressions in wiring/ordering — keep
  them **shape-tolerant**.
- When a fix changes a documented mechanism, update the doc **in the same
  commit** and say which docs changed.
- Verify claims against the running code before writing them (`node -e`
  checks, grep for consumers, `git log -S` for history).
- **A capsule that lists only successes is a trap for whoever picks this up
  next.** That is why §9 exists.

---

## 14. REPORTING CONTRACT (copy this shape)

```
## Why it happened
  <the actual mechanism, with the code path>
## Fix
  <what changed, and what deliberately stayed the same>
## FILES CHANGED
  Added:     path (what it contains)
  Modified:  path (one line why)
  Deleted:   none
## Tests
  npm run test:all  →  <exact> tests / <exact> suites / <exact> fail  (before → after)
  Frontend build    →  ✓ <time>
  eslint            →  <n> problems (baseline 128)
## Docs updated
  <file list, one line each>
## Honest flags
  <what is NOT verified, what the owner must click himself, what remains>
```

Close a completed unit with:

```
Phase <n> <title> — pit rules locked in 🏁
```

---

*End of capsule. Current tip `08d0b73`, all four gates green, both sidebar
units shipped and pushed, awaiting the owner's localhost acceptance.*
