# CREWLY — TOTAL PROJECT MEMORY CAPSULE

For starting a new Agent/session on this project. Read this first, then the
repo (the repo is always the source of truth).
Last updated: 2026-08-29, after Phase 28.9 close (commit a869ad9).

---

## 1. What this is

Crewly: multi-tenant SaaS HRMS + Enterprise RMS/ATS (recruitment management
+ applicant tracking), with billing, platform super-admin, and a public
career portal.

- Backend/: Node.js ESM + Express + MongoDB (Atlas) + Mongoose; workers run
  as a separate process; scripts/ for ops tooling; test/ (node:test).
- Frontend/: Vite + React (tenant app + Super Admin app + public pages).
- docs/: phase reference documents (27 + full 28 series).
- Redis + BullMQ v6.3.1 (Phase 28) — background work, scheduled jobs, cache.
- Integrations: Razorpay (billing), Cloudinary (private file storage),
  SMTP (email).
- Multi-tenancy is NON-NEGOTIABLE: every business doc scoped by
  `companyId`; tenant authority comes ONLY from `req.companyId`; never
  trust client-supplied tenant ids.
- There is NO separate Employee collection: employees are `User` records
  with payroll/profile fields.

## 2. Phase map (all closed)

- Phases 1–26 (mainline HRMS, on `main`): companies/roles/RBAC, users &
  profiles, attendance, leaves, shifts/work schedules, payroll,
  performance/appraisals, assets, expenses, projects & tasks, meetings,
  notifications (+prefs), announcements, org chart, documents/requests,
  exit management (resignation), billing & subscriptions (Razorpay),
  support tickets, analytics, security (sessions, security events,
  password reset, company security policy), platform super-admin
  (subscriptions, platform settings/tokens), audit.
- Phase 27 (RMS + ATS, 27.1–27.16): full hiring lifecycle —
  Requisition → Approval → Job Posting → Career Portal apply → Resume
  upload → Parse → ATS score → Pipeline → Interviews/Feedback → Human
  final selection → Offer (approve → PDF → secure portal) → Accept →
  Pre-Onboarding (doc verify) → BGV (optional policy) → READY_TO_JOIN →
  Convert to Employee → Secure account setup → onboarding.
  Reference: `docs/PHASE_27_RMS_ATS.md` (entity map, public APIs, token
  types, ATS weights, file security, permissions, tests).
- Phase 29 (Payroll, 29.1+): 29.1 = **Company Payroll Setup** — the
  tenant configuration layer (legal entity, statutory applicability,
  payroll cycle/payment date/currency/FY, weekend-LOP-overtime policies,
  company salary bank account) with wizard + activation + audit + tenant
  Redis cache. Decides *what applies*, never *how much* (no calculation).
  Reference: `docs/PHASE_29_1_COMPANY_PAYROLL_SETUP.md`. Roadmap:
  29.2 Salary Components → 29.3 Salary Structures → 29.4 Employee Payroll
  Profile → … → 29.14 Payroll Reports & Analytics.
  29.3 is closed: `docs/PHASE_29_3_SALARY_STRUCTURES.md` +
  `docs/PHASE_29_3_TESTING_CHECKLIST.md`; 34 hermetic tests
  (`npm run test:salary-structures`).
  29.4 is closed: `docs/PHASE_29_4_EMPLOYEE_PAYROLL_PROFILE.md` +
  `docs/PHASE_29_4_TESTING_CHECKLIST.md`; 24 hermetic tests
  (`npm run test:employee-payroll`), 252/252 on the payroll ladder.
- Phase 28 (background infrastructure, 28.1–28.9): Redis foundation,
  BullMQ foundation (7 queues), email delivery queue, processing queues
  (resume/ATS/documents), scheduled one-time jobs, pre-onboarding + BGV
  queues, Redis analytics cache, queue operations + failure management,
  final hardening. Reference: `docs/PHASE_28_FINAL_ARCHITECTURE.md`
  (diagram, full inventory, runbooks, production guidance, §15 capsule).

## 3. Domain invariants (project-wide)

- Human decisions: ATS scores are informational (never auto-reject); BGV
  discrepancy/UNABLE_TO_VERIFY → human HR decision; offer accept/reject
  only via POST on secure token routes (GET never finalizes).
- Secure tokens: offer + pre-onboarding access stored as SHA-256 hashes
  only; account setup via hashed PasswordResetToken.
- Files: resumes/offers/pre-onboarding docs in private storage (Cloudinary
  or local private dirs); no permanent public URLs; storage keys
  `select: false`; security scan state `NOT_CONFIGURED` unless a real
  scanner exists. `FIELD_ENCRYPTION_KEY` for field encryption.
- Public (unauthenticated) surface is small and slug/token scoped:
  `/api/public/careers/:companySlug/…`,
  `/api/public/candidate/offers/:secureToken/…`,
  `/api/public/candidate/pre-onboarding/:secureToken/…`,
  `setup-account?token=` → `/api/auth/reset-password`.
- RBAC: company roles + `Permission` model; `SYSTEM_PERMISSION_VERSION`
  migrates defaults via atomic `$addToSet` (no role.save loops).
  HR_HEAD / HR_EXECUTIVE do NOT exist yet (deferred).
- Platform (super admin): `AdminSession` (Mongo) + `PLATFORM_ROLES` +
  `PLATFORM_PERMISSIONS`; `superAdminSession` middleware;
  `operations:read` (SUPER_ADMIN + PLATFORM_ADMIN) / `operations:manage`
  (SUPER_ADMIN only); per-IP rate limits; platform-scope audit.
- Audit: `AuditLog`, `SecurityEvent`, `SystemEvent` models; every
  sensitive mutation audited.

## 4. Auth model

- Customer: stateless JWT (Bearer) + optional refresh tokens; `protect`
  middleware → RBAC checks.
- Platform: `AdminSession` lookup + role gate (role gate runs BEFORE any
  DB access for non-platform roles — tenant tokens get 403 instantly).
- Redis/queue ids, worker details, and job internals are NEVER exposed in
  tenant or candidate UIs.

## 5. Phase 28 infrastructure (condensed)

- Redis client (28.1): explicit `REDIS_ENABLED` parser (never
  `Boolean(env)`); `redis://` + `rediss://` (TLS verification always ON);
  bounded capped exponential reconnect; state-change-only logging;
  degraded API mode (cache→Mongo, enqueue→reject to outbox-recoverable).
- BullMQ (28.2): 7 implemented queues — system, email, resume, ats,
  scheduled, documents, bgv (reserved `analytics` unimplemented and
  allowlist-excluded); prefix `crewly:<env>`; dedicated ioredis per queue
  (producer + worker purposes, `maxRetriesPerRequest: null`); retention
  completed=100 / failed=500.
- 23 job types: 2 system + 10 email + 1 resume-parse + 1 ats-process +
  5 scheduled (interview-reminder, offer-expiry-reminder, offer-expire,
  preonboarding-reminder, bgv-reminder) + 1 document-process +
  3 bgv (process-check, provider-poll, process-result).
- Worker: ONE process, seven workers, shared `jobRegistry` dispatch
  (unknown job name → safe CONFIGURATION failure), per-queue env
  concurrency, strict payload whitelists, Mongo re-fetch by
  `{_id, companyId}` + revalidation before acting, small-metadata
  returns, startup reconciliation, graceful SIGTERM (10s hard stop),
  throttled error logging.
- Payload contract: reference-only (ids, versions, epochs, correlation
  ids). NEVER in payloads/ids/logs: raw tokens, offer URLs, resume text
  or binary, documents, government/bank data, SMTP/Redis/provider
  credentials. Workers never trust payloads (Mongo is truth).
- Email (28.3): outbox `EmailDelivery` + eventKey dedupe + atomic
  `claimEmailDelivery`; token-bearing send emails stay synchronous by
  policy; SMTP classification — auth failure NON-retryable,
  connection/timeout retryable; honest at-least-once boundary (accepted
  but crashed before SENT).
- Processing (28.4): resume parse (lease, versioned, corrupt → terminal
  UNSUPPORTED attempt 1, scanned/image → REVIEW_REQUIRED, no fake scores)
  → ATS (versioned result upsert, one authoritative result); documents
  (version-scoped, security state in Mongo, V1 never touches V2).
- Scheduled (28.5): native BullMQ `delay` one-time jobs (no
  QueueScheduler); worker revalidates Mongo (stale/terminal → SKIP);
  attempted removal on reschedule/cancel/accept/withdraw + validation.
- Pre-onboarding + BGV (28.6): reminders via scheduled queue; BGV
  consent → atomic submission claim → poll ladder 5→15→30→60 min within
  7-day window → VERIFIED / DISCREPANCY / UNABLE_TO_VERIFY → NEVER
  auto-reject.
- Cache (28.7): tenant-scoped key
  `crewly:cache:company:<id>:recruitment:analytics:v1:g<gen>:<hash16>`;
  generation INCR + 24h TTL invalidated at 24 mutation hooks; short value
  TTL (60s default, 10–3600); fail-open to Mongo; envelope + 256KB guard;
  process-local single-flight (documented multi-instance limitation);
  never used for authorization.
- Operations (28.8): 12 allowlisted `/api/super-admin/operations/*`
  routes (counts, safe serializer, retry policy backend-authoritative —
  no force flag, pause/resume, reconciliation preview + bounded run,
  cache status/invalidate); Super Admin "Background Operations" page;
  worker heartbeat `crewly:ops:worker:<env>:worker-<uuid>` TTL 60s /
  beat 15s (+ member set, no KEYS/SCAN); ONLINE/SHUTTING_DOWN/OFFLINE.
- Reconciliation: 6 idempotent bounded Mongo-authoritative runners (email
  stuck, resume pending, ATS missing, scheduled, documents, BGV) +
  master coordinator (dryRun, limit clamped 1–100 per domain,
  per-domain error isolation); startup + CLI + ops API.
- Hardening (28.9): throttled error logging, signed-customer-JWT gate
  tests, §90 script grouping, opt-in load/backpressure check
  (`scripts/ops-load-check.js` — isolated prefix, never FLUSH).
- Production: workers deploy first; managed Redis with persistence +
  verified no-queue-key eviction; one worker process (split only on
  measured load); separate env per stage; see
  `docs/PHASE_28_FINAL_ARCHITECTURE.md` §10–13 (runbooks, topology,
  checklist, limitations).

## 6. Environment variables (names only — never store real values here)

- Core: NODE_ENV, PORT, MONGO_URI, CLIENT_URL, JWT_SECRET, JWT_EXPIRES_IN
- Billing: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
- Email: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
- Storage: CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET,
  MAX_RESUME_SIZE_MB, PRIVATE_RESUME_STORAGE_DIR,
  PRIVATE_OFFER_STORAGE_DIR, OFFER_TOKEN_MAX_DAYS,
  PRIVATE_PRE_ONBOARDING_STORAGE_DIR, PRE_ONBOARDING_TOKEN_MAX_DAYS,
  MAX_PRE_ONBOARDING_DOC_SIZE_MB
- Security: FIELD_ENCRYPTION_KEY
- Parse/ATS: RESUME_PARSE_MAX_RAW_TEXT_CHARS, RESUME_PARSE_MAX_DOCX_
  EXPANDED_BYTES, RESUME_PARSE_MAX_PDF_PAGES, RESUME_PARSE_TIMEOUT_MS,
  RESUME_PARSE_MAX_ATTEMPTS, RESUME_PARSE_LEASE_MS,
  RESUME_REPROCESS_COOLDOWN_MS, ATS_WEIGHT_* (required/experience/
  preferred/education/location), ATS_DEFAULT_MAX_NOTICE_PERIOD_DAYS
- Phase 29.1: PAYROLL_SETUP_CACHE_TTL_SECONDS
- Phase 28: REDIS_ENABLED, REDIS_URL (secret — env only),
  REDIS_CONNECT_TIMEOUT_MS, BULLMQ_PREFIX, WORKER_CONCURRENCY,
  EMAIL/RESUME/ATS/SCHEDULED/DOCUMENT/BGV_WORKER_CONCURRENCY,
  OFFER_REMINDER_OFFSET_HOURS, PREONBOARDING_DOCS_REMINDER_HOURS,
  PREONBOARDING_RESUBMISSION_REMINDER_HOURS,
  PREONBOARDING_JOINING_REMINDER_DAYS_BEFORE,
  BGV_CANDIDATE_REMINDER_HOURS, BGV_VERIFIER_REMINDER_HOURS,
  RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS, OPS_* (optional, commented)
- `.env.example` holds placeholders/defaults ONLY; `.env` is
  gitignored and must never be committed.

## 7. Commands (developer machine: Windows PowerShell)

```powershell
# setup
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend; npm install
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend; npm install

# run (two terminals)
npm run dev        # Backend API
npm run worker     # Background worker (separate process)
# Frontend: npm run dev

# tests (Backend)
npm run test:all          # 24 non-live suites, 366 hermetic tests
npm run test:phase28      # Phase 28 suites
npm run test:redis / test:bullmq / test:email / test:processing /
npm run test:scheduled / test:background-jobs / test:cache / test:operations
npm run test:payroll-setup   # Phase 29.1 — hermetic (no Mongo, no Redis)
node --test test/<file>.test.js   # single file
# opt-in live (dev Redis + Mongo; isolated prefixes; NEVER FLUSH):
npm run test:bullmq:live
npm run test:ops:live
# controlled load check (dev only):
npm run ops:load-check -- --jobs 100 --concurrency 4

# ops CLI
npm run redis:check; npm run queue:check; npm run email:reconcile;
npm run processing:reconcile; npm run scheduled:reconcile; npm run queue:reconcile

# frontend
npm run build
```

Note: in a fresh sandbox checkout, run `npm install` in BOTH Backend and
Frontend first (node_modules may be missing).

## 8. Standing rules (user-set — never violate)

- Inspect the actual repo before modifying; repo is authoritative over
  any capsule; STOP and report security-sensitive discrepancies before
  destructive changes.
- NEVER ask for, print, or commit secrets (REDIS_URL, SMTP, Cloudinary,
  Razorpay, JWT_SECRET, FIELD_ENCRYPTION_KEY); no real values in
  `.env.example`; no `VITE_REDIS_URL` or any frontend Redis dependency.
- Normal `npm install` (lockfile npm-managed); no unrelated packages; no
  `npm audit fix --force` without approval; no legacy `bull`; verify
  BullMQ v6.3.1 API — "do not guess".
- Explicit `REDIS_ENABLED` parser; support `redis://` AND `rediss://`;
  never `rejectUnauthorized: false` as a blanket fix.
- Style: pure ESM (no `require()`), arrow functions, thin controllers,
  no emojis in new UI, compact maintainable files, follow existing
  repo organization.
- Developer is a Windows PowerShell beginner: exact beginner-friendly
  commands; no Unix-only env-prefix npm scripts; explicit opt-in
  commands; beware `.js.js` filename traps; no destructive
  `git reset --hard`.
- Never claim exactly-once (document at-least-once boundaries); worker
  revalidates Mongo (never trust queue data); no raw tokens/PII/links in
  job data/jobId/returnvalues/logs; no Redis-only lock as sole truth
  (Mongo atomic claims); no automatic candidate rejection from BGV; no
  provider credentials in BullMQ or logs; no Redis/BullMQ/job ids in
  candidate or HR UI.
- Failure tests use isolated prefix / mocks / exact-key removal;
  NEVER FLUSHALL/FLUSHDB on real Redis; no `KEYS` in production hot
  paths; hermetic unit tests never require live Redis; live tests use
  dev namespace + exact cleanup only.
- Cache only after auth + tenant + RBAC; short TTL + Redis generation
  (no Mongo cache-version fields); keep compatibility with future
  separate `REDIS_CACHE_URL`.
- Report exactly ONE build plan (with required subsections) BEFORE
  coding; no repeated plans; implement one phase only; STOP with a next-
  phase handoff at the end.
- **Controller comment convention (house style):** every request handler
  carries three section comments, in this order:

    ```js
    export const offerDetail = asyncHandler(async (req, res) => {
      // Data from frontend - requests from frontend
      const { offerId } = req.params;
      // DB Logic - DB logics
      const result = await getOffer({ companyId: req.companyId, offerId });
      // Data to frontend - response to frontend
      return ApiResponse.success(res, { message: 'Offer fetched', data: result.offer });
    });
    ```

  Placement rules: the request comment goes before the first statement that
  reads `req` (params / query / body); the DB comment before the first
  service or query call; the response comment before the statement that
  emits the response (`return`, `res.json(...)`, `ApiResponse.x(res, ...)`).
  When a handler is wrapped in `try { }`, the comments go INSIDE the try,
  never in the catch. If the very first statement is already the query,
  omit the request comment rather than mislabelling a DB call.
- **ES6+ only, everywhere:** `const`/`let`, arrow functions, destructuring,
  spread/rest, template literals, optional chaining (`?.`), `??`,
  `async`/`await`, and ESM `import`/`export`. Never `var`, never
  `function` declarations, never `require()`/`module.exports`, never
  `.prototype`, `Object.assign` or `.indexOf()` where modern syntax exists.
- Preferred closing phrase: "pit rules locked in 🏁".

## 9. Current state (2026-08-31)

- Phase 29.1 = Company Payroll Setup + an RBAC update on top of it: 39
  granular payroll permissions (10 resources), opt-in role templates
  (HR_HEAD / HR_EXECUTIVE / PAYROLL_ADMIN / PAYROLL_EXECUTIVE /
  FINANCE_MANAGER / FINANCE_EXECUTIVE — DATA ONLY, never seeded), org scope
  SELF|TEAM|DEPARTMENT|ASSIGNED_DEPARTMENTS|COMPANY (utils/payrollScope.js,
  team reach reuses orgHelpers.getSubtreeIds), payroll permission grant/revoke
  audit, and tenant→role→permission→scope enforced on payslip access.
  utils/payrollActionAudit.js holds the §11 sensitive-action audit hooks
  (salary changed … payslips released) for 29.2+; bank numbers are masked to
  the last 4 digits and PAN/UAN/ESI are written as [REDACTED].
  SYSTEM_PERMISSION_VERSION is 18 (29.4 added EMPLOYEE_SALARY_READ_SELF).
  PAYROLL_SETUP_*, SALARY_COMPONENT_*, SALARY_STRUCTURE_* and
  EMPLOYEE_SALARY_* are enforced;
  the rest of the catalogue is declared for the later payroll phases.
  Permission totals: 199 in the catalogue, COMPANY_ADMIN 198, HR_MANAGER 132,
  TEAM_LEAD 58, MANAGER 53, EMPLOYEE 52.
- Phase 29.2 = Salary Components: pure rules in
  services/payroll/salaryComponentRules.js, tenant model
  models/SalaryComponent.js (unique {companyId, code}, company-first indexes),
  injectable service (cache + audit + model injected so tests stay hermetic),
  permissions SALARY_COMPONENT_{READ,MANAGE,ACTIVATE} (SYSTEM_PERMISSION_VERSION
  is 16), Redis fail-open cache 'payroll-components', versioning that writes a
  NEW version when a component has history, deactivation instead of deletion,
  controlled formula operation list (no eval), and defaults that follow the
  29.1 statutory config (PF off => no PF component).
  Payroll nav + /app/payroll/setup and /app/payroll/components are
  PERMISSION-driven, not gated on the COMPANY_ADMIN/HR_MANAGER role names.
- Phase 29.4 = Employee Payroll Profile: pure rules in
  services/payroll/employeePayrollRules.js, tenant model
  models/EmployeePayrollProfile.js (one CURRENT profile per employee via a
  partial unique index, company-first indexes), injectable service
  (models/cache/audit/notify), routes at /api/payroll/employees, and
  middlewares/payrollProfileAccess.js which layers tenant -> self -> permission
  -> payroll scope on top of payrollAccessService (29.1). Permissions
  EMPLOYEE_SALARY_{READ,MANAGE} (already in the 29.1 catalogue) plus the new
  EMPLOYEE_SALARY_READ_SELF (SYSTEM_PERMISSION_VERSION is 18); MANAGER and
  TEAM_LEAD deliberately get nothing, EMPLOYEE gets READ_SELF only, and it is
  NOT in SELF_SERVICE_PERMISSIONS because that list leaks to Manager/Team Lead.
  Bank account reuses 29.1 fieldEncryption (select:false + masked mirror),
  statutory applicability is READ from 29.1 PayrollSetup.statutory, the §9
  breakup reuses the 29.3 preview (never the engine), CTC is validated as
  12 x (gross + employer cost), salary changes write a NEW version, and
  candidateConversionService seeds a DRAFT profile from the offered CTC
  (best-effort + idempotent). Redis namespace 'payroll-employee'; no new queue.
  Frontend: /app/payroll/employees + /app/payroll/employees/:employeeId
  (Overview/Bank/Statutory/Tax/Salary History tabs).
- Navigation rework (2026-09-01): the flat 35-row sidebar became
  layout/SidebarNav.jsx — every page now belongs to a GROUP (Home, People,
  Time & Leave, Payroll, Recruitment, Work, Insights, Me are pinned;
  Finance + Administration sit behind "More"), one group open at a time,
  the group owning the current page opens itself, a search box filters all
  pages, and a collapse toggle (w-60 <-> w-16 icon rail) is remembered in
  localStorage. AppLayout keeps header/main and only builds the menu.
- Phase 29.3 = Salary Structures: pure rules in
  services/payroll/salaryStructureRules.js, tenant model
  models/SalaryStructureTemplate.js (unique {companyId, code}, company-first
  indexes). It is deliberately NOT models/SalaryStructure.js: that file is the
  LEGACY per-employee monthly salary row (user/basic/hra/allowances/pfPercent/
  professionalTax) used by PayrollPage + payrollController, and 29.3 must not
  break it. The 29.3 API therefore lives at /api/payroll/salary-structures and
  leaves the legacy /api/payroll/structures alone (a hermetic test guards it).
  injectable service (cache + audit + models injected), permissions
  SALARY_STRUCTURE_{READ,MANAGE,ACTIVATE} (SYSTEM_PERMISSION_VERSION is 17;
  HR_MANAGER gets READ+MANAGE but NOT ACTIVATE, the PAYROLL_ADMIN template
  gets all three), Redis fail-open cache 'payroll-structures', versioning that
  writes a NEW version when a structure with history is reconfigured, clone as
  a fresh DRAFT v1, and an unstored §9 preview (never the payroll engine).
  salaryComponentService.getUsage() now counts the structures that reference a
  component (injected `structureUsage`), which closes the 29.2 -> 29.3 loop.
  Frontend: /app/payroll/structures + permission-driven sidebar entry.
- Phase 29.1 closed: Company Payroll Setup (backend model/service/routes/
  validator + 33 hermetic tests + frontend wizard & dashboard + docs).
  One current config per company (partial unique index on `companyId` where
  `isCurrent: true`); bank account encrypted (`FIELD_ENCRYPTION_KEY`) +
  `select: false` + masked-only API; `SYSTEM_PERMISSION_VERSION` 14 with the
  new `PAYROLL_SETUP_READ/_UPDATE/_ACTIVATE` permissions (ACTIVATE reserved
  for Company Admin); cache key
  `crewly:cache:company:<id>:payroll-setup:v1:current` via the existing
  Phase 28.7 service; audit via `recordAudit`; activation notification via
  the existing `notifySmart` seam (no new BullMQ queue or job name).
- Still OPEN (dev machine): opt-in live ladders `test:ops:live` /
  `test:bullmq:live`, and a first real `ops:load-check` run.
- Phase 29.1 tests are hermetic — they run without MongoDB/Redis, so they are
  green in a clean sandbox; the other 24 suites still need local MongoDB.

## 9b. Previous state (2026-08-29)

- Branch `arena/01a04272-hrms-crewly`, HEAD `a869ad9` (Phase 28.9),
  pushed; latest `main` = `fc34a35` (Phase 27 notes). Working tree clean.
- Phase 28: fully closed — 366/366 hermetic tests green, npm audit 0/0,
  frontend build passing, secrets scan clean, no FLUSH/KEYS/arbitrary-
  command surface anywhere, tenant tokens denied at platform gate
  (tested).
- OPEN (dev machine only): opt-in live ladders not yet run by the
  developer (`test:ops:live` / `test:bullmq:live`) — first run verifies
  heartbeat export/import + member-set key format; the live ops test
  creates ONE EmailDelivery fixture with exact-`_id` cleanup (documented
  exception). `ops:load-check` also awaits a first real run.
- Workspace quirk (Agent sandboxes): snapshot restore can drop
  `node_modules` (excluded from snapshots → just `npm install` again) and
  can leave local git HEAD stale (remote is authoritative — reset local
  branch to the pushed remote tip after backing up uncommitted work).
- Credential incidents (historical, handled): a live Redis URL+password
  was pasted into chat once (rotated) and a `.env` screenshot exposed
  real Cloudinary credentials (rotation recommended). Never echo these
  again.

## 10. Next-phase candidates (start ONLY on explicit instruction)

- HR_HEAD / HR_EXECUTIVE roles; payroll redesign; L&D module;
  asset/expense upgrades; helpdesk.
- Hardening backlog: external BGV provider integration; OCR for scanned
  resumes; provider message-id/outbox tracking (close the email
  at-least-once boundary); Redis-based cache single-flight (multi-
  instance stampede); worker splitting + auto-scaling (only with load
  evidence from `ops:load-check`); external alerting vendor.
